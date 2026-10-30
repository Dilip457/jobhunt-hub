#!/usr/bin/env python3
"""
run_source.py — Run one of the existing scraper repos with public-portal
overrides, then export its SQLite DB to compact portal JSON.

The source repos are treated as read-only vendor code: we patch their config
and scoring engine in memory, run the pipeline, and export. No source edits.

Usage:
    python automation/run_source.py \
        --role uiux \
        --repo-dir vendor/uiux \
        --out web/data/uiux.json \
        --sources linkedin naukri indeed foundit shine timesjobs wellfound company_pages
"""

from __future__ import annotations

import argparse
import importlib
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

# Portal-wide defaults for a public, pan-India board.
PAN_INDIA_LOCATIONS = [
    "India",
    "Remote",
    "Hyderabad",
    "Bangalore",
    "Pune",
    "Mumbai",
    "Chennai",
    "Gurgaon",
    "Noida",
    "Delhi",
    "Kolkata",
]

PREFERRED_LOCATIONS = [
    "india", "hyderabad", "bangalore", "bengaluru", "remote", "hybrid",
    "mumbai", "pune", "chennai", "delhi", "gurgaon", "noida", "kolkata",
]

# LinkedIn geoIds. "India" gives nationwide coverage.
LINKEDIN_GEO_IDS = {
    "India": "102713980",
    "Hyderabad": "105556991",
    "Bangalore": "105214831",
}

# ── Business Analyst profile for the shared UI/UX vendor repo ────────────────
#
# The BA track reuses Dilip457/UI-UX-Job_Hunt, whose config, scoring engine and
# company-page filter are all design-specific. These constants are injected
# before the vendor modules import their config, so the shared pipeline searches
# and scores BA roles instead of designers.

BA_RESUME_PROFILE = {
    "name": "Business Analyst",
    "title": "Business Analyst",
    "years_of_experience": 1,
    "locations": ["Hyderabad", "Bangalore", "Pune", "Mumbai"],
    "notice_period": "Immediate",
    "core_skills": [
        "Requirement Gathering", "Requirement Elicitation", "Requirement Management",
        "BRD", "FRD", "Business Requirements", "Functional Requirements",
        "User Stories", "Acceptance Criteria", "GAP Analysis", "Process Mapping",
        "Process Improvement", "Stakeholder Communication", "Stakeholder Management",
        "UAT", "User Acceptance Testing", "Data Analysis", "Data Visualization",
        "SQL", "Agile", "Scrum", "Sprint Planning", "Wireframing",
        "Problem Solving", "Documentation", "Business Process",
    ],
    "design_tools": [
        "Excel", "Advanced Excel", "SQL", "Power BI", "Tableau", "JIRA",
        "Confluence", "MS Visio", "Visio", "MS Word", "PowerPoint",
        "Balsamiq", "Figma", "Postman", "API Testing",
    ],
    "ai_tools": [],
    "frontend_skills": [],
    "standards": ["Agile", "Scrum"],
    "research_methods": [
        "Stakeholder Interviews", "Requirement Workshops", "Process Mapping",
    ],
    "domains": [
        "Fintech", "Healthcare", "B2B SaaS", "Enterprise", "E-commerce",
        "Banking", "Insurance",
    ],
    "industry_keywords": [
        "Business Analysis", "Digital Transformation", "Process Improvement",
        "Product", "Enterprise Software",
    ],
    "portfolio_keywords": [],
    "target_role_keywords": [
        "Business Analyst", "Functional Analyst", "Business Systems Analyst",
        "Product Analyst", "Process Analyst", "Requirements Analyst",
        "Junior Business Analyst", "Associate Business Analyst",
    ],
    "experience_highlights": ["Fresher-friendly", "1-3 years", "Agile delivery"],
}

BA_HIGH_WEIGHT_KEYWORDS = [
    "business analyst", "requirement gathering", "requirement elicitation",
    "requirement management", "brd", "frd", "business requirement",
    "functional requirement", "user stories", "acceptance criteria",
    "gap analysis", "process mapping", "stakeholder", "uat",
    "user acceptance testing", "sql", "agile", "scrum", "jira",
    "confluence", "power bi", "tableau", "excel", "visio",
]

