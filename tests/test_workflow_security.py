"""Guard rails for the GitHub Actions workflows.

The scrape jobs run third-party code (vendor repos and their requirements), so
the write token must stay with the one job that pushes, and dispatch inputs
must never be pasted into a shell script. PyYAML is not installed in CI, so
these checks read the files as text; the workflows use plain two-space YAML.
"""

import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")


def read(name):
    """Workflow text without full-line comments (they may quote the keys)."""
    with open(os.path.join(WORKFLOWS, name), encoding="utf-8") as handle:
        return "".join(line for line in handle if not line.lstrip().startswith("#"))


def jobs(text):
    """Map job id -> the text of that job (everything under `jobs:`)."""
    body = text.split("\njobs:\n", 1)[1]
    parts = re.split(r"^  ([A-Za-z0-9_-]+):[ \t]*$", body, flags=re.M)
    return dict(zip(parts[1::2], parts[2::2]))


def steps(job_text):
    return re.split(r"^      - ", job_text, flags=re.M)[1:]


def run_blocks(text):
    """Every `run:` script (inline or block scalar) in a workflow."""
    lines = text.splitlines()
    blocks = []
    for index, line in enumerate(lines):
        match = re.match(r"^(\s*)(?:- )?run:(.*)$", line)
        if not match:
            continue
        indent = len(match.group(1))
        block = [match.group(2)]
        for follow in lines[index + 1:]:
            if follow.strip() and len(follow) - len(follow.lstrip()) <= indent:
                break
            block.append(follow)
        blocks.append("\n".join(block))
    return blocks


def test_scrape_token_is_read_only_except_publish():
    text = read("scrape.yml")
    top = text.split("\njobs:\n", 1)[0]
    assert re.search(r"^permissions:\n  contents: read$", top, re.M)
    assert "contents: write" not in top

    by_job = jobs(text)
    assert set(by_job) == {"prepare", "scrape", "warp", "publish"}
    for name, body in by_job.items():
        writes = "contents: write" in body
        assert writes == (name == "publish"), name
    assert re.search(r"^    permissions:\n      contents: write$", by_job["publish"], re.M)


def test_jobs_that_do_not_push_drop_the_checkout_token():
    by_job = jobs(read("scrape.yml"))
    for name, body in by_job.items():
        for step in steps(body):
            if "uses: actions/checkout@" not in step:
                continue
            dropped = re.search(r"^\s+persist-credentials: false$", step, re.M)
            if name == "publish":
                # publish.py pushes through the credentials checkout persists.
                assert not dropped
            else:
                assert dropped, f"{name}: checkout keeps the token in .git/config"


def test_scrape_runs_queue_per_role():
    text = read("scrape.yml")
    group = re.search(r"^concurrency:\n  group: (.+)$", text, re.M).group(1)
    assert "inputs.role" in group and "'all'" in group
    assert re.search(r"^  cancel-in-progress: false$", text, re.M)
    # Concurrent roles race on the data branch; publish retries on a lease miss.
    attempts = int(re.search(r"publish\.py .*--attempts (\d+)", text).group(1))
    assert attempts >= 5


def test_every_job_has_a_timeout():
    for name in ("scrape.yml", "experience-probe.yml"):
        for job, body in jobs(read(name)).items():
            assert re.search(r"^    timeout-minutes: \d+$", body, re.M), f"{name}: {job}"


def test_run_scripts_never_interpolate_dispatch_inputs():
    for name in ("scrape.yml", "experience-probe.yml"):
        for block in run_blocks(read(name)):
            assert not re.search(r"\$\{\{[^}]*\b(inputs|github\.event)\.", block), (name, block)


def test_probe_limit_is_a_validated_number():
    text = read("experience-probe.yml")
    limit = text.split("      limit:", 1)[1].split("\npermissions:", 1)[0]
    assert re.search(r"^        type: number$", limit, re.M)
    assert "LIMIT: ${{ inputs.limit }}" in text
    assert '[[ "$LIMIT" =~ ^[1-9][0-9]{0,2}$ ]]' in text


def test_run_block_helper_finds_interpolation():
    sample = "    steps:\n      - name: x\n        run: |\n          echo \"${{ inputs.role }}\"\n"
    assert any("inputs.role" in block for block in run_blocks(sample))
