"""Company career boards: the ATS readers, the extra title rule and companies.json."""

import json
from datetime import datetime, timedelta, timezone

import pytest

import api_sources
from api_sources import (
    ATS_POSTINGS,
    _workday_india_facets,
    _workday_location,
    _workday_posted,
    ats_title_ok,
    load_companies,
)
from export import normalize_location


# ── Workday ───────────────────────────────────────────────────────────────────

def test_workday_prefers_a_country_facet_named_india():
    facets = [
        {"facetParameter": "jobFamilyGroup", "values": [{"descriptor": "Engineering", "id": "e1"}]},
        {"facetParameter": "locationMainGroup", "values": [
            {"facetParameter": "locationHierarchy1", "values": [
                {"descriptor": "India", "id": "country-in"},
                {"descriptor": "United States", "id": "country-us"},
            ]},
            {"facetParameter": "locations", "values": [
                {"descriptor": "India, Bengaluru", "id": "blr"},
                {"descriptor": "India, Pune", "id": "pune"},
                {"descriptor": "India, Hyderabad", "id": "hyd"},
            ]},
        ]},
    ]
    assert _workday_india_facets(facets) == {"locationHierarchy1": ["country-in"]}


def test_workday_falls_back_to_every_indian_city_site():
    facets = [{"facetParameter": "locations", "values": [
        {"descriptor": "Bengaluru, India", "id": "blr"},
        {"descriptor": "Chennai - India", "id": "maa"},
        {"descriptor": "Austin, TX", "id": "aus"},
    ]}]
    assert _workday_india_facets(facets) == {"locations": ["blr", "maa"]}


def test_workday_without_an_indian_location_has_no_filter():
    facets = [{"facetParameter": "locations", "values": [{"descriptor": "Indianapolis, IN", "id": "ind"}]}]
    assert _workday_india_facets(facets) == {}


@pytest.mark.parametrize("text, days", [
    ("Posted Today", 0),
    ("Posted Yesterday", 1),
    ("Posted 3 Days Ago", 3),
    ("Posted 30+ Days Ago", 30),
])
def test_workday_posted_dates(text, days):
    today = datetime.now(timezone.utc).date()
    assert _workday_posted(text) == (today - timedelta(days=days)).isoformat()


def test_workday_posted_unknown_is_none():
    assert _workday_posted("") is None
    assert _workday_posted(None) is None


def test_workday_location_reads_the_path_for_several_locations():
    path = "/job/India-Gurugram/SAP-Master-Data-Engineer_JR2026497"
    assert _workday_location("2 Locations", path) == "India Gurugram"
    assert _workday_location("India, Bengaluru", "/job/x/y") == "India, Bengaluru"
    # Matched the India facet, but neither field names an Indian place.
    assert _workday_location("3 Locations", "/job/US-CA-Santa-Clara/x") == "India"


def test_workday_postings_filter_india_and_page(monkeypatch):
    calls = []
    pages = {
        0: {"total": 3, "jobPostings": [
            {"title": "Software Engineer", "externalPath": "/job/India-Pune/SE_JR1",
             "locationsText": "India, Pune", "postedOn": "Posted Today", "bulletFields": ["JR1"]},
            {"title": "Data Engineer", "externalPath": "/job/India-Pune/DE_JR2",
             "locationsText": "2 Locations", "postedOn": "Posted 2 Days Ago", "bulletFields": ["JR2"]},
        ]},
        2: {"total": 0, "jobPostings": [
            {"title": "UX Designer", "externalPath": "/job/India-Bengaluru/UX_JR3",
             "locationsText": "India, Bengaluru", "postedOn": "Posted Yesterday"},
        ]},
    }

    def fake_post(url, payload, headers=None):
        calls.append((url, payload))
        if payload["limit"] == 1:
            return {"facets": [{"facetParameter": "locationCountry", "values": [
                {"descriptor": "India", "id": "IN"}]}]}
        assert payload["appliedFacets"] == {"locationCountry": ["IN"]}
        return pages[payload["offset"]]

    monkeypatch.setattr(api_sources, "post_json", fake_post)
    postings = api_sources._workday_postings(
        {"host": "acme.wd5.myworkdayjobs.com", "site": "AcmeCareers", "name": "Acme"})

    assert calls[0][0] == "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/AcmeCareers/jobs"
    assert [p["title"] for p in postings] == ["Software Engineer", "Data Engineer", "UX Designer"]
    assert postings[0]["url"] == "https://acme.wd5.myworkdayjobs.com/AcmeCareers/job/India-Pune/SE_JR1"
    assert postings[1]["location"] == "India Pune"
    assert postings[2]["id"] == "/job/India-Bengaluru/UX_JR3"
    # The probe, then pages at offset 0 and 2; the total came from page one.
    assert [payload["offset"] for _url, payload in calls] == [0, 0, 2]


