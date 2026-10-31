"""Posting-page experience lookup: parsers, decisions and the merge rule."""

from datetime import datetime, timedelta, timezone

import enrich_experience as ee
import publish

LINKEDIN_HTML = """
<html><body>
<section class="show-more-less-html">
  <div class="show-more-less-html__markup">
    <p>Associate - Business Process &amp; AI Transformation</p>
    <ul><li>Experience: 7+ years of relevant experience in business process management</li></ul>
  </div>
</section>
<ul class="description__job-criteria-list">
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Seniority level</h3>
    <span class="description__job-criteria-text">Mid-Senior level</span>
  </li>
  <li class="description__job-criteria-item">
    <h3 class="description__job-criteria-subheader">Employment type</h3>
    <span class="description__job-criteria-text">Full-time</span>
  </li>
</ul>
</body></html>
"""

LINKEDIN_LEVEL_ONLY = LINKEDIN_HTML.replace(
    "<li>Experience: 7+ years of relevant experience in business process management</li>", ""
)

FOUNDIT_HTML = """
<html><head><script id="__NEXT_DATA__" type="application/json">
{"props":{"pageProps":{"jobDetail":{"title":"Senior Associate IS Business Systems Analyst",
 "minimumExperience":5,"maximumExperience":9,"companyName":"Amgen"}}}}
</script></head><body><h1>Senior Associate IS Business Systems Analyst</h1>
<div class="exp"><span>5-9 Years</span></div></body></html>
"""

FOUNDIT_TEXT_ONLY = FOUNDIT_HTML.split("<body>")[0].replace(
    '"minimumExperience":5,"maximumExperience":9,', ""
) + "<body><h1>Role</h1><div><span>3-6 Years</span></div></body></html>"

GENERIC_HTML = """
<html><body><script>var x = "99-100 years";</script>
<h1>Business Analyst</h1><p>Requirements</p><p>Minimum of 2 years in requirements gathering</p>
</body></html>
"""


def test_linkedin_posting_years_and_level():
    description, level = ee.parse_linkedin_posting(LINKEDIN_HTML)
    assert "7+ years" in description
    assert level == "Mid-Senior level"


def test_linkedin_resolution_prefers_years_then_level():
    job = {"source": "LinkedIn", "title": "Associate - Business Process & AI Transformation"}
    update = ee.resolve_from_page(job, LINKEDIN_HTML)
    assert (update["experience_min"], update["experience_max"], update["experience_source"]) == (7, None, "page")
    update = ee.resolve_from_page(job, LINKEDIN_LEVEL_ONLY)
    assert update["experience_source"] == "level"
    assert update["experience_level"] == "Mid-Senior level"
    assert update["experience_min"] is None


def test_foundit_page_json_then_text():
    assert ee.parse_foundit_page(FOUNDIT_HTML) == "5-9 years"
    assert ee.parse_foundit_page(FOUNDIT_TEXT_ONLY) == "3-6 years"
    job = {"source": "Foundit", "title": "Senior Associate IS Business Systems Analyst"}
    update = ee.resolve_from_page(job, FOUNDIT_HTML)
    assert (update["experience_min"], update["experience_max"], update["experience_source"]) == (5, 9, "page")


def test_generic_page_ignores_scripts():
    job = {"source": "SimplyHired", "title": "Business Analyst"}
    update = ee.resolve_from_page(job, GENERIC_HTML)
    assert (update["experience_min"], update["experience_max"], update["experience_source"]) == (2, None, "page")


def test_nothing_stated_is_stamped_not_guessed():
    job = {"source": "SimplyHired", "title": "Senior Associate Analyst"}
    update = ee.resolve_from_page(job, "<html><body><p>Great team, apply now.</p></body></html>")
    assert "experience_source" not in update
    assert update["experience_checked"] == ee._today()


