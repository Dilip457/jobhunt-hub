#!/usr/bin/env python3
"""
portal_scrapers.py — Direct scrapers for Naukri, Foundit, Indeed and Shine.

These replace the vendor scrapers that stopped working. No API key, no signup,
no account. Two techniques:

  * Shine and Foundit  -> plain HTTP (their pages / JSON search endpoint)
  * Naukri and Indeed  -> a real Chrome via Playwright (their bot walls reject
                          the bundled headless shell, but accept Chrome)

Everything is filtered to India/Remote, de-duplicated and scored with the same
helpers the rest of the portal uses.

Usage (usually called by run_source.py):
    python automation/portal_scrapers.py --role uiux --out artifacts/uiux.portal.json
"""

from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.parse
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional

import requests
from bs4 import BeautifulSoup

from api_sources import ROLE_SEARCH_TERMS, build_job, title_relevant
from export import canonical_url, normalize_location

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
BASE_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-IN,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Upgrade-Insecure-Requests": "1",
}
TIMEOUT = 30
DEFAULT_CITIES = ["Bangalore", "Hyderabad", "Pune"]

STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-IN','en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
window.chrome = { runtime: {} };
"""


# ── Helpers ───────────────────────────────────────────────────────────────────

def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update(BASE_HEADERS)
    return s


def _clean(text: Any) -> str:
    """Decode HTML entities / percent-encoding and collapse whitespace."""
    if text is None:
        return ""
    value = html.unescape(str(text))
    if "%" in value:
        value = urllib.parse.unquote(value)
    return re.sub(r"\s+", " ", value).strip()


def _text(node) -> str:
    """Text of a BeautifulSoup node, or '' when the selector did not match."""
    return _clean(node.get_text(" ", strip=True)) if node else ""


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")


def _relative_date(text: str) -> Optional[str]:
    low = (text or "").lower()
    m = re.search(r"(\d+)\s*(minute|hour|day|week|month)", low)
    if not m:
        if "just" in low or "today" in low:
            return datetime.now(timezone.utc).date().isoformat()
        return None
    n = int(m.group(1))
    unit = m.group(2)
    days = {"minute": 0, "hour": 0, "day": n, "week": n * 7, "month": n * 30}[unit]
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def _absolute(url: str, base: str) -> str:
    if not url:
        return ""
    url = url.strip()
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return base.rstrip("/") + url
    return url


def _cities(profile: Dict[str, Any]) -> List[str]:
    cities = [c for c in (profile.get("cities") or []) if c]
    return cities[:3] or list(DEFAULT_CITIES)


def _queries(role: str, limit: int = 4) -> List[str]:
    return (ROLE_SEARCH_TERMS.get(role) or ["jobs"])[:limit]


# ── Playwright browser ────────────────────────────────────────────────────────

def _open_browser():
    """Return (playwright, browser). Prefer the system Chrome: Naukri's bot wall
    accepts real Chrome but rejects Playwright's bundled headless shell."""
    from playwright.sync_api import sync_playwright

    pw = sync_playwright().start()
    args = ["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage"]
    if os.name != "nt":
        args.append("--no-sandbox")
    try:
        return pw, pw.chromium.launch(channel="chrome", headless=True, args=args)
    except Exception as exc:
        print(f"[portal] system Chrome unavailable ({exc}); using bundled Chromium", file=sys.stderr)
        return pw, pw.chromium.launch(headless=True, args=args)


def _new_page(browser):
    ctx = browser.new_context(
        user_agent=USER_AGENT,
        locale="en-IN",
        viewport={"width": 1400, "height": 900},
    )
    ctx.add_init_script(STEALTH_JS)
    return ctx, ctx.new_page()


def _proxy_kwargs() -> Dict[str, Any]:
    """Route a request through WARP when WARP_PROXY is set (proxy mode).
    Unset means direct, so the other portals keep the runner IP."""
    proxy = os.environ.get("WARP_PROXY", "").strip()
    if not proxy:
        return {}
    return {"proxies": {"http": proxy, "https": proxy}}