BA_MEDIUM_WEIGHT_KEYWORDS = [
    "wireframe", "data visualization", "data visualisation", "postman",
    "api testing", "sprint", "documentation", "balsamiq", "figma",
    "process improvement", "use case", "kpi", "dashboard", "business process",
]

BA_ROLE_KEYWORDS = {
    "high": [
        "business analyst", "business systems analyst", "functional analyst",
        "requirements analyst", "process analyst", "product analyst",
        "junior business analyst", "associate business analyst",
        "business process analyst", "it business analyst", "bpa",
    ],
    "medium": [
        "systems analyst", "analyst", "business analysis", "product owner",
        "uat analyst", "business consultant",
    ],
    "low": ["business", "analysis", "requirements", "process"],
}


def _patch_config(config, args) -> None:
    config.SEARCH_LOCATIONS = list(PAN_INDIA_LOCATIONS)
    config.EXCLUDED_LOCATIONS = []
    config.PREFERRED_LOCATIONS = list(PREFERRED_LOCATIONS)
    config.MIN_MATCH_SCORE = args.min_score
    config.MAX_EXPERIENCE_YEARS = 30
    config.MIN_EXPERIENCE_YEARS = 0
    config.MAX_DAYS_OLD = args.max_days
    config.MAX_WORKERS = 8

    if getattr(args, "max_keywords", 0):
        limit = args.max_keywords
        config.SEARCH_KEYWORDS = list(getattr(config, "SEARCH_KEYWORDS", []))[:limit]
        config.SKILL_SEARCH_KEYWORDS = list(getattr(config, "SKILL_SEARCH_KEYWORDS", []))[:limit]
        config.ALL_SEARCH_KEYWORDS = config.SEARCH_KEYWORDS + config.SKILL_SEARCH_KEYWORDS

    # The shared UI/UX vendor config searches for designers by default. Replace
    # its keyword lists and resume profile before scoring_engine imports them.
    if args.role == "ba":
        profile = getattr(args, "profile_data", {}) or {}
        keywords = [k for k in (profile.get("keywords") or []) if k]
        skills = [k for k in (profile.get("skill_keywords") or []) if k]
        if keywords:
            config.SEARCH_KEYWORDS = list(keywords)
            config.SKILL_SEARCH_KEYWORDS = list(skills)
            config.ALL_SEARCH_KEYWORDS = config.SEARCH_KEYWORDS + config.SKILL_SEARCH_KEYWORDS
            config.TARGET_ROLES = list(keywords)
        config.RESUME_PROFILE = dict(BA_RESUME_PROFILE)
        config.HIGH_WEIGHT_KEYWORDS = list(BA_HIGH_WEIGHT_KEYWORDS)
        config.MEDIUM_WEIGHT_KEYWORDS = list(BA_MEDIUM_WEIGHT_KEYWORDS)


def _patch_scoring(scoring_engine, config, role: str = "") -> None:
    scoring_engine.EXCLUDED_LOCATIONS = []
    scoring_engine.PREFERRED_LOCATIONS = list(PREFERRED_LOCATIONS)
    scoring_engine.MAX_EXPERIENCE_YEARS = 30

    # Public board: never hard-reject a job for years of experience.
    scoring_engine.ScoringEngine._check_experience_strict = (
        lambda self, title, description: (True, "experience filter disabled")
    )

    if role == "ba":
        _patch_ba_scoring(scoring_engine)