def test_workday_keeps_pages_read_before_a_lasting_throttle(monkeypatch):
    monkeypatch.setattr(api_sources.time, "sleep", lambda _s: None)

    def fake_post(url, payload, headers=None):
        if payload["limit"] == 1:
            return {"facets": [{"facetParameter": "locationCountry", "values": [{"descriptor": "India", "id": "IN"}]}]}
        if payload["offset"] == 0:
            return {"total": 40, "jobPostings": [
                {"title": "Software Engineer", "externalPath": f"/job/India-Pune/SE_{i}"} for i in range(20)]}
        raise _http_error(429)

    monkeypatch.setattr(api_sources, "post_json", fake_post)
    postings = api_sources._workday_postings({"host": "acme.wd5.myworkdayjobs.com", "site": "Jobs"})
    assert len(postings) == 20


def test_workday_tenant_without_india_costs_one_request(monkeypatch):
    calls = []

    def fake_post(url, payload, headers=None):
        calls.append(payload)
        return {"facets": [{"facetParameter": "locations", "values": [{"descriptor": "Paris", "id": "p"}]}]}

    monkeypatch.setattr(api_sources, "post_json", fake_post)
    assert api_sources._workday_postings({"host": "acme.wd3.myworkdayjobs.com", "site": "Jobs"}) == []
    assert len(calls) == 1


# ── Retries ───────────────────────────────────────────────────────────────────

