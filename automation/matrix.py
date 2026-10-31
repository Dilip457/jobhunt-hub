#!/usr/bin/env python3
"""Emit the GitHub Actions matrix for the requested roles.

Roles and their vendor repos come from profiles/*.json (see roles.py). A
profile can pin its vendor repo with "repo_ref": "<commit sha or tag>"; an
empty ref checks out the default branch.
"""

from __future__ import annotations

import argparse
import json

from roles import REFS, REPOS


def build_matrix(role: str) -> dict:
    roles = list(REPOS) if role in ("", "all", None) else [role]
    include = [
        {"role": slug, "repo": REPOS[slug], "ref": REFS.get(slug, "")}
        for slug in roles
        if slug in REPOS
    ]
    if not include:
        include = [{"role": slug, "repo": REPOS[slug], "ref": REFS.get(slug, "")} for slug in REPOS]
    return {"include": include}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", default="all")
    args = parser.parse_args()
    print("matrix=" + json.dumps(build_matrix(args.role)))


if __name__ == "__main__":
    main()