def _patch_ba_scoring(scoring_engine) -> None:
    """Replace the vendor's design-only role/tool scoring with BA scoring."""
    scoring_engine.RESUME_PROFILE = dict(BA_RESUME_PROFILE)
    scoring_engine.HIGH_WEIGHT_KEYWORDS = list(BA_HIGH_WEIGHT_KEYWORDS)
    scoring_engine.MEDIUM_WEIGHT_KEYWORDS = list(BA_MEDIUM_WEIGHT_KEYWORDS)
    scoring_engine.ROLE_KEYWORDS = {k: list(v) for k, v in BA_ROLE_KEYWORDS.items()}

    def score_role(self, title: str, description: str = "") -> float:
        title_norm = self._normalize(title)
        desc_norm = self._normalize(description or "")
        score = 0.0
        for role in BA_ROLE_KEYWORDS["high"]:
            if role in title_norm:
                score = max(score, 95.0)
                break
        if score < 80:
            for role in BA_ROLE_KEYWORDS["medium"]:
                if role in title_norm:
                    score = max(score, 75.0)
                    break
        if score < 60:
            for role in BA_ROLE_KEYWORDS["low"]:
                if role in title_norm:
                    score = max(score, 55.0)
                    break
        if score > 0 and desc_norm:
            for role in BA_ROLE_KEYWORDS["high"]:
                if role in desc_norm:
                    score = min(100.0, score + 5.0)
                    break
        return min(100.0, score)

    def score_tools(self, description: str) -> float:
        if not description:
            return 50.0
        desc = self._normalize(description)
        primary = ["excel", "sql", "power bi", "tableau", "jira", "confluence", "visio"]
        secondary = ["balsamiq", "figma", "postman", "api testing", "powerpoint",
                     "ms word", "azure devops", "ms project"]
        primary_matches = sum(1 for tool in primary if tool in desc)
        secondary_matches = sum(1 for tool in secondary if tool in desc)
        raw = (primary_matches * 15) + (secondary_matches * 5)
        return min(100.0, max(40.0, raw))

    scoring_engine.ScoringEngine._score_role_match = score_role
    scoring_engine.ScoringEngine._score_tool_match = score_tools


PLAYWRIGHT_CITIES = ["Hyderabad", "Bangalore", "Pune"]


def _slug(value: str) -> str:
    return re.sub(r"[^\w\s-]", "", value.lower()).strip().replace(" ", "-")


def _plus(value: str) -> str:
    return re.sub(r"\s+", "+", value.strip())


def build_portal_searches(keywords: list[str], cities: list[str]) -> dict[str, list[str]]:
    """Role-appropriate search URLs for the vendor Playwright scraper."""
    portals: dict[str, list[str]] = {"naukri": [], "indeed": [], "foundit": []}
    for keyword in keywords:
        for city in cities:
            portals["naukri"].append(f"https://www.naukri.com/{_slug(keyword)}-jobs-in-{city.lower()}")
            portals["indeed"].append(
                f"https://in.indeed.com/jobs?q={_plus(keyword)}&l={_plus(city)}&fromage=7"
            )
            portals["foundit"].append(
                f"https://www.foundit.in/srp/results?query={_plus(keyword)}&locations={_plus(city)}&sort=1"
            )
    return portals


def _patch_sources(
    keywords: list[str] | None = None,
    cities: list[str] | None = None,
    role: str = "",
) -> None:
    try:
        from scrapers.linkedin_scraper import LinkedInScraper

        LinkedInScraper.GEO_IDS = dict(LINKEDIN_GEO_IDS)
        print("[run_source] LinkedIn geoIds patched for pan-India search")
    except Exception as exc:  # pragma: no cover - optional patch
        print(f"[run_source] LinkedIn patch skipped: {exc}")

    # The shared company-pages scraper only keeps design titles. Point it at BA
    # titles so BA roles from company career pages are not discarded.
    if role == "ba":
        try:
            import scrapers.company_pages_scraper as company_pages

            company_pages.DESIGN_KEYWORDS = list(BA_ROLE_KEYWORDS["high"]) + ["analyst"]
            print("[run_source] company-pages title filter patched for Business Analyst")
        except Exception as exc:
            print(f"[run_source] company-pages patch skipped: {exc}")

    # Point the browser scraper at the role's keywords/cities.
    if keywords:
        try:
            import scrapers.playwright_scraper as pw_scraper

            pw_scraper.PORTAL_SEARCHES = build_portal_searches(keywords, cities or PLAYWRIGHT_CITIES)
            print(
                "[run_source] Playwright PORTAL_SEARCHES patched: "
                f"{len(keywords)} keywords x {len(cities or PLAYWRIGHT_CITIES)} cities"
            )
        except Exception as exc:
            print(f"[run_source] Playwright searches patch skipped: {exc}")

    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            executable = pw.chromium.executable_path
        if executable and os.path.exists(executable):
            from scrapers.playwright_scraper import PlaywrightScraper

            PlaywrightScraper.CHROME_PATHS = [executable]
            print(f"[run_source] Playwright using bundled Chromium: {executable}")
    except Exception:
        # No bundled browser: the vendor code falls back to system Chrome (Windows).
        pass


