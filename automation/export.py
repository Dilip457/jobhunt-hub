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

# Indian places that do not get a city label of their own. They still count
# as a positive India match (labelled "India"), which matters for global
# sources: those drop any location they cannot place.
INDIA_PLACES = {
    "thane", "hosur", "mohali", "ghaziabad", "faridabad", "vijayawada",
    "guntur", "warangal", "raipur", "ranchi", "patna", "bhopal", "guwahati",
    "kanpur", "varanasi", "agra", "meerut", "ludhiana", "amritsar",
    "jalandhar", "jodhpur", "rajkot", "gandhinagar", "aurangabad", "kolhapur",
    "solapur", "belgaum", "belagavi", "hubli", "dharwad", "manipal", "udupi",
    "tirupati", "nellore", "salem", "erode", "tiruppur", "vellore",
    "pondicherry", "puducherry", "thrissur", "kozhikode", "calicut", "kannur",
    "siliguri", "durgapur", "jamshedpur", "cuttack", "rourkela", "gwalior",
    "jabalpur", "ujjain", "srinagar", "jammu", "shimla", "haridwar", "roorkee",
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
    "romania", "portugal", "czech", "hungary", "ukraine", "russia",
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
    # Regions. Global boards often give only a region ("Remote (Americas)").
    "americas", "north america", "south america", "central america", "europe",
    "eu", "eea", "mena", "anz", "nordics", "dach", "benelux", "baltics",
    # US states and the tech-hub cities that global career pages list.
    "california", "texas", "florida", "illinois", "massachusetts", "virginia",
    "north carolina", "south carolina", "georgia", "ohio", "michigan",
    "pennsylvania", "new jersey", "colorado", "arizona", "oregon", "utah",
    "minnesota", "wisconsin", "missouri", "tennessee", "maryland", "indiana",
    "kentucky", "connecticut", "iowa", "kansas", "nevada", "alabama",
    "louisiana", "oklahoma", "nebraska", "idaho", "delaware", "new hampshire",
    "rhode island", "vermont", "new mexico", "alaska", "hawaii",
    "san jose", "mountain view", "sunnyvale", "palo alto", "menlo park",
    "santa clara", "cupertino", "redwood city", "bellevue", "redmond",
    "kirkland", "san diego", "irvine", "sacramento", "raleigh", "pittsburgh",
    "salt lake city", "nashville", "charlotte", "st. louis", "kansas city",
    "indianapolis", "cincinnati", "cleveland", "baltimore", "san antonio",
    "orlando", "tampa", "las vegas", "jersey city", "brooklyn", "plano",
    "memphis", "knoxville", "chattanooga",
    # Canada, Latin America, Europe, Africa, Middle East, Asia-Pacific.
    "ontario", "quebec", "british columbia", "alberta", "calgary", "ottawa",
    "edmonton", "mississauga", "sao paulo", "são paulo", "rio de janeiro",
    "buenos aires", "bogota", "bogotá", "medellin", "medellín", "mexico city",
    "guadalajara", "monterrey", "uruguay", "montevideo", "ecuador",
    "guatemala", "panama", "puerto rico",
    "bulgaria", "sofia", "bucharest", "cluj", "estonia", "tallinn", "latvia",
    "riga", "lithuania", "vilnius", "serbia", "belgrade", "croatia", "zagreb",
    "slovakia", "bratislava", "slovenia", "ljubljana", "krakow", "kraków",
    "wroclaw", "wrocław", "gdansk", "katowice", "budapest", "kyiv", "kiev",
    "lviv", "belarus", "minsk", "armenia", "yerevan", "cyprus", "malta",
    "msida", "iceland", "scotland", "wales", "glasgow", "belfast", "leeds",
    "rotterdam", "eindhoven", "utrecht", "the hague", "brussels", "antwerp",
    "lyon", "toulouse", "milan", "rome", "turin", "porto", "valencia",
    "gothenburg", "malmo", "malmö", "aarhus", "espoo", "cologne", "stuttgart",
    "dusseldorf", "düsseldorf", "leipzig", "dresden", "nuremberg", "basel",
    "lausanne", "morocco", "casablanca", "tunisia", "ghana", "accra",
    "ethiopia", "uganda", "rwanda", "abu dhabi", "sharjah", "jeddah", "muscat",
    "jordan", "amman", "lebanon", "pakistan", "karachi", "lahore",
    "islamabad", "bangladesh", "dhaka", "sri lanka", "colombo", "nepal",
    "kathmandu", "ho chi minh", "hanoi", "da nang", "guangzhou", "hangzhou",
    "chengdu", "makati", "cebu", "penang", "auckland", "brisbane", "perth",
    "adelaide", "canberra",
}

