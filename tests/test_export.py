import pytest

from export import dedupe_jobs, extract_experience, job_fingerprint, normalize_location


@pytest.mark.parametrize(
    "raw, city",
    [
        ("Kukatpally, Hyderabad", "Hyderabad"),  # contains "uk"
        ("Perungudi, Chennai", "Chennai"),  # contains "peru"
        ("Sriperumbudur, Tamil Nadu", "India"),  # contains "peru"
        ("Sukhrali, Gurgaon", "Gurgaon"),  # contains "uk"
        ("Bengaluru, Karnataka, India", "Bangalore"),
        ("Navi Mumbai", "Mumbai"),
        ("Mumbai (Hybrid)", "Mumbai"),
        ("Remote, India", "Remote"),
        ("Work from home", "Remote"),
        ("", "India"),
        ("Bangalore / Singapore", "Bangalore"),
    ],
)
def test_india_locations_are_kept(raw, city):
    assert normalize_location(raw) == (city, True)


@pytest.mark.parametrize(
    "raw",
    ["Toronto", "London, UK", "Remote (US)", "Remote - USA", "San Francisco, CA", "Lima, Peru", "Berlin, Germany"],
)
def test_foreign_locations_are_dropped(raw):
    assert normalize_location(raw)[1] is False


def test_experience_range_and_title_fallback():
    assert extract_experience("Data Engineer", "Needs 3-5 years of experience") == (3, 5)
    # "Senior" alone states no years; see tests/test_experience.py.
    assert extract_experience("Senior Data Engineer", "") == (None, None)
    assert extract_experience("Graduate Trainee", "") == (0, 0)


def test_fingerprint_ignores_case_punctuation_and_company_suffix():
    a = {"title": "Data Engineer", "company": "Acme Technologies Pvt. Ltd.", "location": "Pune"}
    b = {"title": "data engineer ", "company": "ACME", "location": "Pune"}
    assert job_fingerprint(a) == job_fingerprint(b) != ""


def test_unknown_company_never_collapses():
    a = {"title": "Data Engineer", "company": "Unknown", "location": "Pune"}
    assert job_fingerprint(a) == ""
    assert len(dedupe_jobs([dict(a), dict(a)])) == 2


def test_dedupe_keeps_best_copy_and_seen_range():
    jobs = [
        {"title": "UX Designer", "company": "Zeta", "location": "Bangalore", "score": 50,
         "source": "Shine", "first_seen": "2026-10-20", "last_seen": "2026-10-25"},
        {"title": "UX Designer", "company": "Zeta", "location": "Bangalore", "score": 70,
         "source": "LinkedIn", "first_seen": "2026-10-22", "last_seen": "2026-10-30"},
        {"title": "UX Designer", "company": "Zeta", "location": "Pune", "score": 40, "source": "Naukri"},
    ]
    out = dedupe_jobs(jobs)
    assert len(out) == 2  # different city = different opening
    best = out[0]
    assert best["source"] == "LinkedIn"
    assert best["first_seen"] == "2026-10-20"
    assert best["last_seen"] == "2026-10-30"


@pytest.mark.parametrize(
    "raw",
    [
        "San Jose, CA", "Mountain View, CA", "Bellevue, WA", "Sofia, Bulgaria", "Bucharest",
        "Ho Chi Minh City", "Tallinn, Estonia", "Indianapolis, IN", "Santa Clara, California",
        "Remote (Americas)", "Remote - North America", "Remote, Europe", "EMEA", "LATAM",
        "APAC (excluding India)", "Remote - EU", "Nashville, TN", "Austin, TX 78701",
    ],
)
def test_more_foreign_locations_are_dropped(raw):
    # Before, anything unrecognised fell back to ("India", True).
    assert normalize_location(raw)[1] is False
    assert normalize_location(raw, strict=True)[1] is False


