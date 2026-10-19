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
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, Optional

ROLES = ("genai", "data", "uiux")


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


def previous_file(branch: str, filename: str) -> Optional[str]:
    """Return the previous file content from origin/<branch>, if it exists."""
    result = subprocess.run(
        ["git", "show", f"origin/{branch}:{filename}"],
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
        content = previous_file(args.branch, f"{role}.json")
        if content:
            previous[role] = content

    payloads: Dict[str, Dict[str, Any]] = {}
    statuses: Dict[str, str] = {}

    for role in ROLES:
        artifact = os.path.join(artifacts, f"{role}.json")
        candidate = read_json(artifact) if os.path.exists(artifact) else None

        if candidate and isinstance(candidate.get("jobs"), list):
            count = int(candidate.get("count") or len(candidate["jobs"]))
            if count > 0 or role not in previous:
                payloads[role] = candidate
                statuses[role] = "fresh"
                continue

        if role in previous:
            try:
                payloads[role] = json.loads(previous[role])
                statuses[role] = "kept-previous"
                print(f"[publish] {role}: no fresh data, keeping previous JSON")
                continue
            except Exception:
                pass

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
    # is never modified.
    worktree = os.path.join(tempfile.gettempdir(), f"jobhunt-data-{os.getpid()}")
    if os.path.exists(worktree):
        shutil.rmtree(worktree, ignore_errors=True)

    subprocess.run(
        ["git", "worktree", "add", "--detach", worktree],
        cwd=repo_dir,
        check=True,
        capture_output=True,
    )

    try:
        subprocess.run(["git", "checkout", "--orphan", "portal-data"], cwd=worktree, check=True)
        subprocess.run(["git", "rm", "-rf", "."], cwd=worktree, check=False, capture_output=True)

        for role, payload in payloads.items():
            with open(os.path.join(worktree, f"{role}.json"), "w", encoding="utf-8") as handle:
                json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

        with open(os.path.join(worktree, "manifest.json"), "w", encoding="utf-8") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=1)

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

    print(f"[publish] published {len(payloads)} role(s) to '{args.branch}'")
    for role, payload in payloads.items():
        print(f"[publish]   {role}: {payload.get('count', 0)} jobs ({statuses.get(role)})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
