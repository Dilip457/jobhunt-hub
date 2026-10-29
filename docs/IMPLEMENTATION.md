# Implementation — JobHunt Hub

This document explains how the system is implemented, file by file, and how to run, deploy and troubleshoot it.

For the high-level design, see [Architecture](ARCHITECTURE.md).

---

## 1. Prerequisites

### Required

| Requirement | Notes |
|---|---|
| GitHub account + repository | Hosts code, Actions and the `data` branch |
| Vercel account | Free Hobby plan is sufficient |
| Python 3.11 | GitHub Actions uses 3.11; the same version is recommended locally |
| Node.js 20+ | For the Next.js app |
| Git | For local development and publishing |

### Optional

| Requirement | Use |
|---|---|
| Adzuna / Jooble / JSearch keys | Extra API sources (off in the cloud workflow) |
| Cloudflare WARP | Indeed / SimplyHired access; installed by the workflow |
| Local PC agent | Residential-IP fallback for Indeed; not required |

No database, paid domain, proxy subscription, or portal account is needed for the core flow.

---

## 2. Repository map

```text
jobhunt-hub/
├─ .github/
│  └─ workflows/
│     └─ scrape.yml              # cron + manual dispatch + scrape/warp/publish
├─ automation/
│  ├─ run_source.py              # run a vendor repo with portal overrides, then export
│  ├─ portal_scrapers.py         # direct Naukri/Foundit/Indeed/Shine/SimplyHired scrapers
│  ├─ api_sources.py             # optional APIs + company ATS boards
│  ├─ export.py                  # SQLite → compact public JSON
│  ├─ publish.py                 # merge artifacts + force-push the `data` branch
│  ├─ matrix.py                  # role → vendor repo matrix for Actions
│  ├─ companies.json             # optional ATS company tokens
│  ├─ requirements.txt           # portal scraper dependencies
│  ├─ agent.py                   # optional local residential-IP agent
│  ├─ install-agent.ps1          # optional Windows scheduled task setup
│  └─ run-agent.ps1              # optional scheduled task entry point
├─ profiles/
│  ├─ genai.json                 # GenAI role keywords, sources, limits
│  ├─ data.json                  # Data Engineering profile
│  └─ uiux.json                  # UI/UX profile
├─ vendor/                       # cloned at runtime, not committed
├─ web/                          # Next.js 15 app (Vercel Root Directory)
│  ├─ app/
│  │  ├─ page.tsx                # cinematic intro (/)
│  │  ├─ jobs/[role]/page.tsx    # pre-rendered dashboards
│  │  ├─ globals.css
│  │  └─ api/
│  │     ├─ jobs/route.ts
│  │     ├─ refresh/route.ts
│  │     └─ status/route.ts
│  ├─ components/
│  │  ├─ CinematicIntro.tsx      # Three.js scene, camera and transitions
│  │  ├─ IntroPage.tsx           # dynamic loader for the cinematic
│  │  ├─ IntroBoot.tsx           # clean boot screen; no greeting or role cards
│  │  ├─ StaticIntro.tsx         # reduced-motion / WebGL / load fallback
│  │  ├─ RoleDestinations.tsx    # accessible destination cards
│  │  ├─ JobDashboard.tsx        # route-driven dashboard
│  │  ├─ RoleSwitcher.tsx
│  │  ├─ Filters.tsx
│  │  ├─ JobCard.tsx
│  │  ├─ StatsBar.tsx
│  │  ├─ ConfirmRefresh.tsx
│  │  ├─ RefreshPanel.tsx
│  │  └─ ...
│  ├─ lib/
│  │  ├─ github.ts               # GitHub Contents API + workflow dispatch/status
│  │  ├─ service.ts              # role/manifest loading + seed fallback
│  │  ├─ fallback.ts             # seed JSON fallback
│  │  ├─ prefetch.ts             # dashboard prefetch during the intro transition
│  │  ├─ roles.ts                # role metadata
│  │  ├─ types.ts                # RoleSlug, Job, RoleData, Manifest, RunState
│  │  └─ utils.ts                # dates, score tiers, filters
│  ├─ public/models/student/
│  │  └─ student.glb, scene.webp, portrait.webp, ATTRIBUTION.txt
│  └─ data/                      # seed JSON used before the first live scrape
├─ docs/
│  ├─ ARCHITECTURE.md
│  └─ IMPLEMENTATION.md
└─ README.md
```

`vendor/` is not committed; the workflow checks out each scraper repo at run time.

---

## 3. GitHub Actions workflow

File: `.github/workflows/scrape.yml`

### 3.1 Triggers

```yaml
on:
  schedule:
    - cron: "30 21 * * *"     # 03:00 IST (21:30 UTC previous day)
  workflow_dispatch:
    inputs:
      role:
        type: choice
        options: [all, genai, data, uiux]
        default: all
```

### 3.2 Permissions and concurrency

```yaml
permissions:
  contents: write

concurrency:
  group: jobhunt-scrape
  cancel-in-progress: false
```

- `contents: write` is needed to force-push the `data` branch.
- Only one scrape workflow runs at a time; a second run queues rather than cancelling the first.

### 3.3 `prepare` job

1. Checks out the portal repository into `portal/`.
2. Runs:

```bash
python automation/matrix.py --role "${{ inputs.role || 'all' }}" >> "$GITHUB_OUTPUT"
```

`matrix.py` maps roles to vendor repos:

```python
REPOS = {
    "genai": "Dilip457/Job-Hunt-for-GenAI-Profile",
    "data":  "Dilip457/DataEngineer_JobHunt",
    "uiux":  "Dilip457/UI-UX-Job_Hunt",
}
```

`all` produces all three entries; a specific role produces one.

### 3.4 `scrape` job

- `needs: prepare`
- `timeout-minutes: 75`
- `strategy.fail-fast: false`
- `strategy.max-parallel: 1` → **roles run one at a time**

Steps:

1. Checkout the portal into `portal/`.
2. Checkout the vendor repo for `matrix.role` into `vendor/<role>/`.
3. Install Python 3.11 and the vendor `requirements.txt`.
4. Install `automation/requirements.txt` and Playwright Chromium.
5. Run:

```bash
python automation/run_source.py \
  --role "<role>" \
  --profile "profiles/<role>.json" \
  --repo-dir "$GITHUB_WORKSPACE/vendor/<role>" \
  --out "artifacts/<role>.json" \
  --no-playwright \
  --no-apis \
  --no-validate
```