def _warp_reconnect() -> bool:
    """Rotate the WARP egress IP. Some WARP IPs are challenged by Indeed while
    others return the SEO page, so a reconnect often fixes a 401/403."""
    if os.environ.get("WARP_SYSTEM") != "1":
        return False
    import subprocess

    try:
        subprocess.run(["warp-cli", "--accept-tos", "disconnect"], timeout=20, capture_output=True)
        time.sleep(2)
        subprocess.run(["warp-cli", "--accept-tos", "connect"], timeout=20, capture_output=True)
        time.sleep(6)
        return True
    except Exception as exc:
        print(f"[portal] indeed: WARP reconnect failed ({exc})", file=sys.stderr)
        return False


# ── Shine (plain HTTP) ────────────────────────────────────────────────────────

def fetch_shine(role: str, profile: Dict[str, Any], max_days: int) -> List[Dict[str, Any]]:
    session = _session()
    jobs: List[Dict[str, Any]] = []
    cities = _cities(profile)

    for query in _queries(role):
        for city in cities:
            for page in (1, 2):
                suffix = f"-{page}" if page > 1 else ""
                url = f"https://www.shine.com/job-search/{_slug(query)}-jobs-in-{city.lower()}{suffix}"
                try:
                    resp = session.get(url, timeout=TIMEOUT)
                except Exception as exc:
                    print(f"[portal] shine {url}: {exc}", file=sys.stderr)
                    continue
                if resp.status_code != 200:
                    print(f"[portal] shine {resp.status_code} {url}", file=sys.stderr)
                    continue

                soup = BeautifulSoup(resp.text, "lxml")
                for art in soup.select('article[itemprop="itemListElement"]'):
                    meta = art.select_one('meta[itemprop="url"]')
                    link = art.select_one('h3[itemprop="name"] a')
                    if not meta or not link:
                        continue
                    location_node = art.select_one('div[class*="result-card_meta"]')
                    job = build_job(
                        role, "Shine",
                        _text(link),
                        _text(art.select_one('span[class*="result-card_company"]')),
                        _text(location_node),
                        _clean(meta.get("content", "")),
                        _text(art),
                        _relative_date(_text(art.select_one('span[class*="result-card_posted"]'))),
                    )
                    if job:
                        jobs.append(job)
                time.sleep(1)
    return jobs


# ── Foundit (their own JSON search endpoint) ──────────────────────────────────

def fetch_foundit(role: str, profile: Dict[str, Any], max_days: int) -> List[Dict[str, Any]]:
    session = _session()
    session.headers.update({
        "Accept": "application/json, text/plain, */*",
        "Referer": "https://www.foundit.in/srp/results",
        "X-Requested-With": "XMLHttpRequest",
    })
    jobs: List[Dict[str, Any]] = []
    cities = _cities(profile)

    for query in _queries(role):
        for city in cities:
            for start in (0, 15):
                params = {"query": query, "locations": city, "start": start, "limit": 15, "sort": 1}
                try:
                    resp = session.get(
                        "https://www.foundit.in/middleware/jobsearch", params=params, timeout=TIMEOUT
                    )
                    payload = resp.json()
                except Exception as exc:
                    print(f"[portal] foundit {query}/{city}: {exc}", file=sys.stderr)
                    continue

                rows = ((payload.get("jobSearchResponse") or {}).get("data")) or []
                for row in rows:
                    url = row.get("jdUrl") or row.get("redirectUrl") or ""
                    if not url and row.get("jobId"):
                        url = f"https://www.foundit.in/job/{row['jobId']}"
                    created = row.get("createdAt")
                    posted = None
                    if isinstance(created, (int, float)):
                        posted = datetime.fromtimestamp(created / 1000, tz=timezone.utc).date().isoformat()
                    job = build_job(
                        role, "Foundit",
                        _clean(row.get("title", "")),
                        _clean(row.get("companyName", "")),
                        _clean(row.get("locations", "")),
                        _absolute(_clean(url), "https://www.foundit.in"),
                        _clean(row.get("skills", "") or ""),
                        posted,
                        row.get("jobId") or row.get("id"),
                    )
                    if job:
                        jobs.append(job)
                time.sleep(0.5)
    return jobs


# ── Naukri (real Chrome) ─────────────────────────────────────────────────────