# One whole-word alternation over FOREIGN_MARKERS, longest marker first.
_FOREIGN_RE = re.compile(
    r"(?<![a-z])(?:"
    + "|".join(re.escape(m) for m in sorted(FOREIGN_MARKERS, key=len, reverse=True))
    + r")(?![a-z])"
)

# "San Jose, CA" / "Bellevue, WA 98004": a US state code after a comma, dash or
# bracket. Matched on the original casing so prose words never count. Codes
# that are also Indian state or country codes (IN, TN, GA, AR, MN, OR, LA, CT)
# are left out: "Hosur, TN" is Tamil Nadu and "Pune, IN" is India.
US_STATE_CODE_RE = re.compile(
    r"[,\-–(]\s*(?:AL|AK|AZ|CA|CO|DE|FL|HI|ID|IL|IA|KS|KY|ME|MD|MA|MI|MS|MO|MT|"
    r"NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|PA|RI|SC|SD|TX|UT|VT|VA|WA|WV|WI|WY|DC)"
    r"(?:\s+\d{5})?\s*(?=[,)]|$)"
)

REMOTE_WORDS = ("remote", "work from home", "wfh", "anywhere", "worldwide", "global")

# A remote role can still be restricted to a country we cannot work from.
# Strip the generic remote words, then look for a foreign country/region.
REMOTE_FOREIGN_RE = re.compile(
    r"\b(us|usa|u\.s\.|united states|uk|united kingdom|england|canada|emea|apac|"
    r"europe|eu|australia|singapore|uae|dubai|germany|france|netherlands|ireland|"
    r"poland|spain|italy|japan|china|brazil|latam|latin america|mexico|argentina|"
    r"colombia|chile|peru|philippines|malaysia|thailand|vietnam|indonesia|"
    r"hong kong|taiwan|korea|saudi|qatar|new zealand|americas|north america)\b",
    re.I,
)

# Global career pages give Indian sites as "Gangaikondan, TN" or "Sanand, GJ".
# Indian state codes that are also common foreign codes (GA, AR, MN, OR, LA,
# CT, UT, CH, SK, TR, NL, BR, ...) are left out. Checked after the foreign
# markers, so "Nashville, TN" is still dropped.
INDIA_STATE_CODE_RE = re.compile(
    r",\s*(?:TN|KA|KL|MH|TS|TG|AP|GJ|DL|HR|UP|WB|RJ|MP|PB|OD|HP|JK|JH|CG)\s*$"
)

# "APAC (excluding India)" names India only to rule it out.
INDIA_EXCLUDED_RE = re.compile(
    r"\b(?:excluding|except|excl\.?|outside(?:\s+of)?|not\s+in)\s+india\b", re.I
)


def _india_place(low: str) -> Optional[str]:
    """Canonical city when low names an Indian place ("India" for states and
    minor places), else None."""
    if INDIA_EXCLUDED_RE.search(low):
        return None
    for alias, canonical in CITY_ALIASES.items():
        if canonical != "Remote" and _has_word(alias, low):
            return canonical
    for place in INDIA_STATES | INDIA_PLACES:
        if _has_word(place, low):
            return "India"
    return None


def _foreign_location(text: str) -> bool:
    return looks_foreign(text) or US_STATE_CODE_RE.search(text) is not None


