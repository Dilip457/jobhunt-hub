"""The polite sources: what each parser keeps, and when a source stops."""

import json

import pytest

import portal_scrapers as ps
from roles import ROLES


class FakeResponse:
    def __init__(self, status_code=200, text="", payload=None):
        self.status_code = status_code
        self.text = text
        self._payload = payload

    def json(self):
        if self._payload is None:
            raise ValueError("not json")
        return self._payload


@pytest.fixture(autouse=True)
def no_waiting(monkeypatch):
    monkeypatch.setattr(ps, "POLITE_GAP", 0)


def test_every_role_has_cutshort_and_wellfound_pages():
    for role in ROLES:
        assert ps.CUTSHORT_TAGS[role], role
        assert ps.WELLFOUND_PAGES[role], role


# ── PoliteClient ─────────────────────────────────────────────────────────────

def test_client_names_itself_and_asks_robots_first(monkeypatch):
    monkeypatch.setattr(ps, "robots_allow", lambda url: False)
    client = ps.PoliteClient("x")
    calls = []
    monkeypatch.setattr(client.session, "get", lambda *a, **k: calls.append(a))
    assert client.get("https://a.test/jobs") is None
    assert client.stopped and calls == []
    assert "jobhunt-hub" in client.session.headers["User-Agent"]


@pytest.mark.parametrize("status", [401, 403, 429, 503])
def test_client_stops_at_the_first_refusal(monkeypatch, status):
    monkeypatch.setattr(ps, "robots_allow", lambda url: True)
    client = ps.PoliteClient("x")
    calls = []

    def get(url, timeout):
        calls.append(url)
        return FakeResponse(status)

    monkeypatch.setattr(client.session, "get", get)
    assert client.get("https://a.test/1") is None
    assert client.get("https://a.test/2") is None
    assert calls == ["https://a.test/1"]


def test_client_carries_on_after_an_ordinary_miss(monkeypatch):
    monkeypatch.setattr(ps, "robots_allow", lambda url: True)
    client = ps.PoliteClient("x")
    monkeypatch.setattr(client.session, "get", lambda url, timeout: FakeResponse(404))
    assert client.get("https://a.test/1") is None
    assert not client.stopped


def test_get_json_survives_a_page_that_is_not_json(monkeypatch):
    monkeypatch.setattr(ps, "robots_allow", lambda url: True)
    client = ps.PoliteClient("x")
    monkeypatch.setattr(client.session, "get", lambda url, timeout: FakeResponse(200, "<html>"))
    assert client.get_json("https://a.test/1") == {}


@pytest.mark.parametrize(
    "status,body,allowed",
    [
        (200, "User-agent: *\nDisallow: /jobs", False),
        (200, "User-agent: *\nDisallow: /private", True),
        (200, "User-agent: jobhunt-hub\nDisallow: /", False),
        (404, "", True),
        (403, "", False),
        (500, "", False),
    ],
)
def test_robots_rules(monkeypatch, status, body, allowed):
    ps._robots_rules.cache_clear()
    monkeypatch.setattr(ps.requests, "get", lambda *a, **k: FakeResponse(status, body))
    assert ps.robots_allow("https://a.test/jobs") is allowed
    ps._robots_rules.cache_clear()


def test_robots_unreadable_means_no(monkeypatch):
    ps._robots_rules.cache_clear()

    def boom(*a, **k):
        raise OSError("down")

    monkeypatch.setattr(ps.requests, "get", boom)
    assert ps.robots_allow("https://a.test/jobs") is False
    ps._robots_rules.cache_clear()


# ── Parsers ──────────────────────────────────────────────────────────────────

def test_instahyre():
    payload = {"objects": [
        {
            "id": 1, "title": "UX Designer", "locations": "Bangalore",
            "public_url": "https://www.instahyre.com/job-1-ux-designer/",
            "keywords": ["Figma"], "employer": {"company_name": "Acme", "instahyre_note": "Builds things"},
        },
        {"id": 2, "title": "Sales Executive", "locations": "Pune",
         "public_url": "https://www.instahyre.com/job-2/", "employer": {"company_name": "Acme"}},
    ]}
    jobs = ps.parse_instahyre("uiux", payload)
    assert [j["title"] for j in jobs] == ["UX Designer"]
    assert jobs[0]["source"] == "Instahyre"
    assert jobs[0]["company"] == "Acme"
    assert jobs[0]["location"] == "Bangalore"


