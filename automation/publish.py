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
from typing import Any, Dict, Optional, Tuple

from export import canonical_url, dedupe_jobs, states_experience

EXPERIENCE_FIELDS = ("experience_min", "experience_max", "experience_source", "experience_level")
RESOLVED_EXPERIENCE = {"board", "text", "page", "level"}
from roles import ROLES

DEFAULT_RETENTION_DAYS = 21
# A job no scrape has returned for this long is treated as closed.
DEFAULT_UNSEEN_DAYS = 7
# Jobs first collected within this many days get the NEW badge.
NEW_DAYS = 2
# Only drop unseen jobs when the fresh scrape is at least this share of the
# previous size, so a partial or blocked run cannot empty a role.
MIN_FRESH_SHARE_FOR_PRUNE = 0.3


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


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _days_ago(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).date().isoformat()


def stamp_seen(payload: Dict[str, Any], day: Optional[str] = None) -> Dict[str, Any]:
    """Mark every job in a fresh scrape as seen today."""
    day = day or _today()
    for job in payload.get("jobs", []):
        job["last_seen"] = day
        if not job.get("first_seen"):
            job["first_seen"] = day
    return payload


def _backfill_last_seen(payload: Dict[str, Any]) -> None:
    """Older published files have no last_seen; use the file's own date."""
    fallback = (payload.get("generated_at") or "")[:10] or _today()
    for job in payload.get("jobs", []):
        if not job.get("last_seen"):
            job["last_seen"] = fallback


def finalize_job(job: Dict[str, Any], new_days: int = NEW_DAYS) -> Dict[str, Any]:
    """Fields derived at publish time, plus trimming of unused fields."""
    first_seen = (job.get("first_seen") or "")[:10]
    # NEW means "first collected in the last couple of days". The vendor
    # is_new flag stuck for weeks after merges, so it is recomputed here.
    job["is_new"] = bool(first_seen and first_seen >= _days_ago(new_days))
    # Jobs published before experience_source existed may carry years that
    # were guessed from a title word ("Associate" -> 0-2). If the listing's own
    # text does not state years, clear the guess; the next scrape of a live job
    # restores stated values, because the fresh copy wins on merge.
    if "experience_source" not in job and not states_experience(
        job.get("title") or "", job.get("snippet") or ""
    ):
        job["experience_min"] = None
        job["experience_max"] = None
    # score_parts is not read by the web app and is all zeros for portal jobs.
    job.pop("score_parts", None)
    if job.get("apply_url") == job.get("url"):
        job.pop("apply_url", None)
    return job


def merge_payloads(
    previous: Dict[str, Any],
    fresh: Dict[str, Any],
    retention_days: int,
    unseen_days: Optional[int] = None,
) -> Dict[str, Any]:
    """Union two role payloads so a lighter run never removes recent data.

    The fresh copy of a job wins (it carries the current title, snippet and
    scoring rules); first_seen keeps the oldest value and last_seen the newest.
    With unseen_days set, jobs that no scrape has returned for that many days
    are treated as closed and dropped.
    """
    merged: Dict[str, Dict[str, Any]] = {}

    for source in (previous, fresh):
        for job in source.get("jobs", []):
            key = _job_key(job)
            if not key:
                continue
            current = merged.get(key)
            if current is None:
                merged[key] = dict(job)
                continue
            merged_job = {**current, **job}

            # Experience read from the posting page is fetched once, ever: if
            # the fresh copy has no stated experience but the previous one
            # did, keep the previous answer.
            if (
                job.get("experience_source") not in RESOLVED_EXPERIENCE
                and current.get("experience_source") in RESOLVED_EXPERIENCE
            ):
                for field in EXPERIENCE_FIELDS:
                    merged_job[field] = current.get(field)
            checks = [v for v in (current.get("experience_checked"), job.get("experience_checked")) if v]
            if checks:
                merged_job["experience_checked"] = max(checks)

            # "First seen" is the first time our scraper collected the job, so
            # keep the oldest value across runs. A job that was already known
            # must not look newly scraped just because it appeared again.
            firsts = [v for v in (current.get("first_seen"), job.get("first_seen")) if v]
            merged_job["first_seen"] = min(firsts) if firsts else None
            lasts = [v for v in (current.get("last_seen"), job.get("last_seen")) if v]
            merged_job["last_seen"] = max(lasts) if lasts else None

            merged[key] = merged_job

    cutoff = _days_ago(retention_days)
    unseen_cutoff = _days_ago(unseen_days) if unseen_days else None
    jobs = []
    for job in merged.values():
        stamp = (job.get("posted_date") or job.get("first_seen") or "")[:10]
        if stamp and stamp < cutoff:
            continue
        last_seen = (job.get("last_seen") or "")[:10]
        if unseen_cutoff and last_seen and last_seen < unseen_cutoff:
            continue
        jobs.append(job)

    # Same listing found on several boards under different URLs.
    jobs = dedupe_jobs(jobs)
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