def normalize_location(raw: str, strict: bool = False) -> Tuple[str, bool]:
    """Return (city, is_india_or_remote). Foreign jobs are excluded.

    Indian job boards rarely list a foreign city, so by default a location we
    cannot place is kept and labelled "India". Global sources (company career
    pages, remote boards, job APIs) list jobs worldwide: with ``strict`` a job
    is kept only when its location positively names India or an India-eligible
    remote, and anything we cannot place is dropped.
    """
    text = re.sub(r"\s+", " ", unescape(str(raw or ""))).strip()
    low = text.lower()

    if low in ("", "unknown", "n/a", "-", "none"):
        return (text, False) if strict else ("India", True)

    is_remote = any(k in low for k in REMOTE_WORDS)
    if is_remote:
        remainder = low
        for word in REMOTE_WORDS:
            remainder = remainder.replace(word, " ")
        # "Remote - US or India" is open to India; "Remote (Americas)" is not.
        if _india_place(remainder):
            return ("Remote", True)
        if (REMOTE_FOREIGN_RE.search(remainder) or looks_foreign(remainder)
                or US_STATE_CODE_RE.search(text) or INDIA_EXCLUDED_RE.search(low)):
            return (text, False)
        return ("Remote", True)

    # Indian places are matched first and on word boundaries. A plain
    # substring check against FOREIGN_MARKERS used to drop real localities:
    # "Kukatpally" contains "uk", "Perungudi" and "Sriperumbudur" contain "peru".
    # Word boundaries also stop "Indianapolis" from matching "india".
    city = _india_place(low)
    if city:
        return (city, True)

    if _foreign_location(text):
        # "remote - us" already handled above; genuine foreign locations drop out
        return (text, False)

    if INDIA_STATE_CODE_RE.search(text):
        return ("India", True)

    if strict:
        return (text, False)
    # Unknown location on an Indian board: keep it, tagged India so it is not
    # silently lost.
    return ("India", True)


def _has_word(token: str, text: str) -> bool:
    """True when token appears in text as a whole word (letters on neither side)."""
    return re.search(rf"(?<![a-z]){re.escape(token)}(?![a-z])", text) is not None


NON_ENGLISH_MARKERS = {
    "pflichtpraktikum", "werkstudent", "praktikum", "stagiaire", "alternance",
    "becario", "practicas", "prácticas", "praticas",
}


def looks_foreign(text: str) -> bool:
    """True when a free-text field names a non-India place we recognise.

    Also rejects titles written in a language the India-facing board does not
    target (e.g. Bosch's German "Pflichtpraktikum" listing).
    """
    low = unescape(str(text or "")).lower()
    if _FOREIGN_RE.search(low):
        return True
    for marker in NON_ENGLISH_MARKERS:
        if re.search(rf"(?<![a-z]){re.escape(marker)}(?![a-z])", low):
            return True
    return False


# ── Experience extraction ─────────────────────────────────────────────────────