6. Upload the artifact (always, even on failure):

```text
portal/artifacts/<role>.json
portal/artifacts/<role>.json.status.json
```

Artifact name: `jobs-<role>`; retention: 14 days.

**Important:** `--no-playwright` removes the *vendor* Playwright source from the profile. It does **not** disable Playwright inside `portal_scrapers.py`; Naukri still uses real Chrome.

**Important:** `--no-apis` disables `api_sources.py` (Adzuna, Jooble, JSearch, Remotive, Himalayas, ATS) in the cloud. The vendor repo's `linkedin` and `company_pages` sources still run because they are listed in the profile.

### 3.5 `warp` job

- `needs: prepare`
- `timeout-minutes: 12`
- `continue-on-error: true`
- `strategy.max-parallel: 1`

Steps:

1. Checkout the portal.
2. Install lightweight dependencies: `requests`, `beautifulsoup4`, `lxml`, `curl_cffi`.
3. Install and connect Cloudflare WARP:
   - add the Cloudflare apt repository
   - `warp-cli registration new`
   - `warp-cli mode warp`
   - `warp-cli connect`
4. Run:

```bash
WARP_SYSTEM=1 python automation/portal_scrapers.py \
  --role "<role>" \
  --profile "profiles/<role>.json" \
  --out "artifacts/<role>.warp.json" \
  --sites indeed simplyhired \
  --max-days 14
```

5. Disconnect WARP (always).
6. Upload `jobs-<role>-warp` (always, if present).

WARP is best-effort. If it fails to connect, the main scrape still publishes.

### 3.6 `publish` job

- `needs: [prepare, scrape, warp]`
- `if: always()`
- Checks out the portal with `fetch-depth: 0`
- Downloads all artifacts with `merge-multiple: true`
- Runs:

```bash
python automation/publish.py --artifacts artifacts --branch data --retention-days 21
```

The `if: always()` means publishing can happen even when a scrape or WARP job failed or was cancelled.

---

## 4. Scraper internals

### 4.1 Role profiles

Files: `profiles/genai.json`, `profiles/data.json`, `profiles/uiux.json`

| Field | Meaning |
|---|---|
| `role` | Role slug |
| `label` | Display label |
| `repo` | Vendor scraper repository |
| `db` | SQLite database filename in the vendor repo |
| `sources` | Vendor sources to run |
| `playwright` | Whether to add the vendor `playwright` source |
| `keywords` | Search queries |
| `cities` | Target cities |
| `min_score` | Minimum match score |
| `max_days` | Freshness window in days |

Current values:

| Role | Vendor sources | Playwright | Keywords |
|---|---|---|---|
| `genai` | `playwright`, `linkedin`, `company_pages` | yes | Generative AI Engineer, LLM Engineer, Machine Learning Engineer, AI Engineer |
| `data` | `playwright`, `linkedin`, `company_pages` | yes | Data Engineer, Big Data Engineer, PySpark Developer, Cloud Data Engineer |
| `uiux` | `linkedin`, `company_pages` | no | Product Designer, UX Designer, UI Designer, Interaction Designer |

All profiles use `min_score: 20` and `max_days: 14`.

### 4.2 `run_source.py`

The wrapper treats the vendor repos as **read-only**. It patches them in memory, runs their pipeline, and exports their SQLite database.

#### Configuration overrides

- Pan-India locations: India, Remote, Hyderabad, Bangalore, Pune, Mumbai, Chennai, Gurgaon, Noida, Delhi, Kolkata.
- No excluded locations.
- Experience filter disabled (0–30 years); the scoring engine never hard-rejects on experience.
- `MAX_DAYS_OLD` from the profile.
- `MAX_WORKERS = 8`.
- Dashboard generation disabled.
- Link validation disabled when `--no-validate` is passed.
- LinkedIn geo IDs patched for India/Hyderabad/Bangalore.
- Vendor Playwright search URLs built from the role keywords and cities.

#### Execution order

```text
1. Load profile (if provided)
2. Import vendor config, patch it
3. Import vendor scoring engine, patch it
4. Import vendor main pipeline
5. Run JobSearchPipeline(sources=...)
6. Export the vendor SQLite DB via export.py
7. Merge direct portal scraper results (unless --no-portal)
8. Merge optional API/ATS results (unless --no-apis)
9. Write artifacts/<role>.json and .status.json
```

#### CLI

```bash
python automation/run_source.py \
  --role uiux \
  --profile profiles/uiux.json \
  --repo-dir vendor/uiux \
  --out artifacts/uiux.json \
  [--no-playwright] \
  [--no-portal] \
  [--no-apis] \
  [--no-ats] \
  [--no-validate] \
  [--min-score 20] \
  [--max-days 14] \
  [--limit 800]
```

### 4.3 `portal_scrapers.py`

Direct, account-free scrapers. Each fetcher returns a list of normalized job dicts from `build_job()`.

| Portal | Transport | Request | Parsing |
|---|---|---|---|
| **Shine** | `requests` (HTTP) | `https://www.shine.com/job-search/<query>-jobs-in-<city>[-2]` | `article[itemprop="itemListElement"]`; title, company, location, posted text |
| **Foundit** | `requests` (JSON API) | `GET https://www.foundit.in/middleware/jobsearch` with `query`, `locations`, `start=0/15`, `limit=15`, `sort=1` | `jobSearchResponse.data`; builds `/job/<jobId>` URLs; timestamps from `createdAt` |
| **Naukri** | Playwright + real Chrome | `https://www.naukri.com/<query>-jobs-in-<city>` | `div.srp-jobtuple-wrapper`; `.title`, `.comp-name`, `.locWdth`, `.job-post-day` |
| **Indeed** | `curl_cffi` first, Playwright fallback | desktop, mobile and SEO variants of `in.indeed.com` | `div.job_seen_beacon`; `h3.jobTitle a`; job key from `data-jk` or `?jk=` |
| **SimplyHired** | `curl_cffi` through WARP | `https://www.simplyhired.co.in/search?q=...&l=...` | `div[data-testid="searchSerpJob"]` |

#### Browser setup

`_open_browser()` launches Playwright Chromium with:

- `channel="chrome"` when available (Naukri accepts real Chrome; the bundled headless shell is often rejected)
- a desktop user agent and locale
- automation-evasion and sandbox flags suitable for CI

`WARP_PROXY` is applied to `curl_cffi` HTTP requests, not to the Playwright browser. The WARP job relies on the system tunnel (`WARP_SYSTEM=1`) instead.

