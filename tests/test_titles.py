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
        # More filler: joiner and notice-period notes, "#Hiring", office and
        # sector suffixes on a place, a company prefix.
        ("UX Designer | Immediate Joiners Only", "", "UX Designer"),
        ("#Hiring | UX Designer", "", "UX Designer"),
        ("Data Engineer | Chennai (WFO)", "", "Data Engineer"),
        ("Data Engineer | Noida Sec 62", "", "Data Engineer"),
        ("UX Designer | Notice Period: 15 Days", "", "UX Designer"),
        ("UX Designer | 30 Days Notice", "", "UX Designer"),
        ("Deloitte | Data Analyst", "Deloitte USI", "Data Analyst"),
        # Salary is dropped only when the segment looks like a salary.
        ("Hiring | Business Analyst - INR Payments", "", "Business Analyst - INR Payments"),
        ("Data Analyst | CTC up to 12 L", "", "Data Analyst"),
        ("UX Designer | INR 8,00,000", "", "UX Designer"),
        ("Data Analyst | Salary: Negotiable", "", "Data Analyst"),
        # A trailing place after a comma goes; a two-letter role word stays.
        ("Senior Engineer | AI, Bangalore", "", "Senior Engineer - AI"),
        ("Business Analyst | Risk, Pune", "", "Business Analyst - Risk"),
        # Short company prefixes are not trusted: "UX" is a role word here.
        ("Designer | UX", "UX Studio", "Designer - UX"),
        # HTML is removed from the stored title, not only for the gate.
        ("<strong>Business</strong> <strong>Analyst</strong>", "", "Business Analyst"),
        ("&lt;b&gt;Business Analyst&lt;/b&gt;", "", "Business Analyst"),
        ("Business Analyst | <b>Pune</b>", "", "Business Analyst"),
        ("Data&nbsp;Engineer<br/>", "", "Data Engineer"),
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


@pytest.mark.parametrize(
    "raw",
    [
        "<strong>Business</strong> <strong>Analyst</strong>",
        "&lt;b&gt;Business Analyst&lt;/b&gt;",
        "Business Analyst | <b>Pune</b>",
    ],
)
def test_build_job_stores_titles_without_markup(raw):
    job = build_job("ba", "Naukri", raw, "Acme", "Pune", "https://x.test/3", "", None)
    assert job is not None
    assert job["title"] == "Business Analyst"


@pytest.mark.parametrize(
    "raw, company",
    [
        ("Data Engineer | NTT DATA North America", "NTT DATA North America"),
        ("Data Engineer - Bridgestone Americas", "Bridgestone Americas, Inc."),
        ("Data Engineer | Tesco Technology and Services Europe",
         "Tesco Technology and Services Europe Limited"),
    ],
)
def test_company_name_in_title_is_not_a_foreign_place(raw, company):
    job = build_job("data", "LinkedIn", raw, company, "Bengaluru", "https://x.test/4", "", None)
    assert job is not None
    # A "|" company segment is dropped from the stored title; a "-" one stays.
    assert job["title"] in ("Data Engineer", raw)
    # The same region named as the job's place still drops it.
    assert build_job("data", "LinkedIn", "Data Engineer | North America", "Acme", "Bengaluru",
                     "https://x.test/5", "", None) is None


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


def test_export_stores_titles_without_markup(tmp_path):
    db = tmp_path / "jobs.db"
    _vendor_db(db, [{"title": "<strong>Business</strong> <strong>Analyst</strong>"}])
    payload = export.export(str(db), "ba", 0, 100)
    assert [j["title"] for j in payload["jobs"]] == ["Business Analyst"]


def test_export_puts_a_new_title_in_one_track_only(tmp_path):
    db = tmp_path / "jobs.db"
    _vendor_db(db, [{"title": "Machine Learning Engineer"}])
    assert export.export(str(db), "sde", 0, 100)["count"] == 0
    assert export.export(str(db), "genai", 0, 100)["count"] == 1


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
    # An analyst grade counts only on a title that names a data engineering role.
    ("Analyst I Data Engineering", {"data"}),
    ("Sr. Analyst, Data Engineer - India", {"data"}),
    ("ETL Developer/Analyst", {"data"}),
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
    ("Design Engineer", set()),
    # ...unless a UI word says it is front-end design work.
    ("Design Engineer - UI", {"uiux"}),
    ("Web Design Engineer", {"uiux"}),
    ("Lead Product Ui / Ux Design Engineer Hyderabad (India)", {"uiux"}),
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
    ("ETL Analyst", set()),
    ("GIS ETL Analyst", set()),
    ("Data Integration, ETL - Analyst", set()),
    ("Data Warehouse Analyst", set()),
    ("Snowflake Analyst", set()),
    ("Data Entry Operator", set()),
    ("Data-Entry Executive", set()),
    ("DataEntry Operator", set()),
    ("Simple data entry work from home", set()),
]


ROLES = ("genai", "data", "uiux", "ba", "sde")


@pytest.mark.parametrize("title, expected", TRACK_TABLE)
def test_title_lands_in_exactly_the_expected_tracks(title, expected):
    assert set(title_tracks(title)) == expected
    for role in ROLES:
        assert title_relevant(role, title, resolve_overlap=True) == (role in expected), role


@pytest.mark.parametrize("title, expected", TRACK_TABLE)
def test_publish_recheck_never_drops_what_collectors_keep(title, expected):
    # publish.py calls title_relevant(role, title) on carried-over jobs. It
    # must accept at least every track the collectors would put the title in.
    for role in expected:
        assert title_relevant(role, title), role


# Jobs already published under a track that loses the overlap stay until they
# age out; the collectors just stop adding new copies there.
@pytest.mark.parametrize(
    "title, published_in",
    [
        ("AI Engineer", "sde"),
        ("Backend AI Engineer", "sde"),
        ("Machine Learning Engineer", "sde"),
        ("Data and AI Engineer", "genai"),
        ("Lead Data Engineer (GenAI / LLM Applications)", "genai"),
        ("SDE III - Data Engineering", "sde"),
        ("Senior Analytics Engineer", "sde"),
        ("UI Developer", "sde"),
        ("Full Stack Engineer - AI", "genai"),
        ("Business Analyst - Generative AI", "genai"),
    ],
)
def test_carried_over_jobs_are_not_orphaned_by_the_overlap_rule(title, published_in):
    assert published_in not in title_tracks(title)
    assert title_relevant(published_in, title)


@pytest.mark.parametrize(
    "title, role",
    [
        # Wanted removals: these fail the track's own rule, so publish.py
        # drops carried-over copies too.
        ("FPGA Design Engineer", "uiux"),
        ("Product Design Engineer", "uiux"),
        ("Data Entry Operator", "data"),
        ("Data-Entry Executive", "data"),
        ("DataEntry Operator", "data"),
        ("Data Analytics Analyst", "data"),
        ("ETL Analyst", "data"),
        ("Data Warehouse Analyst", "data"),
        ("Snowflake Analyst", "data"),
        ("RPA Developer (UI Path & Power Automate)", "uiux"),
    ],
)
def test_off_role_titles_fail_the_track_rule_itself(title, role):
    assert not title_relevant(role, title)
    assert not title_relevant(role, title, resolve_overlap=True)


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
