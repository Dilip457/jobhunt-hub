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
    assert extract_experience("Senior Data Engineer", "") == (5, None)
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
