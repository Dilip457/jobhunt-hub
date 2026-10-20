#!/usr/bin/env python3
"""
warp_proxy_test.py — verify targeted WARP routing.

Run after `warp-cli mode proxy` + connect. Only clients that explicitly use
http://127.0.0.1:40000 go through Cloudflare; plain requests keep the runner
IP, so Naukri/Shine/Foundit are unaffected.

Checks:
  * SimplyHired (Indeed's sister site) through the WARP proxy, parsed into jobs
  * Shine directly, to confirm the proxy does not change normal traffic
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup
from curl_cffi import requests

sys.path.insert(0, os.path.dirname(__file__))
from api_sources import build_job, title_relevant  # noqa: E402

PROXY = "http://127.0.0.1:40000"
SIMPLY = "https://www.simplyhired.co.in/search?q=ui+ux+designer&l=Bangalore"
SHINE = "https://www.shine.com/job-search/ui-ux-designer-jobs-in-bangalore"


def main() -> None:
    print("[warpx] SimplyHired via WARP proxy")
    try:
        response = requests.get(
            SIMPLY,
            impersonate="chrome",
            proxies={"http": PROXY, "https": PROXY},
            timeout=45,
        )
        soup = BeautifulSoup(response.text, "lxml")
        cards = soup.select("div[data-testid='searchSerpJob']")
        print(f"[warpx] simplyhired: status={response.status_code} bytes={len(response.text)} cards={len(cards)}")
        kept = 0
        for card in cards:
            link = card.select_one("h2[data-testid='searchSerpJobTitle'] a")
            if not link:
                continue
            title = link.get_text(" ", strip=True)
            company = (card.select_one("[data-testid='companyName']") or card).get_text(" ", strip=True)
            location = (card.select_one("[data-testid='searchSerpJobLocation']") or card).get_text(" ", strip=True)
            href = link.get("href", "")
            if not title_relevant(title, "uiux"):
                continue
            job = build_job(
                "uiux",
                "SimplyHired",
                title,
                company,
                location,
                "https://www.simplyhired.co.in" + href if href.startswith("/") else href,
                card.get_text(" ", strip=True),
                datetime.now(timezone.utc).date().isoformat(),
                card.get("data-jobkey") or href,
            )
            if job:
                kept += 1
                if kept <= 5:
                    print(f"[warpx]   {title[:45]} | {company[:25]} | {location[:30]}")
        print(f"[warpx] simplyhired: relevant={kept}")
    except Exception as exc:
        print(f"[warpx] simplyhired ERROR {type(exc).__name__}: {str(exc)[:200]}")

    print("[warpx] Shine direct (no proxy)")
    try:
        response = requests.get(SHINE, impersonate="chrome", timeout=45)
        print(f"[warpx] shine: status={response.status_code} bytes={len(response.text)}")
    except Exception as exc:
        print(f"[warpx] shine ERROR {type(exc).__name__}: {str(exc)[:200]}")


if __name__ == "__main__":
    main()
