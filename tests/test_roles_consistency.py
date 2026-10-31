"""The role list lives in profiles/; every other copy must agree with it."""

import os
import re

import matrix
from roles import REPOS, ROLES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding="utf-8") as handle:
        return handle.read()


def test_every_role_has_a_vendor_repo():
    assert set(REPOS) == set(ROLES)


def test_matrix_all_covers_every_role():
    roles = [item["role"] for item in matrix.build_matrix("all")["include"]]
    assert roles == list(ROLES)
    assert [item["role"] for item in matrix.build_matrix("ba")["include"]] == ["ba"]


def test_web_role_slugs_match():
    types = read("web", "lib", "types.ts")
    slugs = re.search(r"ROLE_SLUGS: RoleSlug\[\] = \[([^\]]*)\]", types).group(1)
    assert re.findall(r'"([a-z]+)"', slugs) == list(ROLES)
    roles_ts = read("web", "lib", "roles.ts")
    assert re.findall(r'slug: "([a-z]+)"', roles_ts) == list(ROLES)
    fallback = read("web", "lib", "fallback.ts")
    for role in ROLES:
        assert f"{role}: " in fallback
        assert os.path.exists(os.path.join(ROOT, "web", "data", f"{role}.json"))


def test_workflow_dispatch_choices_match():
    workflow = read(".github", "workflows", "scrape.yml")
    block = workflow.split("options:", 1)[1].split("permissions:", 1)[0]
    choices = re.findall(r"^\s*-\s*([a-z]+)\s*$", block, re.M)
    assert choices == ["all", *ROLES]
    probe = read(".github", "workflows", "experience-probe.yml")
    block = probe.split("options:", 1)[1].split("limit:", 1)[0]
    assert re.findall(r"^\s*-\s*([a-z]+)\s*$", block, re.M) == list(ROLES)
