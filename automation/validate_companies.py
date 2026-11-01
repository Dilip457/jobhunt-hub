#!/usr/bin/env python3
"""
validate_companies.py — check companies.json against the live ATS feeds.

For every board it reads the postings the scrape would read and counts how
many are in India (the strict location rule build_job applies to ATS jobs).
A board that errors, or lists nothing in India, only costs requests in every
scrape, so --write keeps the boards with at least --min-india India postings.

Usage:
    python automation/validate_companies.py                    # report only
    python automation/validate_companies.py --write            # prune in place
    python automation/validate_companies.py --file candidates.json \
        --write --out automation/companies.json                # vet new boards

The file format is companies.json's (see api_sources.load_companies). Boards
that pass keep their original form (token string or object); the "_comment"
key is carried over. Duplicates (same ATS and token/host+site) are dropped.
"""

from __future__ import annotations

import argparse
import concurrent.futures as cf
import json
import os
import sys
from typing import Any, Dict, List, Tuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from api_sources import ATS_POSTINGS, COMPANIES_FILE, board_label, norm_location  # noqa: E402


def board_key(ats: str, board: Dict[str, Any]) -> Tuple[str, str]:
    if board.get("host"):
        return ats, f"{board['host'].lower()}/{str(board.get('site', '')).lower()}"
    return ats, str(board.get("token", "")).lower()


def check_board(ats: str, board: Dict[str, Any]) -> Dict[str, Any]:
    try:
        postings = ATS_POSTINGS[ats](board)
    except Exception as exc:  # report every failure, never stop the sweep
        return {"total": 0, "india": 0, "latest": None, "error": f"{type(exc).__name__}: {exc}"[:120]}
    india = [p for p in postings if p.get("location") and norm_location(p["location"], strict=True)[1]]
    dates = [p["posted"] for p in india if p.get("posted")]
    return {"total": len(postings), "india": len(india), "latest": max(dates) if dates else None, "error": None}


def main() -> int:
    parser = argparse.ArgumentParser(description="Check companies.json boards against the live ATS feeds")
    parser.add_argument("--file", default=COMPANIES_FILE, help="Boards to check (companies.json format)")
    parser.add_argument("--out", default=None, help="Where --write saves the kept boards (default: --file)")
    parser.add_argument("--write", action="store_true", help="Save only the boards that pass")
    parser.add_argument("--min-india", type=int, default=1, help="India postings a board needs to pass")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    with open(args.file, encoding="utf-8-sig") as handle:
        raw = json.load(handle)

    targets: List[Tuple[str, Any, Dict[str, Any]]] = []
    seen = set()
    for ats, entries in raw.items():
        if ats.startswith("_") or not isinstance(entries, list):
            continue
        if ats not in ATS_POSTINGS:
            print(f"skipping unknown ATS {ats!r}", file=sys.stderr)
            continue
        for entry in entries:
            board = {"token": entry} if isinstance(entry, str) else entry
            if not isinstance(board, dict) or not (board.get("token") or board.get("host")):
                continue
            key = board_key(ats, board)
            if key in seen:
                continue
            seen.add(key)
            targets.append((ats, entry, board))

    with cf.ThreadPoolExecutor(max_workers=args.workers) as pool:
        results = list(pool.map(lambda t: check_board(t[0], t[2]), targets))

    rows = sorted(zip(targets, results, strict=True), key=lambda r: (r[0][0], -r[1]["india"], board_label(r[0][2])))
    kept: Dict[str, List[Any]] = {}
    for (ats, entry, board), result in rows:
        passed = not result["error"] and result["india"] >= args.min_india
        if passed:
            kept.setdefault(ats, []).append(entry)
        status = "keep" if passed else "drop"
        detail = result["error"] or f"{result['india']:>4} India / {result['total']:>5} total, latest {result['latest']}"
        print(f"{status}  {ats:<15} {board_label(board):<45} {detail}")

    total_india = sum(r["india"] for (_t, r) in rows if not r["error"] and r["india"] >= args.min_india)
    print(
        f"\n{sum(len(v) for v in kept.values())} of {len(targets)} boards pass "
        f"(>= {args.min_india} India postings); {total_india} India postings in all",
        file=sys.stderr,
    )

    if args.write:
        out = {key: value for key, value in raw.items() if key.startswith("_")}
        out.update({ats: kept.get(ats, []) for ats in ATS_POSTINGS if kept.get(ats)})
        path = args.out or args.file
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(out, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(f"wrote {path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
