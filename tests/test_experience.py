"""Experience shown on a card must come from the listing, never a title guess."""

import pytest

from api_sources import build_job
from export import extract_experience, extract_experience_with_source, states_experience
from portal_scrapers import _foundit_experience


@pytest.mark.parametrize(
    "title, description, expected",
    [
        # The two mismatches reported from the live BA board.
        ("Associate - Business Process & AI Transformation", "", (None, None)),
        ("Senior Associate IS Business Systems Analyst", "AI-enabled approaches, ChatGPT", (None, None)),
        ("Associate - Business Process & AI Transformation",
         "Experience: 7+ years of relevant experience in business process management", (7, None)),
        # Level words that used to produce numbers no longer do.
        ("Senior Data Engineer", "", (None, None)),
        ("Junior Business Analyst", "", (None, None)),
        ("Engineering Manager", "", (None, None)),
        # Words that really state the level still do.
        ("Business Analyst Intern", "", (0, 0)),
        ("MBA Fresher", "", (0, 0)),
        ("Entry Level Analyst", "", (0, 1)),
        # Stated years in every common wording.
        ("Data Engineer", "5-9 Yrs", (5, 9)),
        ("Data Engineer", "5 to 9 years", (5, 9)),
        ("Data Engineer", "minimum of 3 years", (3, None)),
        ("Data Engineer", "Experience - 4 years", (4, None)),
        ("Data Engineer", "9-5 years", (5, 9)),
    ],
)
def test_extract_experience(title, description, expected):
    assert extract_experience(title, description) == expected


def test_source_is_recorded():
    assert extract_experience_with_source("Analyst", "3-5 years")[2] == "stated"
    assert extract_experience_with_source("Analyst Intern", "")[2] == "title"
    assert extract_experience_with_source("Senior Analyst", "")[2] is None


def test_board_experience_field_wins_over_text():
    assert extract_experience("Senior Associate", "ChatGPT, Copilot", "5-9 Yrs") == (5, 9)


def test_states_experience():
    assert states_experience("Senior Associate", "needs 5-9 years")
    assert not states_experience("Senior Associate", "ChatGPT, Copilot")


def test_build_job_uses_board_experience():
    job = build_job("ba", "Naukri", "Senior Associate Business Analyst", "Amgen", "Hyderabad",
                    "https://x.test/1", "ChatGPT, Copilot", None, experience="5-9 Yrs")
    assert (job["experience_min"], job["experience_max"], job["experience_source"]) == (5, 9, "stated")
    job = build_job("ba", "Foundit", "Senior Associate Business Analyst", "Amgen", "Hyderabad",
                    "https://x.test/2", "ChatGPT, Copilot", None)
    assert (job["experience_min"], job["experience_max"], job["experience_source"]) == (None, None, None)


@pytest.mark.parametrize(
    "row, expected",
    [
        ({"minimumExperience": 5, "maximumExperience": 9}, "5-9 years"),
        ({"minExp": 3}, "3+ years"),
        ({"experience": {"min": 2, "max": 4}}, "2-4 years"),
        ({"experienceText": "5-9 Years"}, "5-9 Years"),
        ({"title": "x", "isExperienced": True}, ""),
    ],
)
def test_foundit_experience_field(row, expected):
    assert _foundit_experience(row) == expected
