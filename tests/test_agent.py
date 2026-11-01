import json
import os
import sys
from datetime import datetime, timedelta, timezone

import agent


def stamp(hours_ago: float, offset_hours: float = 0) -> str:
    tz = timezone(timedelta(hours=offset_hours))
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).astimezone(tz).isoformat(timespec="seconds")


def test_staleness_uses_the_oldest_role():
    manifest = {"roles": {
        "genai": {"generated_at": stamp(1)},
        "data": {"generated_at": stamp(30)},
        "ba": {"generated_at": stamp(2)},
    }}
    # One freshly refreshed role must not hide a role that is 30 hours old.
    assert 29.9 < agent.oldest_role_age_hours(manifest) < 30.1


def test_staleness_compares_offsets_as_times_not_strings():
    # 4 hours old written in IST sorts after 1 hour old in UTC as a string.
    ist_old = stamp(4, offset_hours=5.5)
    utc_new = stamp(1)
    assert ist_old > utc_new
    manifest = {"roles": {"genai": {"generated_at": ist_old}, "data": {"generated_at": utc_new}}}
    assert 3.9 < agent.oldest_role_age_hours(manifest) < 4.1


def test_staleness_unknown_without_timestamps():
    assert agent.oldest_role_age_hours({"roles": {"genai": {}, "data": {"generated_at": "junk"}}}) is None
    assert agent.oldest_role_age_hours({}) is None


def test_agent_writes_utc_and_reads_naive_as_utc():
    assert agent.iso_now().endswith("+00:00")
    naive = agent.parse_stamp("2026-10-31T05:00:00")
    assert naive == datetime(2026, 10, 31, 5, tzinfo=timezone.utc)


def test_clear_role_artifacts_removes_only_that_role(tmp_path):
    for name in ("ba.json", "ba.json.status.json", "ba.warp.json", "ba.apis.json", "bad.json", "data.json"):
        (tmp_path / name).write_text("{}")
    removed = agent.clear_role_artifacts(str(tmp_path), "ba")
    assert sorted(os.path.basename(p) for p in removed) == [
        "ba.apis.json", "ba.json", "ba.json.status.json", "ba.warp.json",
    ]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["bad.json", "data.json"]
    assert agent.clear_role_artifacts(str(tmp_path), "ba") == []


def test_agent_run_does_not_leave_old_artifacts_for_publish(tmp_path, monkeypatch):
    portal = tmp_path / "portal"
    (portal / "automation").mkdir(parents=True)
    (portal / "profiles").mkdir()
    (portal / "profiles" / "genai.json").write_text(json.dumps({"repo": ""}))
    (portal / "vendor" / "genai").mkdir(parents=True)
    artifacts = portal / "artifacts"
    artifacts.mkdir()
    # Yesterday's files: one for the role run now, one for a role not run.
    (artifacts / "genai.json").write_text("{}")
    (artifacts / "data.json").write_text("{}")
    (artifacts / "data.warp.json").write_text("{}")

    commands = []
    monkeypatch.setattr(agent, "run", lambda cmd, cwd, check=False: commands.append(cmd) or 0)
    monkeypatch.setattr(agent, "published_age_hours", lambda portal_dir: 1.0)
    monkeypatch.setattr(sys, "argv", ["agent.py", "--portal-dir", str(portal), "--roles", "genai"])
    assert agent.main() == 0

    assert sorted(p.name for p in artifacts.iterdir()) == []
    assert any("run_source.py" in " ".join(c) and "genai" in c for c in commands)
    assert any("publish.py" in " ".join(c) for c in commands)


def test_git_env_disables_credential_prompts():
    env = agent.git_env()
    assert env["GIT_TERMINAL_PROMPT"] == "0"
    assert env["GCM_INTERACTIVE"] == "never"


def test_failed_clone_leaves_no_partial_vendor_folder(tmp_path, monkeypatch):
    portal = tmp_path / "portal"
    (portal / "automation").mkdir(parents=True)
    (portal / "profiles").mkdir()
    (portal / "profiles" / "genai.json").write_text(json.dumps({"repo": "someone/genai"}))
    repo_dir = portal / "vendor" / "genai"

    commands = []

    def fake_run(cmd, cwd, check=False):
        commands.append(cmd)
        if cmd[:2] == ["git", "clone"]:
            # A clone that times out half way leaves a folder behind.
            (repo_dir / ".git").mkdir(parents=True)
            return 124
        return 0

    monkeypatch.setattr(agent, "run", fake_run)
    monkeypatch.setattr(agent, "published_age_hours", lambda portal_dir: 1.0)
    monkeypatch.setattr(sys, "argv", ["agent.py", "--portal-dir", str(portal), "--roles", "genai"])
    assert agent.main() == 0

    assert not repo_dir.exists()
    assert not any("run_source.py" in " ".join(c) for c in commands)
