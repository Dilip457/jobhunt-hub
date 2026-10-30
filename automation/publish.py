#!/usr/bin/env python3
"""
publish.py — Publish role JSON + manifest to the orphan `data` branch.

The branch is rebuilt from scratch on every run, so its history stays at one
commit and the main branch never grows. Missing or empty role artifacts keep
the previous published file instead of blanking the site.

Usage:
    python automation/publish.py --artifacts artifacts --branch data
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

from export import canonical_url

ROLES = ("genai", "data", "uiux", "ba")
DEFAULT_RETENTION_DAYS = 21


def run(cmd: list[str], cwd: Optional[str] = None, check: bool = True) -> subprocess.CompletedProcess:
    print("[publish] $", " ".join(cmd))
    return subprocess.run(cmd, cwd=cwd, check=check, text=True, capture_output=True)


def read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        with open(path, encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _job_key(job: Dict[str, Any]) -> str:
    url = canonical_url(job.get("url") or "")
    if url:
        return url
    title = (job.get("title") or "").strip().lower()
    company = (job.get("company") or "").strip().lower()
    location = (job.get("location") or "").strip().lower()
    return f"{title}|{company}|{location}" if title else ""


def merge_payloads(
    previous: Dict[str, Any],
    fresh: Dict[str, Any],
    retention_days: int,
) -> Dict[str, Any]:
    """Union two role payloads so a lighter run never removes richer data."""
    merged: Dict[str, Dict[str, Any]] = {}

    for source in (previous, fresh):
        for job in source.get("jobs", []):
            key = _job_key(job)
            if not key:
                continue
            current = merged.get(key)
            if current is None:
                merged[key] = job
                continue
            if (job.get("score") or 0) > (current.get("score") or 0):
                merged_job = {**current, **job}
            else:
                merged_job = {**job, **current}

            # "First seen" is the first time our scraper collected the job, so
            # keep the oldest value across runs. A job that was already known
            # must not look newly scraped just because it appeared again.
            # Older payloads stored the posted date here; keeping the minimum
            # preserves that older listing date instead of relabelling
            # long-known jobs as new.
            stamps = [value for value in (current.get("first_seen"), job.get("first_seen")) if value]
            merged_job["first_seen"] = min(stamps) if stamps else None

            merged[key] = merged_job

    cutoff = (datetime.now(timezone.utc) - timedelta(days=retention_days)).date().isoformat()
    jobs = []
    for job in merged.values():
        stamp = (job.get("posted_date") or job.get("first_seen") or "")[:10]
        if stamp and stamp < cutoff:
            continue
        jobs.append(job)

    jobs.sort(key=lambda j: (-(j.get("score") or 0), j.get("posted_date") or ""))

    sources: Dict[str, int] = {}
    for job in jobs:
        name = job.get("source") or "Unknown"
        sources[name] = sources.get(name, 0) + 1

    stamps = [p.get("generated_at") for p in (previous, fresh) if p.get("generated_at")]

    return {
        "role": fresh.get("role") or previous.get("role"),
        "generated_at": max(stamps) if stamps else datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds"),
        "count": len(jobs),
        "sources": dict(sorted(sources.items(), key=lambda kv: -kv[1])),
        "jobs": jobs,
        "demo": False,
    }


def previous_file(branch: str, filename: str, cwd: Optional[str] = None) -> Optional[str]:
    """Return the previous file content from origin/<branch>, if it exists."""
    result = subprocess.run(
        ["git", "show", f"origin/{branch}:{filename}"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    return result.stdout


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish JSON to the data branch")
    parser.add_argument("--artifacts", default="artifacts")
    parser.add_argument("--branch", default="data")
    parser.add_argument("--repo-dir", default=".")
    parser.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    parser.add_argument("--no-merge", action="store_true", help="Overwrite roles instead of merging")
    args = parser.parse_args()

    repo_dir = os.path.abspath(args.repo_dir)
    artifacts = os.path.abspath(args.artifacts)

    subprocess.run(["git", "config", "user.name", "jobhunt-bot"], cwd=repo_dir, check=False)
    subprocess.run(
        ["git", "config", "user.email", "jobhunt-bot@users.noreply.github.com"],
        cwd=repo_dir,
        check=False,
    )

    # Read the previous published state (may not exist on the first run).
    subprocess.run(
        ["git", "fetch", "origin", args.branch],
        cwd=repo_dir,
        check=False,
        capture_output=True,
    )

    previous: Dict[str, str] = {}
    for role in ROLES:
        content = previous_file(args.branch, f"{role}.json", repo_dir)
        if content:
            previous[role] = content

    payloads: Dict[str, Dict[str, Any]] = {}
    statuses: Dict[str, str] = {}

    for role in ROLES:
        # A role can arrive as more than one artifact: the main scrape writes
        # <role>.json, the optional WARP job writes <role>.warp.json. Merge all
        # of them before comparing with the previous published data.
        candidate = None
        for path in sorted(glob.glob(os.path.join(artifacts, f"{role}*.json"))):
            part = read_json(path)
            if not part or not isinstance(part.get("jobs"), list):
                continue
            if candidate is None:
                candidate = part
            else:
                candidate = merge_payloads(candidate, part, args.retention_days)

        previous_payload = None
        if role in previous:
            try:
                previous_payload = json.loads(previous[role])
            except Exception:
                previous_payload = None

        fresh_ok = bool(
            candidate
            and isinstance(candidate.get("jobs"), list)
            and int(candidate.get("count") or len(candidate["jobs"])) > 0
        )

        if fresh_ok and previous_payload and not args.no_merge:
            payloads[role] = merge_payloads(previous_payload, candidate, args.retention_days)
            statuses[role] = "merged"
            print(
                f"[publish] {role}: merged {candidate.get('count', 0)} fresh + "
                f"{previous_payload.get('count', 0)} previous -> {payloads[role]['count']}"
            )
            continue

        if fresh_ok:
            payloads[role] = candidate
            statuses[role] = "fresh"
            continue

        if previous_payload:
            payloads[role] = previous_payload
            statuses[role] = "kept-previous"
            print(f"[publish] {role}: no fresh data, keeping previous JSON")
            continue

        print(f"[publish] {role}: no data available")
        statuses[role] = "missing"

    if not payloads:
        print("[publish] nothing to publish")
        return 1

    now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
    manifest = {
        "generated_at": now,
        "roles": {
            role: {
                "role": role,
                "count": int(payload.get("count") or len(payload.get("jobs", []))),
                "generated_at": payload.get("generated_at", now),
                "sources": payload.get("sources", {}),
                "demo": False,
                "status": statuses.get(role, "missing"),
            }
            for role, payload in payloads.items()
        },
    }

    # Build the orphan branch in a temporary git worktree so the main checkout
    # is never modified. The branch name is unique per run so repeated local
    # publishes (the PC agent) never collide, and it is deleted afterwards.
    worktree = os.path.join(tempfile.gettempdir(), f"jobhunt-data-{os.getpid()}")
    tmp_branch = f"portal-data-{os.getpid()}"
    if os.path.exists(worktree):
        shutil.rmtree(worktree, ignore_errors=True)

    subprocess.run(["git", "worktree", "prune"], cwd=repo_dir, check=False, capture_output=True)
    subprocess.run(
        ["git", "worktree", "add", "--detach", worktree],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )

    try:
        subprocess.run(["git", "checkout", "--orphan", tmp_branch], cwd=worktree, check=True)
        subprocess.run(["git", "rm", "-rf", "."], cwd=worktree, check=False, capture_output=True)

        for role, payload in payloads.items():
            with open(os.path.join(worktree, f"{role}.json"), "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

        with open(os.path.join(worktree, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=1)

        # Vercel auto-deploys every branch. This branch contains only JSON (no
        # `web/` app), so Vercel's build fails with: "The specified Root
        # Directory 'web' does not exist." Tell Vercel to skip this branch.
        with open(os.path.join(worktree, "vercel.json"), "w", encoding="utf-8") as handle:
            json.dump(
                {
                    "$schema": "https://openapi.vercel.sh/vercel.json",
                    "git": {"deploymentEnabled": {args.branch: False}},
                },
                handle,
                indent=1,
            )

        subprocess.run(["git", "add", "-A"], cwd=worktree, check=True)
        subprocess.run(
            ["git", "commit", "-m", f"data: publish {', '.join(payloads)} at {now}"],
            cwd=worktree,
            check=True,
        )
        subprocess.run(
            ["git", "push", "--force", "origin", f"HEAD:{args.branch}"],
            cwd=worktree,
            check=True,
        )
    finally:
        subprocess.run(
            ["git", "worktree", "remove", "--force", worktree],
            cwd=repo_dir,
            check=False,
            capture_output=True,
        )
        subprocess.run(
            ["git", "branch", "-D", tmp_branch],
            cwd=repo_dir,
            check=False,
            capture_output=True,
        )

    print(f"[publish] published {len(payloads)} role(s) to '{args.branch}'")
    for role, payload in payloads.items():
        print(f"[publish]   {role}: {payload.get('count', 0)} jobs ({statuses.get(role)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
