"""run_source.py must report a failed vendor pipeline instead of "success"."""

import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def make_vendor(path, pipeline_body):
    path.mkdir()
    (path / "config.py").write_text(f"DB_PATH = {str(path / 'jobs.db')!r}\n")
    (path / "scoring_engine.py").write_text("class ScoringEngine:\n    pass\n")
    (path / "main.py").write_text(
        "SCRAPER_REGISTRY = {}\n"
        "class DashboardGenerator:\n    pass\n"
        "class JobSearchPipeline:\n"
        "    def __init__(self, sources=None):\n        pass\n"
        "    def run(self):\n" + pipeline_body
    )


def run_source(vendor, out):
    return subprocess.run(
        [sys.executable, os.path.join(ROOT, "automation", "run_source.py"),
         "--role", "uiux", "--repo-dir", str(vendor), "--out", str(out),
         "--no-portal", "--no-apis", "--no-validate", "--parallel-sources", "1"],
        capture_output=True, text=True, timeout=60,
    )


def test_failed_pipeline_is_reported(tmp_path):
    vendor = tmp_path / "vendor"
    make_vendor(vendor, "        raise RuntimeError('linkedin blocked')\n")
    out = tmp_path / "uiux.json"
    result = run_source(vendor, out)
    assert result.returncode == 0, result.stdout + result.stderr
    status = json.loads((tmp_path / "uiux.json.status.json").read_text())
    assert status["status"] == "empty"
    assert any("linkedin blocked" in p for p in status["problems"])
    assert "::warning title=uiux scrape empty::" in result.stdout
    assert json.loads(out.read_text())["count"] == 0


def make_db(path, url):
    import sqlite3
    from datetime import datetime, timezone

    today = datetime.now(timezone.utc).date().isoformat()
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE jobs (job_id TEXT, title TEXT, company TEXT, location TEXT, url TEXT, apply_url TEXT,"
        " source TEXT, posted_date TEXT, description TEXT, match_score REAL, role_match REAL,"
        " skill_match REAL, experience_match REAL, tool_match REAL, domain_match REAL,"
        " validation_status TEXT, is_new INTEGER, first_seen TEXT, last_seen TEXT)"
    )
    conn.execute(
        "INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0,0,NULL,1,?,?)",
        ("1", "UI/UX Designer", "Acme", "Bangalore", url, url, "LinkedIn", today,
         "Design product screens.", 80, today, today),
    )
    conn.commit()
    conn.close()


def test_previous_publish_is_reused_instead_of_fetched(tmp_path):
    url = "https://www.linkedin.com/jobs/view/ui-ux-designer-at-acme-4100000001"
    vendor = tmp_path / "vendor"
    make_vendor(vendor, "        return {}\n")
    make_db(vendor / "jobs.db", url)
    previous = tmp_path / "previous.json"
    previous.write_text(json.dumps({"role": "uiux", "jobs": [
        {"url": url + "?trackingId=abc", "experience_min": 3, "experience_max": 5,
         "experience_source": "page", "experience_level": None, "experience_checked": "2026-10-20"},
    ]}))
    out = tmp_path / "uiux.json"
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, "automation", "run_source.py"),
         "--role", "uiux", "--repo-dir", str(vendor), "--out", str(out),
         "--no-portal", "--no-apis", "--no-validate", "--parallel-sources", "1",
         "--previous", str(previous)],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    job = json.loads(out.read_text())["jobs"][0]
    # Matched by canonical URL despite the tracking parameter; no page fetch needed.
    assert (job["experience_min"], job["experience_max"], job["experience_source"]) == (3, 5, "page")
    assert job["experience_checked"] == "2026-10-20"
    assert '"resolved": 1' in result.stderr
    status = json.loads((tmp_path / "uiux.json.status.json").read_text())
    assert not any(p.startswith("experience") for p in status["problems"])


def test_missing_previous_file_is_fine(tmp_path):
    vendor = tmp_path / "vendor"
    make_vendor(vendor, "        return {}\n")
    out = tmp_path / "uiux.json"
    result = subprocess.run(
        [sys.executable, os.path.join(ROOT, "automation", "run_source.py"),
         "--role", "uiux", "--repo-dir", str(vendor), "--out", str(out),
         "--no-portal", "--no-apis", "--no-validate", "--parallel-sources", "1",
         "--previous", str(tmp_path / "absent.json")],
        capture_output=True, text=True, timeout=60,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    status = json.loads((tmp_path / "uiux.json.status.json").read_text())
    assert not any(p.startswith("experience") for p in status["problems"])
