#!/usr/bin/env python3
"""
warp_probe2.py — after WARP is connected, check whether a session or a real
browser can turn Indeed's 200 homepage into a working job search, and confirm
SimplyHired's cards parse.

Run inside the "Diagnose Indeed via WARP" workflow after `warp-cli connect`.
"""

from __future__ import annotations

import re

from curl_cffi import requests
from playwright.sync_api import sync_playwright

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
HOME = "https://in.indeed.com/"
SEARCH = "https://in.indeed.com/jobs?q=ui+ux+designer&l=Bangalore"
SIMPLY = "https://www.simplyhired.co.in/search?q=ui+ux+designer&l=Bangalore"


def show(label, response):
    title = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.S | re.I)
    print(
        f"[warp2] {label}: status={response.status_code} bytes={len(response.text)} "
        f"cards={response.text.count('job_seen_beacon')} "
        f"sh_cards={response.text.count('searchSerpJob')} "
        f"title={(title.group(1).strip()[:70] if title else '?')!r}"
    )


def probe_http_session() -> None:
    session = requests.Session()
    print("[warp2] curl_cffi session: homepage -> search")
    try:
        show("session-home", session.get(HOME, impersonate="chrome", timeout=40))
        show("session-search", session.get(SEARCH, impersonate="chrome", timeout=40))
        show("session-simplyhired", session.get(SIMPLY, impersonate="chrome", timeout=40))
    except Exception as exc:
        print(f"[warp2] session ERROR {type(exc).__name__}: {str(exc)[:200]}")


def probe_browser() -> None:
    print("[warp2] Playwright: homepage -> search")
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                channel="chrome",
                headless=True,
                args=["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
            )
            ctx = browser.new_context(user_agent=UA, locale="en-IN", viewport={"width": 1400, "height": 900})
            ctx.add_init_script("Object.defineProperty(navigator,'webdriver',{get:()=>undefined});")
            page = ctx.new_page()
            home = page.goto(HOME, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(3000)
            print(f"[warp2] browser-home: status={home.status if home else '?'} title={page.title()[:70]!r}")
            search = page.goto(SEARCH, wait_until="domcontentloaded", timeout=45000)
            page.wait_for_timeout(8000)
            html = page.content()
            print(
                f"[warp2] browser-search: status={search.status if search else '?'} "
                f"bytes={len(html)} cards={html.count('job_seen_beacon')} title={page.title()[:70]!r}"
            )
            ctx.close()
            browser.close()
    except Exception as exc:
        print(f"[warp2] browser ERROR {type(exc).__name__}: {str(exc)[:200]}")


def main() -> None:
    probe_http_session()
    probe_browser()


if __name__ == "__main__":
    main()
