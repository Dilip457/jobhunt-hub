"""Indeed/SimplyHired posted dates come from the card, never the scrape date,
and publish keeps the earliest known date so undated jobs still expire."""

import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

import portal_scrapers
import publish


def day(offset: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=offset)).date().isoformat()


@pytest.mark.parametrize(
    "stamp, offset",
    [
        ("Just posted", 0),
        ("Today", 0),
        ("Posted Posted 3 days ago", 3),
        ("Posted 1 day ago", 1),
        ("Active 5 days ago", 5),
        ("Employer Active 2 days ago", 2),
        ("30+ days ago", 30),
        ("Posted 30+ days ago", 30),
        ("3d", 3),
        ("30d+", 30),
        ("5h", 0),
        ("2 hours ago", 0),
        ("1 week ago", 7),
    ],
)
def test_card_stamps_are_parsed(stamp, offset):
    assert portal_scrapers._card_posted_date(stamp) == day(offset)


@pytest.mark.parametrize("stamp", ["", "   ", "Hiring ongoing", "Urgently hiring", "Easily apply"])
def test_cards_without_an_age_have_no_date(stamp):
    assert portal_scrapers._card_posted_date(stamp) is None


INDEED_HTML = """
<div class="job_seen_beacon">
  <h3 class="jobTitle"><a data-jk="abc123"><span>Business Analyst</span></a></h3>
  <span data-testid="company-name">Acme</span>
  <div data-testid="text-location">Pune, Maharashtra</div>
  <div class="job-snippet">Gather requirements</div>
  <span data-testid="myJobsStateDate"><span>Posted</span>Posted 4 days ago</span>
</div>
<div class="job_seen_beacon">
  <h3 class="jobTitle"><a data-jk="def456"><span>Senior Business Analyst</span></a></h3>
  <span data-testid="company-name">Globex</span>
  <div data-testid="text-location">Bengaluru, Karnataka</div>
  <div class="job-snippet">Stakeholder workshops</div>
</div>
"""


def test_indeed_cards_use_their_own_date_or_none():
    jobs = {j["id"]: j for j in portal_scrapers._parse_indeed_html("ba", INDEED_HTML)}
    assert jobs["abc123"]["posted_date"] == day(4)
    assert jobs["def456"]["posted_date"] is None


SIMPLYHIRED_HTML = """
<div data-testid="searchSerpJob" data-jobkey="k1">
  <h2 data-testid="searchSerpJobTitle"><a href="/job/k1">Business Analyst</a></h2>
  <span data-testid="companyName">Acme</span>
  <span data-testid="searchSerpJobLocation">Pune</span>
  <p data-testid="searchSerpJobDateStamp">2d</p>
</div>
<div data-testid="searchSerpJob" data-jobkey="k2">
  <h2 data-testid="searchSerpJobTitle"><a href="/job/k2">Business Analyst Lead</a></h2>
  <span data-testid="companyName">Globex</span>
  <span data-testid="searchSerpJobLocation">Hyderabad</span>
</div>
"""


def test_simplyhired_cards_use_their_own_date_or_none(monkeypatch):
    class Response:
        status_code = 200
        text = SIMPLYHIRED_HTML

    class Session:
        def get(self, *args, **kwargs):
            return Response()

    fake = types.ModuleType("curl_cffi")
    fake.requests = types.SimpleNamespace(Session=Session)
    monkeypatch.setitem(sys.modules, "curl_cffi", fake)
    monkeypatch.setenv("WARP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setattr(portal_scrapers, "_queries", lambda role: ["business analyst"])
    monkeypatch.setattr(portal_scrapers, "_cities", lambda profile: ["Pune"])
    monkeypatch.setattr(portal_scrapers.time, "sleep", lambda seconds: None)

    jobs = {j["id"]: j for j in portal_scrapers.fetch_simplyhired("ba", {}, 21)}
    assert jobs["k1"]["posted_date"] == day(2)
    assert jobs["k2"]["posted_date"] is None


def job(url, **extra):
    base = {"title": "Business Analyst", "company": f"Co {url}", "location": "Pune", "url": f"https://x.test/{url}",
            "source": "Indeed", "score": 50, "posted_date": None, "first_seen": day(3), "last_seen": day(0)}
    base.update(extra)
    return base


def payload(jobs):
    return {"role": "ba", "generated_at": f"{day(0)}T00:00:00+00:00", "jobs": jobs}


def test_merge_keeps_the_earliest_posted_date():
    prev = payload([job("a", posted_date=day(6)), job("b", posted_date=day(2))])
    fresh = payload([job("a", posted_date=day(0)), job("b", posted_date=None)])
    out = {j["url"]: j for j in publish.merge_payloads(prev, fresh, 21)["jobs"]}
    assert out["https://x.test/a"]["posted_date"] == day(6)  # re-dated by the board
    assert out["https://x.test/b"]["posted_date"] == day(2)  # fresh copy had no date


def test_undated_jobs_age_out_from_first_seen():
    prev = payload([job("old", first_seen=day(25)), job("new", first_seen=day(3))])
    fresh = payload([job("old", first_seen=day(0)), job("new", first_seen=day(0))])
    urls = {j["url"] for j in publish.merge_payloads(prev, fresh, 21)["jobs"]}
    assert urls == {"https://x.test/new"}


def test_fake_posted_dates_are_capped_at_first_seen():
    # Published before this fix: scrape date stored as posted_date.
    fake = publish.finalize_job(job("a", posted_date=day(0), first_seen=day(9)))
    real = publish.finalize_job(job("b", posted_date=day(12), first_seen=day(9)))
    undated = publish.finalize_job(job("c", posted_date=None, first_seen=day(9)))
    assert fake["posted_date"] == day(9)
    assert real["posted_date"] == day(12)
    assert undated["posted_date"] is None


def test_cross_board_dedupe_still_prefers_the_dated_copy():
    indeed = job("i", company="Acme", source="Indeed", posted_date=None)
    naukri = job("n", company="Acme", source="Naukri", posted_date=day(4))
    out = publish.merge_payloads(payload([indeed]), payload([naukri]), 21)
    assert out["count"] == 1
    assert out["jobs"][0]["source"] == "Naukri"
    assert out["jobs"][0]["posted_date"] == day(4)