def _workable(**over):
    job = {
        "id": "a", "title": "Data Engineer", "state": "published", "workplace": "hybrid",
        "url": "https://jobs.workable.com/view/AbC123/data-engineer-/-etl-in-pune",
        "location": {"city": "Pune", "countryName": "India"},
        "company": {"title": "Acme"}, "created": "2026-11-03T10:00:00.000Z",
        "description": "<p>Requires 3-5 years of experience</p>", "requirementsSection": "",
    }
    job.update(over)
    return job


def test_workable_keeps_india_and_uses_the_stable_link():
    jobs = ps.parse_workable("data", {"jobs": [
        _workable(),
        _workable(id="b", location={"city": "Berlin", "countryName": "Germany"}),
        _workable(id="c", state="closed"),
    ]})
    assert len(jobs) == 1
    assert jobs[0]["url"] == "https://jobs.workable.com/view/AbC123"
    assert jobs[0]["posted_date"] == "2026-11-03"
    assert (jobs[0]["experience_min"], jobs[0]["experience_max"]) == (3, 5)


def test_workable_remote_is_labelled_remote():
    jobs = ps.parse_workable("data", {"jobs": [_workable(workplace="remote")]})
    assert jobs[0]["location"] == "Remote"


def _unstop(**over):
    job = {
        "id": 1, "title": "Data Engineer", "status": "LIVE", "regn_open": 1, "isPaid": False,
        "seo_url": "https://unstop.com/jobs/data-engineer-1", "details": "<p>Build pipelines</p>",
        "organisation": {"name": "Acme"}, "approved_date": "2026-10-20 19:03:29 GMT+0530",
        "end_date": "2026-11-30T23:59:59+05:30",
        "jobDetail": {"locations": ["Mumbai"], "type": "in_office", "timing": "full_time",
                      "min_experience": 2, "max_experience": 4},
    }
    job.update(over)
    return job


def test_unstop_keeps_only_open_free_full_time_jobs():
    rows = [
        _unstop(),
        _unstop(id=2, status="EXPIRED"),
        _unstop(id=3, regn_open=0),
        _unstop(id=4, isPaid=True),
        _unstop(id=5, end_date="2026-10-01T23:59:59+05:30"),
        _unstop(id=6, jobDetail={"locations": ["Pune"], "type": "in_office", "timing": "part_time"}),
    ]
    jobs = ps.parse_unstop("data", {"data": {"data": rows}}, today="2026-11-04")
    assert [j["id"] for j in jobs] == ["1"]
    assert jobs[0]["posted_date"] == "2026-10-20"
    assert (jobs[0]["experience_min"], jobs[0]["experience_max"]) == (2, 4)


def test_unstop_work_from_home_is_remote():
    row = _unstop(jobDetail={"locations": ["Mumbai"], "type": "wfh", "timing": "full_time"})
    jobs = ps.parse_unstop("data", {"data": {"data": [row]}}, today="2026-11-04")
    assert jobs[0]["location"] == "Remote"


def _internshala_card(kind="job", title="UX Designer", place="Bangalore", age="2 weeks ago", years="1 year(s)"):
    return f"""
    <div class="individual_internship" employment_type="{kind}" internshipid="7">
      <h2><a class="job-title-href" href="/job/detail/ux-designer-7">{title}</a></h2>
      <p class="company-name"> Acme </p>
      <p class="row-1-item locations"><span><a>{place}</a></span></p>
      <div class="row-1-item"><i class="ic-16-briefcase"></i><span>{years}</span></div>
      <div class="about_job"><div class="text">Design flows in Figma</div></div>
      <div class="job_skill">Figma</div>
      <div class="color-labels"><div><span>{age}</span></div></div>
    </div>"""


def test_internshala_keeps_jobs_and_skips_internships():
    page = _internshala_card() + _internshala_card(kind="internship")
    jobs = ps.parse_internshala("uiux", page)
    assert len(jobs) == 1
    assert jobs[0]["url"] == "https://internshala.com/job/detail/ux-designer-7"
    assert jobs[0]["company"] == "Acme"
    assert jobs[0]["experience_min"] == 1
    assert jobs[0]["posted_date"] is not None


def test_internshala_hours_ago_is_today_and_home_is_remote():
    jobs = ps.parse_internshala("uiux", _internshala_card(age="Few hours ago", place="Work from home"))
    assert jobs[0]["location"] == "Remote"
    assert jobs[0]["posted_date"] == ps._relative_date("today")


def _apna_card(title="Business Analyst", tags=("Work from Office", "Full Time", "Min. 3 years")):
    spans = "".join(f"<span>{tag}</span>" for tag in tags)
    return f"""
    <a data-testid="job-card" href="/job/hyderabad/business-analyst-5">
      <h2>{title}</h2><span>Acme</span><span>Bengaluru/Bangalore</span><span>Not disclosed</span>{spans}
    </a>"""


