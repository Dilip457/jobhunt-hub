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


def _patch_scoring(scoring_engine, config) -> None:
    scoring_engine.EXCLUDED_LOCATIONS = []
    scoring_engine.PREFERRED_LOCATIONS = list(PREFERRED_LOCATIONS)
    scoring_engine.MAX_EXPERIENCE_YEARS = 30

    # Public board: never hard-reject a job for years of experience.
    scoring_engine.ScoringEngine._check_experience_strict = (
        lambda self, title, description: (True, "experience filter disabled")
    )


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


def _patch_sources(keywords: list[str] | None = None, cities: list[str] | None = None) -> None:
    try:
        from scrapers.linkedin_scraper import LinkedInScraper

        LinkedInScraper.GEO_IDS = dict(LINKEDIN_GEO_IDS)
        print("[run_source] LinkedIn geoIds patched for pan-India search")
    except Exception as exc:  # pragma: no cover - optional patch
        print(f"[run_source] LinkedIn patch skipped: {exc}")

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
    _patch_scoring(scoring_engine, config)

    main_module = importlib.import_module("main")
    _disable_dashboard(main_module, config, repo_dir)
    _patch_sources(getattr(args, "keywords", None), getattr(args, "cities", None))

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
