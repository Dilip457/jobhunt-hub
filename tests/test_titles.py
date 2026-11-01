"""Title cleaning and the title -> track rules shared by every collector."""

import sqlite3

import pytest

import export
from api_sources import build_job, title_relevant, title_tracks
from export import clean_title


# ── clean_title: keep the role-bearing part of a "|" title ───────────────────

@pytest.mark.parametrize(
    "raw, company, expected",
    [
        # Generic hiring words before the role used to win: "Hiring" was
        # stored and then deleted by publish.py as off-role.
        ("Hiring | UX Designer", "", "UX Designer"),
        ("Urgent Opening | Data Analyst", "", "Data Analyst"),
        ("We are hiring! | Product Designer | Remote", "", "Product Designer"),
        ("Immediate Joiners | Business Analyst | Chennai, TN", "", "Business Analyst"),
        ("Walk-in Drive | Data Analyst | 0-1 Years", "", "Data Analyst"),
        ("Apply Now | Senior Software Engineer | Exp: 5+ years", "", "Senior Software Engineer"),
        ("Urgent Requirement | ETL Developer | Pune", "", "ETL Developer"),
        ("Job Opening | Machine Learning Engineer", "", "Machine Learning Engineer"),
        # A role split over two segments keeps both parts.
        ("Senior Engineer | Generative AI", "", "Senior Engineer - Generative AI"),
        ("Software Engineer || Backend", "", "Software Engineer - Backend"),
        ("Data Engineer | Python | Spark", "", "Data Engineer - Python - Spark"),
        # Locations, experience, work mode, shift and salary are dropped.
        ("Business Analyst | Pune", "", "Business Analyst"),
        ("Business Analyst | Bangalore / Hyderabad", "", "Business Analyst"),
        ("AI Engineer | Navi Mumbai", "", "AI Engineer"),
        ("Business&nbsp;Analyst | Delhi NCR", "", "Business Analyst"),
        ("UX Designer | 3-5 Yrs | Bangalore | Hybrid", "", "UX Designer"),
        ("UI/UX Designer | Full Time | WFH", "", "UI/UX Designer"),
        ("Data Analyst | Night Shift", "", "Data Analyst"),
        ("Data Scientist | 10-15 LPA", "", "Data Scientist"),
        ("ML Engineer | San Jose, CA", "", "ML Engineer"),
        # The company name is dropped wherever it sits.
        ("Acme Corp | Data Engineer", "Acme Corp Pvt Ltd", "Data Engineer"),
        ("Data Engineer | Acme Technologies", "Acme", "Data Engineer"),
        # Nothing names a role: the board's own first word is kept, so the
        # title gate rejects it instead of publishing an empty title.
        ("Hiring | Pune", "", "Hiring"),
        # A place inside a role segment is not a location segment.
        ("Pune Delivery Manager | Agile", "", "Pune Delivery Manager - Agile"),
        # Titles without "|" are unchanged apart from whitespace.
        ("Senior  Data   Engineer", "", "Senior Data Engineer"),
        ("", "", "Untitled role"),
    ],
)
def test_clean_title_keeps_the_role(raw, company, expected):
    assert clean_title(raw, company) == expected


@pytest.mark.parametrize(
    "raw, role",
    [
        ("Hiring | UX Designer", "uiux"),
        ("Urgent Opening | Data Analyst", "ba"),
        ("Senior Engineer | Generative AI", "genai"),
        ("Business Analyst | Pune", "ba"),
        ("Immediate Joiner | Data Engineer | 4-8 Yrs", "data"),
        ("Walk-in | .NET Developer | Hyderabad", "sde"),
    ],
)
def test_build_job_gates_and_stores_the_same_cleaned_title(raw, role):
    job = build_job(role, "Naukri", raw, "Acme", "Pune", "https://x.test/1", "", None)
    assert job is not None, raw
    # publish.py re-checks the stored title; it must reach the same answer.
    assert title_relevant(role, job["title"])
    assert "|" not in job["title"]


def test_build_job_still_reads_foreign_segments_of_the_raw_title():
    assert build_job("genai", "Naukri", "AI Engineer | Berlin", "Acme", "Remote",
                     "https://x.test/2", "", None) is None


