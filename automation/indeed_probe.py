#!/usr/bin/env python3
"""
indeed_probe.py — diagnose which Indeed surfaces a runner can reach.

Run locally or from the "Diagnose portal access" workflow. It prints the
runner's public IP and the HTTP status / job-card count for:

  * Indeed homepage
  * Indeed desktop search
  * Indeed mobile search
  * Indeed SEO landing page
  * SimplyHired India (same inventory, separate host)

Run headed under xvfb to compare fingerprints:

    xvfb-run -a python automation/indeed_probe.py --headed
"""

from __future__ import annotations

import argparse
import re
import urllib.request

from playwright.sync_api import sync_playwright

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

URLS = [
    ("indeed-home", "https://in.indeed.com/"),
    ("indeed-desktop", "https://in.indeed.com/jobs?q=ui+ux+designer&l=Bangalore"),
    ("indeed-mobile", "https://in.indeed.com/m/jobs?q=ui+ux+designer&l=Bangalore"),
    ("indeed-seo", "https://in.indeed.com/q-ui-ux-designer-l-bangalore-jobs.html"),
    ("simplyhired", "https://www.simplyhired.co.in/search?q=ui+ux+designer&l=Bangalore"),
]


def public_ip() -> str:
    for url in ("https://api.ipify.org", "https://ifconfig.me/ip"):
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                return response.read().decode().strip()
        except Exception:
            pass
    return "unknown"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headed", action="store_true", help="Run a visible Chrome (needs DISPLAY/xvfb)")
    args = parser.parse_args()

    print(f"[probe] headed={args.headed} public_ip={public_ip()}")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            channel="chrome",
            headless=not args.headed,
            args=["--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage", "--no-sandbox"],
        )
        for name, url in URLS:
            print("=" * 70)
            print(f"[probe] {name}: {url}")
            ctx = browser.new_context(user_agent=UA, locale="en-IN", viewport={"width": 1400, "height": 900})
            ctx.add_init_script(
                "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});"
                "Object.defineProperty(navigator,'languages',{get:()=>['en-IN','en']});"
            )
            page = ctx.new_page()
            try:
                response = page.goto(url, wait_until="domcontentloaded", timeout=45000)
                page.wait_for_timeout(7000)
                html = page.content()
                print(f"  status={response.status if response else '?'} title={page.title()[:90]!r} bytes={len(html)}")
                print(
                    "  cards: job_seen_beacon="
                    f"{html.count('job_seen_beacon')} data-jk={html.count('data-jk')} "
                    f"mosaic={html.count('mosaic-provider-jobcards')}"
                )
                hrefs = sorted(set(re.findall(r'href="([^"]*(?:viewjob|/rc/clk|/job/)[^"]*)"', html)))
                print(f"  job-like links={len(hrefs)}")
                for href in hrefs[:3]:
                    print(f"    {href[:110]}")
            except Exception as exc:
                print(f"  ERROR {type(exc).__name__}: {str(exc)[:200]}")
            finally:
                ctx.close()
        browser.close()


if __name__ == "__main__":
    main()
