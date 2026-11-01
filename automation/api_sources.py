#!/usr/bin/env python3
"""
api_sources.py — Cloud-safe job sources (no browser, no residential IP).

The Indian portals (Naukri, Indeed, Foundit, …) block datacenter IPs, so the
scraper-based pipeline only ever sees LinkedIn and company pages from GitHub
Actions. These sources talk to *official / public* job APIs instead, which work
from any IP and need no machine of your own:

    Remotive          remote roles
    Himalayas         remote roles
    Remote OK         remote roles
    We Work Remotely  remote roles (RSS)
    Company ATS       Greenhouse, Lever, Ashby, SmartRecruiters boards

None of them needs a key or an account.

Usage (usually called by run_source.py):
    python automation/api_sources.py --role uiux --out artifacts/uiux.apis.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional

from export import (
    canonical_url,
    clean_company,
    clean_title,
    dedupe_jobs,
    extract_experience,
    extract_experience_with_source,
    looks_foreign,
    make_snippet,
    normalize_location,
    normalize_title,
    strip_company,
    valid_url,
)

USER_AGENT = "Mozilla/5.0 (compatible; jobhunt-hub/1.0; +https://github.com/Dilip457/jobhunt-hub)"

# A remote posting can be region-restricted in the title alone: "Senior AI
# Engineer - EU". The location field says just "Remote", so reject the title
# suffix instead of surfacing a role we cannot take.
TITLE_FOREIGN_REGION = re.compile(
    r"[-–—(\[]\s*(us|usa|u\.s\.|united states|uk|united kingdom|eu|europe|emea|"
    r"apac|canada|australia|latam|brazil|mexico|singapore|uae|dubai|germany|"
    r"france|netherlands|ireland|poland|spain|italy|japan|china)\s*[)\]]?\s*$",
    re.I,
)

# Internships are not full-time openings. Matched as whole words so "internal
# tools engineer" survives, but "Intern", "Interns" and "Internships" do not.
ENTRY_LEVEL_TITLE = re.compile(
    r"\b(intern|interns|internship|internships|trainee|trainees|working student)\b",
    re.I,
)
TIMEOUT = 25

# Query terms sent to the APIs.
ROLE_SEARCH_TERMS = {
    "genai": ["machine learning engineer", "generative ai engineer", "llm engineer", "ai engineer"],
    "data": ["data engineer", "big data engineer", "etl developer", "cloud data engineer"],
    "uiux": ["ux designer", "ui designer", "product designer", "interaction designer"],
    # The BA track is Business Analyst plus Data Analyst only (see BA_TITLE).
    "ba": ["business analyst", "data analyst", "business analyst fresher",
           "business systems analyst", "junior data analyst"],
    "sde": ["software engineer", "software development engineer", "backend engineer",
            "full stack developer", ".net developer"],
}

# A job only counts if one of these appears in its title (keeps feeds on-topic).
ROLE_TITLE_TOKENS = {
    "genai": ["ai", "ml", "machine learning", "generative", "genai", "llm", "nlp",
              "deep learning", "artificial intelligence", "data scientist", "prompt"],
    "data": ["data engineer", "data", "etl", "elt", "big data", "analytics engineer",
             "spark", "pyspark", "data warehouse", "databricks", "snowflake", "sql"],
    "uiux": ["ux", "ui", "designer", "design", "interaction", "visual", "figma",
             "user experience", "product design"],
    # Score tokens only: BA relevance is decided by BA_TITLE, not by these.
    "ba": ["business analyst", "business analysis", "business systems analyst",
           "data analyst", "data analysis", "analyst"],
    # SDE titles. `developer` and `engineer` are broad tokens, so
    # ROLE_TITLE_EXCLUDE below removes the families that are clearly not
    # software engineering.
    "sde": ["software engineer", "software developer", "software development engineer",
            "sde", "backend", "back end", "full stack", "fullstack", ".net",
            "dotnet", "asp.net", "api developer", "application developer",
            "platform engineer", "developer", "engineer", "programmer"],
}

# Titles that contain a role token but are clearly a different job family.
ROLE_TITLE_EXCLUDE = {
    "genai": ["sales", "account executive", "recruiter", "marketing",
              "support specialist", "ai trainer", "annotation", "data quality",
              "governance", "intern", "internship", "working student", "trainee",
              "pflichtpraktikum", "praktikum", "werkstudent", "data scientist",
              "security", "admin", "coding tasks", "product manager",
              "program manager", "product owner", "product designer",
              "designer", "design strategist", "analyst"],
    "data": ["warehouse associate", "delivery", "driver", "mechanic", "trainee",
             "data center", "data analyst", "data scientist", "data quality",
             "ai trainer", "annotation", "working student", "master data",
             "intern", "internship", "manager", "director", "head of",
             # Test/QA titles that mention ETL only as the thing under test.
             "test", "testing", "tester", "qa", "quality assurance", "etl testing",
             # Platform operations rather than pipeline engineering.
             "administrator", "dba", "database administrator",
             "support engineer", "support lead", "support", "iam support"],
    "uiux": ["mechanical", "hardware", "electrical", "civil", "data center",
             "instructional", "graphic designer", "graphic design", "illustrator",
             "motion graphics", "motion designer", "motion design",
             "brand designer", "brand design", "intern", "internship",
             "working student", "trainee", "premaster", "support engineer",
             "mold", "tool design", "communication design",
             "kommunikationsdesign", "advertising", "marketing manager",
             "sales manager", "program manager", "project manager",
             "product manager", "art director", "analog design",
             "semiconductor", "micro-architect", "soc design", "vlsi",
             "rtl design", "physical design", "cubicle", "locomotive",
             "cab cars", "chip design",
             # UiPath is an RPA product, not UI work; BI reporting is not
             # visual design.
             "ui path", "uipath", "data visualization", "data visualisation"],
    # BA uses an allow-list (BA_TITLE below), so it needs no exclusions.
    "ba": [],
    # `developer`/`engineer` are broad tokens, so drop the non-software families.
    "sde": ["sales", "account executive", "recruiter", "marketing",
            "business development", "support specialist", "mechanical",
            "civil", "electrical", "hardware", "data entry", "intern",
            "trainee", "qa", "manual testing", "test engineer", "in test",
            "sdet", "quality assurance", "power bi", "powerbi",
            "data engineer", "data scientist", "data analyst", "embedded",
            "career fair", "manager", "director", "product analyst",
            "business analyst", "test", "testing", "support engineer",
            "database", "reporting", "admin", "network engineer",
            "devops engineer",
            "site reliability", "solutions engineer", "salesforce",
            "servicenow", "sap ", "warehouse", "driver", "technician",
            # Hardware design ("FPGA Design Engineer", "PCB Design Engineer").
            # Not plain "fpga": "FPGA IP Software Development Engineer" is software.
            "asic", "pcb", "vlsi", "rtl", "analog", "design engineer",
            "design engineering", "signal integrity", "board design"],
}

ROLE_SKILLS = {
    "genai": ["llm", "rag", "langchain", "pytorch", "tensorflow", "transformers", "nlp",
              "generative", "prompt", "vector", "embedding", "fine-tun", "hugging face",
              "openai", "diffusion", "mlops", "deep learning"],
    "data": ["spark", "pyspark", "airflow", "dbt", "kafka", "snowflake", "databricks",
             "etl", "elt", "warehouse", "sql", "python", "aws", "glue", "redshift",
             "bigquery", "data pipeline", "hadoop", "scala", "azure"],
    "uiux": ["figma", "sketch", "adobe xd", "prototyp", "wireframe", "user research",
             "usability", "design system", "interaction design", "ux", "ui",
             "responsive", "accessibility", "html", "css", "framer", "invision"],
    # Fresher + 1–3 year BA skills and tools, as requested.
    "ba": ["requirement gathering", "requirement elicitation", "requirement management",
           "brd", "frd", "business requirement", "functional requirement", "user story",
           "user stories", "acceptance criteria", "gap analysis", "process mapping",
           "process improvement", "stakeholder", "uat", "user acceptance testing",
           "wireframe", "data visualization", "data visualisation", "sql", "agile",
           "scrum", "sprint", "jira", "confluence", "visio", "excel", "power bi",
           "tableau", "balsamiq", "figma", "postman", "api testing", "api"],
    "sde": ["c#", ".net", "dotnet", "asp.net", "rest api", "api", "python",
            "react", "javascript", "typescript", "java", "azure", "sql",
            "microservice", "docker", "kubernetes", "ci/cd", "github actions",
            "git", "flask", "entity framework", "mongodb", "redis",
            "unit test", "system design", "data structure", "algorithm"],
}

# The entries of ROLE_SKILLS that name a product, language, framework or
# platform rather than a practice. The score counts both lists as one
# allowance; score_parts() reports them apart, so the dashboard's match signal
# has a "Skills" and a "Tools" axis for every role. Every entry here must also
# be in ROLE_SKILLS (tests/test_scoring.py checks).
ROLE_TOOLS = {
    "genai": ["langchain", "pytorch", "tensorflow", "transformers", "hugging face", "openai"],
    "data": ["spark", "pyspark", "airflow", "dbt", "kafka", "snowflake", "databricks",
             "sql", "python", "aws", "glue", "redshift", "bigquery", "hadoop", "scala", "azure"],
    "uiux": ["figma", "sketch", "adobe xd", "html", "css", "framer", "invision"],
    "ba": ["sql", "jira", "confluence", "visio", "excel", "power bi", "tableau", "balsamiq",
           "figma", "postman"],
    "sde": ["c#", ".net", "dotnet", "asp.net", "python", "react", "javascript", "typescript",
            "java", "azure", "sql", "docker", "kubernetes", "github actions", "git", "flask",
            "entity framework", "mongodb", "redis"],
}

# The BA track keeps only Business Analyst and Data Analyst titles. Any other
# analyst family (product, functional, systems, process, QA, financial, ...) is
# left out, even when the work overlaps. Domain words do not matter:
# "Business Analyst - Finance" and "Data Analyst, Risk" both stay.
# Letter lookarounds instead of \b, so ATS titles such as "Business Analyst_3471"
# or "PG_Business Analyst" still match. Words may be split by any run of
# spaces, hyphens or underscores ("Business-Analyst", "Business  Analyst").
_W = r"[\s_-]+"
BA_TITLE = re.compile(
    rf"(?<![a-z])(business{_W}analysts?|business{_W}analysis|business{_W}systems?{_W}analysts?|"
    rf"data{_W}analysts?|data{_W}analysis)(?![a-z])",
    re.I,
)

# A hybrid title such as "Data Scientist / AI Engineer" is still a GenAI
# engineering role. An explicit AI-engineering phrase wins over the
# data-scientist exclusion; a pure "Data Scientist" title does not.
GENAI_CORE_TITLE = re.compile(
    r"\b(ai engineer|ai developer|ai scientist|applied ai|ml engineer|"
    r"machine learning engineer|generative ai|genai|llm engineer|"
    r"ai/ml|ml/ai)\b",
    re.I,
)

# People-management and non-engineering families win over the hybrid rule:
# "Manager, Machine Learning Engineer" is a manager job, not an IC role.
GENAI_HARD_TITLE = re.compile(
    r"\b(manager|director|head of|vp|vice president|recruiter|sales|marketing|"
    r"support specialist|ai trainer|annotation)\b",
    re.I,
)

# Business Analyst is an entry-level-first track: fresher/entry/1–3 year roles
# get a score boost and senior/lead titles are pushed down.
BA_ENTRY_TITLE = re.compile(
    r"\b(fresher|entry[\s-]?level|graduate|intern|internship|trainee|junior|jr\.?|"
    r"associate|0\s*[-–]\s*1|1\s*[-–]\s*3|1\s*[-–]\s*2)\b",
    re.I,
)
BA_SENIOR_TITLE = re.compile(
    r"\b(senior|sr\.?|lead|principal|staff|manager|director|head|vp|"
    r"vice president|architect|7\+?\s*years?|8\+?\s*years?)\b",
    re.I,
)

REMOTE_WORDS = {"worldwide", "anywhere", "global", "remote", "work from home", "wfh"}


# ── HTTP helpers (stdlib only) ────────────────────────────────────────────────

def _request(url: str, data: Optional[bytes] = None, headers: Optional[Dict[str, str]] = None):
    merged = {"User-Agent": USER_AGENT, "Accept": "application/json"}
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, data=data, headers=merged, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def get_json(url: str, params: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    return _request(url, headers=headers)


def get_text(url: str, headers: Optional[Dict[str, str]] = None) -> str:
    merged = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
        ),
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
    }
    if headers:
        merged.update(headers)
    req = urllib.request.Request(url, headers=merged)
    with urllib.request.urlopen(req, timeout=TIMEOUT) as response:
        return response.read().decode("utf-8", "replace")


# ── Normalisation ─────────────────────────────────────────────────────────────

def to_date(value: Any) -> Optional[str]:
    if value in (None, "", 0):
        return None
    if isinstance(value, (int, float)):
        try:
            seconds = value / 1000 if value > 1e11 else value
            return datetime.fromtimestamp(seconds, tz=timezone.utc).date().isoformat()
        except Exception:
            return None
    text = str(value).strip()
    match = re.match(r"^(\d{4}-\d{2}-\d{2})", text)
    if match:
        return match.group(1)
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).date().isoformat()
    except Exception:
        return None


def norm_location(raw: str, strict: bool = False) -> tuple[str, bool]:
    # normalize_location already understands remote wording and rejects
    # country-restricted remote roles such as "Remote - US". `strict` drops
    # places it cannot identify as Indian (see build_job).
    return normalize_location(raw, strict=strict)


def search_terms(role: str) -> List[str]:
    return ROLE_SEARCH_TERMS.get(role, ["jobs"])


def _hit(token: str, text: str) -> bool:
    if len(token) <= 3:
        # Lookarounds instead of \b so tokens ending in a symbol ("c#") match.
        return re.search(rf"(?<![a-z0-9]){re.escape(token)}(?![a-z0-9])", text) is not None
    return token in text


def _hit_word(token: str, text: str) -> bool:
    """Whole-word match for exclusion tokens.

    A substring check would let "intern" drop "internal tools engineer" and
    "sales" drop "salesforce"; exclusions need word boundaries.
    """
    return re.search(rf"(?<![a-z]){re.escape(token)}(?![a-z])", text) is not None


# ── One track per title ───────────────────────────────────────────────────────
#
# The token lists above are broad on purpose ("engineer" for SDE, "data" for
# Data, "ai" for GenAI), so on their own they accept "Machine Learning
# Engineer" as both GenAI and SDE, or "UI Developer" as both UI/UX and SDE.
# When several tracks accept a title, the phrases below decide:
#
#   1. A title that names a specialised role outright goes to that track only,
#      never also to the broad SDE track: "ML Engineer", "Backend AI Engineer"
#      (GenAI), "Data Engineer", "ETL Developer" (Data), "UX Engineer", "UI
#      Developer", "Designer" (UI/UX).
#   2. A strong domain phrase without a named role ("Generative AI", "LLM",
#      "AI/ML"; "Data & AI"; "Product & Design") picks one specialised track,
#      but SDE keeps the title too: "Senior Engineer - Generative AI" and
#      "Full Stack Developer (RAG/LLM)" are both GenAI and SDE jobs.
#   3. Two phrases of the same strength: the one that comes first wins, as
#      boards lead with the role ("Data Engineer - AI Hub" is Data,
#      "AI/ML Engineer (Data Engineering focus)" is GenAI).
#   4. No phrase at all ("Software Engineer - AI", "Engineer, Data"): the title
#      stays in every track that accepts it. Plain "AI" or "data" is too weak
#      to take a job away from either side.
#
# GenAI and Data also leave web-stack roles to SDE unless they are named:
# "Senior Software Engineer - Data & Backend" and "Full Stack developer (AI &
# SaaS)" are SDE jobs. A Business/Data Analyst title (BA_TITLE) is a BA job
# only, whatever its domain ("Business Analyst - Generative AI").
#
# These rules decide where a newly scraped job goes (build_job and export call
# title_relevant(..., resolve_overlap=True)). publish.py re-checks the jobs it
# carries over from earlier runs with each track's own, wider rule
# (_track_accepts), so a job already published under the "losing" track is not
# deleted before the winning track has scraped it; it ages out instead.

_AI_QUALIFIER = (
    r"(?:ai|a\.i\.|ml|aiml|ai\s*[/&+-]\s*ml|ml\s*[/&+-]\s*ai|ai\s+and\s+ml|"
    r"artificial\s+intelligence|gen\s*ai|generative\s+ai|applied\s+ai|agentic\s+ai|"
    r"conversational\s+ai|voice\s+ai|machine\s+learning|deep\s+learning|llms?|nlp|"
    r"computer\s+vision|mlops|rag|prompt|ai\s+agents?)"
)
_ROLE_NOUN = (
    r"(?:engineers?|engineering|developers?|scientists?|researchers?|"
    r"architects?|programmers?|specialists?|lead)"
)
# "AI Engineer", "Backend AI Engineer", "AI Software Engineer", "AI/ML Engineer",
# "LLM Platform Engineer", "Prompt Engineer".
GENAI_ROLE_TITLE = re.compile(
    rf"(?<![a-z]){_AI_QUALIFIER}\s+(?:(?:software|application|applications|solutions?|"
    rf"platforms?|systems?|product|full[\s-]?stack|backend|infrastructure|infra|"
    rf"integration|research|senior|sr\.?|lead|principal|staff|junior|jr\.?)\s+)?"
    rf"{_ROLE_NOUN}(?![a-z])"
)
# Plain "AI" is too weak a signal ("Java Full Stack Developer (React + AI)").
GENAI_DOMAIN_TITLE = re.compile(
    r"(?<![a-z])(?:generative\s+ai|gen\s*ai|llms?|machine\s+learning|deep\s+learning|"
    r"nlp|computer\s+vision|mlops|agentic\s+ai|ai\s*/\s*ml|ml\s*/\s*ai|ai\s*&\s*ml|aiml)(?![a-z])"
)
# "Data Engineer", "Data and AI Engineer", "Data Platform Engineer", "ETL
# Developer", "Databricks Engineer", "Spark Developer", "PL/SQL Developer".
DATA_ROLE_TITLE = re.compile(
    r"(?<![a-z])(?:data\s+(?!science)(?:[a-z&/+]+\s+){0,2}?(?:engineers?|engineering|developers?)|"
    r"data\s*(?:&|and|/|\+)\s*(?:ai|ml|analytics)\s+(?:\w+\s+)?(?:engineers?|engineering)|"
    r"big\s*data|etl|elt|databricks?|data\s?bricks?|snowflake|pyspark|spark|hadoop|"
    r"informatica|datastage|talend|ab\s+initio|ssis|data\s+warehous\w*|data\s+integrator|"
    r"analytics\s+engineer\w*|(?:pl\s*/\s*sql|sql)\s+(?:lead\s+)?developers?)(?![a-z])"
)
# "Data & AI" / "AI and Data" is a practice name, not a GenAI role.
DATA_DOMAIN_TITLE = re.compile(
    r"(?<![a-z])(?:data\s*(?:&|and)\s*ai|ai\s*(?:&|and)\s*data)(?![a-z])"
)
# "UX Engineer", "UI Developer", "UI/UX", "Product Designer", "Figma Developer".
UIUX_ROLE_TITLE = re.compile(
    r"(?<![a-z])(?:designers?|ux|ui\s*/\s*ux|ux\s*/\s*ui|ui\s+ux|user\s+experience|"
    r"ui\s+(?:developers?|engineers?)|figma|webflow|interaction\s+design|"
    r"visual\s+design|product\s+design(?!\s+engineer)|design\s+systems?)(?![a-z])"
)
UIUX_DOMAIN_TITLE = re.compile(
    r"(?<![a-z])(?:product\s*(?:&|and)\s*design|experience\s+design|design\s+lead(?:er)?)(?![a-z])"
)

# Web-stack roles that GenAI and Data leave to SDE unless they name themselves.
SDE_WEB_ROLE_TITLE = re.compile(r"(?<![a-z])(?:full[\s-]?stack|front[\s-]?end|back[\s-]?end)(?![a-z])")

# Per track: (named role, strong domain phrase).
SPECIALISED_TITLE = {
    "genai": (GENAI_ROLE_TITLE, GENAI_DOMAIN_TITLE),
    "data": (DATA_ROLE_TITLE, DATA_DOMAIN_TITLE),
    "uiux": (UIUX_ROLE_TITLE, UIUX_DOMAIN_TITLE),
}
OVERLAP_TRACKS = ("genai", "data", "uiux", "sde")

# The Data track is engineering. "Data Analytics Analyst", "SQL Analyst",
# "ETL Analyst" or "Senior Data Analysts" contain its broad tokens but are
# analyst jobs (BA keeps the Data Analyst ones). Only an analyst grade on a
# title that names a data engineering role ("Analyst I Data Engineering",
# "Sr. Analyst, Data Engineer") still counts.
DATA_ANALYST_TITLE = re.compile(r"(?<![a-z])analysts?(?![a-z])")
ENGINEERING_NOUN = re.compile(r"(?<![a-z])(?:engineers?|engineering|developers?)(?![a-z])")
# "Data Entry Operator", "Data-Entry Executive", "DataEntry".
DATA_ENTRY_TITLE = re.compile(r"(?<![a-z])data[\s_-]*entry(?![a-z])")

# Hardware design titles ("FPGA Design Engineer", "Product Design Engineer")
# carry UI/UX's "design" token; they stay out unless a UI/UX role or a UI
# word is named ("Design Engineer - UI", "Web Design Engineer").
HARDWARE_DESIGN_TITLE = re.compile(
    r"(?<![a-z])(?:design\s+engineer\w*|fpga|asic|pcb|vlsi|rtl|analog|"
    r"signal\s+integrity|board\s+design)(?![a-z])"
)
UI_WORD_TITLE = re.compile(r"(?<![a-z])(?:ui|front[\s-]?end|web|interface)(?![a-z])")


def _claim(role: str, low: str):
    """(strength, -position) of the strongest phrase naming this track, or None.
    Strength 2 is a named role, 1 a domain phrase."""
    best = None
    for strength, pattern in zip((2, 1), SPECIALISED_TITLE.get(role, ())):
        match = pattern.search(low)
        if match:
            key = (strength, -match.start())
            best = key if best is None or key > best else best
    return best


def _track_accepts(role: str, low: str) -> bool:
    """The track's own rule, before overlaps with other tracks are resolved."""
    if role == "ba":
        return BA_TITLE.search(low) is not None
    # Internships are not full-time openings for the engineering/design tracks.
    if ENTRY_LEVEL_TITLE.search(low):
        return False
    if role == "genai" and GENAI_HARD_TITLE.search(low):
        return False
    if role == "genai" and GENAI_CORE_TITLE.search(low):
        return True
    if role == "sde" and re.fullmatch(r"\s*data engineering\s*", low):
        return False
    if role == "data" and DATA_ANALYST_TITLE.search(low) and not (
            DATA_ROLE_TITLE.search(low) and ENGINEERING_NOUN.search(low)):
        return False
    if role == "data" and DATA_ENTRY_TITLE.search(low):
        return False
    if role == "uiux" and HARDWARE_DESIGN_TITLE.search(low) and not (
            UIUX_ROLE_TITLE.search(low) or UI_WORD_TITLE.search(low)):
        return False
    if any(_hit_word(token, low) for token in ROLE_TITLE_EXCLUDE.get(role, [])):
        return False
    return any(_hit(token, low) for token in ROLE_TITLE_TOKENS.get(role, []))