#### WARP handling

- `WARP_SYSTEM=1` means the machine's traffic is routed through the system WARP tunnel.
- `WARP_PROXY` can point to an explicit proxy instead.
- Indeed probes for an accepted WARP exit IP and reconnects a limited number of times.
- SimplyHired skips itself when neither WARP route is configured.

#### Collection and filtering

`collect_portal_jobs()`:

1. Runs the selected fetchers (`sites`).
2. Drops jobs below `min_score`.
3. De-duplicates by canonical URL.
4. De-duplicates by `(company, title, location)` when all three are non-empty.
5. Drops jobs older than `max_days` based on `posted_date`.
6. Returns the combined list.

`merge_portal_jobs()` merges portal results into the vendor payload by canonical URL, recomputes source counts, and sorts by score then posted date.

#### Posted-date caveat

Naukri, Shine and Foundit use the portal's posted date. **Indeed and SimplyHired currently use the scrape date as `posted_date`** because their relative timestamps are not parsed reliably. For those two sources, the card's “Posted” value is effectively the scrape date; `first_seen` remains the authoritative first-scrape date.

### 4.4 `api_sources.py` (optional)

This module is disabled in the cloud workflow with `--no-apis`. It can be enabled locally or by removing the flag.

| Source | Key | Notes |
|---|---|---|
| Company ATS boards | none | Greenhouse, Lever, Ashby, SmartRecruiters; tokens in `automation/companies.json` |
| Adzuna | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` | Free India API |
| Jooble | `JOOBLE_API_KEY` | Free India API |
| Google Jobs (JSearch) | `JSEARCH_API_KEY` | RapidAPI free tier |
| Remotive | none | Remote roles |
| Himalayas | none | Remote roles |

Missing keys are skipped silently. All results go through `build_job()` and are merged by canonical URL.

### 4.5 `export.py`

Exports the vendor SQLite database to public JSON:

- Reads the `jobs` table ordered by score and posted date.
- Normalizes locations to India/Remote; foreign listings are dropped.
- Keeps only a **240-character snippet**, not the full description.
- Extracts experience ranges when available.
- Produces `id`, `title`, `company`, `location`, `url`, `apply_url`, `source`, `posted_date`, `score`, `score_parts`, `experience_min`, `experience_max`, `snippet`, `is_new`, `first_seen`.
- Drops jobs below the score floor, with invalid URLs, with foreign locations, or older than the freshness window.
- Sorts by score then posted date.

### 4.6 Normalization, scoring and deduplication

**Location normalization**

- Recognizes Indian cities and remote/hybrid/WFH terms.
- Drops known foreign locations (for example “Remote - US”, “EMEA”, “APAC”).
- Unknown locations are kept and labelled “India” so they are not silently lost.

**Title relevance**

- `ROLE_TITLE_TOKENS` and `ROLE_TITLE_EXCLUDE` in `api_sources.py`.
- `title_relevant()` rejects obviously unrelated titles.
- `looks_foreign()` rejects foreign-language/region titles.

**Score**

- `score_job()` starts from a base and adds role-title, skill and snippet matches.
- Scores are capped below 100.
- UI tiers: Excellent ≥ 85, Strong ≥ 75, Good ≥ 65, Fair ≥ 50, Low < 50.
- The profile's `min_score` (20) is the hard floor.

**Deduplication**

- Canonical URL first (removes tracking parameters).
- Then `(company, title, location)` when all three exist.
- In the publisher, the same canonical URL rule is used; the highest score wins.

### 4.7 `first_seen` and `is_new`

- `build_job()` sets `first_seen` to the **current UTC date** at scrape time.
- `export.py` maps the vendor DB's `first_seen` value.
- `publish.merge_payloads()` keeps the **minimum** `first_seen` across previous and fresh data.
- Therefore, a job that was already known keeps its original first-seen date.

`is_new` is a source-provided flag (primarily from the vendor database). It is **not** recalculated from `first_seen`. The UI's `NEW` badge uses `is_new`; the “First seen” text uses `first_seen`. For reliable scrape history, use `first_seen`.

---

## 5. Publisher internals

File: `automation/publish.py`

### 5.1 Artifact naming

After `download-artifact` with `merge-multiple: true`, the publish workspace contains:

```text
artifacts/
├─ genai.json
├─ genai.json.status.json      # ignored by publish.py
├─ genai.warp.json
├─ data.json
├─ data.json.status.json
├─ data.warp.json
├─ uiux.json
├─ uiux.json.status.json
└─ uiux.warp.json
```

`publish.py` globs `<role>*.json`, so both the main and WARP files are included.

### 5.2 Merge algorithm

```text
for each role in (genai, data, uiux):
    candidate = first valid artifact for the role
    for each additional artifact:
        candidate = merge_payloads(candidate, artifact, retention)

    previous = read origin/data:<role>.json (if it exists)

    if candidate has jobs and previous exists:
        result = merge_payloads(previous, candidate, retention)
        status = "merged"
    else if candidate has jobs:
        result = candidate
        status = "fresh"
    else if previous exists:
        result = previous
        status = "kept-previous"
    else:
        status = "missing"
```

`merge_payloads(previous, fresh)`:

1. Index every job by canonical URL (fallback `title|company|location`).
2. If the same job appears twice, keep the version with the higher `score`.
3. Set `first_seen` to the earliest non-null value.
4. Drop jobs older than `retention_days` (default 21), using `posted_date` or `first_seen`.
5. Sort by score descending, then posted date ascending/empty.
6. Recompute `sources` counts.
7. Set `generated_at` to the newer of the two payload timestamps.

### 5.3 Manifest

`manifest.json` is written with an indented, human-readable structure:

```json
{
  "generated_at": "2026-10-20T08:44:52+00:00",
  "roles": {
    "genai": {
      "role": "genai",
      "count": 928,
      "generated_at": "2026-10-20T08:40:00+00:00",
      "sources": { "LinkedIn": 215, "Naukri": 173 },
      "demo": false,
      "status": "merged"
    }
  }
}
```

The `status` value is one of `merged`, `fresh`, `kept-previous`, `missing`.

### 5.4 Orphan `data` branch mechanics

1. Fetch `origin/data` (ignore failure on the first run).
2. Read previous `<role>.json` files with `git show origin/data:<file>`.
3. Create a temporary git worktree.
4. `git checkout --orphan portal-data-<pid>`.
5. Remove tracked files.
6. Write `<role>.json`, `manifest.json`, and `vercel.json`.
7. `git add -A` and commit once.
8. `git push --force origin HEAD:data`.
9. Remove the worktree and temporary branch.

The branch always has one commit.

### 5.5 Vercel skip

`publish.py` writes:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "git": { "deploymentEnabled": { "data": false } }
}
```

