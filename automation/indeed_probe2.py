#!/usr/bin/env python3
"""
indeed_probe2.py — can a browser-impersonating HTTP client pass Cloudflare?

Indeed serves a "Just a moment..." challenge to plain requests and to Chrome
running on GitHub's IPs. `curl_cffi` reproduces Chrome's TLS/JA3 fingerprint,
which is sometimes enough to pass. This probe checks every surface and prints
the status plus the number of job cards in the returned HTML.
"""

from __future__ import annotations

import re
import urllib.request

from curl_cffi import requests

URLS = [
    ("indeed-home", "https://in.indeed.com/"),
    ("indeed-desktop", "https://in.indeed.com/jobs?q=ui+ux+designer&l=Bangalore"),
    ("indeed-mobile", "https://in.indeed.com/m/jobs?q=ui+ux+designer&l=Bangalore"),
    ("indeed-seo", "https://in.indeed.com/q-ui-ux-designer-l-bangalore-jobs.html"),
    ("simplyhired", "https://www.simplyhired.co.in/search?q=ui+ux+designer&l=Bangalore"),
]


def main() -> None:
    try:
        ip = urllib.request.urlopen("https://api.ipify.org", timeout=10).read().decode().strip()
    except Exception:
        ip = "unknown"
    print(f"[probe2] public_ip={ip}")
    for name, url in URLS:
        try:
            response = requests.get(url, impersonate="chrome", timeout=40)
            text = response.text
            title = re.search(r"<title[^>]*>(.*?)</title>", text, re.S | re.I)
            print(
                f"[probe2] {name}: status={response.status_code} bytes={len(text)} "
                f"cards={text.count('job_seen_beacon')} "
                f"sh_cards={text.count('searchSerpJob')} "
                f"title={(title.group(1).strip()[:80] if title else '?')!r}"
            )
        except Exception as exc:
            print(f"[probe2] {name}: ERROR {type(exc).__name__}: {str(exc)[:200]}")


if __name__ == "__main__":
    main()