def remote_head(branch: str, cwd: str) -> str:
    """SHA of origin/<branch> after the last fetch, or "" when it does not exist."""
    result = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}"],
        cwd=cwd,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip() if result.returncode == 0 else ""


def load_candidate(artifacts: str, role: str, retention_days: int) -> Optional[Dict[str, Any]]:
    """Merge every artifact for one role (<role>.json, <role>.warp.json, ...)."""
    candidate = None
    for path in sorted(glob.glob(os.path.join(artifacts, f"{role}.*json"))):
        if path.endswith(".status.json"):
            continue
        part = read_json(path)
        if not part or not isinstance(part.get("jobs"), list):
            continue
        part = stamp_seen(part)
        if candidate is None:
            candidate = part
        else:
            candidate = merge_payloads(candidate, part, retention_days)
    return candidate


def build_payloads(
    artifacts: str,
    previous: Dict[str, str],
    retention_days: int,
    unseen_days: int,
    no_merge: bool,
) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, str]]:
    payloads: Dict[str, Dict[str, Any]] = {}
    statuses: Dict[str, str] = {}

    for role in ROLES:
        candidate = load_candidate(artifacts, role, retention_days)

        previous_payload = None
        if role in previous:
            try:
                previous_payload = json.loads(previous[role])
            except Exception:
                previous_payload = None
        if previous_payload:
            _backfill_last_seen(previous_payload)

        fresh_ok = bool(candidate and len(candidate.get("jobs") or []) > 0)

        if fresh_ok and previous_payload and not no_merge:
            fresh_count = len(candidate["jobs"])
            previous_count = len(previous_payload.get("jobs") or [])
            prune = fresh_count >= MIN_FRESH_SHARE_FOR_PRUNE * previous_count
            payloads[role] = merge_payloads(
                previous_payload,
                candidate,
                retention_days,
                unseen_days if prune else None,
            )
            statuses[role] = "merged"
            print(
                f"[publish] {role}: merged {fresh_count} fresh + {previous_count} previous "
                f"-> {payloads[role]['count']}"
                + ("" if prune else " (fresh run is small; unseen jobs kept)")
            )
        elif fresh_ok:
            payloads[role] = merge_payloads({}, candidate, retention_days)
            statuses[role] = "fresh"
        elif previous_payload:
            payloads[role] = previous_payload
            statuses[role] = "kept-previous"
            print(f"[publish] {role}: no fresh data, keeping previous JSON")
        else:
            print(f"[publish] {role}: no data available")
            statuses[role] = "missing"
            continue

        for job in payloads[role]["jobs"]:
            finalize_job(job)

    return payloads, statuses