This prevents Vercel from building the JSON-only branch with Root Directory `web`.

### 5.6 CLI

```bash
python automation/publish.py \
  --artifacts artifacts \
  --branch data \
  --retention-days 21 \
  [--repo-dir .] \
  [--no-merge]
```

`--no-merge` skips merging with the previously published role file and publishes the fresh candidate instead. Do not use it in normal operation.

---

## 6. Web application

### 6.1 Stack

- Next.js 15 (App Router)
- React 19
- TypeScript
- No database or ORM
- Deployed on Vercel with **Root Directory = `web`**

### 6.2 Routes

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | Cinematic role selection |
| `/jobs/genai` | GET | GenAI dashboard (pre-rendered) |
| `/jobs/data` | GET | Data Engineering dashboard (pre-rendered) |
| `/jobs/uiux` | GET | UI/UX dashboard (pre-rendered) |
| `/jobs/<unknown>` | GET | Redirect to `/` |
| `/api/jobs?role=<role>` | GET | Return `RoleData` JSON |
| `/api/jobs?role=<role>&fresh=1` | GET | Same, bypassing caches |
| `/api/refresh` | POST | Dispatch the GitHub Actions workflow |
| `/api/status?role=<role>` | GET | Latest workflow run status |

### 6.3 Data loading

`web/lib/service.ts`:

```ts
getRoleData(role, fresh)
  → readJsonFromDataBranch(`${role}.json`, ...)
  → if valid, return it
  → otherwise return web/data/<role>.json (seed, demo: true)
```

`web/lib/github.ts` — `readJsonFromDataBranch()`:

1. If `GITHUB_TOKEN` exists, call the GitHub Contents API:

   ```text
   GET /repos/<owner>/<repo>/contents/<file>?ref=data
   ```

   Decode the base64 content.

2. If that fails or no token exists, fall back to:

   ```text
   https://raw.githubusercontent.com/<owner>/<repo>/data/<file>
   ```

3. If both fail, the caller uses the seed JSON.

This makes the app work even before the first scrape.

### 6.4 Caching

| Layer | Setting |
|---|---|
| `getRoleData` | `no-store` (fresh read on every API cache miss) |
| `getManifest` | `revalidate: 60`, tag `jobs` |
| `/api/jobs` response | `public, s-maxage=60, stale-while-revalidate=300` |
| `/api/jobs?fresh=1` | `no-store` (bypasses CDN cache) |
| `/api/status` | `no-store` |
| `/api/refresh` | `force-dynamic` |

### 6.5 Refresh/status state machine

`web/lib/types.ts`:

```ts
type RunState = "idle" | "queued" | "running" | "success" | "failed" | "cancelled";
```

`web/lib/github.ts` maps GitHub runs:

| GitHub status/conclusion | UI state |
|---|---|
| `queued`, `requested`, `waiting` | `queued` |
| `in_progress` | `running` |
| `success` | `success` |
| `cancelled` | `cancelled` |
| any other conclusion | `failed` |
| no run | `idle` |

`getRunStatus(role)`:

- Fetches the latest 12 runs.
- Matches runs whose `display_title` contains `all` or the role.
- Computes `canRefresh = !active && !onCooldown`.
- `cooldownMinutesLeft` is based on the latest run's `updated_at` (fallback `created_at`) and `REFRESH_COOLDOWN_MINUTES = 25`.

`POST /api/refresh`:

1. Reject disallowed origins (localhost, `*.vercel.app`, `NEXT_PUBLIC_SITE_URL`, `VERCEL_URL` are allowed).
2. Validate the role.
3. Require GitHub configuration.
4. Return `409` if a run is active.
5. Return `429` if the 25-minute cooldown is active.
6. Dispatch `workflow_dispatch` with `{ ref: "main", inputs: { role } }`.
7. Return `202`.

`JobDashboard.tsx` polls `/api/status` every 8 seconds while queued/running. On `success`, it reloads jobs with `fresh=1` and shows “Fresh jobs loaded.” On `cancelled`, it shows “The scrape was cancelled before it finished.”

The public UI does **not** render a refresh button, and there is no admin URL. On any dashboard, press **`Alt` + `Shift` + `R`** to open the confirmation dialog (`ConfirmRefresh.tsx`); only **Confirm refresh** dispatches the workflow. The shortcut is ignored while typing in an input, textarea, select or contenteditable element, and `Escape` cancels.

Each role is a real route: `/jobs/genai`, `/jobs/data`, `/jobs/uiux`. The homepage `/` stays a clean introduction, choosing a destination navigates to its route, and browser back/forward works naturally. Filter parameters such as `q`, `city`, `source`, `score`, `exp`, `days` and `sort` are written to the role URL for shareable filtered views.

### 6.6 UI

- `/` plays a rigged Three.js character close-up (`HI.` for four seconds), camera pullback, illuminated path, turn, walk and role selection.
- The greeting owns the screen: no role cards are rendered while `HI.` is visible. The three destination gates are hidden during the close-up and appear with the pullback.
- The first paint before the cinematic bundle is a clean `IntroBoot` (brand, loader, no headline and no role cards). The boot is also used while the GLB is loading, so a slow connection cannot turn the greeting into a selector.
- Every full page load runs the greeting sequence. Returning visitors use **Skip intro** to jump straight to role selection; there is no localStorage shortcut that bypasses the greeting.
- Desktop uses a shallow bottom role dock that keeps the character, path and all three gates visible. Phones use a bottom sheet with explicit card rows. The cinematic camera widens with viewport aspect and height; the departure shot pulls back until the selected gate’s width and height fit, so the gate and its surroundings stay visible on portrait phones, tablets and short landscape screens.
- Short portrait screens (720px high or less) hide the explanatory subline and compact the cards; screens 600px high or less also hide card descriptions. Short landscape screens use a compact three-column strip. The sheet scrolls when its content exceeds the viewport and respects safe-area insets.
- In `selecting`, pointer drag on the canvas rotates a dedicated model turntable around the GLB’s vertical axis. `Auto-rotate` is **off by default** and can be enabled from the dock; a drag pauses it for 2.8 seconds. The camera, floor and lights do not move, and rotation is outside `AnimationMixer`, so walk/run animation is unaffected.
- `prefers-reduced-motion: reduce`, WebGL failure, model failure or a 12-second load timeout render `StaticIntro`: the same wide scene poster, a four-second `HI.` beat first, then the identical destinations. It never shows the greeting and role cards together.
- Role routes are pre-rendered via `generateStaticParams`; unknown slugs redirect to `/`.
- Dashboard filters: search, city, source, experience bucket, minimum score, date range, sort.
- Job card: title, company, location, experience, posted date, first-seen date, snippet, source badge, score tier, Apply button.
- Job card date line: `Posted <relative> · First seen <relative>`.
- `dateAgo()` is date-only: “today”, “yesterday”, “N days ago”, then a formatted date.
- `NEW` badge uses `is_new`; “First seen” uses `first_seen`.
- Contact link in the “Built in the open” card: `mailto:heyjarvis.03@gmail.com`.
- No site footer; the contact link and credits stay inside the explainer card.
- The explainer card states that the 3D guide is a stylized prototype and credits Grab3D.