@lru_cache(maxsize=16384)
def _title_tracks(low: str) -> frozenset:
    # Business/Data Analyst titles are BA jobs, whatever their domain
    # ("Business Analyst - Generative AI", "Associate - Financial Data Analysis").
    if BA_TITLE.search(low):
        return frozenset({"ba"})
    accepted = [role for role in OVERLAP_TRACKS if _track_accepts(role, low)]
    if "sde" in accepted:
        accepted = [
            role for role in accepted
            if role not in ("genai", "data") or not SDE_WEB_ROLE_TITLE.search(low)
            or _claim(role, low)
        ]
    if len(accepted) > 1:
        claims = {role: _claim(role, low) for role in accepted if role != "sde"}
        claims = {role: claim for role, claim in claims.items() if claim}
        if claims:
            winner = max(claims, key=claims.get)
            named_role = claims[winner][0] == 2
            accepted = [winner] if named_role or "sde" not in accepted else [winner, "sde"]
    return frozenset(accepted)


def title_tracks(title: str) -> frozenset:
    """The tracks a newly scraped title goes to: BA alone for a BA_TITLE,
    otherwise usually at most one of GenAI, Data, UI/UX and SDE (see the rules
    above)."""
    return _title_tracks(normalize_title(title).lower())


def title_relevant(role: str, title: str, resolve_overlap: bool = False) -> bool:
    """True when title belongs to the role's track.

    Collectors pass ``resolve_overlap=True``: the title must also win the
    one-track-per-title rules (title_tracks). Without it only the track's own
    rule applies; publish.py re-checks jobs carried over from earlier runs
    that way, so it never deletes a job the collectors would keep.
    """
    low = normalize_title(title).lower()
    if resolve_overlap:
        return role in _title_tracks(low)
    return _track_accepts(role, low)