def build_manifest(payloads: Dict[str, Dict[str, Any]], statuses: Dict[str, str], now: str) -> Dict[str, Any]:
    return {
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


def write_step_summary(payloads: Dict[str, Dict[str, Any]], statuses: Dict[str, str]) -> None:
    """Make stale or missing roles visible in the Actions run instead of silent."""
    lines = ["| Role | Jobs | Status | Years | Level | Not stated |", "| --- | --- | --- | --- | --- | --- |"]
    for role in ROLES:
        jobs = payloads.get(role, {}).get("jobs", [])
        years = sum(1 for j in jobs if j.get("experience_min") is not None or j.get("experience_max") is not None)
        level = sum(1 for j in jobs if j.get("experience_source") == "level")
        lines.append(
            f"| {role} | {len(jobs)} | {statuses.get(role, 'missing')} | {years} | {level} | {len(jobs) - years - level} |"
        )
        if statuses.get(role) in ("kept-previous", "missing"):
            # GitHub renders this as a warning annotation on the run.
            print(f"::warning title=No fresh {role} jobs::{role} published as {statuses.get(role)}")
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("### Published roles\n\n" + "\n".join(lines) + "\n")


def push_data_branch(
    repo_dir: str,
    branch: str,
    payloads: Dict[str, Dict[str, Any]],
    manifest: Dict[str, Any],
    expected_head: str,
    now: str,
) -> bool:
    """Write the orphan branch and push it. Returns False when the remote moved.

    The push uses --force-with-lease against the head we read the previous data
    from, so a concurrent publisher (the PC agent or another run) is never
    silently overwritten; the caller re-reads and merges again instead.
    """
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
                    "git": {"deploymentEnabled": {branch: False}},
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
        push = subprocess.run(
            ["git", "push", f"--force-with-lease={branch}:{expected_head}", "origin", f"HEAD:{branch}"],
            cwd=worktree,
            capture_output=True,
            text=True,
        )
        if push.returncode != 0:
            print(f"[publish] push rejected: {push.stderr.strip()[:300]}")
            return False
        return True
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


def main() -> int:
    parser = argparse.ArgumentParser(description="Publish JSON to the data branch")
    parser.add_argument("--artifacts", default="artifacts")
    parser.add_argument("--branch", default="data")
    parser.add_argument("--repo-dir", default=".")
    parser.add_argument("--retention-days", type=int, default=DEFAULT_RETENTION_DAYS)
    parser.add_argument(
        "--unseen-days",
        type=int,
        default=DEFAULT_UNSEEN_DAYS,
        help="Drop jobs that no scrape has returned for this many days",
    )
    parser.add_argument("--attempts", type=int, default=3, help="Retries when the data branch moved")
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

    for attempt in range(1, max(1, args.attempts) + 1):
        # Read the previous published state (may not exist on the first run).
        subprocess.run(
            ["git", "fetch", "origin", f"+refs/heads/{args.branch}:refs/remotes/origin/{args.branch}"],
            cwd=repo_dir,
            check=False,
            capture_output=True,
        )
        expected_head = remote_head(args.branch, repo_dir)

        previous: Dict[str, str] = {}
        for role in ROLES:
            content = previous_file(args.branch, f"{role}.json", repo_dir)
            if content:
                previous[role] = content

        payloads, statuses = build_payloads(
            artifacts, previous, args.retention_days, args.unseen_days, args.no_merge
        )
        if not payloads:
            print("[publish] nothing to publish")
            return 1

        now = datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")
        manifest = build_manifest(payloads, statuses, now)

        if push_data_branch(repo_dir, args.branch, payloads, manifest, expected_head, now):
            write_step_summary(payloads, statuses)
            print(f"[publish] published {len(payloads)} role(s) to '{args.branch}'")
            for role, payload in payloads.items():
                print(f"[publish]   {role}: {payload.get('count', 0)} jobs ({statuses.get(role)})")
            return 0
        print(f"[publish] data branch moved; retrying ({attempt}/{args.attempts})")

    print("[publish] giving up: the data branch kept changing")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