### 6.7 3D assets and limitations

| Item | Detail |
|---|---|
| Base | “Casual Man” by Grab3D, **CC0 1.0** |
| Source | `https://grab3d.com/models/characters/man/` |
| Local files | `web/public/models/student/` |
| Posters | `scene.webp` is the wide selector still used by the boot/static background; `portrait.webp` is a close-up reference render |
| Mesh | 85,487 triangles; quantized; embedded WebP textures: 2048px basecolour, 1024px normal and metallic-roughness; shipped GLB 3,684,764 B |
| Look | Bearded adult, warm-brown hair, blue bomber over a white crew-neck tee, navy jeans, white sneakers; no runtime glasses |
| Shading | Runtime geometry split into three indexed material groups: original textured atlas (head, hair, hands, shoes), a vertex-coloured clothing group (blue bomber `0x275285` and the feathered skin neck tint `0xd99479`) and navy jeans (flat `0x1b2b4a`). Both the white t-shirt panel (`0xffffff`) and the skin collar band (`0xd99479`) are masked per fragment in the body shader (all three materials) from the bind-pose position, so their edges stay crisp instead of following the chest's coarse triangles; the collar band hides the jagged neck-to-collar material seam that otherwise read as dark spikes. Textured material: `metalness: 0`, roughness `0.86`, normal scale `0.38`, environment intensity `0.42`; clothing materials are matte `MeshStandardMaterial` with dithering. Clothing/face can be tuned independently without re-authoring the atlas |
| Motion | Walk (1.0 s) + run clips; breathing idle averages four walk poses to remove the stride, then layers a 5.6 s chest/head cycle; 1.8 m stride-matched walk; 0.55 s turn before travel. The walk's upper-leg tracks are adducted only 4 degrees (feet ~25 cm apart instead of ~33 cm) - a larger angle tilted the legs inward and made the gait read as curvy; the idle is sampled from a copy adducted 6 degrees so the standing stance stays ~22 cm. Idle hands keep the first sampled pose (averaging splayed them) and each wrist is twisted 45 degrees so the palms face the thighs |
| Rotation | `student-turntable` group inside the character root; pointer drag in `selecting`; auto-rotate defaults **off** but can be enabled from the dock; turntable yaw is independent of skeleton animation and resets smoothly before walking |
| Framing | The selector camera adapts to viewport aspect and height. On a 900px desktop the full guide is about 60% of the viewport; portrait phones use a wider lens and a centred stage, and short landscape screens get an extra vertical-FOV boost. The departure shot fits the selected gate’s width and height before the walk, so the gate and surrounding floor/pillars stay in frame rather than being cropped by a close fixed camera |
| Render | `compileAsync` before the reveal, DPR 1.75–2 on desktop and 1.35–1.8 on mobile, up to 16x anisotropic filtering, mipmapped linear filtering, ACES exposure `0.98` desktop / `0.94` mobile, soft `PCFSoftShadowMap` on desktop plus a contact-shadow fallback |
| Not implemented | Facial blendshapes, eye rig, lip-sync, hair simulation, motion capture |

The guide is deliberately a stylized prototype, not a finished character. The source
atlas has scrambled garment UV islands: jacket, knit top, hair and skin shared one texture,
which produced brown “tears” and dark flecks when the atlas was used directly. The runtime
now replaces the jacket, trousers and knit top with clean materials: a blue bomber, navy
jeans, a white t-shirt V and a feathered skin tint at the collar. The tint and tee are
vertex-colour blends, so the low-poly neckline seam no longer reads as a hard collar band.
Because the cleaned atlas is only sampled by those remaining textured triangles, residual
garment-island artifacts in the atlas are not rendered. The basecolour is embedded at 2048px so the closer selector framing has
enough facial detail; the supporting normal and metallic-roughness maps stay at 1024px to
keep the GLB under 4 MB. Lighting was softened (key `1.32` desktop / `1.25` mobile, face fill
`0.6` / `0.5`, exposure `0.98` / `0.94`) so the fair skin is less bright and less contrasty.
The earlier runtime glasses were removed so the face reads cleanly. Attribution is
documented in `ATTRIBUTION.txt` and linked from the dashboard credits. The model path must
stay under `web/public/models/student/`.

### 6.8 Environment variables

Set these in **Vercel → Settings → Environment Variables**:

| Variable | Example | Required |
|---|---|---|
| `GITHUB_REPO` | `Dilip457/jobhunt-hub` | yes |
| `GITHUB_TOKEN` | Fine-grained PAT: Actions read/write + Contents read | yes |
| `GITHUB_WORKFLOW` | `scrape.yml` | no (default) |
| `GITHUB_DATA_BRANCH` | `data` | no (default) |
| `GITHUB_DISPATCH_REF` | `main` | no (default) |
| `NEXT_PUBLIC_SITE_URL` | `https://jobhunt-hub-web.vercel.app` | no |

The token is server-side only. Never prefix it with `NEXT_PUBLIC_`.

---

## 7. Data contract

### 7.1 Role file

`<role>.json`:

```json
{
  "role": "genai",
  "generated_at": "2026-10-20T08:44:52+00:00",
  "count": 1,
  "sources": { "Naukri": 1 },
  "jobs": [
    {
      "id": "abc123",
      "title": "Senior LLM Engineer",
      "company": "Example AI",
      "location": "Bangalore",
      "url": "https://www.naukri.com/job-listings-example",
      "apply_url": "https://www.naukri.com/job-listings-example",
      "source": "Naukri",
      "posted_date": "2026-10-18",
      "score": 82,
      "score_parts": {
        "role": 20,
        "skill": 18,
        "experience": 10,
        "tool": 8,
        "domain": 6
      },
      "experience_min": 2,
      "experience_max": 5,
      "snippet": "Build RAG pipelines and production LLM systems.",
      "is_new": false,
      "first_seen": "2026-10-20"
    }
  ],
  "demo": false
}
```

### 7.2 Job fields

| Field | Type | Meaning |
|---|---|---|
| `id` | string | Source ID or canonical URL |
| `title` | string | Job title |
| `company` | string | Company name |
| `location` | string | Normalized city or `India` / `Remote` |
| `url` | string | Job detail URL |
| `apply_url` | string | Apply URL (usually same as `url`) |
| `source` | string | `LinkedIn`, `Naukri`, `Foundit`, `Indeed`, `Shine`, `SimplyHired`, etc. |
| `posted_date` | string \| null | Portal posted date (`YYYY-MM-DD`); may be null |
| `score` | number | Match score |
| `score_parts` | object | Score breakdown (vendor jobs may populate it) |
| `experience_min` | number \| null | Minimum years |
| `experience_max` | number \| null | Maximum years |
| `snippet` | string | Short description excerpt (max ~240 chars) |
| `is_new` | boolean | Source-provided new flag |
| `first_seen` | string \| null | First scrape date (`YYYY-MM-DD`) |

### 7.3 Manifest

`manifest.json`:

```json
{
  "generated_at": "2026-10-20T08:44:52+00:00",
  "roles": {
    "genai": {
      "role": "genai",
      "count": 3,
      "generated_at": "2026-10-20T08:40:00+00:00",
      "sources": { "LinkedIn": 1, "Naukri": 1, "Shine": 1 },
      "demo": false,
      "status": "merged"
    },
    "data": { "...": "..." },
    "uiux": { "...": "..." }
  }
}
```

---

## 8. Local development

### 8.1 Web app

```bash
cd web
npm install
npm run dev
```

Open <http://localhost:3000>.

The seed JSON in `web/data/` is used until `GITHUB_REPO` and `GITHUB_TOKEN` are configured.

Production build check:

```bash
cd web
npm run build
```

### 8.2 Run one vendor scraper

```bash
# Clone a vendor repo next to the portal
git clone https://github.com/Dilip457/UI-UX-Job_Hunt.git vendor/uiux

python automation/run_source.py \
  --role uiux \
  --profile profiles/uiux.json \
  --repo-dir vendor/uiux \
  --out artifacts/uiux.json \
  --no-validate
```

Add `--no-apis` and `--no-playwright` to match the cloud workflow.

### 8.3 Run only the direct portal scrapers

```bash
pip install -r automation/requirements.txt
python -m playwright install chromium

python automation/portal_scrapers.py \
  --role uiux \
  --profile profiles/uiux.json \
  --out artifacts/uiux.portal.json
```

To restrict sources:

```bash
python automation/portal_scrapers.py \
  --role data \
  --profile profiles/data.json \
  --out artifacts/data.portal.json \
  --sites naukri foundit shine \
  --max-days 14
```

### 8.4 Publish locally

```bash
python automation/publish.py --artifacts artifacts --branch data --retention-days 21
```

This creates a temporary worktree, writes an orphan commit, and force-pushes `origin data`. Run it only when you intend to update the live data.

---

## 9. Deployment

### 9.1 GitHub

1. Push the repository to GitHub.
2. Go to **Settings → Actions → General** and allow workflows.
3. Ensure the repository has a `main` branch.
4. No Actions secrets are required for the core pipeline.

Optional API keys go in **Settings → Secrets and variables → Actions**.

### 9.2 Vercel

1. Import the repository.
2. Set **Root Directory** to `web`.
3. Framework preset: **Next.js**.
4. Build command: `npm run build`.
5. Add the environment variables from section 6.8.
6. Deploy.

The production branch is `main`. The `data` branch is skipped by its own `vercel.json`.

### 9.3 First run

1. GitHub → **Actions** → **Scrape jobs** → **Run workflow** → `all`.
2. Wait for `prepare`, `scrape`, `warp`, `publish`.
3. Confirm the `data` branch exists and contains:

   ```text
   genai.json
   data.json
   uiux.json
   manifest.json
   vercel.json
   ```

4. Reload the site. The demo banner should disappear once live data is available.

### 9.4 Verification URLs

```text
https://jobhunt-hub-web.vercel.app/                  (cinematic intro)
https://jobhunt-hub-web.vercel.app/jobs/genai        (GenAI dashboard)
https://jobhunt-hub-web.vercel.app/jobs/data         (Data Engineering dashboard)
https://jobhunt-hub-web.vercel.app/jobs/uiux         (UI/UX dashboard)
https://jobhunt-hub-web.vercel.app/api/jobs?role=genai
https://jobhunt-hub-web.vercel.app/api/jobs?role=genai&fresh=1
https://jobhunt-hub-web.vercel.app/api/status?role=genai
https://raw.githubusercontent.com/Dilip457/jobhunt-hub/data/manifest.json
```

---

## 10. Operations and troubleshooting

### 10.1 Manual dispatch

```bash
curl -X POST \
  -H "Authorization: Bearer <PAT>" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  https://api.github.com/repos/<owner>/<repo>/actions/workflows/scrape.yml/dispatches \
  -d '{"ref":"main","inputs":{"role":"all"}}'
```

On Windows PowerShell, write the JSON body to a file and use `--data-binary "@file.json"` to avoid quoting problems.

### 10.2 Common issues

| Symptom | Likely cause | Fix |
|---|---|---|
| UI shows demo/seed data | `GITHUB_REPO` or `GITHUB_TOKEN` missing; data branch missing | Check Vercel env vars and the `data` branch |
| `Scrape failed` in the panel | A run failed; check the run URL | Open the run log; look for the failed job |
| `Scrape cancelled` | Run was cancelled | Start a new run; data is merged, not wiped |
| `409 A scrape is already running` | Another run is queued/running | Wait or use the existing run |
| `429 Recently refreshed` | 25-minute cooldown | Wait for the cooldown |
| `403 Blocked origin` | Refresh called from an unapproved origin | Use the Vercel domain or localhost |
| Indeed has 0 jobs | Cloud IP blocked | Expected; WARP is best-effort |
| Naukri has 0 jobs | Bot wall / parser change | Check Naukri selector in `portal_scrapers.py` |
| Data branch build failed on Vercel | `vercel.json` missing on `data` | Run `publish.py`; it writes the skip config |
| New jobs look “old” | Portal posted date is old | Correct: `first_seen` shows when we scraped it |
| Old jobs look “new” | `first_seen` was reset or missing | Check the merge logic; earliest value should win |

