#!/usr/bin/env python3
"""
agent.py — Run the full scrape on the user's own machine (residential IP).

Why: LinkedIn/company pages work from the cloud, but Naukri, Indeed and Foundit
block datacenter IPs and need a real browser from a normal connection. This
agent runs locally, so those sources work, and it does not care *when* the PC is
on: a scheduled task runs it every few minutes and it refreshes automatically
whenever the published data has gone stale (catch-up).

Usage (normally via automation\\run-agent.ps1 from Task Scheduler):

    python automation/agent.py
    python automation/agent.py --force            # scrape all roles now
    python automation/agent.py --roles genai      # just one role
    python automation/agent.py --dry-run          # show the plan, do nothing
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from typing import Dict, List, Optional

ROLES = ("genai", "data", "uiux", "ba", "sde")
LOCK_STALE_MINUTES = 240


def iso_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def log(message: str) -> None:
    print(f"[{iso_now()}] {message}", flush=True)


def run(cmd: List[str], cwd: str, check: bool = False) -> int:
    log("$ " + " ".join(cmd))
    try:
        result = subprocess.run(cmd, cwd=cwd)
        return result.returncode
    except FileNotFoundError as exc:
        log(f"command not found: {exc}")
        return 127


def read_profile(portal: str, role: str) -> Dict:
    path = os.path.join(portal, "profiles", f"{role}.json")
    with open(path, encoding="utf-8-sig") as handle:
        return json.load(handle)


def published_age_hours(portal: str) -> Optional[float]:
    """Age in hours of the newest published role data, read from origin/data."""
    run(["git", "fetch", "origin", "data"], cwd=portal)
    result = subprocess.run(
        ["git", "show", "origin/data:manifest.json"],
        cwd=portal,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return None
    try:
        manifest = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None

    stamps = [
        item.get("generated_at")
        for item in (manifest.get("roles") or {}).values()
        if item.get("generated_at")
    ]
    if not stamps:
        return None
    newest = max(stamps)
    try:
        when = datetime.fromisoformat(newest)
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - when).total_seconds() / 3600.0


def venv_python(venv_dir: str, role: str) -> str:
    windows = os.path.join(venv_dir, role, "Scripts", "python.exe")
    posix = os.path.join(venv_dir, role, "bin", "python")
    return windows if os.path.exists(windows) else posix


def main() -> int:
    parser = argparse.ArgumentParser(description="Local job-hunt scrape agent")
    here = os.path.dirname(os.path.abspath(__file__))
    parser.add_argument("--portal-dir", default=os.path.dirname(here))
    parser.add_argument("--vendor-dir", default=None)
    parser.add_argument("--venv-dir", default=None)
    parser.add_argument("--roles", default=None, help="Comma-separated roles to force")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-age-hours", type=float, default=18.0)
    parser.add_argument("--min-gap-hours", type=float, default=4.0)
    parser.add_argument("--retention-days", type=int, default=21)
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    portal = os.path.abspath(args.portal_dir)
    vendor_dir = os.path.abspath(args.vendor_dir or os.path.join(portal, "vendor"))
    venv_dir = os.path.abspath(args.venv_dir or os.path.join(vendor_dir, "venvs"))
    artifacts = os.path.join(portal, "artifacts")
    state_path = os.path.join(vendor_dir, "agent-state.json")
    lock_path = os.path.join(vendor_dir, "agent.lock")

    if not os.path.isdir(os.path.join(portal, "automation")):
        log(f"portal dir does not look right: {portal}")
        return 2

    os.makedirs(vendor_dir, exist_ok=True)

    # ── Single-instance lock ────────────────────────────────────────────────
    if os.path.exists(lock_path):
        age_min = (time.time() - os.path.getmtime(lock_path)) / 60
        if age_min < LOCK_STALE_MINUTES:
            log(f"another run is in progress (lock age {age_min:.0f}m); exiting")
            return 0
        log(f"stale lock ({age_min:.0f}m); removing")
        os.remove(lock_path)

    # ── Decide which roles need refreshing ──────────────────────────────────
    age_hours = published_age_hours(portal)
    last_run = None
    if os.path.exists(state_path):
        try:
            with open(state_path, encoding="utf-8") as handle:
                last_run = json.load(handle).get("last_run")
        except Exception:
            last_run = None

    last_run_age = None
    if last_run:
        try:
            last_run_age = (datetime.now(timezone.utc) - datetime.fromisoformat(last_run)).total_seconds() / 3600.0
        except ValueError:
            last_run_age = None

    log(
        f"published data age: "
        f"{'unknown' if age_hours is None else f'{age_hours:.1f}h'}; "
        f"last local run: {'never' if last_run_age is None else f'{last_run_age:.1f}h ago'}"
    )

    requested = [r.strip() for r in (args.roles or "").split(",") if r.strip()]
    if requested:
        roles = [r for r in requested if r in ROLES]
        reason = "explicit --roles"
    elif args.force:
        roles = list(ROLES)
        reason = "--force"
    elif age_hours is None or age_hours > args.max_age_hours:
        if last_run_age is not None and last_run_age < args.min_gap_hours:
            log(f"data is stale but last run was {last_run_age:.1f}h ago; waiting")
            return 0
        roles = list(ROLES)
        reason = f"stale (>{args.max_age_hours}h)"
    else:
        log("data is fresh; nothing to do")
        return 0

    log(f"will scrape {roles} because {reason}")

    def role_command(role: str) -> List[str]:
        python = venv_python(venv_dir, role)
        if not os.path.exists(python):
            python = sys.executable
        return [
            python,
            os.path.join("automation", "run_source.py"),
            "--role", role,
            "--profile", os.path.join("profiles", f"{role}.json"),
            "--repo-dir", os.path.join(vendor_dir, role),
            "--out", os.path.join("artifacts", f"{role}.json"),
            "--no-validate",
        ]

    if args.dry_run:
        for role in roles:
            log("would run: " + " ".join(role_command(role)))
        if not args.no_publish:
            log(
                "would publish: "
                + " ".join([sys.executable, os.path.join("automation", "publish.py"),
                            "--artifacts", "artifacts", "--branch", "data"])
            )
        return 0

    with open(lock_path, "w", encoding="utf-8") as handle:
        handle.write(iso_now())

    try:
        os.makedirs(artifacts, exist_ok=True)

        for role in roles:
            profile = read_profile(portal, role)
            repo = profile.get("repo")
            repo_dir = os.path.join(vendor_dir, role)

            if not os.path.isdir(repo_dir):
                if not repo:
                    log(f"{role}: no repo in profile; skipping")
                    continue
                log(f"{role}: cloning {repo}")
                run(["git", "clone", "--depth", "1", f"https://github.com/{repo}.git", repo_dir], cwd=portal)
            else:
                run(["git", "-C", repo_dir, "pull", "--ff-only", "--quiet"], cwd=portal)

            python = venv_python(venv_dir, role)
            if not os.path.exists(python):
                log(f"{role}: venv not found; using current interpreter (run install-agent.ps1 for a proper setup)")

            run(role_command(role), cwd=portal)

        if not args.no_publish:
            run(
                [
                    sys.executable,
                    os.path.join("automation", "publish.py"),
                    "--artifacts", "artifacts",
                    "--branch", "data",
                    "--retention-days", str(args.retention_days),
                ],
                cwd=portal,
            )
    finally:
        if os.path.exists(lock_path):
            os.remove(lock_path)
        os.makedirs(vendor_dir, exist_ok=True)
        with open(state_path, "w", encoding="utf-8") as handle:
            json.dump({"last_run": iso_now(), "roles": roles}, handle, indent=2)

    log("done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
