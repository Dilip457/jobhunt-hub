#!/usr/bin/env python3
"""Emit the GitHub Actions matrix for the requested roles."""

from __future__ import annotations

import argparse
import json

REPOS = {
    "genai": "Dilip457/Job-Hunt-for-GenAI-Profile",
    "data": "Dilip457/DataEngineer_JobHunt",
    "uiux": "Dilip457/UI-UX-Job_Hunt",
    # Business Analyst reuses the UI/UX vendor pipeline; the BA profile below
    # replaces its keywords and skills, so no separate vendor repo is needed.
    "ba": "Dilip457/UI-UX-Job_Hunt",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--role", default="all")
    args = parser.parse_args()

    roles = list(REPOS) if args.role in ("", "all", None) else [args.role]
    include = [{"role": role, "repo": REPOS[role]} for role in roles if role in REPOS]
    if not include:
        include = [{"role": role, "repo": REPOS[role]} for role in REPOS]

    print("matrix=" + json.dumps({"include": include}))


if __name__ == "__main__":
    main()