def fetch_naukri(role: str, profile: Dict[str, Any], max_days: int) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    cities = _cities(profile)
    pw = browser = ctx = None
    try:
        pw, browser = _open_browser()
        ctx, page = _new_page(browser)
        for query in _queries(role):
            for city in cities:
                url = f"https://www.naukri.com/{_slug(query)}-jobs-in-{city.lower()}"
                try:
                    resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                    page.wait_for_timeout(5000)
                except Exception as exc:
                    print(f"[portal] naukri {url}: {exc}", file=sys.stderr)
                    continue
                if resp and resp.status >= 400:
                    print(f"[portal] naukri {resp.status} {url}", file=sys.stderr)
                    continue

                soup = BeautifulSoup(page.content(), "lxml")
                for card in soup.select("div.srp-jobtuple-wrapper, div.srp-jobtuple"):
                    link = card.select_one("a.title") or card.select_one('a[class*="title"]')
                    if not link:
                        continue
                    posted_text = _text(card.select_one(".job-post-day"))
                    job = build_job(
                        role, "Naukri",
                        _text(link),
                        _text(card.select_one(".comp-name")),
                        _text(card.select_one(".locWdth") or card.select_one(".loc")),
                        _clean(link.get("href", "")),
                        _text(card.select_one(".job-desc")),
                        _relative_date(posted_text),
                    )
                    if job:
                        jobs.append(job)
                time.sleep(2)
    finally:
        if ctx:
            ctx.close()
        if browser:
            browser.close()
        if pw:
            pw.stop()
    return jobs


# ── Indeed (Chrome TLS fingerprint, browser fallback) ────────────────────────

def _indeed_variants(query: str, city: str) -> List[str]:
    return [
        "https://in.indeed.com/jobs?" + urllib.parse.urlencode({"q": query, "l": city}),
        "https://in.indeed.com/m/jobs?" + urllib.parse.urlencode({"q": query, "l": city}),
        f"https://in.indeed.com/q-{_slug(query)}-l-{_slug(city)}-jobs.html",
    ]


def _parse_indeed_html(role: str, html: str) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    soup = BeautifulSoup(html, "lxml")
    for card in soup.select("div.job_seen_beacon"):
        anchor = card.select_one("h3.jobTitle a") or card.select_one("a.jobTitle")
        if not anchor:
            continue
        jk = anchor.get("data-jk") or ""
        if not jk:
            match = re.search(r"[?&]jk=([0-9a-zA-Z]+)", anchor.get("href", ""))
            jk = match.group(1) if match else ""
        if not jk:
            continue
        job = build_job(
            role, "Indeed",
            _text(anchor.select_one("span") or anchor),
            _text(card.select_one('[data-testid="company-name"]')),
            _text(card.select_one('[data-testid="text-location"]')),
            f"https://in.indeed.com/viewjob?jk={jk}",
            _text(card.select_one(".job-snippet")),
            datetime.now(timezone.utc).date().isoformat(),
            jk,
        )
        if job:
            jobs.append(job)
    return jobs


