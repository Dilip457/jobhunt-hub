"""publish.py against real git repositories: reading the previous data branch
and pushing a new one must round-trip UTF-8, and any failure other than "no
previous file" must abort instead of publishing with data missing."""

import json
import os
import subprocess
import sys
from datetime import datetime, timezone

import pytest

import publish

# Accented Latin, typographic punctuation, Devanagari and an emoji. Several of
# these bytes are undefined in cp1252, which used to empty git's stdout.
UNICODE_TITLE = "Business Analyst Á — Négoce “Lead”… डेटा विश्लेषक 🚀"


def today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def sh(*args, cwd):
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0"}
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, env=env)


def init_repo(path):
    path.mkdir(parents=True, exist_ok=True)
    sh("init", "-q", cwd=path)
    sh("config", "user.name", "test", cwd=path)
    sh("config", "user.email", "test@example.com", cwd=path)
    sh("config", "commit.gpgsign", "false", cwd=path)
    sh("config", "core.autocrlf", "false", cwd=path)
    return path


def ba_payload(title=UNICODE_TITLE):
    return {
        "role": "ba",
        "generated_at": f"{today()}T00:00:00+00:00",
        "count": 1,
        "sources": {"Naukri": 1},
        "jobs": [{
            "id": "1", "title": title, "company": "Société Générale", "location": "Pune",
            "url": "https://x.test/1", "source": "Naukri", "score": 50, "posted_date": today(),
            "first_seen": today(), "last_seen": today(), "snippet": "Requirements gathering…",
        }],
    }


def publish_data_branch(repo, files):
    """Commit <files> (name -> bytes) as an orphan branch and point origin/data at it."""
    sh("checkout", "-q", "--orphan", "tmp-data", cwd=repo)
    sh("rm", "-rfq", "--cached", "--ignore-unmatch", ".", cwd=repo)
    for name, data in files.items():
        (repo / name).write_bytes(data)
        sh("add", name, cwd=repo)
    sh("commit", "-qm", "data", cwd=repo)
    sha = sh("rev-parse", "HEAD", cwd=repo).stdout.decode().strip()
    sh("update-ref", "refs/remotes/origin/data", sha, cwd=repo)
    return sha


def test_previous_file_round_trips_utf8(tmp_path):
    repo = init_repo(tmp_path / "repo")
    raw = json.dumps(ba_payload(), ensure_ascii=False).encode("utf-8")
    publish_data_branch(repo, {"ba.json": raw})

    content = publish.previous_file("data", "ba.json", str(repo))
    assert content is not None
    assert content.encode("utf-8") == raw
    assert json.loads(content)["jobs"][0]["title"] == UNICODE_TITLE


def test_missing_file_or_branch_means_no_previous(tmp_path):
    repo = init_repo(tmp_path / "repo")
    assert publish.remote_head("data", str(repo)) == ""
    assert publish.previous_file("data", "ba.json", str(repo)) is None
    publish_data_branch(repo, {"ba.json": b"{}"})
    assert publish.previous_file("data", "sde.json", str(repo)) is None


def test_undecodable_previous_file_aborts(tmp_path):
    repo = init_repo(tmp_path / "repo")
    head = publish_data_branch(repo, {"ba.json": b'{"role": "ba", "x": "\xff\xfe"}'})
    with pytest.raises(publish.PublishError, match="not valid UTF-8"):
        publish.read_previous(head, str(repo))


def test_corrupt_previous_json_aborts(tmp_path):
    repo = init_repo(tmp_path / "repo")
    head = publish_data_branch(repo, {"ba.json": b'{"role": "ba", "jobs": ['})
    with pytest.raises(publish.PublishError, match="not valid JSON"):
        publish.read_previous(head, str(repo))


def test_git_failure_is_not_treated_as_first_publish(tmp_path):
    not_a_repo = tmp_path / "plain"
    not_a_repo.mkdir()
    with pytest.raises(publish.PublishError):
        publish.remote_head("data", str(not_a_repo))


def test_git_calls_disable_terminal_prompts(monkeypatch):
    seen = {}

    def fake_run(cmd, **kwargs):
        seen.update(kwargs)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(publish.subprocess, "run", fake_run)
    publish.git(["status"], ".")
    assert seen["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert seen["encoding"] == "utf-8"
    assert seen["timeout"] == publish.GIT_TIMEOUT


def run_main(monkeypatch, work, artifacts):
    monkeypatch.setattr(sys, "argv", [
        "publish.py", "--artifacts", str(artifacts), "--branch", "data", "--repo-dir", str(work), "--attempts", "1",
    ])
    return publish.main()


def make_origin(tmp_path):
    origin = tmp_path / "origin.git"
    sh("init", "-q", "--bare", str(origin), cwd=tmp_path)
    work = init_repo(tmp_path / "work")
    (work / "README").write_text("x")
    sh("add", "README", cwd=work)
    sh("commit", "-qm", "init", cwd=work)
    sh("remote", "add", "origin", str(origin), cwd=work)
    return origin, work


def test_end_to_end_publish_keeps_non_ascii_previous_jobs(tmp_path, monkeypatch):
    origin, work = make_origin(tmp_path)
    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()

    # First publish: one BA job with a non-ASCII title.
    (artifacts / "ba.json").write_text(json.dumps(ba_payload(), ensure_ascii=False), encoding="utf-8")
    assert run_main(monkeypatch, work, artifacts) == 0

    # Second publish: a different fresh job; the first must be carried over intact.
    fresh = ba_payload(title="Business Analyst")
    fresh["jobs"][0].update(id="2", url="https://x.test/2", company="Acme")
    (artifacts / "ba.json").write_text(json.dumps(fresh), encoding="utf-8")
    assert run_main(monkeypatch, work, artifacts) == 0

    shown = sh("show", "data:ba.json", cwd=origin).stdout.decode("utf-8")
    published = json.loads(shown)
    titles = sorted(j["title"] for j in published["jobs"])
    assert titles == sorted([UNICODE_TITLE, "Business Analyst"])
    assert "Société Générale" in shown and "Ã" not in shown
    assert published["count"] == 2


def test_end_to_end_publish_aborts_on_unreadable_previous(tmp_path, monkeypatch):
    origin, work = make_origin(tmp_path)
    head = publish_data_branch(work, {"ba.json": b'{"role": "ba", "jobs": [], "x": "\xff"}'})
    sh("push", "-q", "origin", f"{head}:refs/heads/data", cwd=work)

    artifacts = tmp_path / "artifacts"
    artifacts.mkdir()
    (artifacts / "sde.json").write_text(json.dumps({**ba_payload(), "role": "sde"}), encoding="utf-8")
    assert run_main(monkeypatch, work, artifacts) == 1
    # The data branch was left exactly as it was.
    assert sh("rev-parse", "data", cwd=origin).stdout.decode().strip() == head