# SDE targets 3-8 years; titles are the fallback when no range is stated.
SDE_BAND = (3, 8)
SDE_OVER_TITLE = re.compile(
    r"\b(principal|staff|architect|director|vp|vice president|head of|distinguished)\b",
    re.I,
)
SDE_UNDER_TITLE = re.compile(
    r"\b(fresher|entry[\s-]?level|graduate|intern|trainee|junior)\b", re.I
)


def sde_band_adjust(title: str, snippet: str) -> float:
    """Bias SDE listings toward the 3-8 year band the profile targets."""
    band_lo, band_hi = SDE_BAND
    # Title overrides first. A "Principal" title extracts (8, None) from the
    # title fallback, which would otherwise look perfectly in-band and get the
    # boost meant for 3-8 year engineers.
    if SDE_OVER_TITLE.search(title or ""):
        return -7.0
    if SDE_UNDER_TITLE.search(title or ""):
        return -9.0
    exp_min, exp_max = extract_experience(title, snippet)
    if exp_min is not None or exp_max is not None:
        start = exp_min if exp_min is not None else exp_max
        end = exp_max if exp_max is not None else exp_min
        low, high = min(start, end), max(start, end)
        overlap = min(high, band_hi) - max(low, band_lo) + 1
        if low >= band_lo and high <= band_hi:
            return 8.0
        if overlap >= 3:
            return 6.0
        if overlap >= 1:
            return 3.0
        if high < band_lo:
            return -9.0
        return -7.0
    return 0.0