def _vendor_db(path, rows):
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE jobs (job_id TEXT, title TEXT, company TEXT, location TEXT, url TEXT,
           apply_url TEXT, source TEXT, posted_date TEXT, description TEXT, match_score REAL,
           role_match REAL, skill_match REAL, experience_match REAL, tool_match REAL,
           domain_match REAL, validation_status TEXT, is_new INTEGER, first_seen TEXT,
           last_seen TEXT)"""
    )
    for i, row in enumerate(rows):
        base = {"job_id": str(i), "title": "Data Engineer", "company": "Acme", "location": "Pune",
                "url": f"https://x.test/{i}", "apply_url": None, "source": "LinkedIn",
                "posted_date": export.datetime.now(export.timezone.utc).date().isoformat(),
                "description": "", "match_score": 50, "role_match": 0, "skill_match": 0,
                "experience_match": 0, "tool_match": 0, "domain_match": 0,
                "validation_status": "VALID", "is_new": 0, "first_seen": None, "last_seen": None}
        base.update(row)
        conn.execute(f"INSERT INTO jobs ({','.join(base)}) VALUES ({','.join('?' * len(base))})",
                     list(base.values()))
    conn.commit()
    conn.close()


def test_export_gates_on_the_cleaned_title(tmp_path):
    db = tmp_path / "jobs.db"
    _vendor_db(db, [{"title": "Hiring | UX Designer"}, {"title": "Hiring | Pune"}])
    payload = export.export(str(db), "uiux", 0, 100)
    assert [j["title"] for j in payload["jobs"]] == ["UX Designer"]


# ── One track per title ───────────────────────────────────────────────────────

TRACK_TABLE = [
    # A named GenAI role is GenAI only, never also SDE.
    ("Machine Learning Engineer", {"genai"}),
    ("AI Engineer", {"genai"}),
    ("AI Developer", {"genai"}),
    ("Backend AI Engineer", {"genai"}),
    ("Applied AI Engineer, Startups", {"genai"}),
    ("Senior Delivery AI Software Engineer", {"genai"}),
    ("Software Engineer – AI Engineering", {"genai"}),
    ("Fullstack and AI Engineer", {"genai"}),
    ("Data Scientist / AI Engineer", {"genai"}),
    ("AI/ML Engineer (Data Engineering + AI Focus)", {"genai"}),
    # A GenAI domain phrase without a named role stays in SDE as well.
    ("Senior Engineer - Generative AI", {"genai", "sde"}),
    ("Full Stack Developer (RAG/LLM)", {"genai", "sde"}),
    ("Software Engineering (Generative AI) (Pune)", {"genai", "sde"}),
    # Plain "AI" is too weak to move a job either way.
    ("Software Engineer - AI", {"genai", "sde"}),
    ("Java Full Stack Developer (React + AI)", {"sde"}),
    # Data: named data roles win over GenAI and SDE.
    ("Data Engineer", {"data"}),
    ("ETL Developer", {"data"}),
    ("Databricks Engineer", {"data"}),
    ("Data and AI Engineer", {"data"}),
    ("AI and Data Engineer", {"data"}),
    ("AI & Data Solutions Engineer", {"data"}),
    ("AI Data Engineer - Senior", {"data"}),
    ("AI / Data Engineer", {"data"}),
    ("Data Engineer - AI Hub", {"data"}),
    ("SDE III - Data Engineering", {"data"}),
    ("Analyst I Data Engineering", {"data"}),
    ("Software Engineer - AI and Data Platforms", {"data", "sde"}),
    ("Staff Fullstack Engineer, Data Products (Golang / Node)", {"sde"}),
    ("Senior Software Engineer - Data & Backend", {"sde"}),
    # UI/UX: named design roles win over SDE and GenAI.
    ("UX Engineer", {"uiux"}),
    ("UI Developer", {"uiux"}),
    ("Senior Front End Developer (UI/UX)", {"uiux"}),
    ("Product Designer", {"uiux"}),
    ("Generative AI Creative - UI/UX & Visual Designer", {"uiux"}),
    ("AI Transformation Owner, Product & Design", {"uiux"}),
    ("UI React - Senior Engineer", {"uiux", "sde"}),
    # Hardware design and UiPath are not UI/UX (or software) design.
    ("FPGA Design Engineer", set()),
    ("Product Design Engineer", set()),
    ("Lead Design Engineer - Rail Bridges", set()),
    ("RPA Developer (UI Path & Power Automate)", {"sde"}),
    # SDE.
    ("Software Engineer", {"sde"}),
    (".NET Developer", {"sde"}),
    ("Senior Backend Engineer", {"sde"}),
    # BA is its own allow-list; its titles go nowhere else.
    ("Business Analyst", {"ba"}),
    ("Business Analyst - Generative AI", {"ba"}),
    ("Senior Business Analyst-Functional Payment Design with SWIFT, NACHA", {"ba"}),
    ("Data Analyst", {"ba"}),
    ("Senior Data Analysts", {"ba"}),
    ("Associate - Financial Data Analysis", {"ba"}),
    # Analyst titles are not Data (engineering) jobs.
    ("Data Analytics Analyst", set()),
    ("Analyst - Data Analytics", set()),
    ("Data Reporting Analyst", set()),
    ("SQL Analyst", set()),
    ("Data Governance Analyst", set()),
    ("Lead Analyst - BI, Reporting and Data Visualization", set()),
    ("Data Entry Operator", set()),
    ("Simple data entry work from home", set()),
]


@pytest.mark.parametrize("title, expected", TRACK_TABLE)
def test_title_lands_in_exactly_the_expected_tracks(title, expected):
    assert set(title_tracks(title)) == expected
    for role in ("genai", "data", "uiux", "ba", "sde"):
        assert title_relevant(role, title) == (role in expected), role


@pytest.mark.parametrize(
    "title",
    [
        "Business  Analyst",
        "Business-Analyst",
        "Business_Analyst",
        "Business Analyst",
        "Business&nbsp;Analyst",
        "<strong>Business</strong> <strong>Analyst</strong>",
        "Data-Analyst (SQL)",
        "Junior Business\tSystems  Analyst",
    ],
)
def test_ba_titles_tolerate_spacing_and_html(title):
    assert title_relevant("ba", title)


def test_unknown_role_is_never_relevant():
    assert not title_relevant("devops", "Software Engineer")
