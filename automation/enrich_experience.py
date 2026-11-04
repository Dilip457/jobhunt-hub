#!/usr/bin/env python3
"""
enrich_experience.py — Read the experience a posting states, from the posting.

The search cards most boards return say little about experience, and the
title says nothing reliable ("Associate" is a 7+ year grade at JPMorgan). For
every job that still has no stated experience after the card and listing
text were read, this module fetches the posting page once and parses it:

  * LinkedIn: the public job-posting endpoint gives the full description and
    LinkedIn's own "Seniority level" field.
  * Foundit: the job page embeds the listing JSON (min/max experience) and
    prints "5-9 Years" under the title.
  * Everything else (SimplyHired, company career pages, IIBA, Wellfound,
    Remote OK, We Work Remotely): the page text, parsed the same way as a
    description.

Results are recorded with their origin in `experience_source`:
  board  the board's own field on the card / search JSON
  text   years written in the title or scraped description
  page   years written on the posting page
  level  LinkedIn's seniority label (no number stated anywhere)
  title  only a fresher/intern/entry-level word in the title
A job whose posting states nothing keeps experience_min/max = None and is
stamped `experience_checked`, so it is not fetched again for RECHECK_DAYS.

A fresh scrape never carries those results: only the published JSON on the
data branch does. Pass the previously published payload as `previous` and its
answers are copied onto the same postings (matched by canonical URL) before
any fetch, so each posting page is read once, not once per run.

Usage inside the pipeline:
    from enrich_experience import enrich_payload, load_previous
    enrich_payload(payload, previous=load_previous("previous/ba.json"))

Probe (prints what the card will say for live jobs; run it on GitHub Actions,
where the boards are reachable):
    python automation/enrich_experience.py --probe --input ba.json --limit 10
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import ipaddress
import json
import os
import re
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import requests
from bs4 import BeautifulSoup

from export import canonical_url, extract_experience_with_source

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
}
TIMEOUT = 15
# Fetch budget per run and per role. After the first run only new jobs need a
# fetch, because publish keeps resolved values across runs.
DEFAULT_MAX_FETCHES = 300
DEFAULT_WORKERS = 4
# Seconds between two requests to the same host.
HOST_GAP = 0.5
# A posting that stated nothing is looked at again after this many days.
RECHECK_DAYS = 7

RESOLVED_SOURCES = {"board", "text", "page", "level"}
# Copied from the previous publish when the fresh card states nothing. Matches
# publish.EXPERIENCE_FIELDS, so the artifact and the published merge agree.
REUSED_FIELDS = ("experience_min", "experience_max", "experience_source", "experience_level")
# Boards whose posting page cannot be read with plain HTTP from a runner.
# Naukri's card already carries the years; Indeed blocks server fetches.
SKIP_SOURCES = {"naukri", "indeed"}
# These list experience (or their whole description) in the feed, so their pages
# add little, and Apna's pages hold figures that read like a range ("0 to 31
# years are eligible", "Age limit 18 - 35 years").
SKIP_SOURCES |= {"apna", "internshala", "unstop", "workable", "cutshort", "wellfound"}
# Instahyre's feed has no experience, but its posting page does. It is read under
# the project's name, within robots.txt, and slowly: its site rate-limits.
NAMED_LOOKUP_SOURCES = {"instahyre"}
HOST_GAPS = {"www.instahyre.com": 2.0}

LINKEDIN_ID_RE = re.compile(r"linkedin\.com/jobs/view/(?:[^/?#]*?-)?(\d{6,})")
LINKEDIN_POSTING = "https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}"
# LinkedIn's fixed vocabulary for the "Seniority level" criterion.
LINKEDIN_LEVELS = (
    "Internship",
    "Entry level",
    "Associate",
    "Mid-Senior level",
    "Director",
    "Executive",
)
LEVEL_LOOKUP = {level.lower(): level for level in LINKEDIN_LEVELS}
FOUNDIT_YEARS_RE = re.compile(r"(\d{1,2})\s*-\s*(\d{1,2})\s*Years?", re.I)


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def html_to_text(html: str) -> str:
    soup = BeautifulSoup(html or "", "lxml")
    for node in soup(["script", "style", "noscript"]):
        node.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ")).strip()


# ── Parsers (pure functions, unit-tested on saved markup) ─────────────────────

def parse_linkedin_posting(html: str) -> Tuple[str, Optional[str]]:
    """Return (description text, seniority level) from the guest posting HTML."""
    soup = BeautifulSoup(html or "", "lxml")
    description = ""
    node = soup.select_one(".show-more-less-html__markup, .description__text, .decorated-job-posting__details")
    if node:
        description = re.sub(r"\s+", " ", node.get_text(" ")).strip()

    level: Optional[str] = None
    for item in soup.select(".description__job-criteria-item"):
        heading = item.select_one("h3")
        value = item.select_one("span")
        if not heading or not value:
            continue
        if "seniority" in heading.get_text(" ").strip().lower():
            level = LEVEL_LOOKUP.get(re.sub(r"\s+", " ", value.get_text(" ")).strip().lower())
            break
    if level is None:
        # Fallback for markup changes: the label followed by one of the known values.
        text = re.sub(r"\s+", " ", soup.get_text(" "))
        m = re.search(r"Seniority level\s*([A-Za-z\- ]{4,20}?level|Internship|Associate|Director|Executive)", text)
        if m:
            level = LEVEL_LOOKUP.get(m.group(1).strip().lower())
    if not description:
        description = html_to_text(html)
    return description, level


def _walk_json(value: Any, found: Dict[str, Any], depth: int = 0) -> None:
    if depth > 12:
        return
    if isinstance(value, dict):
        for key, sub in value.items():
            k = key.lower()
            if "exp" in k and isinstance(sub, (int, float)) and not isinstance(sub, bool):
                if "min" in k:
                    found.setdefault("min", int(sub))
                elif "max" in k:
                    found.setdefault("max", int(sub))
            _walk_json(sub, found, depth + 1)
    elif isinstance(value, list):
        for sub in value:
            _walk_json(sub, found, depth + 1)


def parse_foundit_page(html: str) -> str:
    """Experience text from a Foundit job page ("5-9 years"), or ""."""
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html or "", re.S)
    if m:
        try:
            found: Dict[str, Any] = {}
            _walk_json(json.loads(m.group(1)), found)
            if "min" in found and "max" in found:
                return f"{found['min']}-{found['max']} years"
            if "min" in found:
                return f"{found['min']}+ years"
        except Exception:
            pass
    text = html_to_text(html)
    m = FOUNDIT_YEARS_RE.search(text)
    return f"{m.group(1)}-{m.group(2)} years" if m else ""


# ── Fetching ──────────────────────────────────────────────────────────────────

class HostThrottle:
    """At most one request per HOST_GAP seconds to each host."""

    def __init__(self, gap: float = HOST_GAP) -> None:
        self.gap = gap
        self._lock = threading.Lock()
        self._last: Dict[str, float] = {}
        self._host_locks: Dict[str, threading.Lock] = {}

    def wait(self, host: str) -> None:
        with self._lock:
            lock = self._host_locks.setdefault(host, threading.Lock())
        with lock:
            with self._lock:
                elapsed = time.monotonic() - self._last.get(host, 0.0)
            gap = HOST_GAPS.get(host, self.gap)
            if elapsed < gap:
                time.sleep(gap - elapsed)
            with self._lock:
                self._last[host] = time.monotonic()


def is_public_url(url: str) -> bool:
    """False for anything but http(s), and for local or private addresses given literally.

    The URLs come from scraped data, so one could point at the runner's own
    network (a cloud metadata address, say).
    """
    try:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
    except ValueError:
        return False
    if parts.scheme.lower() not in ("http", "https") or not host:
        return False
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        return ipaddress.ip_address(host).is_global
    except ValueError:
        return True


def fetch(
    url: str,
    session: requests.Session,
    throttle: HostThrottle,
    headers: Optional[Dict[str, str]] = None,
) -> Optional[str]:
    if not is_public_url(url):
        print(f"[experience] skipped non-public link: {url[:80]}", file=sys.stderr)
        return None
    host = urlsplit(url).netloc.lower()
    throttle.wait(host)
    try:
        response = session.get(url, timeout=TIMEOUT, allow_redirects=True, **({"headers": headers} if headers else {}))
    except Exception as exc:
        print(f"[experience] {url}: {exc}", file=sys.stderr)
        return None
    if response.status_code != 200 or not response.text:
        print(f"[experience] {url}: HTTP {response.status_code}", file=sys.stderr)
        return None
    # A redirect may have ended somewhere private; do not read what came back.
    if not is_public_url(getattr(response, "url", url) or url):
        print(f"[experience] {url}: redirected to a non-public address", file=sys.stderr)
        return None
    return response.text


def linkedin_posting_url(url: str) -> Optional[str]:
    m = LINKEDIN_ID_RE.search(url or "")
    return LINKEDIN_POSTING.format(id=m.group(1)) if m else None


def _checked_day(value: Any) -> Optional[str]:
    """The ISO day of an experience_checked stamp, or None if it is not a date."""
    try:
        return datetime.fromisoformat(str(value or "")[:10]).date().isoformat()
    except ValueError:
        return None


def needs_lookup(job: Dict[str, Any], today: Optional[str] = None) -> bool:
    if job.get("experience_source") in RESOLVED_SOURCES:
        return False
    if (job.get("source") or "").strip().lower() in SKIP_SOURCES:
        return False
    # A garbled stamp counts as never checked rather than as checked forever.
    checked = _checked_day(job.get("experience_checked"))
    if checked:
        today = today or _today()
        recheck = (datetime.fromisoformat(today) - timedelta(days=RECHECK_DAYS)).date().isoformat()
        if checked >= recheck:
            return False
    return bool(job.get("url"))


def load_previous(path: Optional[str]) -> Optional[Dict[str, Any]]:
    """The previously published role JSON, or None if absent or unreadable.

    The first run of a role, or a data branch that was never published, has
    no file; that is normal and must not stop the scrape.
    """
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
    except FileNotFoundError:
        return None
    except Exception as exc:
        print(f"[experience] previous data ignored ({path}): {exc}", file=sys.stderr)
        return None
    if not isinstance(payload, dict) or not isinstance(payload.get("jobs"), list):
        print(f"[experience] previous data ignored ({path}): no jobs list", file=sys.stderr)
        return None
    return payload


def reuse_previous(payload: Dict[str, Any], previous: Optional[Dict[str, Any]]) -> Dict[str, int]:
    """Copy earlier lookups from the published payload onto fresh jobs. Mutates payload.

    Mirrors publish.merge_payloads(): a fresh job that states experience on its
    own card (board/text) keeps it; otherwise a resolved previous answer
    (board/text/page/level) is copied, and experience_checked keeps the newer
    stamp so needs_lookup() honours the recheck window.
    """
    stats = {"resolved": 0, "checked": 0}
    if not previous:
        return stats
    earlier: Dict[str, Dict[str, Any]] = {}
    for job in previous.get("jobs") or []:
        if not isinstance(job, dict):
            continue
        key = canonical_url(job.get("url") or "")
        if key:
            earlier.setdefault(key, job)

    for job in payload.get("jobs") or []:
        old = earlier.get(canonical_url(job.get("url") or ""))
        if old is None:
            continue
        if (
            job.get("experience_source") not in RESOLVED_SOURCES
            and old.get("experience_source") in RESOLVED_SOURCES
        ):
            for field in REUSED_FIELDS:
                job[field] = old.get(field)
            stats["resolved"] += 1
        stamps = [d for d in (_checked_day(old.get("experience_checked")),
                              _checked_day(job.get("experience_checked"))) if d]
        if stamps and job.get("experience_checked") != max(stamps):
            job["experience_checked"] = max(stamps)
            stats["checked"] += 1
    return stats


def resolve_from_page(job: Dict[str, Any], html: str) -> Dict[str, Any]:
    """Fields to set on the job from its posting page (pure, for tests)."""
    source = (job.get("source") or "").strip().lower()
    title = job.get("title") or ""
    update: Dict[str, Any] = {"experience_checked": _today()}

    if source == "linkedin":
        description, level = parse_linkedin_posting(html)
        lo, hi, origin = extract_experience_with_source(title, description)
        if origin in ("board", "text"):
            update.update(experience_min=lo, experience_max=hi, experience_source="page")
        elif level:
            update.update(experience_min=None, experience_max=None, experience_source="level",
                          experience_level=level)
        return update

    if source == "foundit":
        experience = parse_foundit_page(html)
        lo, hi, origin = extract_experience_with_source(title, "", experience)
        if origin == "board":
            update.update(experience_min=lo, experience_max=hi, experience_source="page")
            return update

    text = html_to_text(html)
    lo, hi, origin = extract_experience_with_source(title, text)
    if origin in ("board", "text"):
        update.update(experience_min=lo, experience_max=hi, experience_source="page")
    return update


def lookup_job(job: Dict[str, Any], session: requests.Session, throttle: HostThrottle) -> Dict[str, Any]:
    url = job.get("url") or ""
    source = (job.get("source") or "").strip().lower()
    headers = None
    if source == "linkedin":
        url = linkedin_posting_url(url) or url
    elif source in NAMED_LOOKUP_SOURCES:
        from portal_scrapers import PROJECT_USER_AGENT, robots_allow

        if not robots_allow(url):
            return {}
        headers = {"User-Agent": PROJECT_USER_AGENT}
    html = fetch(url, session, throttle, headers)
    if html is None:
        return {}
    return resolve_from_page(job, html)


def enrich_payload(
    payload: Dict[str, Any],
    max_fetches: int = DEFAULT_MAX_FETCHES,
    workers: int = DEFAULT_WORKERS,
    previous: Optional[Dict[str, Any]] = None,
) -> Dict[str, int]:
    """Fill experience from posting pages for unresolved jobs. Mutates payload.

    `previous` is the last published payload for the role (see load_previous);
    its answers are reused first so only new or stale postings are fetched.
    """
    reused = reuse_previous(payload, previous)
    if previous is not None:
        print(f"[experience] reused from previous publish: {json.dumps(reused)}", file=sys.stderr)
    jobs = payload.get("jobs") or []
    candidates = [job for job in jobs if needs_lookup(job)]
    # Best-scored jobs first: they are the ones users see first.
    candidates.sort(key=lambda j: -(j.get("score") or 0))
    candidates = candidates[:max_fetches]
    stats = {"reused": reused["resolved"], "candidates": len(candidates),
             "page": 0, "level": 0, "none": 0, "failed": 0}
    if not candidates:
        return stats

    session = requests.Session()
    session.headers.update(HEADERS)
    throttle = HostThrottle()

    def work(job: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any]]:
        return job, lookup_job(job, session, throttle)

    with cf.ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for job, update in pool.map(work, candidates):
            if not update:
                stats["failed"] += 1
                continue
            job.update(update)
            origin = update.get("experience_source")
            if origin == "page":
                stats["page"] += 1
            elif origin == "level":
                stats["level"] += 1
            else:
                stats["none"] += 1
    print(f"[experience] {json.dumps(stats)}", file=sys.stderr)
    return stats


# ── Probe ─────────────────────────────────────────────────────────────────────

def card_text(job: Dict[str, Any]) -> str:
    """What the card will show (mirrors web/lib/utils.ts experienceLabel)."""
    lo, hi = job.get("experience_min"), job.get("experience_max")
    if lo is None and hi is None:
        return job.get("experience_level") or "Not stated in posting"
    if lo == 0 and (hi == 0 or hi is None):
        return "Fresher / entry level"
    if lo is not None and hi is not None:
        return f"{lo} yrs" if lo == hi else f"{lo}–{hi} yrs"
    if lo is not None:
        return f"{lo}+ yrs"
    return f"Up to {hi} yrs"


def probe(path: str, limit: int) -> int:
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    by_source: Dict[str, List[Dict[str, Any]]] = {}
    for job in payload.get("jobs") or []:
        if job.get("experience_source") in RESOLVED_SOURCES:
            continue
        if (job.get("source") or "").lower() in SKIP_SOURCES:
            continue
        by_source.setdefault(job.get("source") or "Unknown", []).append(job)

    session = requests.Session()
    session.headers.update(HEADERS)
    throttle = HostThrottle()
    rows = ["| Source | Title | Card will say | Origin |", "| --- | --- | --- | --- |"]
    totals: Dict[str, Dict[str, int]] = {}
    for source, jobs in sorted(by_source.items()):
        for job in jobs[:limit]:
            job.pop("experience_checked", None)
            update = lookup_job(job, session, throttle)
            job.update(update)
            origin = update.get("experience_source") or ("fetch failed" if not update else "not stated")
            totals.setdefault(source, {}).setdefault(origin, 0)
            totals[source][origin] += 1
            title = (job.get("title") or "")[:60].replace("|", "/")
            rows.append(f"| {source} | [{title}]({job.get('url')}) | {card_text(job)} | {origin} |")

    summary = ["### Experience probe", "", *rows, "", "| Source | Result | Count |", "| --- | --- | --- |"]
    for source, counts in sorted(totals.items()):
        for origin, count in sorted(counts.items()):
            summary.append(f"| {source} | {origin} | {count} |")
    text = "\n".join(summary) + "\n"
    print(text)
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a", encoding="utf-8") as handle:
            handle.write(text)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Fill experience from posting pages")
    parser.add_argument("--input", required=True, help="Role JSON (from the data branch or artifacts)")
    parser.add_argument("--output", default=None, help="Write the enriched JSON here")
    parser.add_argument("--probe", action="store_true", help="Fetch a few jobs per source and print a table")
    parser.add_argument("--limit", type=int, default=10, help="Jobs per source for --probe")
    parser.add_argument("--max-fetches", type=int, default=DEFAULT_MAX_FETCHES)
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS)
    args = parser.parse_args()

    if args.probe:
        return probe(args.input, args.limit)

    with open(args.input, encoding="utf-8") as handle:
        payload = json.load(handle)
    enrich_payload(payload, args.max_fetches, args.workers)
    out = args.output or args.input
    with open(out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
