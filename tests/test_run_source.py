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