### 10.3 Useful checks

```bash
# Latest workflow runs
curl -H "Authorization: Bearer <PAT>" \
  https://api.github.com/repos/<owner>/<repo>/actions/workflows/scrape.yml/runs?per_page=5

# Manifest
curl https://raw.githubusercontent.com/<owner>/<repo>/data/manifest.json

# Jobs API
curl "https://<site>/api/jobs?role=genai&fresh=1"
```

Front-end smoke checks used for this redesign (all must pass before deploying):

```text
/                         → clean boot, 4 s greeting with 0 cards, pullback, 3 gates, role dock, skip intro
/jobs/genai               → GenAI cards, filters, back/forward
/jobs/data                → Data Engineering cards, URL filters
/jobs/uiux                → UI/UX cards on a 390×844 viewport, no overflow
reduced-motion            → static intro: HI. with 0 cards, then 3 cards after 4 s; no WebGL canvas
blocked WebGL             → same static intro fallback; never HI. and cards together
/jobs/not-a-role          → redirect to /
Alt+Shift+R on dashboard  → confirmation dialog; Escape closes; ignored in inputs
```

Production verification (2026-10-21, `79e03f7`): 45/45 Playwright checks passed against the live Vercel deployment, including the cinematic intro, all three role dashboards, live API data, mobile 390×844, reduced motion, blocked WebGL, invalid-role redirect, skip intro, URL filters, browser back/forward, and no console/page errors. Greeting timing was re-checked at 1920×889 and 390×844: the boot renders no headline and no cards, `HI.` holds for at least four seconds with zero cards, and cards appear only in `phase-selecting`. The static reduced-motion fallback shows `HI.` with 0 cards, then 3 cards after 4 s. Live APIs returned GenAI **1,084**, Data Engineering **1,234** and UI/UX **1,280** (all `demo=false`); `/api/status` succeeded and an invalid role redirected to `/`. At the time of that check, production assets were present (`scene.webp` 87,822 B, `student.glb` 3,460,444 B, `portrait.webp` 39,640 B). The scheduled workflow run on 2026-10-21 (`06:15Z`) passed `prepare`, `scrape`, `warp` and `publish`.

Closer-framing and 2K verification (2026-10-22, `3959580`): `npm run build` passes. A local production build was checked at 1600×900 and 390×844: the selector reaches `phase-selecting` with three role cards, the auto-rotate toggle is present, the full guide is about 60% of the desktop viewport height, and the shoes stay above the bottom dock. The WebGL framebuffer was read back directly and contains the clean 3D scene at 2800×1575; no runtime page errors occurred apart from the existing favicon 404. The shipped `student.glb` is 3,922,652 B with a 2048px basecolour and 1024px normal/roughness maps.

The live deployment at <https://jobhunt-hub-web.vercel.app> was rechecked after the push: the page reached `phase-selecting` with three cards and auto-rotate on, and the browser loaded the new 3,922,652-byte GLB. `/api/jobs` still returned GenAI **1,084**, Data Engineering **1,234** and UI/UX **1,280** with `demo=false`; `/api/status` reported `configured=true` for all three roles, and `/jobs/genai`, `/jobs/data` and `/jobs/uiux` all returned 200.

Clean-clothing pass (2026-10-22, local production capture): `npm run build` passes. A local production build was checked at 1600×900 and 390×844. The jacket renders as clean navy fabric with no brown seam tears or white knit-top flecks, the sneakers are white again, and the softened key/face fill gives a fair, lower-contrast face. The `AUTO-ROTATE OFF` toggle reports `aria-pressed=false`; a still captured 4 seconds later shows no auto-rotation, and a pointer drag rotates the turntable to the side/back. A departure capture at 0.5 s, 1.2 s and 2.5 s shows the clean jacket from behind during the walk, with no visible collar detachment. The local `/`, `/jobs/genai`, `/jobs/data`, `/jobs/uiux` and `/api/status` routes all returned 200; local `/api/jobs?role=…` served the bundled fallback (`demo=true`, 14/14/396) rather than live counts. The shipped `student.glb` is 3,684,764 B with a 2048px basecolour and 1024px normal/roughness maps. The only console message was the existing favicon 404.

Live verification after the push (2026-10-22, `0baecf8`): the deployment served the new `student.glb` (`Content-Length: 3,684,764`). The selector toggle read `AUTO-ROTATE OFF` with `aria-pressed=false`; a still captured 3.5 seconds later showed no auto-rotation, and a pointer drag turned the guide to the side/back. Desktop 1600×900 and mobile 390×844 captures showed the clean navy bomber, white sneakers and the lower-contrast face with no layout regression. The static/reduced-motion poster now serves the regenerated clean `scene.webp` (57,588 B), with `portrait.webp` at 25,482 B. `/api/jobs` returned GenAI **1,084**, Data Engineering **1,234** and UI/UX **1,280**, all `demo=false`; `/api/status` reported `configured=true`; `/`, `/jobs/genai`, `/jobs/data` and `/jobs/uiux` all returned 200. The only console message was the existing favicon 404.

Outfit refresh (2026-10-22, local dev capture, pre-deployment commit): `npx tsc --noEmit` and `npm run build` pass. Local captures at 1280×800 and 2560×1440 show the blue bomber, blue jeans and a visible white V-neck t-shirt. The collar and t-shirt boundaries are per-vertex colour blends, so there is no pink material sawtooth and no torn-looking edge in close-up. The dock read `AUTO-ROTATE OFF` after a 3 s hold, and a pointer drag rotated the guide to the side and back. No page errors were reported. Local `/api/jobs` served the bundled fallback rather than live counts, so live counts are re-verified after deployment. The regenerated posters are `scene.webp` (74,924 B) and `portrait.webp` (38,112 B).

