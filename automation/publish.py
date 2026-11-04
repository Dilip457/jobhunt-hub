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
import re
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple
from urllib.parse import urlsplit

from api_sources import score_parts, title_relevant
from export import canonical_url, dedupe_jobs, states_experience, valid_url

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
# Seconds before a git call is abandoned. Local steps are instant; this only
# matters when fetch/push stalls on the network or a credential helper.
GIT_TIMEOUT = 300


RECOVERY_HINT = " (fix or delete it on the data branch; see docs/IMPLEMENTATION.md 5.4)"


class PublishError(RuntimeError):
    """A git step failed in a way that would publish incomplete data."""


def _git_env() -> Dict[str, str]:
    # Fail instead of waiting for a username/password nobody will type.
    # GIT_TERMINAL_PROMPT covers the console prompt; GCM_INTERACTIVE stops
    # Git Credential Manager's sign-in window on Windows.
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GCM_INTERACTIVE": "never"}


def git(args: list[str], cwd: Optional[str], check: bool = True, timeout: int = GIT_TIMEOUT) -> subprocess.CompletedProcess:
    """Run git with UTF-8 output decoding, no terminal prompts and a timeout.

    Without an explicit encoding Python decodes git's output with the Windows
    ANSI code page, which mangles or silently drops UTF-8 text.
    """
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=check,
        capture_output=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=_git_env(),
    )


def git_step(args: list[str], cwd: str) -> subprocess.CompletedProcess:
    """A git call that must succeed; failures become PublishError with git's message."""
    try:
        return git(args, cwd)
    except subprocess.CalledProcessError as exc:
        raise PublishError(f"git {args[0]} failed: {(exc.stderr or '').strip()[:300]}") from exc
    except (OSError, subprocess.SubprocessError) as exc:
        raise PublishError(f"git {args[0]} failed: {exc}") from exc


def git_quiet(args: list[str], cwd: str) -> None:
    """Best-effort cleanup; never raises."""
    try:
        git(args, cwd, check=False)
    except (OSError, subprocess.SubprocessError):
        pass


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