def test_linkedin_posting_url():
    assert ee.linkedin_posting_url("https://www.linkedin.com/jobs/view/4483596430/") == (
        "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4483596430"
    )
    assert ee.linkedin_posting_url("https://in.linkedin.com/jobs/view/business-analyst-at-acme-4483596430") == (
        "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4483596430"
    )
    assert ee.linkedin_posting_url("https://example.com/jobs/1") is None


def test_needs_lookup_rules():
    today = "2026-10-31"
    assert ee.needs_lookup({"source": "LinkedIn", "url": "https://x"}, today)
    assert not ee.needs_lookup({"source": "LinkedIn", "url": "https://x", "experience_source": "text"}, today)
    assert not ee.needs_lookup({"source": "LinkedIn", "url": "https://x", "experience_source": "level"}, today)
    assert not ee.needs_lookup({"source": "Naukri", "url": "https://x"}, today)
    assert not ee.needs_lookup({"source": "Indeed", "url": "https://x"}, today)
    assert not ee.needs_lookup({"source": "LinkedIn", "url": "https://x", "experience_checked": "2026-10-28"}, today)
    assert ee.needs_lookup({"source": "LinkedIn", "url": "https://x", "experience_checked": "2026-10-10"}, today)
    # A fresher title word is only a hint; the page is still worth one look.
    assert ee.needs_lookup({"source": "LinkedIn", "url": "https://x", "experience_source": "title"}, today)


def test_card_text_mirrors_web_label():
    assert ee.card_text({"experience_min": 5, "experience_max": 9}) == "5–9 yrs"
    assert ee.card_text({"experience_min": 7, "experience_max": None}) == "7+ yrs"
    assert ee.card_text({"experience_min": 0, "experience_max": 0}) == "Fresher / entry level"
    assert ee.card_text({"experience_level": "Associate"}) == "Associate"
    assert ee.card_text({}) == "Not stated in posting"


def _job(url, **extra):
    base = {"title": "Business Analyst", "company": f"Co {url}", "location": "Pune", "url": f"https://x.test/{url}",
            "source": "LinkedIn", "score": 50,
            "posted_date": (datetime.now(timezone.utc) - timedelta(days=1)).date().isoformat()}
    base.update(extra)
    return base


def test_publish_keeps_page_answer_when_fresh_copy_has_none():
    prev = {"role": "ba", "jobs": [_job("a", experience_min=7, experience_max=None, experience_source="page",
                                        experience_checked="2026-10-30")]}
    fresh = {"role": "ba", "jobs": [_job("a", experience_min=None, experience_max=None, experience_source=None)]}
    merged = publish.merge_payloads(prev, fresh, 21)["jobs"][0]
    assert (merged["experience_min"], merged["experience_source"]) == (7, "page")
    assert merged["experience_checked"] == "2026-10-30"

    # But a fresh stated value replaces an older page answer.
    fresh = {"role": "ba", "jobs": [_job("a", experience_min=3, experience_max=5, experience_source="board")]}
    merged = publish.merge_payloads(prev, fresh, 21)["jobs"][0]
    assert (merged["experience_min"], merged["experience_max"], merged["experience_source"]) == (3, 5, "board")


def test_enrich_payload_uses_lookup(monkeypatch):
    calls = []

    def fake_lookup(job, session, throttle):
        calls.append(job["url"])
        if job["url"].endswith("fail"):
            return {}
        return {"experience_min": 4, "experience_max": 6, "experience_source": "page",
                "experience_checked": "2026-10-31"}

    monkeypatch.setattr(ee, "lookup_job", fake_lookup)
    payload = {"jobs": [_job("a", score=10), _job("fail", score=90), _job("c", source="Naukri")]}
    stats = ee.enrich_payload(payload, max_fetches=5, workers=2)
    assert calls == ["https://x.test/fail", "https://x.test/a"]  # best score first, Naukri skipped
    assert stats["page"] == 1 and stats["failed"] == 1
    assert payload["jobs"][0]["experience_min"] == 4
