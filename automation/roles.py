#!/usr/bin/env python3
"""Single source of truth for the role tracks on the Python side.

Every role is a file in profiles/<slug>.json. matrix.py, publish.py and
agent.py read the list from here instead of keeping their own copies.
tests/test_roles_consistency.py checks that the web app and the workflow
list the same slugs.
"""

from __future__ import annotations

import json
import os
from typing import Dict, Tuple

PROFILES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "profiles")

# Display and publish order.
ROLE_ORDER = ("genai", "data", "uiux", "ba", "sde")


def load_profiles(profiles_dir: str = PROFILES_DIR) -> Dict[str, dict]:
    profiles: Dict[str, dict] = {}
    for name in sorted(os.listdir(profiles_dir)):
        if not name.endswith(".json"):
            continue
        with open(os.path.join(profiles_dir, name), encoding="utf-8-sig") as handle:
            profile = json.load(handle)
        slug = profile.get("role") or name[: -len(".json")]
        profiles[slug] = profile
    return profiles


def _ordered(slugs) -> Tuple[str, ...]:
    known = [slug for slug in ROLE_ORDER if slug in slugs]
    extra = sorted(slug for slug in slugs if slug not in ROLE_ORDER)
    return tuple(known + extra)


PROFILES = load_profiles()
ROLES: Tuple[str, ...] = _ordered(PROFILES)
# Vendor scraper repo per role (BA and SDE reuse the UI/UX pipeline).
REPOS: Dict[str, str] = {slug: PROFILES[slug]["repo"] for slug in ROLES if PROFILES[slug].get("repo")}
# Optional pinned commit per vendor repo; empty means the default branch.
REFS: Dict[str, str] = {slug: PROFILES[slug].get("repo_ref", "") for slug in ROLES}