Live verification after the outfit push (2026-10-22, `cc60e7c`): the deployment served the new `scene.webp` (74,924 B) and `portrait.webp` (38,112 B). Captures at 1280×800 and 1600×900, taken seven seconds after skipping the intro, show the blue bomber, blue jeans, white V-neck t-shirt and soft collar. The dock read `AUTO-ROTATE OFF` and no page errors were reported. `/api/jobs` returned GenAI **1,084**, Data Engineering **1,234** and UI/UX **1,280**, all `demo=false`; `/api/status` reported `configured=true`; `/`, `/jobs/genai`, `/jobs/data` and `/jobs/uiux` returned 200. A capture taken three seconds after skipping was still mid lighting ramp at 1600×900; the settled seven-second capture is the reference.

Outfit colour pass (2026-10-22, local dev capture, pre-deployment): `npx tsc --noEmit` and `npm run build` pass. The guide now renders a blue bomber (`0x275285`), navy jeans (`0x1b2b4a`) and a pure-white V-neck t-shirt (`0xffffff` vertex tint), with the feathered collar skin at `0xd99479`. Captures at 1280×800, 1600×900 and 2560×1440 show the jeans clearly darker than the jacket and the t-shirt visibly white at both selector and close-up scale. The dock read `AUTO-ROTATE OFF` after a 3 s hold, and a pointer drag rotated the guide to the side and back. No page errors were reported. The regenerated posters are `scene.webp` (74,192 B) and `portrait.webp` (38,452 B). Live verification after the push (2026-10-22, `81b013e`): the deployment served both new posters, and 1280×800 and 1600×900 captures taken seven seconds after skipping show the white V-neck tee and the navy jeans clearly separated from the blue bomber. No page errors were reported. `/api/jobs` still returned GenAI **1,084**, Data Engineering **1,234** and UI/UX **1,280**, all `demo=false`; `/api/status` reported `configured=true`.

The refresh panel counts elapsed time from the current request rather than the previous run (`357b5ff`), and `/api/jobs` reads the `data` branch on every cache miss so a published scrape is not hidden by the origin cache (`5264079`).

Animated favicon pass (2026-10-29, local production build): `npx tsc --noEmit` and `npm run build` pass. The tab icon is now a transparent mark of the guide climbing a white staircase with blue tread lips and a red destination flag. The first SVG attempt had two defects: a CSS `transform` animation overrode the walker's `transform="translate(...)"` attribute and moved the figure off-canvas, and `currentColor` rendered the steps black. Both are fixed by using explicit palette colours and nested groups. Chromium does not animate SVG favicons, so `web/components/AnimatedFavicon.tsx` draws the same scene to a 64×64 canvas at roughly 12 fps and repoints every `rel="icon"` / `rel="shortcut icon"` link at the PNG data URL; it pauses on `visibilitychange` and leaves the static files untouched under `prefers-reduced-motion: reduce`. Static fallbacks are `favicon.svg`, `favicon.ico` (16/32/48), `favicon-16/32/48.png`, `apple-touch-icon.png` (180), `icon-192/512.png` and `manifest.json`; all preserve alpha and use the palette `#08090D`, `#287BFF`, `#FF304F`, `#FFFFFF` and `#E8B48F`. Icon, manifest and shortcut URLs are versioned with `?v=6` to break stale browser favicon caches. A Playwright check against the local production server found one dynamic icon link, confirmed its data URL changed after 600 ms, sampled four distinct frames, and verified that `prefers-reduced-motion: reduce` leaves only the static links; there were no console or page errors. The 32×32 and 16×16 renders were inspected on both light (`#F4F5F7`) and dark (`#202124`) backgrounds and remain legible. The icon links are declared explicitly in `web/app/layout.tsx` rather than through `metadata.icons`, because Next.js re-injected the metadata set during hydration and produced a duplicate second set. Live verification after the push (`7bfbbb3`, Vercel deployment completed): the live DOM held one dynamic icon link plus five static links with no duplicates, the animated href changed after 600 ms, and reduced motion left the static set. `/favicon.svg?v=6` (4,900 B) contained the staircase and no background rect, `/favicon-32.png?v=6` (896 B) retained alpha, and `/favicon.ico?v=6` (2,887 B) carried three frames. No console or page errors were reported.

Brand mark and favicon clarity pass (2026-10-29, local production build): the static gradient-square spark in the intro topbar, boot screen, static fallback and dashboard header is replaced by `web/components/BrandMark.tsx`, a CSS 3D cube with the white spark on its front and back faces. It rocks ±28° on Y every 7 s and floats 1.5px, and the reduced-motion path freezes it at `rotateX(-18deg) rotateY(-24deg)`; the boot screen does not load a second WebGL context. The mark measures 42×42px on desktop and 36×36px at ≤520px. The favicon was redrawn around two chunky steps instead of four thin steps and a flag, and the guide was enlarged from roughly 13.8 to 17.7 viewBox units, so the figure fills much more of the 16×16 tab icon. `favicon.svg`, the 16/32/48/180/192/512 PNGs and the three-frame `favicon.ico` were regenerated with alpha. Icon, shortcut, apple, mask and manifest URLs now use `?v=6`. `npx tsc --noEmit` and `npm run build` pass. Playwright checks against the local production server found no console or page errors, confirmed the dynamic favicon href still changes after 600 ms with `?v=6` links, and captured the 42px desktop / 36px phone brand mark at multiple rotation phases; the spark remained visible through the rock. The 16×16 and 32×32 favicon renders were inspected on light (`#F4F5F7`) and dark (`#202124`) backgrounds.

---

## 11. Current constraints and future work

1. **Indeed** — direct cloud scraping is blocked most of the time. Options: WARP (current), a residential proxy, or the optional local agent.
2. **Posted dates for Indeed/SimplyHired** — currently set to the scrape date; could be improved by parsing their date elements.
3. **First-seen backfill** — legacy jobs use the portal posted date as a proxy. Exact historical scrape dates could be backfilled from Actions artifacts while they are still retained.
4. **Sequential matrix** — `max-parallel: 1` can be raised if runtime becomes a problem, at the cost of more concurrent load.
5. **Parser maintenance** — portal HTML changes require selector updates.
6. **Retention** — 21 days is a balance between freshness and board size; it is configurable via `--retention-days`.
7. **3D guide** — the stylized CC0 character is rigged for body motion but has no facial blendshapes, eye rig or lip-sync. A production character would need facial animation, hair simulation and motion capture.

---

## 12. Related documents

- [Architecture](ARCHITECTURE.md) — system design, data flow, failure handling, decisions.
- [Code map](CODE_MAP.md) — every action, flow, component and data item mapped to its file and code path.
- [README](../README.md) — overview and quick start.
