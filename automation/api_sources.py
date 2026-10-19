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
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, Iterable, List, Optional

from export import (
    canonical_url,
    clean_company,
    clean_title,
    looks_foreign,
    make_snippet,
    normalize_location,
    valid_url,
)

USER_AGENT = "Mozilla/5.0 (compatible; jobhunt-hub/1.0; +https://github.com/Dilip457/jobhunt-hub)"
TIMEOUT = 25

# Query terms sent to the APIs.
ROLE_SEARCH_TERMS = {
    "genai": ["machine learning engineer", "generative ai engineer", "llm engineer", "ai engineer"],
    "data": ["data engineer", "big data engineer", "etl developer", "cloud data engineer"],
    "uiux": ["ux designer", "ui designer", "product designer", "interaction designer"],
}

# A job only counts if one of these appears in its title (keeps feeds on-topic).
ROLE_TITLE_TOKENS = {
    "genai": ["ai", "ml", "machine learning", "generative", "genai", "llm", "nlp",
              "deep learning", "artificial intelligence", "data scientist", "prompt"],
    "data": ["data engineer", "data", "etl", "elt", "big data", "analytics engineer",
             "spark", "pyspark", "data warehouse", "databricks", "snowflake", "sql"],
    "uiux": ["ux", "ui", "designer", "design", "interaction", "visual", "figma",
             "user experience", "product design"],
}

# Titles that contain a role token but are clearly a different job family.
ROLE_TITLE_EXCLUDE = {
    "genai": ["sales", "account executive", "recruiter", "marketing", "support specialist"],
    "data": ["warehouse associate", "delivery", "driver", "mechanic", "trainee"],
    "uiux": ["mechanical", "hardware", "electrical", "civil", "data center", "instructional"],
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
}

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
    low = (raw or "").strip().lower()
    if any(word in low for word in REMOTE_WORDS):
        return ("Remote", True)
    return normalize_location(raw)


def search_terms(role: str) -> List[str]:
    return ROLE_SEARCH_TERMS.get(role, ["jobs"])


def _hit(token: str, text: str) -> bool:
    if len(token) <= 3:
        return re.search(rf"\b{re.escape(token)}\b", text) is not None
    return token in text


def title_relevant(role: str, title: str) -> bool:
    low = (title or "").lower()
    if any(_hit(token, low) for token in ROLE_TITLE_EXCLUDE.get(role, [])):
        return False
    return any(_hit(token, low) for token in ROLE_TITLE_TOKENS.get(role, []))


def score_job(role: str, title: str, snippet: str) -> float:
    text = f"{title} {snippet}".lower()
    title_l = (title or "").lower()
    score = 30.0
    for token in ROLE_TITLE_TOKENS.get(role, []):
        if _hit(token, title_l):
            score += 8
    for skill in ROLE_SKILLS.get(role, []):
        if skill in text:
            score += 3
    return round(min(score, 97.0), 1)


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
) -> Optional[Dict[str, Any]]:
    if not valid_url(url):
        return None
    if not title_relevant(role, title):
        return None
    if looks_foreign(title):
        return None
    city, keep = norm_location(location)
    if not keep:
        return None
    snippet = make_snippet(description)
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
        "experience_min": None,
        "experience_max": None,
        "snippet": snippet,
        "is_new": False,
        "first_seen": posted,
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
    ("ats", fetch_ats),
)


# ── Collection / merging ──────────────────────────────────────────────────────

def collect_api_jobs(
    role: str,
    profile: Dict[str, Any],
    max_days: int,
    min_score: float = 20.0,
    include_ats: bool = True,
) -> List[Dict[str, Any]]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_days)).date().isoformat()
    seen = set()
    seen_roles = set()
    collected: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    for name, fetcher in SOURCES:
        if name == "ats" and not include_ats:
            continue
        try:
            found = fetcher(role, max_days) or []
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as exc:
            print(f"[apis] {name}: failed ({exc})", file=sys.stderr)
            continue
        except Exception as exc:  # never let one source break the run
            print(f"[apis] {name}: error ({exc})", file=sys.stderr)
            continue

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
    args = parser.parse_args()

    profile: Dict[str, Any] = {}
    if args.profile and os.path.exists(args.profile):
        with open(args.profile, encoding="utf-8-sig") as handle:
            profile = json.load(handle)

    if args.min_score == 20.0 and profile.get("min_score") is not None:
        args.min_score = float(profile["min_score"])

    jobs = collect_api_jobs(args.role, profile, args.max_days, args.min_score, include_ats=not args.no_ats)
    payload = merge_api_jobs({"role": args.role, "jobs": []}, jobs)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"[apis] wrote {args.out} ({payload['count']} jobs)")


if __name__ == "__main__":
    main()
