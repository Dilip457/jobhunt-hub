#!/usr/bin/env python3
"""
export.py — Convert a scraper repo's SQLite DB into the portal's compact JSON.

Usage:
    python automation/export.py \
        --db vendor/uiux/jobs.db \
        --role uiux \
        --out web/data/uiux.json \
        --min-score 25

Design goals:
  * Public-safe: no full descriptions (only a short snippet), no resume/PII.
  * Pan-India: only India + Remote locations survive; foreign listings are dropped.
  * Small payload: strongly typed, ~250-500 bytes per job.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from html import unescape
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode

# ── City normalisation ────────────────────────────────────────────────────────

CITY_ALIASES = {
    "bengaluru": "Bangalore",
    "bangalore": "Bangalore",
    "bombay": "Mumbai",
    "mumbai": "Mumbai",
    "new delhi": "Delhi",
    "delhi ncr": "Delhi",
    "delhi": "Delhi",
    "gurugram": "Gurgaon",
    "gurgaon": "Gurgaon",
    "noida": "Noida",
    "hyderabad": "Hyderabad",
    "secunderabad": "Hyderabad",
    "pune": "Pune",
    "puna": "Pune",
    "chennai": "Chennai",
    "madras": "Chennai",
    "kolkata": "Kolkata",
    "calcutta": "Kolkata",
    "ahmedabad": "Ahmedabad",
    "jaipur": "Jaipur",
    "kochi": "Kochi",
    "cochin": "Kochi",
    "coimbatore": "Coimbatore",
    "indore": "Indore",
    "chandigarh": "Chandigarh",
    "lucknow": "Lucknow",
    "nagpur": "Nagpur",
    "bhubaneswar": "Bhubaneswar",
    "mysore": "Mysore",
    "mysuru": "Mysore",
    "thiruvananthapuram": "Trivandrum",
    "trivandrum": "Trivandrum",
    "visakhapatnam": "Visakhapatnam",
    "vizag": "Visakhapatnam",
    "surat": "Surat",
    "vadodara": "Vadodara",
    "nashik": "Nashik",
    "madurai": "Madurai",
    "trichy": "Trichy",
    "tiruchirappalli": "Trichy",
    "mangalore": "Mangalore",
    "mangaluru": "Mangalore",
    "udaipur": "Udaipur",
    "dehradun": "Dehradun",
    "goa": "Goa",
    "panaji": "Goa",
    "remote": "Remote",
    "work from home": "Remote",
    "wfh": "Remote",
    "anywhere": "Remote",
}

INDIA_STATES = {
    "telangana", "andhra pradesh", "karnataka", "tamil nadu", "maharashtra",
    "delhi", "haryana", "uttar pradesh", "west bengal", "gujarat", "rajasthan",
    "kerala", "madhya pradesh", "punjab", "odisha", "bihar", "jharkhand",
    "assam", "goa", "uttarakhand", "himachal pradesh", "chhattisgarh",
    "india", "ind", "bharat",
}

FOREIGN_MARKERS = {
    "united states", "usa", "u.s.", "united kingdom", "uk", "england",
    "canada", "australia", "singapore", "dubai", "uae", "germany", "france",
    "netherlands", "ireland", "poland", "spain", "italy", "japan", "china",
    "new york", "london", "san francisco", "seattle", "boston", "austin",
    "toronto", "berlin", "amsterdam", "paris", "sydney", "melbourne",
    "remote - us", "remote, us", "emea", "apac",
    "vancouver", "montreal", "brazil", "brasil", "latam", "latin america",
    "mexico", "argentina", "colombia", "chile", "peru", "costa rica",
    "poland", "romania", "portugal", "czech", "hungary", "ukraine", "russia",
    "sweden", "norway", "denmark", "finland", "switzerland", "austria",
    "belgium", "luxembourg", "greece", "turkey", "israel", "egypt", "nigeria",
    "kenya", "south africa", "philippines", "malaysia", "thailand", "vietnam",
    "indonesia", "hong kong", "taiwan", "korea", "saudi", "qatar", "kuwait",
    "bahrain", "oman", "new zealand", "los angeles", "chicago", "denver",
    "atlanta", "dallas", "houston", "miami", "phoenix", "portland",
    "washington", "philadelphia", "detroit", "minneapolis", "columbus",
    "barcelona", "madrid", "munich", "hamburg", "frankfurt", "dublin",
    "manchester", "edinburgh", "bristol", "stockholm", "oslo", "helsinki",
    "copenhagen", "zurich", "geneva", "vienna", "prague", "warsaw", "lisbon",
    "athens", "istanbul", "tel aviv", "cairo", "lagos", "nairobi",
    "johannesburg", "cape town", "manila", "kuala lumpur", "bangkok",
    "jakarta", "taipei", "seoul", "tokyo", "osaka", "shanghai", "beijing",
    "shenzhen", "riyadh", "doha",
}


def normalize_location(raw: str) -> Tuple[str, bool]:
    """Return (city, is_india_or_remote). Foreign jobs are excluded."""
    if not raw:
        return ("India", True)

    text = unescape(str(raw)).strip()
    low = text.lower()

    if low in ("unknown", "n/a", "-", "none"):
        return ("India", True)

    is_remote = any(k in low for k in ("remote", "work from home", "wfh", "anywhere"))
    if is_remote:
        return ("Remote", True)

    if any(marker in low for marker in FOREIGN_MARKERS):
        # "remote - us" already handled above; genuine foreign locations drop out
        return (text, False)

    for alias, canonical in CITY_ALIASES.items():
        if alias in low:
            return (canonical, True)

    for state in INDIA_STATES:
        if re.search(rf"\b{re.escape(state)}\b", low):
            return ("India", True)

    # Unknown location: keep it, tagged India so it is not silently lost.
    return ("India", True)


def looks_foreign(text: str) -> bool:
    """True when a free-text field names a non-India place we recognise."""
    low = unescape(str(text or "")).lower()
    for marker in FOREIGN_MARKERS:
        if re.search(rf"(?<![a-z]){re.escape(marker)}(?![a-z])", low):
            return True
    return False


# ── Experience extraction ─────────────────────────────────────────────────────

EXP_RANGE_RE = re.compile(r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)
EXP_PLUS_RE = re.compile(r"(\d{1,2})\s*\+\s*(?:years?|yrs?)", re.I)
EXP_MIN_RE = re.compile(r"(?:minimum|min|at\s+least|atleast)\s+(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)
EXP_OF_RE = re.compile(r"(?:experience|exp)\s*(?:of|:|=)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)

TITLE_EXP = [
    (re.compile(r"\b(intern|internship|trainee|fresher|graduate)\b", re.I), (0, 0)),
    (re.compile(r"\b(junior|jr\.?|associate|entry)\b", re.I), (0, 2)),
    (re.compile(r"\b(principal|staff|director|head|vp|vice president|fellow)\b", re.I), (8, None)),
    (re.compile(r"\b(architect|manager)\b", re.I), (6, None)),
    (re.compile(r"\b(lead|senior|sr\.?)\b", re.I), (5, None)),
]


def extract_experience(title: str, description: str) -> Tuple[Optional[int], Optional[int]]:
    text = f"{title or ''}. {description or ''}"

    m = EXP_RANGE_RE.search(text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        if lo > hi:
            lo, hi = hi, lo
        return (lo, hi)

    m = EXP_MIN_RE.search(text)
    if m:
        return (int(m.group(1)), None)

    m = EXP_PLUS_RE.search(text)
    if m:
        return (int(m.group(1)), None)

    m = EXP_OF_RE.search(text)
    if m:
        return (int(m.group(1)), None)

    for pattern, span in TITLE_EXP:
        if pattern.search(title or ""):
            return span

    return (None, None)


# ── Helpers ───────────────────────────────────────────────────────────────────

TRACKING_PARAMS = {
    "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "ref", "refid", "source", "trackingid", "originaljob",
    "posted", "search", "pos", "s", "vjs", "ss",
}


def canonical_url(url: str) -> str:
    if not url:
        return ""
    try:
        parts = urlsplit(url.strip())
        query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
                 if k.lower() not in TRACKING_PARAMS]
        path = parts.path.rstrip("/") or "/"
        return urlunsplit((parts.scheme, parts.netloc.lower(), path, urlencode(query), ""))
    except Exception:
        return url.strip()


def make_snippet(description: str, limit: int = 240) -> str:
    if not description:
        return ""
    text = unescape(str(description))
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\{\{.*?\}\}", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if " " in cut:
        cut = cut[: cut.rfind(" ")]
    return cut.strip() + "…"


def clean_company(company: str) -> str:
    value = unescape(str(company or "")).strip()
    if not value or value.lower() in {"unknown", "n/a", "na", "-", "none", "null"}:
        return "Unknown"
    return value[:120]


def clean_title(title: str) -> str:
    value = unescape(str(title or "")).strip()
    value = re.sub(r"\s*\|\s*.*$", "", value).strip()
    return value[:180] or "Untitled role"


def valid_url(url: str) -> bool:
    if not url:
        return False
    low = url.strip().lower()
    return low.startswith("http://") or low.startswith("https://")


# ── Export ────────────────────────────────────────────────────────────────────

def export(db_path: str, role: str, min_score: float, limit: int, max_days: int = 21) -> Dict[str, Any]:
    if not os.path.exists(db_path):
        raise SystemExit(f"[export] DB not found: {db_path}")

    cutoff = (datetime.now(timezone.utc) - timedelta(days=max_days)).date().isoformat()

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        """
        SELECT job_id, title, company, location, url, apply_url, source,
               posted_date, description, match_score,
               role_match, skill_match, experience_match, tool_match, domain_match,
               validation_status, is_new, first_seen, last_seen
        FROM jobs
        WHERE (validation_status IS NULL OR validation_status IN ('VALID', 'PENDING'))
          AND match_score >= ?
        ORDER BY match_score DESC, posted_date DESC
        """,
        (min_score,),
    ).fetchall()

    jobs: List[Dict[str, Any]] = []
    seen = set()
    sources: Dict[str, int] = {}
    dropped_foreign = 0
    dropped_stale = 0

    for row in rows:
        url = (row["url"] or "").strip()
        if not valid_url(url):
            continue
        key = canonical_url(url)
        if not key or key in seen:
            continue

        city, keep = normalize_location(row["location"] or "")
        if not keep:
            dropped_foreign += 1
            continue

        seen.add(key)

        exp_min, exp_max = extract_experience(row["title"], row["description"])
        source = (row["source"] or "Unknown").strip() or "Unknown"
        sources[source] = sources.get(source, 0) + 1

        posted = (row["posted_date"] or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", posted):
            fallback = (row["last_seen"] or row["first_seen"] or "")[:10]
            posted = fallback if re.match(r"^\d{4}-\d{2}-\d{2}$", fallback) else ""

        # Never publish jobs that have aged out. The scraper DB ships inside the
        # vendor repos, so without this a fresh clone would re-publish months-old
        # rows (e.g. Indeed/Shine) as if they were current.
        if posted and posted < cutoff:
            dropped_stale += 1
            continue

        job = {
            "id": str(row["job_id"] or key),
            "title": clean_title(row["title"]),
            "company": clean_company(row["company"]),
            "location": city,
            "url": url,
            "apply_url": (row["apply_url"] or url).strip(),
            "source": source,
            "posted_date": posted or None,
            "score": round(float(row["match_score"] or 0), 1),
            "score_parts": {
                "role": round(float(row["role_match"] or 0), 1),
                "skill": round(float(row["skill_match"] or 0), 1),
                "experience": round(float(row["experience_match"] or 0), 1),
                "tool": round(float(row["tool_match"] or 0), 1),
                "domain": round(float(row["domain_match"] or 0), 1),
            },
            "experience_min": exp_min,
            "experience_max": exp_max,
            "snippet": make_snippet(row["description"]),
            "is_new": bool(row["is_new"]),
            "first_seen": (row["first_seen"] or "")[:10] or None,
        }
        jobs.append(job)
        if len(jobs) >= limit:
            break

    conn.close()

    jobs.sort(key=lambda j: (-j["score"], j["posted_date"] or ""))

    payload = {
        "role": role,
        "generated_at": datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(jobs),
        "sources": dict(sorted(sources.items(), key=lambda kv: -kv[1])),
        "jobs": jobs,
    }

    print(
        f"[export] role={role} jobs={len(jobs)} sources={len(sources)} "
        f"dropped_foreign={dropped_foreign} dropped_stale={dropped_stale}",
        file=sys.stderr,
    )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a scraper SQLite DB to portal JSON")
    parser.add_argument("--db", required=True, help="Path to the scraper's SQLite DB")
    parser.add_argument("--role", required=True, help="Role slug: genai | data | uiux")
    parser.add_argument("--out", required=True, help="Output JSON path")
    parser.add_argument("--min-score", type=float, default=25.0)
    parser.add_argument("--limit", type=int, default=800)
    parser.add_argument("--max-days", type=int, default=21, help="Drop jobs older than this (days)")
    args = parser.parse_args()

    payload = export(args.db, args.role, args.min_score, args.limit, args.max_days)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(args.out) / 1024
    print(f"[export] wrote {args.out} ({size_kb:.0f} KB)", file=sys.stderr)


if __name__ == "__main__":
    main()