@pytest.mark.parametrize(
    "raw, city",
    [
        ("Chennai, TN", "Chennai"),  # TN is Tamil Nadu here, not Tennessee
        ("Pune, MH", "Pune"),
        ("Bangalore, IN", "Bangalore"),
        ("Gangaikondan, TN", "India"),  # Indian state code, unknown town
        ("Sanand, GJ", "India"),
        ("Hosur, Tamil Nadu", "India"),
        ("Thane", "India"),
        ("Remote, India", "Remote"),
        ("Remote - US or India", "Remote"),
        ("Worldwide", "Remote"),
        ("Anywhere in the World", "Remote"),
    ],
)
def test_strict_mode_keeps_positive_india_matches(raw, city):
    assert normalize_location(raw, strict=True) == (city, True)


@pytest.mark.parametrize("raw", ["", "Kakkanad", "Springfield", "Debar", "Unknown"])
def test_strict_mode_drops_unknown_places_but_lenient_mode_keeps_them(raw):
    assert normalize_location(raw, strict=True)[1] is False
    assert normalize_location(raw) == ("India", True)


def test_career_page_rows_need_a_positive_india_match():
    from export import export_location

    deloitte = "https://apply.deloitte.com/en_US/careers/JobDetail/AI-Engineer-II/371700"
    assert export_location("", "Company Career Pages", "AI Engineer II", deloitte)[1] is False
    # No location, but the glued title names Bengaluru.
    sarvam = export_location("", "Company Career Pages",
                             "ML Engineer (Training Infra), Foundational ModelsBengaluruFull Time",
                             "https://www.sarvam.ai/careers/jobs/e9fb")
    assert sarvam == ("Bangalore", True)
    # A foreign place in the title drops it even when the URL says Bengaluru.
    ey = export_location("", "Company Career Pages",
                         "Senior-BC sector-Health-Healthcare Data Architecture-DHEC-Germany-EU",
                         "https://careers.ey.com/ey/job/Bengaluru-Senior-BC-sector-Health")
    assert ey[1] is False
    assert export_location("Katowice", "Company Career Pages", "Data Engineer", "")[1] is False
    # LinkedIn keeps the lenient rule.
    assert export_location("", "LinkedIn", "Data Engineer", "") == ("India", True)


def test_ats_and_remote_board_jobs_use_the_strict_rule():
    from api_sources import build_job

    def make(location, source="Company Career Pages", strict=True):
        return build_job("sde", source, "Software Engineer", "Acme", location,
                         "https://x.test/1", "", None, strict_location=strict)

    assert make("Santa Clara, California") is None
    assert make("Linz") is None
    assert make("Bengaluru, Karnataka")["location"] == "Bangalore"
    assert make("Remote")["location"] == "Remote"
    # Indian boards keep unknown localities.
    assert make("Kakkanad", source="Naukri", strict=False)["location"] == "India"


def test_sources_count_only_exported_rows(tmp_path):
    import sqlite3
    from datetime import datetime, timedelta, timezone

    import export

    today = datetime.now(timezone.utc).date()
    db = tmp_path / "jobs.db"
    conn = sqlite3.connect(db)
    conn.execute(
        """CREATE TABLE jobs (job_id TEXT, title TEXT, company TEXT, location TEXT, url TEXT,
           apply_url TEXT, source TEXT, posted_date TEXT, description TEXT, match_score REAL,
           role_match REAL, skill_match REAL, experience_match REAL, tool_match REAL,
           domain_match REAL, validation_status TEXT, is_new INTEGER, first_seen TEXT,
           last_seen TEXT)"""
    )
    rows = [
        ("1", "LinkedIn", today.isoformat()),
        ("2", "LinkedIn", (today - timedelta(days=60)).isoformat()),  # aged out
        ("3", "Indeed", (today - timedelta(days=90)).isoformat()),  # aged out
    ]
    for job_id, source, posted in rows:
        conn.execute(
            "INSERT INTO jobs VALUES (?, 'Data Engineer', 'Acme', 'Pune', ?, NULL, ?, ?, '', 50,"
            " 0, 0, 0, 0, 0, 'VALID', 0, NULL, NULL)",
            (job_id, f"https://x.test/{job_id}", source, posted),
        )
    conn.commit()
    conn.close()

    payload = export.export(str(db), "data", 0, 100, max_days=21)
    assert payload["count"] == 1
    assert payload["sources"] == {"LinkedIn": 1}
    assert sum(payload["sources"].values()) == payload["count"]