def _count_sources(jobs: list[Dict[str, Any]]) -> Dict[str, int]:
    """Jobs per source, largest first (the shape the manifest and site expect)."""
    sources: Dict[str, int] = {}
    for job in jobs:
        name = job.get("source") or "Unknown"
        sources[name] = sources.get(name, 0) + 1
    return dict(sorted(sources.items(), key=lambda kv: -kv[1]))


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_stamp(value: Any) -> Optional[datetime]:
    """An ISO timestamp as an aware datetime (naive values are taken as UTC)."""
    if not value:
        return None
    try:
        when = datetime.fromisoformat(str(value).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def newest_stamp(values: list[Any]) -> Optional[str]:
    """The latest of several ISO timestamps, written in UTC.

    Compared as datetimes: as strings "09:00+05:30" sorts after "05:00+00:00"
    although it is half an hour earlier, so mixing PC and CI publishes could
    move generated_at backwards.
    """
    stamps = [when for when in (parse_stamp(v) for v in values) if when]
    if not stamps:
        return None
    return max(stamps).astimezone(timezone.utc).isoformat(timespec="seconds")


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
    generated = parse_stamp(payload.get("generated_at"))
    fallback = generated.astimezone(timezone.utc).date().isoformat() if generated else _today()
    for job in payload.get("jobs", []):
        if not job.get("last_seen"):
            job["last_seen"] = fallback


def cap_posted_date(job: Dict[str, Any]) -> None:
    """A listing was posted no later than we first collected it.

    Indeed and SimplyHired used to stamp the scrape date as posted_date,
    refreshed every run; capping at first_seen retires those fake dates.
    """
    first_seen = (job.get("first_seen") or "")[:10]
    posted = (job.get("posted_date") or "")[:10]
    if posted and first_seen and posted > first_seen:
        job["posted_date"] = first_seen


# Listings are scraped text, so a scam posted on a board arrives here too. These
# only ever appear in a listing that asks the applicant to pay or to move off the
# board; ordinary wording about pay or benefits does not match.
FEE_DEMAND_RE = re.compile(
    # "no processing fee" is a lender describing its product, not a demand.
    r"(?<!\bno )(?<!\bzero )(?<!\bnil )(?<!without )(?<!without any )"
    r"\b(?:registration|processing|training|joining|application|interview)\s+(?:fees?|charges?)\b"
    r"|\brefundable\s+(?:fees?|deposit|amount)\b",
    re.I,
)
# Link shorteners hide the destination; chat links take the applicant off the board.
BLOCKED_LINK_HOSTS = frozenset({
    "bit.ly", "tinyurl.com", "t.co", "goo.gl", "ow.ly", "rb.gy", "cutt.ly", "is.gd", "shorturl.at",
    "wa.me", "t.me", "telegram.me", "chat.whatsapp.com", "api.whatsapp.com",
})
EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
INDIAN_PHONE_RE = re.compile(r"(?<![\d-])(?:\+?91[ -]?)?[6-9]\d{4}[ -]?\d{5}(?!\d)")
CONTACT_REMOVED = "[contact removed]"


def _link_host(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def unsafe_listing(job: Dict[str, Any]) -> Optional[str]:
    """Why a job must not be published, or None. Runs in the one job holding a write token."""
    url = job.get("url") or ""
    if not valid_url(url):
        return "unsafe link"
    apply_url = job.get("apply_url") or ""
    for link in (url, apply_url):
        if link and valid_url(link) and _link_host(link) in BLOCKED_LINK_HOSTS:
            return "shortener or chat link"
    if FEE_DEMAND_RE.search(f"{job.get('title') or ''} {job.get('snippet') or ''}"):
        return "asks for a fee"
    return None


def drop_unsafe(payload: Dict[str, Any], role: str) -> int:
    """Remove listings unsafe_listing rejects, including carried-over ones, and recount."""
    jobs = payload.get("jobs") or []
    kept = []
    for job in jobs:
        reason = unsafe_listing(job)
        if reason:
            print(f"[publish] {role}: dropped {job.get('company')!r} {job.get('title')!r}: {reason}")
        else:
            kept.append(job)
    payload["jobs"] = kept
    payload["count"] = len(kept)
    return len(jobs) - len(kept)


def redact_contacts(text: str) -> str:
    """A recruiter's email or phone in a listing is personal data this site need not republish."""
    return INDIAN_PHONE_RE.sub(CONTACT_REMOVED, EMAIL_RE.sub(CONTACT_REMOVED, text))


def finalize_job(job: Dict[str, Any], new_days: int = NEW_DAYS, role: Optional[str] = None) -> Dict[str, Any]:
    """Fields derived at publish time, plus trimming of unused fields."""
    first_seen = (job.get("first_seen") or "")[:10]
    cap_posted_date(job)
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
    # The dashboard draws the parts of the top match's score. Jobs published
    # before the parts existed, before the "tool" part was split out, and ATS
    # jobs that carried zeros, get theirs from today's rules; a set that is
    # still all zeros is not a breakdown.
    parts = dict(job.get("score_parts") or {})
    if role and (not any(parts.values()) or "tool" not in parts):
        parts = score_parts(role, job.get("title") or "", job.get("snippet") or "")
    if any(parts.values()):
        job["score_parts"] = parts
    else:
        job.pop("score_parts", None)
    if job.get("snippet"):
        job["snippet"] = redact_contacts(job["snippet"])
    if job.get("apply_url") == job.get("url") or not valid_url(job.get("apply_url") or ""):
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
    scoring rules); first_seen and posted_date keep the oldest value and
    last_seen the newest. Jobs older than retention_days (by posted_date, or
    first_seen when the board gave no date) are dropped, except undated jobs
    the fresh scrape still lists. With unseen_days set, jobs that no scrape
    has returned for that many days are treated as closed and dropped.
    """
    merged: Dict[str, Dict[str, Any]] = {}
    # Jobs the fresh scrape lists without a posted date (see the age check).
    listed_undated = {
        key for key in (_job_key(job) for job in fresh.get("jobs", []) if not job.get("posted_date")) if key
    }

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
            # Keep the earliest known posted date. A board that re-dates a
            # listing (or a copy with no date) must not make it look new or
            # restart its retention clock.
            posts = [v for v in (current.get("posted_date"), job.get("posted_date")) if v]
            merged_job["posted_date"] = min(posts, key=lambda v: str(v)[:10]) if posts else None

            merged[key] = merged_job

    cutoff = _days_ago(retention_days)
    unseen_cutoff = _days_ago(unseen_days) if unseen_days else None
    jobs = []
    for key, job in merged.items():
        # Cap before the age check, so a fake date published before the cap
        # existed cannot keep an old job inside the window for one more run.
        cap_posted_date(job)
        stamp = (job.get("posted_date") or job.get("first_seen") or "")[:10]
        # When the board's current listing gives no date, first_seen is only
        # our own first sighting, not the job's age. Expiring it while still
        # listed would bring it straight back next run as a NEW job (no
        # previous copy left to keep first_seen), every retention_days. It
        # leaves once the board stops listing it: then it is aged as usual.
        if key in listed_undated:
            stamp = ""
        if stamp and stamp < cutoff:
            continue
        last_seen = (job.get("last_seen") or "")[:10]
        if unseen_cutoff and last_seen and last_seen < unseen_cutoff:
            continue
        jobs.append(job)

    # Same listing found on several boards under different URLs.
    jobs = dedupe_jobs(jobs)
    jobs.sort(key=lambda j: (-(j.get("score") or 0), j.get("posted_date") or ""))

    return {
        "role": fresh.get("role") or previous.get("role"),
        "generated_at": newest_stamp([previous.get("generated_at"), fresh.get("generated_at")]) or utc_now(),
        "count": len(jobs),
        "sources": _count_sources(jobs),
        "jobs": jobs,
        "demo": False,
    }


def file_at(commit: str, filename: str, cwd: Optional[str] = None) -> Optional[str]:
    """Content of <filename> in <commit>, or None when the commit has no such file.

    Any other failure raises PublishError. Treating a failed read as "no
    previous file" would publish the role without its carried-over jobs, or
    drop the role from the data branch entirely.
    """
    try:
        listing = git(["ls-tree", "--name-only", commit, "--", filename], cwd)
        if listing.stdout.strip() != filename:
            return None
        # Read raw bytes and decode here, so a decoding problem raises in this
        # thread instead of silently emptying stdout.
        shown = subprocess.run(
            ["git", "show", f"{commit}:{filename}"],
            cwd=cwd,
            capture_output=True,
            timeout=GIT_TIMEOUT,
            env=_git_env(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PublishError(f"could not read {filename} from {commit[:12]}: {exc}") from exc
    if shown.returncode != 0:
        error = shown.stderr.decode("utf-8", "replace").strip()
        raise PublishError(f"could not read {filename} from {commit[:12]}: {error}")
    try:
        return shown.stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PublishError(f"{filename} on {commit[:12]} is not valid UTF-8: {exc}{RECOVERY_HINT}") from exc


def previous_file(branch: str, filename: str, cwd: Optional[str] = None) -> Optional[str]:
    """Previous content of <filename> on origin/<branch>; None when not published yet."""
    head = remote_head(branch, cwd)
    return file_at(head, filename, cwd) if head else None


def remote_head(branch: str, cwd: Optional[str]) -> str:
    """SHA of origin/<branch> after the last fetch, or "" when it does not exist."""
    try:
        result = git(
            ["rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}^{{commit}}"],
            cwd,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise PublishError(f"could not resolve origin/{branch}: {exc}") from exc
    if result.returncode == 0:
        return result.stdout.strip()
    # --quiet exits 1 with no message when the ref is simply missing; anything
    # else (not a repository, broken git) must not look like a first publish.
    if result.returncode == 1 and not result.stderr.strip():
        return ""
    raise PublishError(f"could not resolve origin/{branch}: {result.stderr.strip()}")


def read_previous(head: str, cwd: str) -> Dict[str, str]:
    """Every published role file at <head>, checked to be a JSON object."""
    previous: Dict[str, str] = {}
    if not head:
        return previous
    for role in ROLES:
        content = file_at(head, f"{role}.json", cwd)
        if content is None:
            continue
        # Recovery (fix or delete the file on the data branch) is described
        # in docs/IMPLEMENTATION.md 5.4.
        try:
            parsed = json.loads(content)
        except ValueError as exc:
            raise PublishError(f"published {role}.json is not valid JSON: {exc}{RECOVERY_HINT}") from exc
        if not isinstance(parsed, dict):
            raise PublishError(f"published {role}.json is not a JSON object{RECOVERY_HINT}")
        previous[role] = content
    return previous


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
            # Jobs past the retention window still age out, so a role whose
            # scraper keeps failing does not show stale listings forever. No
            # unseen-days pruning here: when the scrape failed, a job missing
            # from the run is no evidence that it closed.
            payloads[role] = merge_payloads(previous_payload, {"role": role}, retention_days)
            statuses[role] = "kept-previous"
            print(
                f"[publish] {role}: no fresh data, keeping previous JSON "
                f"({len(previous_payload.get('jobs') or [])} -> {payloads[role]['count']} after retention)"
            )
        else:
            print(f"[publish] {role}: no data available")
            statuses[role] = "missing"
            continue

        drop_offrole(payloads[role], role)
        drop_unsafe(payloads[role], role)
        for job in payloads[role]["jobs"]:
            finalize_job(job, role=role)

    return payloads, statuses


def drop_offrole(payload: Dict[str, Any], role: str) -> int:
    """Re-apply today's title rules to every job, including carried-over ones.

    Collectors already filter fresh jobs, but merged and kept-previous jobs
    were filtered by whatever rules were live when they were scraped. Without
    this, a tightened role definition (BA dropping Product Analyst) would only
    take effect as old jobs age out.
    """
    jobs = payload.get("jobs") or []
    kept = [job for job in jobs if title_relevant(role, job.get("title") or "")]
    dropped = len(jobs) - len(kept)
    # Always recount: the manifest copies count and sources from here, and
    # they must describe the jobs actually published.
    payload["jobs"] = kept
    payload["count"] = len(kept)
    payload["sources"] = _count_sources(kept)
    if dropped:
        print(f"[publish] {role}: dropped {dropped} jobs whose titles no longer match the role")
    return dropped


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

    git_quiet(["worktree", "prune"], repo_dir)
    git_step(["worktree", "add", "--detach", worktree], repo_dir)

    try:
        git_step(["checkout", "--orphan", tmp_branch], worktree)
        git_quiet(["rm", "-rf", "."], worktree)

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

        git_step(["add", "-A"], worktree)
        git_step(["commit", "-m", f"data: publish {', '.join(payloads)} at {now}"], worktree)
        try:
            push = git(
                ["push", f"--force-with-lease={branch}:{expected_head}", "origin", f"HEAD:{branch}"],
                worktree,
                check=False,
            )
        except (OSError, subprocess.SubprocessError) as exc:
            raise PublishError(f"git push failed: {exc}") from exc
        if push.returncode != 0:
            print(f"[publish] push rejected: {push.stderr.strip()[:300]}")
            return False
        return True
    finally:
        git_quiet(["worktree", "remove", "--force", worktree], repo_dir)
        git_quiet(["branch", "-D", tmp_branch], repo_dir)


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

    git_quiet(["config", "user.name", "jobhunt-bot"], repo_dir)
    git_quiet(["config", "user.email", "jobhunt-bot@users.noreply.github.com"], repo_dir)

    try:
        return publish(args, repo_dir, artifacts)
    except PublishError as exc:
        # Publishing with a role's previous data unreadable would silently
        # discard its carried-over jobs, so stop and leave the branch as it is.
        print(f"::error title=Publish aborted::{exc}")
        print(f"[publish] aborted, nothing was pushed: {exc}")
        return 1


def publish(args: argparse.Namespace, repo_dir: str, artifacts: str) -> int:
    for attempt in range(1, max(1, args.attempts) + 1):
        # Read the previous published state (may not exist on the first run).
        try:
            fetch = git(
                ["fetch", "origin", f"+refs/heads/{args.branch}:refs/remotes/origin/{args.branch}"],
                repo_dir,
                check=False,
            )
            if fetch.returncode != 0:
                # Also the normal first-run message. The push lease below still
                # refuses to overwrite a remote branch we could not read.
                print(f"[publish] fetch of '{args.branch}' failed: {fetch.stderr.strip()[:300]}")
        except subprocess.TimeoutExpired:
            print(f"[publish] fetch of '{args.branch}' timed out")
        expected_head = remote_head(args.branch, repo_dir)
        previous = read_previous(expected_head, repo_dir)

        payloads, statuses = build_payloads(
            artifacts, previous, args.retention_days, args.unseen_days, args.no_merge
        )
        if not payloads:
            print("[publish] nothing to publish")
            return 1

        now = utc_now()
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