def _http_error(code, retry_after=None):
    import email.message
    import urllib.error
    headers = email.message.Message()
    if retry_after is not None:
        headers["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError("https://x.test", code, "error", headers, None)


def test_ats_call_retries_rate_limits_then_succeeds(monkeypatch):
    sleeps = []
    monkeypatch.setattr(api_sources.time, "sleep", sleeps.append)
    answers = [_http_error(429, retry_after=5), _http_error(503), {"ok": True}]

    def flaky():
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    assert api_sources._ats_call(flaky) == {"ok": True}
    # Retry-After first, then the backoff for the second attempt (plus jitter).
    assert 5 <= sleeps[0] < 6 and 4 <= sleeps[1] < 5


def test_ats_call_does_not_retry_a_missing_board(monkeypatch):
    calls = []
    monkeypatch.setattr(api_sources.time, "sleep", lambda _s: None)

    def missing():
        calls.append(1)
        raise _http_error(404)

    with pytest.raises(Exception):
        api_sources._ats_call(missing)
    assert len(calls) == 1


def test_ats_call_gives_up_after_the_retries(monkeypatch):
    calls = []
    monkeypatch.setattr(api_sources.time, "sleep", lambda _s: None)

    def throttled():
        calls.append(1)
        raise _http_error(429)

    with pytest.raises(Exception):
        api_sources._ats_call(throttled)
    assert len(calls) == api_sources.ATS_RETRIES + 1


# ── SmartRecruiters ───────────────────────────────────────────────────────────

def test_smartrecruiters_asks_for_india_and_pages(monkeypatch):
    offsets = []

    def fake_get(url, params=None, headers=None):
        assert params["country"] == "in"
        offsets.append(params["offset"])
        start = params["offset"]
        items = [
            {"id": str(i), "name": f"Job {i}", "company": {"name": "Bosch Group"},
             "location": {"city": "Bangalore", "country": "in"}, "releasedDate": "2026-10-30T10:00:00Z"}
            for i in range(start, min(start + params["limit"], 150))
        ]
        return {"totalFound": 150, "content": items}

    monkeypatch.setattr(api_sources, "get_json", fake_get)
    postings = api_sources._smartrecruiters_postings({"token": "boschgroup"})
    assert offsets == [0, 100]
    assert len(postings) == 150
    assert postings[0]["location"] == "Bangalore, India"
    assert postings[0]["company"] == "Bosch Group"
    assert postings[0]["url"] == "https://jobs.smartrecruiters.com/boschgroup/0"


# ── Board jobs ────────────────────────────────────────────────────────────────

def test_board_jobs_use_the_configured_name_and_the_title_rule(monkeypatch):
    postings = [
        {"title": "Senior Software Engineer", "location": "Bengaluru, India",
         "url": "https://jobs.example.com/1", "posted": None, "id": "1"},
        {"title": "Gas insulated switchgear installation engineer", "location": "Chennai, India",
         "url": "https://jobs.example.com/2", "posted": None, "id": "2"},
        {"title": "Senior Software Engineer II", "location": "Austin, TX",
         "url": "https://jobs.example.com/3", "posted": None, "id": "3"},
    ]
    monkeypatch.setitem(ATS_POSTINGS, "lever", lambda board: postings)
    jobs = api_sources._board_jobs("lever", {"token": "extremenetworks", "name": "Extreme Networks"}, "sde")
    assert [j["title"] for j in jobs] == ["Senior Software Engineer"]
    assert jobs[0]["company"] == "Extreme Networks"
    assert jobs[0]["source"] == api_sources.CAREERS_SOURCE


@pytest.mark.parametrize("role, title, ok", [
    ("sde", "Senior Software Engineer - Android", True),
    ("sde", "Java Angular Full Stack Developer", True),
    ("sde", "Senior Lead Firmware Engineer", True),
    ("sde", "Gas insulated switchgear installation engineer", False),
    ("sde", "Manufacturing Engineer", False),
    ("sde", "Senior Engineer", False),
    ("data", "Senior Data Engineer", True),
    ("data", "Java Spark developer", True),
    ("data", "Data Architect With AI", True),
    ("data", "Medical Data Review Physician", False),
    ("data", "Vice President - Data Science", False),
    ("uiux", "Senior UX Designer", True),
    ("uiux", "Product Designer", True),
    ("uiux", "Senior UI Developer", True),
    ("uiux", "Senior DFT Designer", False),
    ("uiux", "Interior Designer", False),
    ("uiux", "BMS Design", False),
    ("uiux", "IAM Lead Designer, AVP", False),
    ("uiux", "Sr QA Automation Engineer (JavaScript , UI automation)", False),
    # GenAI and BA rely on their own rules, which already name the role.
    ("genai", "AI Software Solutions Engineer", True),
    ("ba", "Anything", True),
])
def test_ats_title_rule(role, title, ok):
    assert ats_title_ok(role, title) is ok


# ── Locations ─────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("raw, keep", [
    ("Remote, AMER", False),
    ("Remote - AMER", False),
    ("Remote, Global", True),
    ("Amer, Jaipur", True),
])
def test_regional_remote_labels(raw, keep):
    assert normalize_location(raw, strict=True)[1] is keep


# ── companies.json ────────────────────────────────────────────────────────────

def test_load_companies_accepts_tokens_and_objects(tmp_path, monkeypatch):
    path = tmp_path / "companies.json"
    path.write_text(json.dumps({
        "_comment": "ignored",
        "greenhouse": ["okta", {"token": "databricks", "name": "Databricks"}, 42, {"name": "no token"}],
        "workday": [{"name": "NVIDIA", "host": "nvidia.wd5.myworkdayjobs.com", "site": "X"}],
        "notes": "not a list",
    }), encoding="utf-8")
    monkeypatch.setattr(api_sources, "COMPANIES_FILE", str(path))
    assert load_companies() == {
        "greenhouse": [{"token": "okta"}, {"token": "databricks", "name": "Databricks"}],
        "workday": [{"name": "NVIDIA", "host": "nvidia.wd5.myworkdayjobs.com", "site": "X"}],
    }


def test_shipped_companies_json_is_well_formed():
    boards = load_companies()
    assert set(boards) <= set(ATS_POSTINGS)
    seen = set()
    for ats, entries in boards.items():
        for board in entries:
            if ats == "workday":
                assert board.get("host", "").endswith(".myworkdayjobs.com") and board.get("site"), board
                key = (ats, board["host"].lower(), board["site"].lower())
            else:
                assert board.get("token"), board
                key = (ats, board["token"].lower())
            # Lever, Ashby and Workday feeds carry no company name.
            if ats in ("lever", "ashby", "workday"):
                assert board.get("name"), board
            assert key not in seen, key
            seen.add(key)
    assert len(seen) >= 100