# Portal and API listings have no resume match, so score_job approximates one.
# Its range is kept close to the vendor pipeline's resume-match scores (which
# top out in the 70s): base + a few title hits + a capped number of skills,
# so a keyword match (max 64 before BA/SDE nudges) cannot outrank a strong
# resume match.
# Uncapped, a board that pastes its whole skill-tag list into the description
# (Foundit) scored up to 97 and buried better LinkedIn matches.
SCORE_BASE = 30.0
TITLE_POINTS = 8.0
MAX_TITLE_HITS = 2
SKILL_POINTS = 3.0
MAX_SKILL_HITS = 6
SCORE_CAP = 88.0


# sde_band_adjust() returns between these two values.
SDE_ADJUST_MIN = -9.0
SDE_ADJUST_MAX = 8.0


def _title_hits(role: str, title_l: str) -> int:
    return sum(1 for token in ROLE_TITLE_TOKENS.get(role, []) if _hit(token, title_l))


def _skill_hits(role: str, text: str) -> int:
    # Short skills ("ui", "ux", "sql") need word boundaries: as substrings
    # "ui" matched "build" and "ux" matched "linux".
    return sum(1 for skill in ROLE_SKILLS.get(role, []) if _hit(skill, text))


def score_job(role: str, title: str, snippet: str) -> float:
    text = f"{title} {snippet}".lower()
    title_l = (title or "").lower()
    score = SCORE_BASE
    score += TITLE_POINTS * min(_title_hits(role, title_l), MAX_TITLE_HITS)
    score += SKILL_POINTS * min(_skill_hits(role, text), MAX_SKILL_HITS)
    if role == "ba":
        if BA_ENTRY_TITLE.search(title or ""):
            score += 9
        if BA_SENIOR_TITLE.search(title or ""):
            score -= 10
    elif role == "sde":
        score += sde_band_adjust(title or "", snippet or "")
    return round(max(0.0, min(score, SCORE_CAP)), 1)


def _part(hits: int, allowance: int) -> float:
    allowance = max(1, min(MAX_SKILL_HITS, allowance))
    return round(100.0 * min(hits, allowance) / allowance, 1)