def _fetch_indeed_http(role: str, profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Indeed is behind Cloudflare: plain requests and headless Chrome both get
    a 'Just a moment...' challenge from datacenter IPs. curl_cffi reproduces
    Chrome's TLS/JA3 fingerprint, which often passes and returns the
    server-rendered HTML (no JS needed)."""
    try:
        from curl_cffi import requests as cffi_requests
    except Exception as exc:
        print(f"[portal] indeed: curl_cffi unavailable ({exc})", file=sys.stderr)
        return []

    jobs: List[Dict[str, Any]] = []
    session = cffi_requests.Session()
    warp_mode = os.environ.get("WARP_SYSTEM") == "1"
    warp_ready = not warp_mode
    request_timeout = 20 if warp_mode else 40

    if warp_mode:
        probe = "https://in.indeed.com/q-ui-ux-designer-l-bangalore-jobs.html"
        for attempt in range(1, 4):
            try:
                response = session.get(probe, impersonate="chrome", timeout=request_timeout)
            except Exception as exc:
                print(f"[portal] indeed: WARP probe error {exc}", file=sys.stderr)
                response = None
            if response is not None and response.status_code == 200 and "job_seen_beacon" in response.text:
                print(f"[portal] indeed: WARP IP accepted (attempt {attempt})", file=sys.stderr)
                warp_ready = True
                break
            status = response.status_code if response is not None else "?"
            print(f"[portal] indeed: WARP IP rejected ({status}); reconnecting", file=sys.stderr)
            if not _warp_reconnect():
                break
        if not warp_ready:
            print("[portal] indeed: no clean WARP IP; skipping", file=sys.stderr)
            return []

    for query in _queries(role):
        for city in _cities(profile):
            variants = _indeed_variants(query, city)
            if warp_mode:
                # Desktop and mobile always return 401/403 through WARP; the
                # server-rendered SEO page is the only surface worth trying.
                variants = [variants[-1]]
            for url in variants:
                try:
                    response = session.get(
                        url, impersonate="chrome", timeout=request_timeout, **_proxy_kwargs()
                    )
                except Exception as exc:
                    print(f"[portal] indeed {url}: {exc}", file=sys.stderr)
                    continue
                if response.status_code == 200 and "job_seen_beacon" in response.text:
                    found = _parse_indeed_html(role, response.text)
                    jobs.extend(found)
                    if found:
                        break
                elif response.status_code == 403:
                    print(f"[portal] indeed 403 (Cloudflare) {url}", file=sys.stderr)
    return jobs


def _fetch_indeed_browser(role: str, profile: Dict[str, Any]) -> List[Dict[str, Any]]:
    jobs: List[Dict[str, Any]] = []
    cities = _cities(profile)
    pw = browser = ctx = None
    try:
        pw, browser = _open_browser()
        ctx, page = _new_page(browser)

        try:
            home = page.goto("https://in.indeed.com/", wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(2500)
            if home and home.status >= 400:
                print(f"[portal] indeed: homepage {home.status}; browser fallback skipped", file=sys.stderr)
                return []
        except Exception as exc:
            print(f"[portal] indeed: homepage error {exc}", file=sys.stderr)

        for query in _queries(role):
            for city in cities:
                variants = _indeed_variants(query, city)
                resp = None
                used = ""
                for url in variants:
                    try:
                        resp = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                        page.wait_for_timeout(7000 if url == variants[0] else 5000)
                    except Exception as exc:
                        print(f"[portal] indeed {url}: {exc}", file=sys.stderr)
                        resp = None
                        continue
                    if resp and resp.status < 400:
                        used = url
                        break
                if not resp or resp.status >= 400:
                    print(
                        f"[portal] indeed {resp.status if resp else '?'} all variants for {query}/{city}",
                        file=sys.stderr,
                    )
                    continue
                if used != variants[0]:
                    print(f"[portal] indeed fallback OK: {used}", file=sys.stderr)
                jobs.extend(_parse_indeed_html(role, page.content()))
                time.sleep(3)
    finally:
        if ctx:
            ctx.close()
        if browser:
            browser.close()
        if pw:
            pw.stop()
    return jobs


def fetch_indeed(role: str, profile: Dict[str, Any], max_days: int) -> List[Dict[str, Any]]:
    """Try the fast TLS-impersonation path first; only start a browser if it
    returns nothing (e.g. Cloudflare changed its challenge). Inside the WARP
    job we never start a browser: headed/headless Chrome gets the same 401/403
    and a hung page.goto would stall the job."""
    jobs = _fetch_indeed_http(role, profile)
    if jobs:
        print(f"[portal] indeed: {len(jobs)} jobs via curl_cffi", file=sys.stderr)
        return jobs
    if os.environ.get("WARP_SYSTEM") == "1":
        print("[portal] indeed: HTTP path empty under WARP; skipping browser", file=sys.stderr)
        return jobs
    print("[portal] indeed: HTTP path empty; trying browser", file=sys.stderr)
    return _fetch_indeed_browser(role, profile)


# ── SimplyHired (Indeed's sister site, reachable via WARP) ───────────────────

def fetch_simplyhired(role: str, profile: Dict[str, Any], max_days: int) -> List[Dict[str, Any]]:
    """SimplyHired India carries Indeed's inventory. Cloudflare blocks it from
    datacenter IPs, so it only runs when traffic goes through WARP (either the
    system tunnel or the explicit WARP_PROXY)."""
    if not os.environ.get("WARP_PROXY", "").strip() and os.environ.get("WARP_SYSTEM", "") != "1":
        print("[portal] simplyhired: no WARP route; skipping", file=sys.stderr)
        return []
    try:
        from curl_cffi import requests as cffi_requests
    except Exception as exc:
        print(f"[portal] simplyhired: curl_cffi unavailable ({exc})", file=sys.stderr)
        return []

    today = datetime.now(timezone.utc).date().isoformat()
    session = cffi_requests.Session()
    jobs: List[Dict[str, Any]] = []
    failures = 0

    for query in _queries(role):
        for city in _cities(profile):
            url = "https://www.simplyhired.co.in/search?" + urllib.parse.urlencode(
                {"q": query, "l": city}
            )
            try:
                response = session.get(
                    url, impersonate="chrome", timeout=25, **_proxy_kwargs()
                )
            except Exception as exc:
                print(f"[portal] simplyhired {url}: {exc}", file=sys.stderr)
                failures += 1
                if failures >= 2:
                    print("[portal] simplyhired: proxy unreachable; stopping", file=sys.stderr)
                    return jobs
                continue
            if response.status_code != 200:
                print(f"[portal] simplyhired {response.status_code} {url}", file=sys.stderr)
                failures += 1
                if failures >= 3:
                    print("[portal] simplyhired: blocked; stopping", file=sys.stderr)
                    return jobs
                continue
            failures = 0
            soup = BeautifulSoup(response.text, "lxml")
            for card in soup.select("div[data-testid='searchSerpJob']"):
                link = card.select_one("h2[data-testid='searchSerpJobTitle'] a")
                if not link:
                    continue
                href = link.get("href", "")
                if href.startswith("/"):
                    href = "https://www.simplyhired.co.in" + href
                job = build_job(
                    role,
                    "SimplyHired",
                    _text(link),
                    _text(card.select_one("[data-testid='companyName']")),
                    _text(card.select_one("[data-testid='searchSerpJobLocation']")),
                    href,
                    _text(card),
                    today,
                    card.get("data-jobkey") or href,
                )
                if job:
                    jobs.append(job)
            time.sleep(1)

    print(f"[portal] simplyhired: {len(jobs)} raw jobs", file=sys.stderr)
    return jobs


# ── Collection ────────────────────────────────────────────────────────────────

SOURCES = (
    ("shine", fetch_shine),
    ("foundit", fetch_foundit),
    ("naukri", fetch_naukri),
    ("indeed", fetch_indeed),
    ("simplyhired", fetch_simplyhired),
)


def collect_portal_jobs(
    role: str,
    profile: Dict[str, Any],
    max_days: int,
    min_score: float = 20.0,
    sites: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_days)).date().isoformat()
    seen = set()
    seen_pairs = set()
    collected: List[Dict[str, Any]] = []
    counts: Dict[str, int] = {}

    for name, fetcher in SOURCES:
        if sites and name not in sites:
            continue
        try:
            found = fetcher(role, profile or {}, max_days) or []
        except Exception as exc:
            print(f"[portal] {name}: failed ({exc})", file=sys.stderr)
            found = []

        kept = 0
        for job in found:
            if (job.get("score") or 0) < min_score:
                continue
            key = canonical_url(job.get("url", ""))
            if not key or key in seen:
                continue
            pair = (
                (job.get("company") or "").strip().lower(),
                (job.get("title") or "").strip().lower(),
                (job.get("location") or "").strip().lower(),
            )
            if all(pair) and pair in seen_pairs:
                continue
            stamp = (job.get("posted_date") or "")[:10]
            if stamp and stamp < cutoff:
                continue
            seen.add(key)
            seen_pairs.add(pair)
            collected.append(job)
            kept += 1
        counts[name] = kept
        print(f"[portal] {name}: {kept} jobs kept", file=sys.stderr)

    print(f"[portal] role={role} total={len(collected)} {counts}", file=sys.stderr)
    return collected


def merge_portal_jobs(payload: Dict[str, Any], portal_jobs: List[Dict[str, Any]]) -> Dict[str, Any]:
    jobs = list(payload.get("jobs", []))
    seen = {canonical_url(j.get("url", "")) for j in jobs}
    for job in portal_jobs:
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
    parser = argparse.ArgumentParser(description="Scrape Naukri/Foundit/Indeed/Shine directly")
    parser.add_argument("--role", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--profile", default=None)
    parser.add_argument("--max-days", type=int, default=21)
    parser.add_argument("--min-score", type=float, default=20.0)
    parser.add_argument("--sites", nargs="*", default=None)
    args = parser.parse_args()

    profile: Dict[str, Any] = {}
    if args.profile and os.path.exists(args.profile):
        with open(args.profile, encoding="utf-8-sig") as handle:
            profile = json.load(handle)

    jobs = collect_portal_jobs(args.role, profile, args.max_days, args.min_score, args.sites)
    payload = merge_portal_jobs({"role": args.role, "jobs": []}, jobs)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))
    print(f"[portal] wrote {args.out} ({payload['count']} jobs)")


if __name__ == "__main__":
    main()
