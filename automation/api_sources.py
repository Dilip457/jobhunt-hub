#!/usr/bin/env python3
"""
api_sources.py — Cloud-safe job sources (no browser, no residential IP).

The Indian portals (Naukri, Indeed, Foundit, …) block datacenter IPs, so the
scraper-based pipeline only ever sees LinkedIn and company pages from GitHub
Actions. These sources talk to *official / public* job APIs instead, which work
from any IP and need no machine of your own:

    Adzuna        needs ADZUNA_APP_ID + ADZUNA_APP_KEY   (free, India supported)
    Jooble        needs JOOBLE_API_KEY                    (free, India)
    Google Jobs   needs JSEARCH_API_KEY (RapidAPI)        (free tier, India)
    Remotive      no key needed                           (remote roles)
    Himalayas     no key needed                           (remote roles)

Missing keys are simply skipped, so the portal keeps working with whatever is
configured.

Usage (usually called by run_source.py):
    python automation/api_sources.py --role uiux --out artifacts/uiux.apis.json
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime
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
    "ba": ["business analyst", "functional analyst", "business systems analyst",
           "product analyst", "business analyst fresher"],
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
    # BA-specific titles plus a broad `analyst` token. The broad token keeps
    # IIBA's generic listings alive; ROLE_TITLE_EXCLUDE below removes the
    # finance, data, QA, security and ops analyst families.
    "ba": ["business analyst", "business analysis", "functional analyst",
           "business systems analyst", "systems analyst", "process analyst",
           "requirements analyst", "product analyst", "it analyst",
           "business process analyst", "bpa", "analyst"],
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
             "cab cars", "chip design"],
    # `analyst` is a broad token (it keeps IIBA's generic titles alive), so
    # exclude the analyst families that are clearly not business analysis.
    # A title that explicitly says "business analyst" bypasses both lists, so a
    # BA in a finance/risk/sales domain is still kept. See BA_HARD_EXCLUDE and
    # BA_SOFT_EXCLUDE below for the two-stage check.
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
            "servicenow", "sap ", "warehouse", "driver", "technician"],
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

# Titles that unambiguously describe BA work. The core phrase wins over every
# exclusion, so "Business Analyst - Finance" and "Business Analyst - Risk" stay.
BA_CORE_TITLE = re.compile(
    r"\b(business analyst|business analysis|business systems analyst|bpa)\b",
    re.I,
)
# BA-adjacent titles. They survive domain words ("Business Process Analyst -
# Logistics") but not a non-BA family word ("HRIS Functional Analyst").
BA_STRONG_TITLE = re.compile(
    r"\b(functional analyst|requirements analyst|process analyst|"
    r"business process analyst|product analyst|systems analyst|it analyst)\b",
    re.I,
)
# Another job family entirely: even a "Functional Analyst" title in one of
# these domains is not a BA role.
BA_HARD_EXCLUDE = [
    "data analyst", "business intelligence", "bi analyst", "bi developer",
    "power bi", "quality analyst", "quality assurance analyst", "qa analyst",
    "qa engineer", "qa", "test analyst", "automation analyst",
    "security analyst", "soc analyst", "research analyst", "research analytics",
    "verification analyst", "hris", "hcm", "workday", "people technology", "benefits",
    "compensation", "support specialist", "ai trainer",
    # Support/helpdesk analyst families are not business analysis.
    "support analyst", "product support", "client support",
    "platform engineering",
]

# A domain that can legitimately contain BA work. "Financial Analyst" is out,
# but "Business Analyst - Finance" is kept by the core-title check above.
BA_SOFT_EXCLUDE = [
    "financial analyst", "finance", "fp&a", "investment analyst",
    "credit analyst", "risk", "lending", "marketing", "sales",
    "business development", "account executive", "recruiter",
    "order management", "order to cash", "o2c", "billing", "payroll",
    "accounts payable", "accounts receivable", "logistics", "inventory",
    "finops", "procurement", "supply chain", "payment operations",
    "revenue analyst", "banking", "healthcare analyst",
]

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


def post_json(url: str, payload: Dict[str, Any], headers: Optional[Dict[str, str]] = None):
    body = json.dumps(payload).encode("utf-8")
    merged = {"Content-Type": "application/json"}
    if headers:
        merged.update(headers)
    return _request(url, data=body, headers=merged)


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


def norm_location(raw: str) -> tuple[str, bool]:
    # normalize_location already understands remote wording and rejects
    # country-restricted remote roles such as "Remote - US".
    return normalize_location(raw)


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


def title_relevant(role: str, title: str) -> bool:
    low = (title or "").lower()
    if role == "ba":
        # An explicit "business analyst" title is authoritative: a finance,
        # risk or sales domain word must not turn it into a non-BA listing.
        if BA_CORE_TITLE.search(low):
            return True
        if any(_hit_word(token, low) for token in BA_HARD_EXCLUDE):
            return False
        if BA_STRONG_TITLE.search(low):
            return True
        if any(_hit_word(token, low) for token in BA_SOFT_EXCLUDE):
            return False
        return any(_hit(token, low) for token in ROLE_TITLE_TOKENS.get("ba", []))
    # Internships are not full-time openings for the engineering/design tracks.
    if ENTRY_LEVEL_TITLE.search(low):
        return False
    if role == "genai" and GENAI_HARD_TITLE.search(low):
        return False
    if role == "genai" and GENAI_CORE_TITLE.search(low):
        return True
    if role == "sde" and re.fullmatch(r"\s*data engineering\s*", low):
        return False
    if any(_hit_word(token, low) for token in ROLE_TITLE_EXCLUDE.get(role, [])):
        return False
    return any(_hit(token, low) for token in ROLE_TITLE_TOKENS.get(role, []))


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


def score_job(role: str, title: str, snippet: str) -> float:
    text = f"{title} {snippet}".lower()
    title_l = (title or "").lower()
    score = SCORE_BASE
    title_hits = sum(1 for token in ROLE_TITLE_TOKENS.get(role, []) if _hit(token, title_l))
    score += TITLE_POINTS * min(title_hits, MAX_TITLE_HITS)
    # Short skills ("ui", "ux", "sql") need word boundaries: as substrings
    # "ui" matched "build" and "ux" matched "linux".
    skill_hits = sum(1 for skill in ROLE_SKILLS.get(role, []) if _hit(skill, text))
    score += SKILL_POINTS * min(skill_hits, MAX_SKILL_HITS)
    if role == "ba":
        if BA_ENTRY_TITLE.search(title or ""):
            score += 9
        if BA_SENIOR_TITLE.search(title or ""):
            score -= 10
    elif role == "sde":
        score += sde_band_adjust(title or "", snippet or "")
    return round(max(0.0, min(score, SCORE_CAP)), 1)


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
) -> Optional[Dict[str, Any]]:
    """Build one public job. `experience` is the board's own experience field
    (e.g. Naukri "5-9 Yrs"); it beats anything guessed from the title."""
    if not valid_url(url):
        return None
    if not title_relevant(role, title):
        return None
    if looks_foreign(title):
        return None
    if TITLE_FOREIGN_REGION.search(title or ""):
        return None
    city, keep = norm_location(location)
    if not keep:
        return None
    snippet = make_snippet(description)
    exp_min, exp_max, exp_source = extract_experience_with_source(title, description, experience)
    return {
        "id": str(job_id or canonical_url(url)),
        "title": clean_title(title),
        "company": clean_company(company),
        "location": city,
        "url": url.strip(),
        "apply_url": url.strip(),
        "source": source,
        "posted_date": posted,
        "score": score_job(role, title, snippet),
        "score_parts": {"role": 0.0, "skill": 0.0, "experience": 0.0, "tool": 0.0, "domain": 0.0},
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

def fetch_adzuna(role: str, max_days: int) -> List[Dict[str, Any]]:
    app_id = os.environ.get("ADZUNA_APP_ID")
    app_key = os.environ.get("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        return []
    jobs: List[Dict[str, Any]] = []
    for keyword in search_terms(role)[:3]:
        data = get_json(
            "https://api.adzuna.com/v1/api/jobs/in/search/1",
            params={
                "app_id": app_id,
                "app_key": app_key,
                "results_per_page": 50,
                "what": keyword,
                "where": "india",
                "max_days_old": max_days,
                "sort_by": "date",
                "content-type": "application/json",
            },
        )
        for item in data.get("results", []):
            job = build_job(
                role, "Adzuna",
                item.get("title", ""),
                (item.get("company") or {}).get("display_name", ""),
                (item.get("location") or {}).get("display_name", ""),
                item.get("redirect_url", ""),
                item.get("description", ""),
                to_date(item.get("created")),
                item.get("id"),
            )
            if job:
                jobs.append(job)
    return jobs


def fetch_jooble(role: str, max_days: int) -> List[Dict[str, Any]]:
    key = os.environ.get("JOOBLE_API_KEY")
    if not key:
        return []
    jobs: List[Dict[str, Any]] = []
    for keyword in search_terms(role)[:3]:
        data = post_json(f"https://jooble.org/api/{key}", {"keywords": keyword, "location": "India", "page": 1})
        for item in data.get("jobs", []):
            job = build_job(
                role, "Jooble",
                item.get("title", ""),
                item.get("company", ""),
                item.get("location", ""),
                item.get("link", ""),
                item.get("snippet", ""),
                to_date(item.get("updated")),
                item.get("id"),
            )
            if job:
                jobs.append(job)
    return jobs


def fetch_jsearch(role: str, max_days: int) -> List[Dict[str, Any]]:
    key = os.environ.get("JSEARCH_API_KEY") or os.environ.get("RAPIDAPI_KEY")
    if not key:
        return []
    data = get_json(
        "https://jsearch.p.rapidapi.com/search",
        params={
            "query": f"{search_terms(role)[0]} in India",
            "page": "1",
            "num_pages": "1",
            "country": "in",
            "date_posted": "week" if max_days <= 7 else "month",
        },
        headers={"X-RapidAPI-Key": key, "X-RapidAPI-Host": "jsearch.p.rapidapi.com"},
    )
    jobs: List[Dict[str, Any]] = []
    for item in data.get("data", []):
        city = ", ".join(p for p in [item.get("job_city"), item.get("job_state")] if p)
        job = build_job(
            role, "Google Jobs",
            item.get("job_title", ""),
            item.get("employer_name", ""),
            city or item.get("job_country", ""),
            item.get("job_apply_link") or item.get("job_google_link") or "",
            item.get("job_description", ""),
            to_date(item.get("job_posted_at_datetime_utc")),
            item.get("job_id"),
        )
        if job:
            jobs.append(job)
    return jobs


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
        )
        if job:
            jobs.append(job)
    return jobs


# ── Company ATS boards (keyless, public JSON) ─────────────────────────────────
#
# Naukri / Indeed / Foundit block datacenter IPs *and* now return nothing even
# from a home IP, so we read companies' own careers systems instead. These
# endpoints are official, public, need no key and no card, and answer fine from
# GitHub Actions. The company list lives in companies.json.

COMPANIES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "companies.json")
CAREERS_SOURCE = "Company Career Pages"


def load_companies() -> Dict[str, List[str]]:
    try:
        with open(COMPANIES_FILE, encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except Exception:
        return {}
    return {k: v for k, v in data.items() if isinstance(v, list) and not k.startswith("_")}


def pretty(token: str) -> str:
    return " ".join(part.capitalize() for part in str(token).replace("_", "-").split("-") if part)


def _greenhouse(token: str, role: str) -> List[Dict[str, Any]]:
    data = get_json(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs")
    jobs = []
    for item in data.get("jobs", []):
        places = ((item.get("location") or {}).get("name") or "").strip()
        if not places:
            continue
        job = build_job(
            role, CAREERS_SOURCE,
            item.get("title", ""),
            pretty(token),
            places,
            item.get("absolute_url", ""),
            "",
            to_date(item.get("updated_at") or item.get("first_published")),
            item.get("id"),
        )
        if job:
            jobs.append(job)
    return jobs


def _lever(token: str, role: str) -> List[Dict[str, Any]]:
    data = get_json(f"https://api.lever.co/v0/postings/{token}", params={"mode": "json"})
    jobs = []
    for item in (data if isinstance(data, list) else []):
        places = ((item.get("categories") or {}).get("location") or "").strip()
        if not places:
            continue
        job = build_job(
            role, CAREERS_SOURCE,
            item.get("text", ""),
            pretty(token),
            places,
            item.get("hostedUrl", ""),
            item.get("descriptionPlain") or "",
            to_date(item.get("createdAt")),
            item.get("id"),
        )
        if job:
            jobs.append(job)
    return jobs


def _ashby(token: str, role: str) -> List[Dict[str, Any]]:
    data = get_json(f"https://api.ashbyhq.com/posting-api/job-board/{token}")
    jobs = []
    for item in data.get("jobs", []):
        if item.get("isListed") is False:
            continue
        places = (item.get("location") or item.get("locationName") or "").strip()
        if not places:
            continue
        job = build_job(
            role, CAREERS_SOURCE,
            item.get("title", ""),
            pretty(token),
            places,
            item.get("jobUrl") or item.get("applyUrl") or "",
            item.get("descriptionPlain") or "",
            to_date(item.get("publishedAt")),
            item.get("id"),
        )
        if job:
            jobs.append(job)
    return jobs


def _smartrecruiters(token: str, role: str) -> List[Dict[str, Any]]:
    data = get_json(
        f"https://api.smartrecruiters.com/v1/companies/{token}/postings",
        params={"limit": 100},
    )
    jobs = []
    for item in data.get("content", []):
        loc = item.get("location") or {}
        places = ", ".join(p for p in [loc.get("city"), loc.get("region") or loc.get("country")] if p).strip()
        if not places:
            continue
        job = build_job(
            role, CAREERS_SOURCE,
            item.get("name", ""),
            pretty(token),
            places,
            f"https://jobs.smartrecruiters.com/{token}/{item.get('id')}",
            "",
            to_date(item.get("releasedDate")),
            item.get("id"),
        )
        if job:
            jobs.append(job)
    return jobs


_ATS_FETCHERS = {
    "greenhouse": _greenhouse,
    "lever": _lever,
    "ashby": _ashby,
    "smartrecruiters": _smartrecruiters,
}


def fetch_ats(role: str, max_days: int) -> List[Dict[str, Any]]:
    companies = load_companies()
    targets = [
        (ats, token)
        for ats, tokens in companies.items()
        for token in tokens
        if ats in _ATS_FETCHERS
    ]
    if not targets:
        return []
    jobs: List[Dict[str, Any]] = []
    with cf.ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_ATS_FETCHERS[ats], token, role): (ats, token) for ats, token in targets}
        for future in cf.as_completed(futures):
            ats, token = futures[future]
            try:
                jobs.extend(future.result() or [])
            except Exception:
                continue
    return jobs


SOURCES = (
    ("adzuna", fetch_adzuna),
    ("jooble", fetch_jooble),
    ("jsearch", fetch_jsearch),
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
) -> List[Dict[str, Any]]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_days)).date().isoformat()
    seen = set()
    seen_roles = set()
    collected: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    selected = [
        (name, fetcher)
        for name, fetcher in SOURCES
        if not (name == "ats" and not include_ats)
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
    args = parser.parse_args()

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
    )
    payload = merge_api_jobs({"role": args.role, "jobs": []}, jobs)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"[apis] wrote {args.out} ({payload['count']} jobs)")


if __name__ == "__main__":
    main()