EXP_RANGE_RE = re.compile(r"(\d{1,2})\s*(?:-|–|to)\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)
EXP_PLUS_RE = re.compile(r"(\d{1,2})\s*\+\s*(?:years?|yrs?)", re.I)
EXP_MIN_RE = re.compile(r"(?:minimum|min|at\s+least|atleast)\s+(?:of\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)
EXP_OF_RE = re.compile(r"(?:experience|exp)\s*(?:of|:|=|-)?\s*(\d{1,2})\s*\+?\s*(?:years?|yrs?)", re.I)

# Title words that genuinely state the experience level. Everything else that
# used to be here ("associate", "senior", "manager", ...) was a guess, and the
# guess was often wrong: "Associate" at JPMorgan is a 7+ year grade and
# "Senior Associate" at Amgen asks for 5-9 years, yet both showed "0-2 yrs".
# A listing that states no years now shows none.
TITLE_EXP = [
    (re.compile(r"\b(intern|internship|trainee|fresher|freshers)\b", re.I), (0, 0)),
    (re.compile(r"\b(entry[\s-]?level|new\s+grad(?:uate)?|campus\s+hire)\b", re.I), (0, 1)),
]

# Business Analyst is an entry-level-first track. The vendor DB score is kept,
# but fresher/entry/1–3 year titles are lifted and senior titles are pushed
# down so the dashboard opens on the roles the user actually wants.
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


# SDE targets 3-8 years. Titles are the fallback when a listing states no range.
SDE_BAND = (3, 8)
SDE_IN_BAND_TITLE = re.compile(
    r"\b(senior|sr\.?|lead|sde\s*(?:ii|2|iii|3)|engineer\s*(?:ii|2|iii|3)|specialist)\b",
    re.I,
)
SDE_OVER_TITLE = re.compile(
    r"\b(principal|staff|architect|director|vp|vice president|head of|distinguished)\b",
    re.I,
)
SDE_UNDER_TITLE = re.compile(
    r"\b(fresher|entry[\s-]?level|graduate|intern|trainee|junior)\b", re.I
)


def sde_band_score(
    title: str,
    score: float,
    exp_min: Optional[int] = None,
    exp_max: Optional[int] = None,
) -> float:
    """Nudge an SDE listing by how well it fits the 3-8 year target band.

    The band wins on the published score, so the dashboard's default
    score-descending sort surfaces 3-8 year roles before fresher and very
    senior ones.
    """
    band_lo, band_hi = SDE_BAND
    value = float(score or 0)

    # Title overrides first: "Principal" extracts (8, None) from the title
    # fallback and would otherwise be treated as squarely in-band.
    if SDE_OVER_TITLE.search(title or ""):
        return max(0.0, min(value - 10, 100.0))
    if SDE_UNDER_TITLE.search(title or ""):
        return max(0.0, min(value - 12, 100.0))

    if exp_min is not None or exp_max is not None:
        start = exp_min if exp_min is not None else exp_max
        end = exp_max if exp_max is not None else exp_min
        low, high = min(start, end), max(start, end)
        overlap = min(high, band_hi) - max(low, band_lo) + 1
        if low >= band_lo and high <= band_hi:
            value += 8
        elif overlap >= 3:
            value += 6
        elif overlap >= 1:
            value += 3
        elif high < band_lo:
            value -= 12
        else:
            value -= 10
        return max(0.0, min(value, 100.0))

    if SDE_IN_BAND_TITLE.search(title or ""):
        value += 5
    return max(0.0, min(value, 100.0))


def priority_score(
    role: str,
    title: str,
    score: float,
    exp_min: Optional[int] = None,
    exp_max: Optional[int] = None,
) -> float:
    if role == "ba":
        value = float(score or 0)
        if BA_ENTRY_TITLE.search(title or ""):
            value += 10
        if BA_SENIOR_TITLE.search(title or ""):
            value -= 12
        return round(max(0.0, min(value, 100.0)), 1)
    if role == "sde":
        return round(sde_band_score(title, float(score or 0), exp_min, exp_max), 1)
    return score


ExperienceSource = Optional[str]  # "board" | "text" | "page" | "level" | "title" | None
STATED_SOURCES = ("board", "text", "page")


def extract_experience_with_source(
    title: str, description: str, experience: str = ""
) -> Tuple[Optional[int], Optional[int], ExperienceSource]:
    """Years of experience a listing asks for, and where that came from.

    `experience` is a board's own experience field (Naukri "5-9 Yrs", Foundit
    min/max). It is checked first ("board"), then the title and description
    ("text"). "title" means only an unambiguous level word (intern, fresher,
    entry level) was found. enrich_experience.py adds "page" and "level".
    """
    for origin, text in (("board", experience or ""), ("text", f"{title or ''}. {description or ''}")):
        if not text.strip():
            continue
        m = EXP_RANGE_RE.search(text)
        if m:
            lo, hi = int(m.group(1)), int(m.group(2))
            if lo > hi:
                lo, hi = hi, lo
            return (lo, hi, origin)

        for pattern in (EXP_MIN_RE, EXP_PLUS_RE, EXP_OF_RE):
            m = pattern.search(text)
            if m:
                return (int(m.group(1)), None, origin)

    for pattern, span in TITLE_EXP:
        if pattern.search(title or ""):
            return (span[0], span[1], "title")

    return (None, None, None)


def extract_experience(
    title: str, description: str, experience: str = ""
) -> Tuple[Optional[int], Optional[int]]:
    lo, hi, _source = extract_experience_with_source(title, description, experience)
    return (lo, hi)


def states_experience(title: str, snippet: str) -> bool:
    """True when title or snippet spells out years (used to repair old data)."""
    _lo, _hi, source = extract_experience_with_source(title, snippet)
    return source in STATED_SOURCES


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


COMPANY_SUFFIX_RE = re.compile(
    r"\b(private limited|pvt\.? ltd\.?|pvt|ltd\.?|limited|llp|inc\.?|corp\.?|"
    r"corporation|technologies|technology|solutions|services|india)\b",
    re.I,
)


def _norm_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", unescape(str(value or "")).lower()).strip()


def job_fingerprint(job: Dict[str, Any]) -> str:
    """Identity of a listing independent of the board it was found on.

    The same opening is often posted on Naukri, Shine and LinkedIn with
    different URLs. Title + company + city catches those copies. Jobs with an
    unknown company never collapse, because "Unknown" would merge unrelated
    listings.
    """
    title = _norm_text(job.get("title"))
    company = _norm_text(COMPANY_SUFFIX_RE.sub(" ", unescape(str(job.get("company") or ""))))
    location = _norm_text(job.get("location"))
    if not title or not company or company == "unknown":
        return ""
    return f"{title}|{company}|{location}"


def _better_copy(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    """Pick which of two copies of the same listing to keep."""
    def rank(job: Dict[str, Any]):
        return (
            float(job.get("score") or 0),
            1 if job.get("posted_date") else 0,
            len(job.get("snippet") or ""),
        )

    return b if rank(b) > rank(a) else a


def dedupe_jobs(jobs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Collapse cross-board copies of one listing, keeping the best copy.

    The kept copy inherits the earliest first_seen and the latest last_seen of
    the group, so merging never makes a known job look new or stale.
    """
    kept: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for index, job in enumerate(jobs):
        key = job_fingerprint(job) or f"__unique__{index}"
        current = kept.get(key)
        if current is None:
            kept[key] = job
            order.append(key)
            continue
        best = dict(_better_copy(current, job))
        firsts = [v for v in (current.get("first_seen"), job.get("first_seen")) if v]
        if firsts:
            best["first_seen"] = min(firsts)
        lasts = [v for v in (current.get("last_seen"), job.get("last_seen")) if v]
        if lasts:
            best["last_seen"] = max(lasts)
        kept[key] = best
    return [kept[key] for key in order]


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


# Boards pack extra facts into a title with "|": "Hiring | UX Designer",
# "Data Engineer | 3-5 Yrs | Pune | Hybrid". The role is not always first, so
# clean_title() drops the segments that carry no role and keeps the rest.
TITLE_SEPARATOR_RE = re.compile(r"\s*[|｜¦]\s*")

TITLE_FILLER_RE = re.compile(
    r"^(?:(?:we\s*(?:'re|are)\s+|now\s+)?hiring(?:\s+now)?|"
    r"urgent(?:ly)?(?:\s+(?:hiring|opening|openings|requirement|need|vacancy))?|"
    r"(?:job|new|current)?\s*(?:opening|openings|vacancy|vacancies|requirement)|"
    r"immediate(?:\s+(?:joiners?|joining|hiring|opening|requirement|start))?|"
    r"(?:early\s+)?joiners?(?:\s+(?:only|preferred))?|"
    r"walk[\s-]?ins?(?:\s+(?:drive|interview))?|apply(?:\s+now|\s+today)?|"
    r"jobs?|careers?|freshers?(?:\s+(?:can|may)\s+apply)?|"
    r"(?:full|part)[\s-]?time|contract(?:ual)?|contract\s+to\s+hire|c2h|"
    r"permanent|freelance|on[\s-]?site|onsite|in[\s-]?office|hybrid|remote|"
    r"wfh|wfo|work\s+from\s+(?:home|office)|"
    r"(?:night|day|general|rotational|us|uk)\s+shifts?)"
    r"[\s!.:*-]*$",
    re.I,
)

# "3-5 Yrs", "5+ years", "Exp: 2-4 years", "0 - 1 Year Experience".
TITLE_EXPERIENCE_RE = re.compile(
    r"^(?:exp(?:erience)?\s*[:.-]?\s*)?\d{1,2}\s*(?:\+|(?:-|–|to)\s*\d{1,2})?\s*\+?\s*"
    r"(?:years?|yrs?)?(?:\s+(?:of\s+)?exp(?:erience)?)?\.?$",
    re.I,
)

# "10-15 LPA", "CTC up to 12 L", "INR 8,00,000".
TITLE_SALARY_RE = re.compile(r"\b(?:lpa|ctc|salary|inr|per\s+annum|p\.a\.)\b|₹", re.I)

# Words that may sit next to a place in a location segment: "Pune (Hybrid)",
# "Locations: Bangalore / Chennai", "Navi Mumbai", "Delhi NCR".
TITLE_PLACE_FILLER = (
    "locations", "location", "based", "only", "city", "multiple", "any",
    "across", "hybrid", "onsite", "on-site", "office", "navi", "greater", "ncr",
    "region", "and", "or", "in",
)
_TITLE_PLACE_RE = re.compile(
    r"(?<![a-z])(?:"
    + "|".join(
        re.escape(word)
        for word in sorted(
            set(CITY_ALIASES) | INDIA_STATES | INDIA_PLACES | FOREIGN_MARKERS
            | set(REMOTE_WORDS) | {"pan india", "pan-india"},
            key=len,
            reverse=True,
        )
    )
    + r")(?![a-z])"
)
_TITLE_PLACE_FILLER_RE = re.compile(
    r"(?<![a-z])(?:" + "|".join(re.escape(w) for w in TITLE_PLACE_FILLER) + r")(?![a-z])"
)


def _is_location_segment(segment: str) -> bool:
    """True when segment is only places ("Pune", "Bangalore / Chennai",
    "San Jose, CA"), with no role words left over."""
    low = segment.lower()
    if not _TITLE_PLACE_RE.search(low):
        return False
    # State and country codes after a place: "Chennai, TN", "Austin, TX".
    residue = re.sub(r"(?<![A-Za-z])[A-Z]{2}(?![A-Za-z])", " ", segment).lower()
    residue = _TITLE_PLACE_RE.sub(" ", residue)
    residue = _TITLE_PLACE_FILLER_RE.sub(" ", residue)
    return re.search(r"[a-z]", residue) is None


def _is_company_segment(segment: str, company: str) -> bool:
    if not company:
        return False
    def norm(value: str) -> str:
        return _norm_text(COMPANY_SUFFIX_RE.sub(" ", unescape(value)))
    seg, comp = norm(segment), norm(company)
    return bool(seg) and seg == comp


def _title_noise(segment: str, company: str = "") -> bool:
    """True when a "|"-separated title segment names no role."""
    value = segment.strip(" -–—:*!.")
    if not value:
        return True
    return bool(
        TITLE_FILLER_RE.match(value)
        or TITLE_EXPERIENCE_RE.match(value)
        or TITLE_SALARY_RE.search(value)
        or _is_location_segment(value)
        or _is_company_segment(value, company)
    )


def clean_title(title: str, company: str = "") -> str:
    """Public title. Keeps the role-bearing part of a "|"-separated title.

    Generic hiring words, locations, experience ranges, work modes, salary and
    the company name are dropped; the remaining segments are joined with
    " - ". "Hiring | UX Designer" becomes "UX Designer", "Business Analyst |
    Pune" becomes "Business Analyst" and "Senior Engineer | Generative AI"
    becomes "Senior Engineer - Generative AI".
    """
    value = re.sub(r"\s+", " ", unescape(str(title or ""))).strip()
    if TITLE_SEPARATOR_RE.search(value):
        segments = [s.strip() for s in TITLE_SEPARATOR_RE.split(value) if s.strip()]
        kept = [s for s in segments if not _title_noise(s, company)]
        # Nothing names a role ("Hiring | Pune"): keep the first segment so
        # the title gate sees what the board actually said and rejects it.
        value = " - ".join(kept) if kept else (segments[0] if segments else "")
    return value[:180] or "Untitled role"


def valid_url(url: str) -> bool:
    if not url:
        return False
    low = url.strip().lower()
    return low.startswith("http://") or low.startswith("https://")


# Company career pages list jobs worldwide (the vendor pipeline reads global
# boards such as apply.deloitte.com and careers.ey.com), so their rows get the
# strict location rule. LinkedIn and the Indian boards keep the lenient one.
GLOBAL_SOURCE_RE = re.compile(r"career|company", re.I)

# Hints are matched as substrings because career-page titles and URLs glue
# words together ("Foundational ModelsBengaluruFull Time", "/job/Bengaluru-...").
_INDIA_HINTS = tuple(sorted(
    {k for k, v in CITY_ALIASES.items() if v != "Remote" and len(k) >= 5} | {"india"},
    key=len, reverse=True,
))


def india_hint(*texts: str) -> Optional[str]:
    """Indian city named anywhere in texts ("India" for the country), else None."""
    low = " ".join(unescape(str(t or "")) for t in texts).lower()
    low = re.sub(r"indiana(?:polis)?", " ", low)
    for hint in _INDIA_HINTS:
        if hint in low:
            return "India" if hint == "india" else CITY_ALIASES[hint]
    return None


def export_location(location: str, source: str, title: str = "", url: str = "") -> Tuple[str, bool]:
    """(city, keep) for one vendor row. Global sources need a positive India
    match; a row with no location may still name its Indian city in the title
    or URL. A title that names a foreign place ("...-Germany-EU") drops it."""
    if not GLOBAL_SOURCE_RE.search(source or ""):
        return normalize_location(location)
    if looks_foreign(title):
        return (location, False)
    city, keep = normalize_location(location, strict=True)
    if keep or (location or "").strip():
        return (city, keep)
    hint = india_hint(title, urlsplit(url or "").path)
    return (hint, True) if hint else (location, False)


# ── Export ────────────────────────────────────────────────────────────────────

def export(db_path: str, role: str, min_score: float, limit: int, max_days: int = 21) -> Dict[str, Any]:
    if not os.path.exists(db_path):
        raise SystemExit(f"[export] DB not found: {db_path}")

    # The vendor scrapers do their own keyword matching, which is loose enough
    # to keep "Scrum Master" or "QA Analyst" in a BA search. Apply the same
    # title-relevance gate the portal and API collectors use so every source
    # lands on the same role definition.
    try:
        from api_sources import title_relevant
    except Exception:
        title_relevant = None

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
    dropped_offrole = 0

    for row in rows:
        url = (row["url"] or "").strip()
        if not valid_url(url):
            continue
        key = canonical_url(url)
        if not key or key in seen:
            continue

        # The gate sees the same cleaned title that is published, so publish.py
        # re-checking the stored title can never disagree with this one.
        title = clean_title(row["title"], row["company"] or "")
        if title_relevant is not None and not title_relevant(role, title):
            dropped_offrole += 1
            continue

        source = (row["source"] or "Unknown").strip() or "Unknown"
        city, keep = export_location(row["location"] or "", source, row["title"] or "", url)
        if not keep:
            dropped_foreign += 1
            continue

        seen.add(key)

        exp_min, exp_max, exp_source = extract_experience_with_source(
            row["title"], row["description"]
        )
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
            "title": title,
            "company": clean_company(row["company"]),
            "location": city,
            "url": url,
            "apply_url": (row["apply_url"] or url).strip(),
            "source": source,
            "posted_date": posted or None,
            "score": priority_score(
                role, row["title"], float(row["match_score"] or 0), exp_min, exp_max
            ),
            "score_parts": {
                "role": round(float(row["role_match"] or 0), 1),
                "skill": round(float(row["skill_match"] or 0), 1),
                "experience": round(float(row["experience_match"] or 0), 1),
                "tool": round(float(row["tool_match"] or 0), 1),
                "domain": round(float(row["domain_match"] or 0), 1),
            },
            "experience_min": exp_min,
            "experience_max": exp_max,
            "experience_source": exp_source,
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
        f"dropped_foreign={dropped_foreign} dropped_stale={dropped_stale} "
        f"dropped_offrole={dropped_offrole}",
        file=sys.stderr,
    )
    return payload


def main() -> None:
    parser = argparse.ArgumentParser(description="Export a scraper SQLite DB to portal JSON")
    parser.add_argument("--db", required=True, help="Path to the scraper's SQLite DB")
    parser.add_argument("--role", required=True, help="Role slug: genai | data | uiux | ba | sde")
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