def _disable_dashboard(main_module, config, repo_dir: str) -> None:
    class _NoDashboard:
        def __init__(self, *args, **kwargs):
            pass

        def generate(self, *args, **kwargs):
            return ""

    main_module.DashboardGenerator = _NoDashboard
    try:
        config.DASHBOARD_FILE = os.path.join(repo_dir, "_portal_dashboard.html")
    except Exception:
        pass


def _disable_validation() -> None:
    try:
        import link_validator

        def fast_validate(self, job):
            result = dict(job)
            result["validation_status"] = "VALID"
            result["http_status_code"] = 200
            result["validation_reason"] = "Validation skipped"
            return result

        link_validator.LinkValidator.validate = fast_validate
        print("[run_source] URL validation disabled")
    except Exception as exc:
        print(f"[run_source] Could not disable validation: {exc}")


def run(args) -> int:
    from export import export as export_db  # automation/export.py

    repo_dir = os.path.abspath(args.repo_dir)
    out_path = os.path.abspath(args.out)

    if not os.path.isdir(repo_dir):
        print(f"[run_source] repo dir not found: {repo_dir}")
        return 2

    sys.path.insert(0, repo_dir)
    os.chdir(repo_dir)

    config = importlib.import_module("config")
    _patch_config(config, args)

    scoring_engine = importlib.import_module("scoring_engine")
    _patch_scoring(scoring_engine, config, args.role)

    main_module = importlib.import_module("main")
    _disable_dashboard(main_module, config, repo_dir)
    _patch_sources(getattr(args, "keywords", None), getattr(args, "cities", None), args.role)

    if args.no_validate:
        _disable_validation()

    # Restrict to sources that exist in this repo's registry.
    registry = getattr(main_module, "SCRAPER_REGISTRY", {})
    sources = args.sources or None
    if sources:
        unknown = [s for s in sources if s not in registry]
        if unknown:
            print(f"[run_source] ignoring unknown sources for this repo: {unknown}")
        sources = [s for s in sources if s in registry]
        if not sources:
            print("[run_source] no valid sources supplied; using repo defaults")
            sources = None

    print("=" * 68)
    print(f"[run_source] role={args.role} repo={repo_dir}")
    print(f"[run_source] sources={sources or list(registry.keys())}")
    print(f"[run_source] min_score={args.min_score} max_days={args.max_days}")
    print("=" * 68)

    started = time.time()
    stats: dict = {}
    payload = None
    try:
        pipeline = main_module.JobSearchPipeline(sources=sources)
        stats = pipeline.run()
        elapsed = time.time() - started
        print(f"[run_source] pipeline finished in {elapsed:.0f}s: {json.dumps(stats)}")
    except Exception as exc:
        elapsed = time.time() - started
        print(f"[run_source] pipeline failed after {elapsed:.0f}s: {exc}")

    db_path = getattr(config, "DB_PATH", os.path.join(repo_dir, args.db))
    if os.path.exists(db_path):
        try:
            payload = export_db(db_path, args.role, args.min_score, args.limit, args.max_days)
        except Exception as exc:
            print(f"[run_source] export failed: {exc}")
    else:
        print(f"[run_source] DB not found at {db_path}")

    if payload is None:
        payload = {
            "role": args.role,
            "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
            "count": 0,
            "sources": {},
            "jobs": [],
        }

    # Direct portal scrapers (Naukri, Foundit, Indeed, Shine). These are the
    # primary sources: no API keys, no accounts, no signups.
    if not getattr(args, "no_portal", False):
        try:
            from portal_scrapers import collect_portal_jobs, merge_portal_jobs

            portal_jobs = collect_portal_jobs(
                args.role,
                getattr(args, "profile_data", {}) or {},
                args.max_days,
                args.min_score,
            )
            payload = merge_portal_jobs(payload, portal_jobs)
            print(f"[run_source] portal scrapers merged: {len(portal_jobs)} jobs")
        except Exception as exc:
            print(f"[run_source] portal scrapers skipped: {exc}")

    # Cloud-safe API sources (Adzuna, Jooble, Google Jobs, Remotive, Himalayas).
    # Always attempted, so the portal still gets data even when every scraper is blocked.
    if not args.no_apis:
        try:
            from api_sources import collect_api_jobs, merge_api_jobs

            api_jobs = collect_api_jobs(
                args.role,
                getattr(args, "profile_data", {}) or {},
                args.max_days,
                args.min_score,
                include_ats=not getattr(args, "no_ats", False),
            )
            payload = merge_api_jobs(payload, api_jobs)
        except Exception as exc:
            print(f"[run_source] API sources skipped: {exc}")

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(out_path) / 1024
    print(f"[run_source] wrote {out_path} ({size_kb:.0f} KB, {payload['count']} jobs)")

    status = {
        "role": args.role,
        "status": "success",
        "count": payload["count"],
        "sources": payload["sources"],
        "elapsed_seconds": round(elapsed),
        "stats": stats,
    }
    with open(f"{out_path}.status.json", "w", encoding="utf-8") as handle:
        json.dump(status, handle, ensure_ascii=False, indent=2)

    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description="Run a scraper repo with portal overrides")
    parser.add_argument("--role", required=True)
    parser.add_argument("--repo-dir", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", default=None, help="profiles/<role>.json (overrides db/sources/limits)")
    parser.add_argument("--db", default="jobs.db", help="Fallback DB filename")
    parser.add_argument("--sources", nargs="*", default=None)
    parser.add_argument("--min-score", type=float, default=20.0)
    parser.add_argument("--max-days", type=int, default=14)
    parser.add_argument("--limit", type=int, default=800)
    parser.add_argument("--max-keywords", type=int, default=0, help="Truncate keyword lists (debugging)")
    parser.add_argument("--no-playwright", action="store_true", help="Skip the browser source")
    parser.add_argument("--no-portal", action="store_true", help="Skip the direct portal scrapers")
    parser.add_argument("--no-apis", action="store_true", help="Skip the cloud-safe API sources")
    parser.add_argument("--no-ats", action="store_true", help="Skip company ATS boards")
    parser.add_argument("--no-validate", action="store_true")
    args = parser.parse_args()

    args.keywords = None
    args.cities = None
    args.profile_data = {}
    if args.profile:
        with open(args.profile, encoding="utf-8-sig") as handle:
            profile = json.load(handle)
        args.profile_data = profile
        args.db = profile.get("db", args.db)
        args.sources = profile.get("sources", args.sources)
        args.min_score = profile.get("min_score", args.min_score)
        args.max_days = profile.get("max_days", args.max_days)
        args.limit = profile.get("limit", args.limit)
        args.keywords = profile.get("keywords")
        args.cities = profile.get("cities")
        if profile.get("playwright"):
            sources = list(args.sources or [])
            if "playwright" not in sources:
                sources.insert(0, "playwright")
            args.sources = sources
        print(f"[run_source] loaded profile {args.profile}")

    if args.no_playwright and args.sources:
        args.sources = [s for s in args.sources if s != "playwright"]
        args.keywords = None

    raise SystemExit(run(args))


if __name__ == "__main__":
    main()