def score_parts(role: str, title: str, snippet: str) -> Dict[str, float]:
    """The parts of score_job() on a 0-100 scale, for the dashboard's match
    signal: how much of the title allowance the listing earned, how much of
    the skill allowance came from practices ("skill") and from named products
    ("tool", the ROLE_TOOLS subset), and, for the two roles with an experience
    rule, how well its years fit the band. Roles without such a rule publish
    only the first three. The web estimates the same parts for files that
    predate them (web/lib/rank.ts), so the two must agree."""
    text = f"{title} {snippet}".lower()
    title_l = (title or "").lower()
    tools = ROLE_TOOLS.get(role, [])
    practices = [skill for skill in ROLE_SKILLS.get(role, []) if skill not in tools]
    parts = {
        "role": round(100.0 * min(_title_hits(role, title_l), MAX_TITLE_HITS) / MAX_TITLE_HITS, 1),
        "skill": _part(sum(1 for skill in practices if _hit(skill, text)), len(practices)),
        "tool": _part(sum(1 for tool in tools if _hit(tool, text)), len(tools)),
    }
    if role == "sde":
        adjust = sde_band_adjust(title or "", snippet or "")
        parts["experience"] = round(100.0 * (adjust - SDE_ADJUST_MIN) / (SDE_ADJUST_MAX - SDE_ADJUST_MIN), 1)
    elif role == "ba":
        if BA_ENTRY_TITLE.search(title or ""):
            parts["experience"] = 100.0
        elif BA_SENIOR_TITLE.search(title or ""):
            parts["experience"] = 0.0
        else:
            parts["experience"] = 50.0
    return parts


def build_job(
    role: str,
    source: str,
    title: str,
    company: str,
    location: str,
    url: str,
    description: str,
    posted: Optional[str],
    job_id: Optional[str] = None,
    experience: str = "",
    strict_location: bool = False,
) -> Optional[Dict[str, Any]]:
    """Build one public job. `experience` is the board's own experience field
    (e.g. Naukri "5-9 Yrs"); it beats anything guessed from the title.

    `strict_location` is for global sources (company ATS boards and remote
    boards): their unknown locations are usually abroad, so only a location
    that names India or an India-eligible remote is kept."""
    if not valid_url(url):
        return None
    # Gate on the cleaned title that is published, so publish.py re-checking
    # the stored title reaches the same answer ("Hiring | UX Designer" is
    # stored and checked as "UX Designer"). The foreign checks still read the
    # raw title, where "| Berlin" or "- EU" may sit in a dropped segment.
    public_title = clean_title(title, company)
    if not title_relevant(role, public_title, resolve_overlap=True):
        return None
    # The company name is left out: "NTT DATA North America" in a title names
    # the employer, not where the job is.
    place_title = strip_company(title, company)
    if looks_foreign(place_title):
        return None
    if TITLE_FOREIGN_REGION.search(place_title):
        return None
    city, keep = norm_location(location, strict=strict_location)
    if not keep:
        return None
    snippet = make_snippet(description)
    exp_min, exp_max, exp_source = extract_experience_with_source(title, description, experience)
    return {
        "id": str(job_id or canonical_url(url)),
        "title": public_title,
        "company": clean_company(company),
        "location": city,
        "url": url.strip(),
        "apply_url": url.strip(),
        "source": source,
        "posted_date": posted,
        "score": score_job(role, public_title, snippet),
        "score_parts": score_parts(role, public_title, snippet),
        "experience_min": exp_min,
        "experience_max": exp_max,
        "experience_source": exp_source,
        "snippet": snippet,
        "is_new": False,
        # When *we* first scraped this job, not when the portal posted it.
        # publish.py keeps the oldest value across runs so it stays stable.
        "first_seen": datetime.now(timezone.utc).date().isoformat(),
    }


# ── Sources ───────────────────────────────────────────────────────────────────
#
# Every source here lists jobs worldwide, so each passes strict_location=True:
# a location that does not name India or an India-eligible remote is dropped.

def fetch_remotive(role: str, max_days: int) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    for keyword in search_terms(role)[:3]:
        data = get_json("https://remotive.com/api/remote-jobs", params={"search": keyword, "limit": 50})
        for item in data.get("jobs", []):
            job = build_job(
                role, "Remotive",
                item.get("title", ""),
                item.get("company_name", ""),
                item.get("candidate_required_location", ""),
                item.get("url", ""),
                item.get("description", ""),
                to_date(item.get("publication_date")),
                item.get("id"),
                strict_location=True,
            )
            if job:
                jobs.append(job)
    return jobs


def fetch_himalayas(role: str, max_days: int) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    data = get_json("https://himalayas.app/jobs/api", params={"limit": 100})
    for item in data.get("jobs", []):
        restrictions = item.get("locationRestrictions") or []
        if restrictions and not any("india" in r.lower() or r.lower() in ("worldwide", "anywhere") for r in restrictions):
            continue
        location = "India" if restrictions else "Remote"
        job = build_job(
            role, "Himalayas",
            item.get("title", ""),
            item.get("companyName", ""),
            location,
            item.get("applicationLink") or item.get("guid", ""),
            item.get("description") or item.get("excerpt", ""),
            to_date(item.get("pubDate")),
            item.get("guid"),
            strict_location=True,
        )
        if job:
            jobs.append(job)
    return jobs


def fetch_remoteok(role: str, max_days: int) -> List[Dict[str, Any]]:
    """Remote OK's public API. No key, no signup; link back to the listing."""
    data = get_json("https://remoteok.com/api")
    jobs: List[Dict[str, Any]] = []
    for item in (data if isinstance(data, list) else []):
        if not isinstance(item, dict) or item.get("legal"):
            continue
        tags = item.get("tags") or []
        description = " ".join([item.get("description") or "", " ".join(str(t) for t in tags)])
        job = build_job(
            role, "Remote OK",
            item.get("position", ""),
            item.get("company", ""),
            item.get("location") or "Remote",
            item.get("apply_url") or item.get("url", ""),
            description,
            to_date(item.get("date") or item.get("epoch")),
            item.get("id"),
            strict_location=True,
        )
        if job:
            jobs.append(job)
    return jobs


def _rss_date(value: Optional[str]) -> Optional[str]:
    if not value:
        return None
    try:
        return parsedate_to_datetime(value).date().isoformat()
    except Exception:
        return to_date(value)


def fetch_weworkremotely(role: str, max_days: int) -> List[Dict[str, Any]]:
    """We Work Remotely's public RSS feed (no key)."""
    raw = get_text("https://weworkremotely.com/remote-jobs.rss")
    if not raw:
        return []
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return []

    jobs: List[Dict[str, Any]] = []
    for item in root.iter("item"):
        raw_title = (item.findtext("title") or "").strip()
        company, _, title = raw_title.partition(": ")
        if not title:
            title, company = raw_title, ""
        region = (item.findtext("region") or "").strip()
        country = (item.findtext("country") or "").strip()
        link = (item.findtext("link") or item.findtext("guid") or "").strip()
        job = build_job(
            role, "We Work Remotely",
            title,
            company or "We Work Remotely",
            region or country or "Remote",
            link,
            item.findtext("description") or "",
            _rss_date(item.findtext("pubDate")),
            link,
            strict_location=True,
        )
        if job:
            jobs.append(job)
    return jobs