def test_apna_reads_a_card():
    jobs = ps.parse_apna("ba", _apna_card())
    assert len(jobs) == 1
    job = jobs[0]
    assert job["url"] == "https://apna.co/job/hyderabad/business-analyst-5"
    assert (job["company"], job["location"]) == ("Acme", "Bangalore")
    assert job["experience_min"] == 3


def test_apna_skips_part_time_and_labels_work_from_home():
    assert ps.parse_apna("ba", _apna_card(tags=("Part Time",))) == []
    jobs = ps.parse_apna("ba", _apna_card(tags=("Work from Home", "Full Time")))
    assert jobs[0]["location"] == "Remote"


def _next_page(props):
    return f'<script id="__NEXT_DATA__" type="application/json">{json.dumps({"props": {"pageProps": props}})}</script>'


def _cutshort_page(*rows):
    state = {"queries": [
        {"state": {"data": {"data": {"seoData": {}}}}},
        {"state": {"data": {"data": {"pageData": {"jobs": list(rows)}}}}},
    ]}
    return _next_page({"dehydratedState": state})


def _cutshort(**over):
    job = {
        "_id": "6ae320fe4633a27b7bf2301e", "headline": "Data Engineer",
        "publicUrl": "https://cutshort.io/job/Data-Engineer-Acme-1",
        "companyDetails": {"name": "Acme"}, "expRange": {"min": 4, "max": 8},
        "roleTypes": ["full_time"], "remoteType": "no_remote", "locationsText": "Pune",
        "sanitizedComment": "<p>Pipelines</p>", "allSkills": ["Spark"],
    }
    job.update(over)
    return job


def test_cutshort_finds_the_jobs_and_dates_them_from_the_id():
    jobs = ps.parse_cutshort("data", _cutshort_page(_cutshort()))
    assert len(jobs) == 1
    assert jobs[0]["posted_date"] == "2026-10-29"
    assert (jobs[0]["experience_min"], jobs[0]["experience_max"]) == (4, 8)
    assert jobs[0]["location"] == "Pune"


def test_cutshort_skips_internships_and_labels_remote():
    assert ps.parse_cutshort("data", _cutshort_page(_cutshort(roleTypes=["internship"]))) == []
    jobs = ps.parse_cutshort("data", _cutshort_page(_cutshort(remoteType="remote_only")))
    assert jobs[0]["location"] == "Remote"


@pytest.mark.parametrize("page", ["", "<html></html>", '<script id="__NEXT_DATA__">not json</script>'])
def test_next_data_pages_without_data_give_nothing(page):
    assert ps.parse_cutshort("data", page) == []
    assert ps.parse_wellfound("data", page) == []


def _wellfound_page(*rows):
    data = {"StartupResult:1": {"name": "Acme", "highlightedJobListings": [
        {"__ref": f"JobListingSearchResult:{row['id']}"} for row in rows
    ]}}
    data.update({f"JobListingSearchResult:{row['id']}": row for row in rows})
    return _next_page({"apolloState": {"data": data}})


def _wellfound(id, **over):
    job = {
        "id": id, "title": "Data Engineer", "slug": "data-engineer", "jobType": "full-time",
        "locationNames": ["Bengaluru"], "liveStartAt": 1793085881,
        "yearsExperienceMin": 3, "yearsExperienceMax": 6, "description": "Pipelines",
    }
    job.update(over)
    return job


def test_wellfound_keeps_india_full_time_for_any_role():
    page = _wellfound_page(
        _wellfound(1),
        _wellfound(2, locationNames=["London"]),
        _wellfound(3, jobType="internship"),
        _wellfound(4, jobType="cofounder"),
    )
    jobs = ps.parse_wellfound("data", page)
    assert [j["id"] for j in jobs] == ["1"]
    job = jobs[0]
    assert job["company"] == "Acme"
    assert job["url"] == "https://wellfound.com/jobs/1-data-engineer"
    assert (job["experience_min"], job["experience_max"]) == (3, 6)


# ── A failing source costs only itself ───────────────────────────────────────

def test_a_refused_source_returns_what_it_already_has(monkeypatch):
    monkeypatch.setattr(ps, "robots_allow", lambda url: True)
    answers = iter([
        FakeResponse(200, payload={"jobs": [_workable()], "nextPageToken": "t"}),
        FakeResponse(429),
    ])
    monkeypatch.setattr(ps.requests.Session, "get", lambda self, url, timeout: next(answers))
    jobs = ps.fetch_workable("data", {}, 21)
    assert len(jobs) == 1