# ── Company ATS boards (keyless, public JSON) ─────────────────────────────────
#
# Most company career sites are a front end over a hosted applicant tracking
# system (ATS). Its public job feed is official, needs no key or card, answers
# from GitHub Actions, and returns structured jobs, where scraping the career
# page itself mostly finds an empty JavaScript shell. The boards live in
# companies.json; validate_companies.py checks them against the live feeds.
#
# Each ATS has a *postings* reader that returns a board's jobs as plain dicts,
# independent of role; _board_jobs then turns them into public jobs for one
# role through build_job (title gate, scoring, strict India location).

COMPANIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "companies.json")
CAREERS_SOURCE = "Company Career Pages"

# Boards are read in parallel; each costs one or a few small JSON requests.
ATS_WORKERS = 16
# Large employers list thousands of openings. These caps bound what one board
# can cost; where the ATS allows it, India is filtered in the request itself.
SMARTRECRUITERS_PAGE_SIZE = 100
SMARTRECRUITERS_MAX_POSTINGS = 1000
WORKDAY_PAGE_SIZE = 20
WORKDAY_MAX_POSTINGS = 600

Posting = Dict[str, Any]


def load_companies() -> Dict[str, List[Dict[str, Any]]]:
    """companies.json as {ats: [board, ...]}.

    A board is a token string ("postman") or an object. An object may carry a
    display "name" (otherwise the feed's company name or the token is used);
    Workday boards are objects with "host" and "site" (see _workday_postings).
    """
    try:
        with open(COMPANIES_FILE, encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    boards: Dict[str, List[Dict[str, Any]]] = {}
    for ats, entries in data.items():
        if ats.startswith("_") or not isinstance(entries, list):
            continue
        for entry in entries:
            board = {"token": entry} if isinstance(entry, str) else entry
            if isinstance(board, dict) and (board.get("token") or board.get("host")):
                boards.setdefault(ats, []).append(board)
    return boards


def pretty(token: str) -> str:
    return " ".join(part.capitalize() for part in str(token).replace("_", "-").split("-") if part)


def post_json(url: str, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None):
    merged = {"Content-Type": "application/json"}
    if headers:
        merged.update(headers)
    return _request(url, data=json.dumps(payload).encode("utf-8"), headers=merged)


# Workday rate-limits by caller across every tenant (429 Too Many Requests), so
# its requests share a few slots whatever ATS_WORKERS is. Every ATS request
# retries the answers that mean "try later" (429, 5xx, timeouts) with backoff,
# honouring a short Retry-After.
WORKDAY_CONCURRENCY = 8
ATS_RETRIES = 3
ATS_RETRY_STATUS = {429, 500, 502, 503, 504}
_WORKDAY_SLOTS = threading.BoundedSemaphore(WORKDAY_CONCURRENCY)


def _retry_after(exc: urllib.error.HTTPError) -> float:
    try:
        return min(float(exc.headers.get("Retry-After")), 30.0)
    except (AttributeError, TypeError, ValueError):
        return 0.0


def _ats_call(func, *args, slots: Optional[threading.BoundedSemaphore] = None, **kwargs):
    """func(*args, **kwargs), retried on transient failures; inside `slots` if given."""
    for attempt in range(ATS_RETRIES + 1):
        try:
            if slots is None:
                return func(*args, **kwargs)
            with slots:
                return func(*args, **kwargs)
        except urllib.error.HTTPError as exc:
            if exc.code not in ATS_RETRY_STATUS or attempt == ATS_RETRIES:
                raise
            wait = _retry_after(exc) or 2.0 * 2 ** attempt
        except (urllib.error.URLError, TimeoutError):
            if attempt == ATS_RETRIES:
                raise
            wait = 2.0 * 2 ** attempt
        # The slot is released while waiting, and jitter spreads the retries.
        time.sleep(wait + random.uniform(0, 1))
    raise AssertionError("unreachable")


def _greenhouse_postings(board: Dict[str, Any]) -> List[Posting]:
    token = board["token"]
    data = _ats_call(get_json, f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs")
    return [
        {
            "title": item.get("title", ""),
            "company": item.get("company_name"),
            "location": ((item.get("location") or {}).get("name") or "").strip(),
            "url": item.get("absolute_url", ""),
            "posted": to_date(item.get("updated_at") or item.get("first_published")),
            "id": item.get("id"),
        }
        for item in data.get("jobs", [])
    ]


def _lever_postings(board: Dict[str, Any]) -> List[Posting]:
    token = board["token"]
    data = _ats_call(get_json, f"https://api.lever.co/v0/postings/{token}", params={"mode": "json"})
    return [
        {
            "title": item.get("text", ""),
            "location": ((item.get("categories") or {}).get("location") or "").strip(),
            "url": item.get("hostedUrl", ""),
            "description": item.get("descriptionPlain") or "",
            "posted": to_date(item.get("createdAt")),
            "id": item.get("id"),
        }
        for item in (data if isinstance(data, list) else [])
    ]


def _ashby_postings(board: Dict[str, Any]) -> List[Posting]:
    token = board["token"]
    data = _ats_call(get_json, f"https://api.ashbyhq.com/posting-api/job-board/{token}")
    return [
        {
            "title": item.get("title", ""),
            "location": (item.get("location") or item.get("locationName") or "").strip(),
            "url": item.get("jobUrl") or item.get("applyUrl") or "",
            "description": item.get("descriptionPlain") or "",
            "posted": to_date(item.get("publishedAt")),
            "id": item.get("id"),
        }
        for item in data.get("jobs", [])
        if item.get("isListed") is not False
    ]


def _smartrecruiters_postings(board: Dict[str, Any]) -> List[Posting]:
    """India postings only (country=in), paged. Big employers list thousands
    worldwide, so the old single unfiltered page rarely held an Indian one."""
    token = board["token"]
    postings: List[Posting] = []
    offset = 0
    while offset < SMARTRECRUITERS_MAX_POSTINGS:
        data = _ats_call(
            get_json,
            f"https://api.smartrecruiters.com/v1/companies/{token}/postings",
            params={"limit": SMARTRECRUITERS_PAGE_SIZE, "offset": offset, "country": "in"},
        )
        items = data.get("content") or []
        for item in items:
            loc = item.get("location") or {}
            # The country filter guarantees India; the feed's own country is a
            # bare "in", which the location rules cannot read.
            city = loc.get("city") or ("Remote" if loc.get("remote") else "")
            postings.append({
                "title": item.get("name", ""),
                "company": (item.get("company") or {}).get("name"),
                "location": ", ".join(part for part in (city, "India") if part),
                "url": f"https://jobs.smartrecruiters.com/{token}/{item.get('id')}",
                "posted": to_date(item.get("releasedDate")),
                "id": item.get("id"),
            })
        offset += len(items)
        if not items or offset >= int(data.get("totalFound") or 0):
            break
    return postings


def _workday_india_facets(facets: Any) -> Dict[str, List[str]]:
    """The appliedFacets that restrict a Workday search to India.

    Tenants name their location facets differently (locationCountry,
    locationHierarchy1, locations, ...), sometimes nested in a group. A value
    called exactly "India" (a country facet) wins; otherwise every India value
    of the one facet with the most of them (city sites such as "India,
    Bengaluru"). Empty when the tenant lists no Indian location.
    """
    found: Dict[str, List[tuple]] = {}

    def walk(items: Any) -> None:
        for facet in items or []:
            param = facet.get("facetParameter")
            for value in facet.get("values") or []:
                if "facetParameter" in value:
                    walk([value])
                    continue
                label = (value.get("descriptor") or "").strip()
                if param and value.get("id") and re.search(r"\bindia\b", label, re.I):
                    found.setdefault(param, []).append((value["id"], label))

    walk(facets)
    for param, values in found.items():
        exact = [value_id for value_id, label in values if label.lower() == "india"]
        if exact:
            return {param: exact}
    if not found:
        return {}
    param = max(found, key=lambda name: len(found[name]))
    return {param: [value_id for value_id, _label in found[param]]}


def _workday_posted(text: Any) -> Optional[str]:
    """Workday's "Posted Today" / "Posted Yesterday" / "Posted 3 Days Ago" /
    "Posted 30+ Days Ago" as a UTC date ("30+" reads as 30, past the cutoff)."""
    value = str(text or "").lower()
    today = datetime.now(timezone.utc).date()
    if "today" in value:
        return today.isoformat()
    if "yesterday" in value:
        return (today - timedelta(days=1)).isoformat()
    match = re.search(r"(\d+)\+?\s*days?", value)
    if match:
        return (today - timedelta(days=int(match.group(1)))).isoformat()
    return None


def _workday_location(text: Any, path: str) -> str:
    """One readable location for a posting already filtered to India.

    "2 Locations" hides the list; the URL path names the primary one
    ("/job/India-Gurugram/..."). When neither names India the posting still
    matched the India facet, so it is labelled plain "India".
    """
    value = str(text or "").strip()
    if value and not re.fullmatch(r"\d+\s+locations?", value, re.I) and norm_location(value, strict=True)[1]:
        return value
    parts = path.strip("/").split("/")
    if len(parts) >= 2 and parts[0] == "job":
        primary = parts[1].replace("-", " ")
        if norm_location(primary, strict=True)[1]:
            return primary
    return "India"


def _workday_postings(board: Dict[str, Any]) -> List[Posting]:
    """India postings of one Workday career site.

    A board is {"host": "nvidia.wd5.myworkdayjobs.com", "site":
    "NVIDIAExternalCareerSite"}, read off the public careers URL
    https://<host>/<site>; "tenant" defaults to the host's first label. The
    first request only reads the location facets, then the India-filtered
    search is paged.
    """
    host, site = board["host"], board["site"]
    tenant = board.get("tenant") or host.split(".")[0]
    url = f"https://{host}/wday/cxs/{tenant}/{site}/jobs"
    probe = _ats_call(
        post_json, url, {"appliedFacets": {}, "limit": 1, "offset": 0, "searchText": ""},
        slots=_WORKDAY_SLOTS,
    )
    india = _workday_india_facets(probe.get("facets"))
    if not india:
        return []
    postings: List[Posting] = []
    offset = 0
    total: Optional[int] = None
    while offset < WORKDAY_MAX_POSTINGS:
        try:
            page = _ats_call(post_json, url, {
                "appliedFacets": india, "limit": WORKDAY_PAGE_SIZE, "offset": offset, "searchText": "",
            }, slots=_WORKDAY_SLOTS)
        except (urllib.error.URLError, TimeoutError):
            # Still throttled after the retries: keep the pages already read
            # (newest first) rather than losing the whole board.
            if not postings:
                raise
            break
        items = page.get("jobPostings") or []
        # Only the first page reliably carries the total; later pages send 0.
        if total is None:
            total = int(page.get("total") or 0)
        for item in items:
            path = item.get("externalPath") or ""
            if not path:
                continue
            postings.append({
                "title": item.get("title", ""),
                "location": _workday_location(item.get("locationsText"), path),
                "url": f"https://{host}/{site}{path}",
                "posted": _workday_posted(item.get("postedOn")),
                "id": (item.get("bulletFields") or [path])[0],
            })
        offset += len(items)
        if not items or offset >= total:
            break
    return postings


ATS_POSTINGS = {
    "greenhouse": _greenhouse_postings,
    "lever": _lever_postings,
    "ashby": _ashby_postings,
    "smartrecruiters": _smartrecruiters_postings,
    "workday": _workday_postings,
}


def board_label(board: Dict[str, Any]) -> str:
    return board.get("token") or board.get("host", "")


# Portal results come from a role keyword search, so the broad track rules
# (any "engineer" for SDE, any "design" for UI/UX) only have to sort them.
# A company feed returns every opening, and those rules then let in
# switchgear installers and chip designers. An ATS job must also name its
# role outright. BA_TITLE is already that strict, and GenAI's rule needs an AI
# qualifier, which a stricter pattern only cost real jobs ("AI Software
# Solutions Engineer").
_DATA_ROLE_EXTRA_TITLE = re.compile(
    r"(?<![a-z])data\s+(?:architects?|architecture|model+ers?|model+ing|platforms?|pipelines?)(?![a-z])"
)
_SDE_ROLE_TITLE = re.compile(
    r"(?<![a-z])(?:software|developers?|programmers?|sde|swe|full[\s-]?stack|back[\s-]?end|"
    r"front[\s-]?end|java|j2ee|spring\s+boot|\.net|dotnet|c#|c\+\+|python|golang|node(?:\.?js)?|"
    r"react|angular|devops|sre|site\s+reliability|cloud\s+engineer\w*|platform\s+engineer\w*|"
    r"mobile|android|ios|web|apis?|microservices?|applications?\s+engineer\w*|mainframe|"
    r"firmware|embedded)(?![a-z])"
)
# Design that is not UI/UX: silicon, mechanical, building, identity and
# infrastructure, learning ("Senior DFT Designer", "BMS Design", "IAM Lead
# Designer").
_NON_UX_DESIGN_TITLE = re.compile(
    r"(?<![a-z])(?:dft|asic|fpga|rtl|vlsi|soc|silicon|analog|mixed[\s-]signal|physical\s+design|"
    r"ip\s+design|circuit|layout|pcb|verification|mechanical|electrical|hvac|bms|civil|"
    r"structural|piping|tool\s+design|mou?ld|iam|identity|infrastructure|network|"
    r"instructional|learning|interior|retrofit|solutions?|clinical|db|database|cpu|gpu|"
    r"chip|clock|textile|fashion|jewell?e?ry)(?![a-z])"
)
ATS_ROLE_TITLE = {
    "data": (DATA_ROLE_TITLE, DATA_DOMAIN_TITLE, _DATA_ROLE_EXTRA_TITLE),
    "uiux": (UIUX_ROLE_TITLE, UIUX_DOMAIN_TITLE),
    "sde": (_SDE_ROLE_TITLE,),
}


def ats_title_ok(role: str, title: str) -> bool:
    """The extra title rule for company-feed jobs (see ATS_ROLE_TITLE)."""
    patterns = ATS_ROLE_TITLE.get(role)
    if not patterns:
        return True
    low = normalize_title(title).lower()
    if role == "uiux" and _NON_UX_DESIGN_TITLE.search(low) and not UI_WORD_TITLE.search(low):
        return False
    return any(pattern.search(low) for pattern in patterns)


def _board_jobs(ats: str, board: Dict[str, Any], role: str) -> List[Dict[str, Any]]:
    """One board's postings as public jobs for `role`.

    Every ATS lists jobs worldwide, so locations take the strict rule. The
    company name prefers companies.json, then the feed's own, then the token.
    """
    fallback = pretty(board.get("token") or board.get("host", "").split(".")[0])
    jobs: List[Dict[str, Any]] = []
    for posting in ATS_POSTINGS[ats](board):
        if not posting.get("location") or not ats_title_ok(role, posting.get("title", "")):
            continue
        job = build_job(
            role, CAREERS_SOURCE,
            posting.get("title", ""),
            board.get("name") or posting.get("company") or fallback,
            posting["location"],
            posting.get("url", ""),
            posting.get("description", ""),
            posting.get("posted"),
            posting.get("id"),
            strict_location=True,
        )
        if job:
            jobs.append(job)
    return jobs


def fetch_ats(role: str, max_days: int) -> List[Dict[str, Any]]:
    targets = [
        (ats, board)
        for ats, boards in load_companies().items()
        if ats in ATS_POSTINGS
        for board in boards
    ]
    if not targets:
        return []
    jobs: List[Dict[str, Any]] = []
    failed: List[str] = []
    with cf.ThreadPoolExecutor(max_workers=ATS_WORKERS) as pool:
        futures = {pool.submit(_board_jobs, ats, board, role): (ats, board) for ats, board in targets}
        for future in cf.as_completed(futures):
            ats, board = futures[future]
            try:
                jobs.extend(future.result() or [])
            except Exception:
                failed.append(f"{ats}:{board_label(board)}")
    note = f", {len(failed)} boards failed: {', '.join(sorted(failed)[:10])}" if failed else ""
    print(f"[apis] ats: {len(targets)} boards, {len(jobs)} {role} jobs{note}", file=sys.stderr)
    return jobs


SOURCES = (
    ("remotive", fetch_remotive),
    ("himalayas", fetch_himalayas),
    ("remoteok", fetch_remoteok),
    ("weworkremotely", fetch_weworkremotely),
    ("ats", fetch_ats),
)


# ── Collection / merging ──────────────────────────────────────────────────────

def _run_api_source(name: str, fetcher, role: str, max_days: int):
    """Fetch one API source without letting its failure abort the others."""
    try:
        return name, fetcher(role, max_days) or [], None
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as exc:
        return name, [], str(exc)
    except Exception as exc:  # never let one source break the run
        return name, [], f"error ({exc})"


def collect_api_jobs(
    role: str,
    profile: Dict[str, Any],
    max_days: int,
    min_score: float = 20.0,
    include_ats: bool = True,
    parallel: int = 1,
    sources: Optional[Iterable[str]] = None,
) -> List[Dict[str, Any]]:
    """Jobs from SOURCES (all, or only the names in `sources`) for one role."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_days)).date().isoformat()
    seen = set()
    seen_roles = set()
    collected: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    wanted = set(sources) if sources is not None else None
    selected = [
        (name, fetcher)
        for name, fetcher in SOURCES
        if not (name == "ats" and not include_ats)
        and (wanted is None or name in wanted)
    ]
    results: Dict[str, List[Dict[str, Any]]] = {}

    if parallel > 1 and len(selected) > 1:
        print(
            f"[apis] fetching {len(selected)} sources in parallel (up to {parallel})",
            file=sys.stderr,
        )
        with cf.ThreadPoolExecutor(max_workers=min(parallel, len(selected))) as pool:
            futures = {
                pool.submit(_run_api_source, name, fetcher, role, max_days): name
                for name, fetcher in selected
            }
            for future in cf.as_completed(futures):
                name, found, error = future.result()
                if error:
                    print(f"[apis] {name}: {error}", file=sys.stderr)
                results[name] = found
    else:
        for name, fetcher in selected:
            name, found, error = _run_api_source(name, fetcher, role, max_days)
            if error:
                print(f"[apis] {name}: {error}", file=sys.stderr)
            results[name] = found

    # Merge in registry order, not completion order, so the output is stable
    # between parallel and sequential runs.
    for name, _fetcher in selected:
        found = results.get(name, [])
        kept = 0
        for job in found:
            if (job.get("score") or 0) < min_score:
                continue
            key = canonical_url(job["url"])
            if not key or key in seen:
                continue
            # Collapse the same role relisted under several ATS departments.
            role_key = (
                (job.get("company") or "").lower(),
                (job.get("title") or "").lower(),
                (job.get("location") or "").lower(),
            )
            if role_key in seen_roles:
                continue
            stamp = (job.get("posted_date") or "")[:10]
            if stamp and stamp < cutoff:
                continue
            seen.add(key)
            seen_roles.add(role_key)
            collected.append(job)
            kept += 1
        counts[name] = kept
        print(f"[apis] {name}: {kept} jobs kept", file=sys.stderr)

    print(f"[apis] role={role} total={len(collected)} {counts}", file=sys.stderr)
    return collected


def merge_api_jobs(payload: Dict[str, Any], api_jobs: Iterable[Dict[str, Any]]) -> Dict[str, Any]:
    jobs = list(payload.get("jobs", []))
    seen = {canonical_url(j.get("url", "")) for j in jobs}

    for job in api_jobs:
        key = canonical_url(job.get("url", ""))
        if not key or key in seen:
            continue
        seen.add(key)
        jobs.append(job)

    # The same opening is often on several boards under different URLs.
    jobs = dedupe_jobs(jobs)
    jobs.sort(key=lambda j: (-(j.get("score") or 0), j.get("posted_date") or ""))

    sources: Dict[str, int] = {}
    for job in jobs:
        name = job.get("source") or "Unknown"
        sources[name] = sources.get(name, 0) + 1

    return {
        "role": payload.get("role"),
        "generated_at": payload.get("generated_at")
        or datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(jobs),
        "sources": dict(sorted(sources.items(), key=lambda kv: -kv[1])),
        "jobs": jobs,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch jobs from cloud-safe job APIs")
    parser.add_argument("--role", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", default=None)
    parser.add_argument("--max-days", type=int, default=14)
    parser.add_argument("--min-score", type=float, default=20.0)
    parser.add_argument("--no-ats", action="store_true", help="Skip company ATS boards")
    parser.add_argument(
        "--parallel-sources",
        type=int,
        default=1,
        help="Fetch this many API sources at once (default 1, sequential).",
    )
    parser.add_argument(
        "--sources",
        default="all",
        help="Comma-separated source names to run, or 'all' (default). Names: "
        + ", ".join(name for name, _fetcher in SOURCES),
    )
    args = parser.parse_args()
    known = {name for name, _fetcher in SOURCES}
    sources = None if args.sources == "all" else [s.strip() for s in args.sources.split(",") if s.strip()]
    unknown = sorted(set(sources or []) - known)
    if unknown:
        parser.error(f"unknown source(s): {', '.join(unknown)}")

    profile: Dict[str, Any] = {}
    if args.profile and os.path.exists(args.profile):
        with open(args.profile, encoding="utf-8-sig") as handle:
            profile = json.load(handle)

    if args.min_score == 20.0 and profile.get("min_score") is not None:
        args.min_score = float(profile["min_score"])

    jobs = collect_api_jobs(
        args.role,
        profile,
        args.max_days,
        args.min_score,
        include_ats=not args.no_ats,
        parallel=args.parallel_sources,
        sources=sources,
    )
    payload = merge_api_jobs({"role": args.role, "jobs": []}, jobs)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"[apis] wrote {args.out} ({payload['count']} jobs)")


if __name__ == "__main__":
    main()
