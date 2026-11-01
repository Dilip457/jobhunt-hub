# JobHunt India

A public, daily-updated job portal for five role tracks — **GenAI**, **Data Engineering**, **UI/UX**, **Business Analyst** and **Software Development Engineer (SDE)** — built from existing Python scrapers.

**Live:** <https://jobhunt-hub-web.vercel.app>

- **UI:** Next.js on Vercel
- **Scraper:** GitHub Actions only — **direct portal scrapers** (Naukri, Foundit, Indeed, Shine, SimplyHired) + LinkedIn, plus company career boards and keyless feeds (no PC required)
- **Business Analyst:** the UI/UX vendor pipeline with BA config, scoring and title filters, plus IIBA Career Center, Wellfound, Remote OK and We Work Remotely. Fresher and 1–3 year roles rank first.
- **Data:** compact JSON on an orphan `data` branch
- **Database:** none
- **Cost:** ₹0/month

---

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — components, data flow, branch model, caching, failure handling and design decisions.
- **[Implementation](docs/IMPLEMENTATION.md)** — workflow jobs, scraper internals, publisher merge logic, API routes, data contract, deployment and troubleshooting.
- **[Code map](docs/CODE_MAP.md)** — every action, flow, component and data item mapped to its file and code path.

---

## How it works

```
GitHub Actions (03:00 IST or manual — runs entirely in the cloud, no PC needed)
  ├─ checkout each scraper repo
  ├─ patch config for pan-India search
  ├─ run pipeline → SQLite            (LinkedIn + company career pages)
  ├─ scrape Naukri / Foundit / Indeed / Shine directly
  │    (plain HTTP for Shine & Foundit, real Chrome via Playwright for Naukri)
  ├─ scrape Indeed SEO + SimplyHired through an isolated WARP job
  ├─ company career boards            (Workday/Greenhouse/Lever/Ashby/SmartRecruiters)
  └─ export compact JSON (no PII, no full descriptions)
            │
            ▼
   orphan `data` branch (single commit, JSON is MERGED, never clobbered)
     manifest.json · genai.json · data.json · uiux.json · ba.json · sde.json
            │
            ▼
Vercel — Next.js
  ├─ /                    cinematic role selection (Three.js)
  ├─ /jobs/genai|data|uiux|ba|sde shareable dashboards + filters
  ├─ /api/jobs       reads the data branch (60s cache)
  ├─ /api/refresh    dispatches the workflow
  └─ /api/status     polls the GitHub Actions run
```

The scraper never runs on Vercel. Vercel only serves the UI and small API routes.
**No computer of your own is required** — everything runs on GitHub's servers.

---

## Repository layout

```
jobhunt-hub/
├─ .github/workflows/scrape.yml   # cron + manual dispatch + publish
├─ .github/workflows/ci.yml       # tests, lint, typecheck, build on every PR
├─ tests/                         # pytest: export, scoring, publish merge, roles
├─ automation/
│  ├─ run_source.py               # run a vendor scraper with portal overrides
│  ├─ portal_scrapers.py          # direct Naukri / Foundit / Indeed / Shine / SimplyHired scrapers
│  ├─ api_sources.py              # company career boards + keyless feeds
│  ├─ companies.json              # company career boards (edit freely, no key)
│  ├─ validate_companies.py       # check companies.json against the live feeds
│  ├─ export.py                   # SQLite → compact public JSON
│  ├─ publish.py                  # rebuild the orphan `data` branch (merges)
│  ├─ matrix.py                   # workflow matrix helper
│  ├─ roles.py                    # role list + vendor repos, read from profiles/
│  ├─ agent.py                    # OPTIONAL local PC agent (residential IP)
│  ├─ install-agent.ps1           # optional PC setup + scheduled task
│  └─ run-agent.ps1               # optional Task Scheduler entry point
├─ profiles/
│  ├─ genai.json
│  ├─ data.json
│  ├─ uiux.json
│  ├─ ba.json
│  └─ sde.json
└─ web/                           # Next.js 16 app (Vercel root)
   ├─ app/
   │  ├─ page.tsx                 # cinematic intro
   │  ├─ jobs/[role]/page.tsx     # /jobs/genai · /jobs/data · /jobs/uiux · /jobs/ba · /jobs/sde
   │  ├─ globals.css
   │  └─ api/{jobs,refresh,status}/route.ts
   ├─ components/                 # intro, dashboard, filters, cards
   ├─ lib/
   ├─ public/models/              # CC0 rigged guide, poster + attribution
   └─ data/                       # seed JSON used before the first live scrape
```

---

## Local development

```bash
cd web
npm install
npm run dev
# http://localhost:3000
```

The app ships with seed data (`web/data/*.json`), so it works instantly. Once `GITHUB_REPO` and `GITHUB_TOKEN` are set, it reads the live `data` branch instead.

### Run a scraper locally

```bash
# get a scraper repo next to the portal
git clone https://github.com/Dilip457/UI-UX-Job_Hunt.git vendor/uiux

# run it using the role profile (sources, db, limits all come from profiles/)
python automation/run_source.py \
  --role uiux \
  --profile profiles/uiux.json \
  --repo-dir vendor/uiux \
  --out web/data/uiux.json \
  --no-validate
```

The wrapper patches the vendor repo in memory (pan-India locations, no hard experience rejects, no dashboard generation). It does not edit the scraper repos.

The direct portal scrapers need Playwright for Naukri/Indeed:

```bash
pip install playwright
python -m playwright install chromium   # Skips if you already have Chrome (used via channel="chrome")
```

Run only the portal scrapers, without any vendor repo:

```bash
python automation/portal_scrapers.py --role uiux --profile profiles/uiux.json \
  --out artifacts/uiux.portal.json
```

---

## Experience on the cards

A card shows the experience the posting states, never a guess from the title. The card
and text are read first; jobs still unresolved get their posting page fetched once
(`automation/enrich_experience.py`): LinkedIn's public posting endpoint gives the full
description and its "Seniority level", Foundit's page gives min/max years, other boards are
parsed as text. A posting that states a level but no years shows the level ("Mid-Senior
level"); one that states nothing shows "Not stated in posting". Run the **Experience probe**
workflow (Actions → Experience probe → role) to see what the cards will say for live
postings on each board.

---

## Direct portal scrapers (primary)

The vendor repos' Naukri/Indeed/Foundit scrapers are out of date. `automation/portal_scrapers.py`
replaces them with four portal-specific scrapers that run inside the same GitHub Actions job —
**no API key, no account, no signup**:

| Portal | How it is read | Speed |
|---|---|---|
| **Naukri** | real Chrome (Playwright) renders the search page; job cards are parsed from the DOM | ~5s per query/city |
| **Indeed** | real Chrome renders `in.indeed.com`; cards are parsed from the DOM | ~7s per query/city |
| **Foundit** | its own public `/middleware/jobsearch` JSON endpoint | instant |
| **Shine** | server-rendered HTML search pages | instant |

Why a real Chrome? Naukri's bot wall returns `403 Access Denied` to Playwright's bundled
headless shell, but accepts the system Chrome. The workflow installs Playwright and launches
`channel="chrome"` (Google Chrome is preinstalled on GitHub's Ubuntu runners).

Each source is filtered to India/Remote, scored with the same role rules, de-duplicated by
URL **and** by `(company, title, location)`, then merged with LinkedIn and any other sources.
If a portal refuses the runner's IP on a given day, it reports 0 for that run and the rest
still publish.

Local end-to-end run (UI/UX, 14-day window): **633 jobs** — LinkedIn 215, Naukri 173,
Shine 112, Indeed 88, Foundit 45 — exported to 385 KB of JSON.

### Business Analyst sources

The BA track reuses the UI/UX vendor pipeline (no separate scraper repo). Before the run,
`run_source.py` replaces its design keywords, resume profile, role/tool scoring and
company-page title filter with BA versions, so the shared pipeline searches for business
analysts instead of designers.

The BA track keeps **Business Analyst** (including Business Systems Analyst) and **Data Analyst**
titles only. Product Analyst, Functional Analyst, Systems Analyst and other analyst families are
left out (`BA_TITLE` in `automation/api_sources.py`).

Two BA-only portal scrapers sit alongside the shared portals:

| Source | How it is read | Notes |
|---|---|---|
| **IIBA Career Center** | server-rendered search page (plain HTTP) | the BA-specific board; parses both its legacy `job-tile` and newer `job-card` layouts |
| **Wellfound** | embedded Apollo state in the role page | India roles + unrestricted remote only; US-only remote listings are dropped |

Two keyless feeds also run for BA:

| Source | What it adds | Key needed |
|---|---|---|
| **Remote OK** | public remote jobs API | none |
| **We Work Remotely** | public RSS feed | none |

BA is an **entry-level-first** track: `api_sources.py` and `export.py` boost fresher, entry,
graduate, junior and 1–3 year titles and push senior/lead/manager titles down. The dashboard
applies the same priority when sorting by score, so fresher and 1–3 year roles appear first.

### Company career boards and keyless extra sources

`automation/api_sources.py` reads company career sites through the job feeds of the hiring
systems behind them, plus a few remote job boards. The main scrape runs with `--no-apis`
because the direct scrapers are the primary source; the workflow's **Fetch company career
boards and keyless sources** step then runs this module: the company boards for **every
role**, the remote boards for `ba` and `sde` only. None of these sources needs a key, an
account or a card. The company boards take about 2–3 minutes per role.

| Source | What it adds |
|---|---|
| **Company career boards** | Openings straight from about 240 companies' own hiring systems: Workday (Accenture, Citi, NVIDIA, Cisco, Salesforce, Adobe, …), Greenhouse (Okta, Databricks, MongoDB, Stripe, …), Lever (Paytm, Meesho, CRED, …), Ashby (Sarvam AI, Supabase, OpenAI, …) and SmartRecruiters (Bosch, ServiceNow, Freshworks, …). Published as "Company Career Pages". |
| **Remotive** | Remote roles (BA, SDE) |
| **Himalayas** | Remote roles (BA, SDE) |
| **Remote OK** | Remote roles (BA, SDE) |
| **We Work Remotely** | Remote roles, RSS feed (BA, SDE) |

The board list lives in `automation/companies.json`. A board is a token from the careers
URL (`boards.greenhouse.io/<token>`, `jobs.lever.co/<token>`, `jobs.ashbyhq.com/<token>`,
`jobs.smartrecruiters.com/<token>`) or, for Workday, `{"name", "host", "site"}` from
`https://<host>/<site>`. Give Lever, Ashby and Workday boards a `"name"`: their feeds carry
none, and the name is what lets a company's own listing collapse with the same job on
Naukri or LinkedIn. Check the list against the live feeds, and drop boards with no India
postings, with:

```bash
python automation/validate_companies.py           # report
python automation/validate_companies.py --write   # prune companies.json
```

Results are filtered to India + India-eligible remote and de-duplicated against the scraper
output (same title, company and city collapse to one listing). A company feed returns every
opening, not just a keyword search's, so its jobs must also name the role in the title
(`ats_title_ok`): a software title for SDE, a data engineering title for Data, a UX or
product designer title for UI/UX. Run it locally:

```bash
python automation/api_sources.py --role data --profile profiles/data.json \
  --out /tmp/apis.json --sources ats
```

**Merging:** `publish.py` unions each run with the previously published file, so a lighter
run never removes jobs. Jobs older than 21 days are dropped.

---

## Optional: local agent (residential-IP fallback)

The cloud workflow already scrapes all four portals directly. The local agent is **not
required**; it is only a fallback if a portal starts refusing GitHub's IPs and you want to
run the same pipeline from your home connection.

```powershell
powershell -ExecutionPolicy Bypass -File .\automation\install-agent.ps1
```

It registers a Windows Scheduled Task (every 15 min, at logon, at startup, *start when
available*) that runs the full pipeline from your PC only when the data is stale (the
oldest role's `generated_at` is over 18 hours old) — so it catches up whenever the PC is
next on. A role published as `kept-previous` keeps its old `generated_at`, so while one
role's scrape keeps failing the agent re-runs all roles at most every 4 hours
(`--min-gap-hours`). See `automation/agent.py` (`--dry-run`, `--force`).

---

## The experience

`/` is a cinematic entry point, not a gate:

1. A clean boot screen loads the scene; no role cards are shown during this step.
2. A four-second close-up of the guide says **“HI.”** against red/blue rim light. Role cards are still hidden.
3. The camera pulls back to reveal an illuminated path and four gates.
4. The guide turns and walks to the selector; a bottom dock offers GenAI, Data Engineering, UI/UX and Business Analyst (a bottom sheet on phones).
5. In role selection, drag the guide left or right to inspect the front, side and back. **Auto-rotate** is off by default and can be turned on from the dock; dragging always works.
6. Choosing a destination animates the turn, walk and arrival before opening `/jobs/<role>`.

The dashboard is one click away in every degraded mode:

- **Skip intro** jumps straight to role selection.
- `prefers-reduced-motion: reduce` renders a static wide-scene intro: `HI.` first, then the same destinations after four seconds.
- WebGL failure, model failure or a slow load (12 s) falls back to the same static intro, again without showing the greeting and role cards together.
- Every full page load plays the greeting; use **Skip intro** if you want to go straight to the roles.
- Keyboard focus, mobile layout and browser back/forward work normally.

Each role lives at a clean, shareable URL — `/jobs/genai`, `/jobs/data`, `/jobs/uiux` and
`/jobs/ba`, `/jobs/sde` — and filter parameters are preserved in the URL.

Each role page, in the role's own colour:

- a ticker under the header with the jobs new since the last scrape, best match first;
- the title beside the gate the guide walked through, with the role's job, company and source counts;
- **Best match right now** as a solid tile, beside **How the top match scores**: a radar of
  that job's role fit, skills and experience fit, and every job of the role by match band;
- the filters, then 8 job cards per page (four across on wide screens, one on phones). A
  card tilts toward the pointer and lights in the role colour for a moment on hover.

### The 3D guide is a prototype

The guide is a **stylized, rigged CC0 “Casual Man” base by Grab3D**, optimized for the
web. It was simplified from 244,257 to 85,487 triangles. The basecolour atlas is 2048px
and the normal and metallic-roughness maps are 1024px, all WebP. The source atlas has
scrambled garment UV islands, so the runtime splits the body geometry into clean material
groups: a blue bomber, navy jeans, a white V-neck t-shirt and a feathered skin tint around
the neck. Head, hair, beard, hands and white sneakers keep the original textured material.
The neck seam and t-shirt neckline are blended per vertex, so the collar sits below the
neck with a soft transition instead of a hard triangle edge. The textured material uses a
matte finish (`metalness: 0`, roughness `0.86`, normal scale `0.38`, environment intensity
`0.42`). The face fill and key light were softened so the fair skin reads evenly rather
than glowing.

Runtime quality comes from the closer selector framing (the guide fills roughly 60% of a
900px viewport instead of about 300px), 16x anisotropic filtering, mipmapped linear
filtering, ACES tone mapping, a character-following face fill and a desktop cast shadow.
Auto-rotate starts **off**; manual drag is always available. The character has **no facial
blendshapes, eye rig or lip-sync**; the breathing idle averages four walk poses to remove
the stride, then adds a 5.6-second chest/head cycle.
This is a prototype, not a finished character. The dashboard credits the asset, and the
full modification record ships at
[`web/public/models/student/ATTRIBUTION.txt`](web/public/models/student/ATTRIBUTION.txt).

---

## Deploy to Vercel

1. **Create a public GitHub repo** and push this folder.

2. **Add the Vercel project**
   - Import the repo.
   - **Root Directory:** `web`
   - Framework preset: Next.js
   - Build command: `npm run build`

3. **Environment variables** (Vercel → Settings → Environment Variables)

   | Variable | Value |
   |---|---|
   | `GITHUB_REPO` | `your-user/jobhunt-hub` |
   | `GITHUB_TOKEN` | Fine-grained PAT: **Actions: read & write**, **Contents: read** |
   | `GITHUB_WORKFLOW` | `scrape.yml` |
   | `GITHUB_DATA_BRANCH` | `data` |
   | `GITHUB_DISPATCH_REF` | `main` |
   | `REFRESH_TOKEN` | Required for refresh: the password the refresh dialog asks for. Pick any password or PIN you can remember (8+ characters, or at least 6 digits). Without it a production deployment refuses every refresh |
   | `NEXT_PUBLIC_SITE_URL` | `https://your-project.vercel.app` |

4. **Deploy.** The free `*.vercel.app` domain is enough. Add a custom domain later if you want.

5. **Run the workflow once**
   - GitHub → Actions → **Scrape jobs** → Run workflow → `all`.
   - The `publish` job creates the `data` branch.
   - Reload the site; the demo banner disappears.

---

## The `data` branch

`publish.py` creates a temporary git worktree, checks out an orphan branch, writes the JSON files, commits once, force-pushes to `origin data`, and removes the worktree.

Why: the branch always has **one commit**, so the repository never grows by ~1 MB/day and the main branch never triggers a deploy.

If a role's scrape fails or returns zero jobs, the publisher **keeps the previous JSON** for that role instead of blanking the site and raises a warning on the Actions run. Otherwise it **merges** the new jobs with the previous ones:

- Deduplicated by canonical URL, then by title + company + city, so one opening posted on several boards appears once (the best-scored copy is kept).
- The fresh copy of a job wins, so scoring changes reach old listings; `first_seen` and `posted_date` keep the oldest date and `last_seen` the newest.
- Jobs that no scrape has returned for 7 days (`--unseen-days`) are treated as closed and dropped, and nothing older than 21 days is kept (an undated listing the boards still return stays until they stop returning it). Pruning is skipped when a run is much smaller than the previous data, so a blocked run cannot empty a role.
- `is_new` (the card's New tag and the updates ticker) is recomputed at publish time: first collected within the last 2 days.
- `apply_url` is dropped when it equals `url`; `score_parts` (role fit, skills, experience fit) stays, since the dashboard draws it for the top match.

The push uses `--force-with-lease`, so if the PC agent and a cloud run publish at the same time, the second one re-reads the data and merges again instead of overwriting.

---

## Refresh flow

The refresh control is **not rendered anywhere on the site**, so a visitor cannot click it or discover a separate admin link.

To run a manual scrape, open the main site and press **`Alt` + `Shift` + `R`**. This opens the confirmation dialog:

1. Open any dashboard, e.g. `https://jobhunt-hub-web.vercel.app/jobs/data`.
2. Press **`Alt` + `Shift` + `R`**.
3. Enter the refresh password and confirm.
4. `POST /api/refresh` checks the origin and the password (the `x-refresh-token` header), an active run, and a 25-minute cooldown after the last successful run, then calls the GitHub `workflow_dispatch` API and returns the dispatch time (`dispatchedAt`).
5. The UI polls `/api/status?since=<dispatchedAt>` every 8 seconds. Runs created before the dispatch count as still queued, so the previous run is never reported as the new one.
6. When the run succeeds, the page re-fetches `/api/jobs?fresh=…` with the password (which skips the caches) and shows the new `generated_at`.

Protections:

- No visible refresh button and no separate admin URL.
- Hidden keyboard shortcut (`Alt+Shift+R`) plus a confirmation dialog.
- GitHub Actions `concurrency: jobhunt-scrape-<role>` serialises runs for the same role; different roles run side by side and their publishes merge.
- 25-minute cooldown per role (`lib/github.ts`).
- Same-origin (CSRF) check on the POST route: only this deployment's own hosts are accepted, and requests without an `Origin` header are refused. `localhost` origins are accepted in development only.
- **Refresh password:** `REFRESH_TOKEN` is a password or PIN you choose; it is never in the codebase. Set it in Vercel → Settings → Environment Variables (Production) and **redeploy**: Vercel reads environment variables at deploy time, so a new value only takes effect after a redeploy (browsers holding the old one are then refused and asked again). Use 8+ characters, or at least 6 digits for a PIN. Without it, a production deployment refuses every refresh with "Refresh is disabled: REFRESH_TOKEN is not configured." Only `next dev` allows refresh without a password.
- **Wrong-password lockout** (`web/lib/refreshAuth.ts`): every wrong password is answered after a ~750 ms delay. 5 wrong passwords from one IP within 15 minutes lock that IP for 15 minutes, and more than 30 from all IPs together lock refresh for everyone for 15 minutes (a backstop against rotating IPs; the owner waits it out too). While locked, even the right password gets `429` with `code: "too_many_attempts"` and the minutes left. The right password clears that IP's count. Wrong passwords sent to `/api/jobs?fresh` count as well. The counters live in the server instance's memory, so they are best effort (a cold start resets them, and on Vercel the two routes may run as separate functions with their own counts), but they turn unlimited guessing into a handful of tries per quarter hour. The IP comes from `x-vercel-forwarded-for` / `x-real-ip` / `x-forwarded-for`, which Vercel overwrites with the real client address.
- **Saving the password:** the dialog is a real sign-in form (a hidden username `jobhunt-refresh` plus the password field), so Chrome, Edge and Safari offer to save it and sync it to your other devices; on a new laptop signed in to the same browser account it can be filled in for you. "Remember on this device" (on by default) also keeps it in this browser's `localStorage`; untick it on a shared computer. A wrong password shows "Wrong password" in the dialog and clears the remembered copy.
- A per-role lock stops two near-simultaneous confirmations from both dispatching.
- Seeded data remains visible if GitHub is unreachable.
- Refresh triggers the **cloud** pass (scrapers + official APIs). Everything runs on
  GitHub's servers; no PC is involved.

### Shareable role URLs

Each destination has a real route: `/jobs/genai`, `/jobs/data`, `/jobs/uiux` and
`/jobs/ba`, `/jobs/sde`. The homepage stays at `/`; choosing a role navigates to its route, so links and
browser history work normally. Filter parameters such as `?q=python&city=Bangalore` are
written to the role URL for shareable filtered views. Unknown role slugs redirect to `/`.

Hiding the control is a UX guard, not an authentication boundary. `REFRESH_TOKEN` is the
real access control (production refuses refresh without it) and the wrong-password lockout
stops it being guessed; the cooldown and one-run-per-role concurrency limit only bound
repeated use.

---

## Add or change a role

1. Add `profiles/<slug>.json` with `role`, `repo`, `db`, `sources`, `min_score`, and optionally
   `playwright`, `keywords`, `cities` and `repo_ref` (a commit SHA or tag that pins the vendor
   repo). The Python side (`automation/roles.py`: matrix, publish, agent) reads roles from here.
2. Add the slug to `ROLE_SLUGS` in `web/lib/types.ts` and `ROLES` in `web/lib/roles.ts`
   (include a `shortLabel` for the mobile dock).
3. Add seed JSON at `web/data/<slug>.json` and import it in `web/lib/fallback.ts`.
4. Add it to the workflow's `workflow_dispatch` choices.
5. For a role that shares another vendor repo, add its config/scoring patch in
   `automation/run_source.py` (the BA track is the reference implementation).

`tests/test_roles_consistency.py` fails if any of these lists disagree.

---

## Public-site guardrails

- **No PII:** the export strips resume/profile data. Only job metadata is published.
- **No full descriptions:** a 240-character snippet is kept; Apply links go to the original posting.
- **India + Remote only:** foreign listings are dropped during export.
- **`noindex` at launch:** set in `web/app/layout.tsx`. Remove it only after reviewing the legal model.
- **Respectful scraping:** rate limits, retries, no login walls, public pages only.
- **Job board terms:** LinkedIn/Naukri/Indeed restrict automated access. For a commercial or high-traffic public product, switch to official, licensed job feeds rather than scraping.

---

## Source reliability

Scrapers and keyless feeds fail in different ways, so the pipeline uses both:

| Source | Cloud (GitHub Actions) | Notes |
|---|---|---|
| LinkedIn | ✅ works | guest API |
| **Naukri** | ✅ direct scrape | real Chrome; bundled headless shell gets `403` |
| **Foundit** | ✅ direct scrape | public `/middleware/jobsearch` JSON |
| **Shine** | ✅ direct scrape | static HTML search pages |
| **Indeed** | ⚠️ IP-blocked | Cloudflare `403 Security Check - Indeed.com` from Azure runner IPs, on every path |
| **SimplyHired** (Indeed inventory) | ✅ via WARP (optional) | Indeed's sister site; same Indian listings |
| Company career boards | ✅ works (every role) | Workday / Greenhouse / Lever / Ashby / SmartRecruiters, no key |
| **IIBA Career Center** | ✅ works (BA only) | plain HTTP; the BA-specific board |
| **Wellfound** | ✅ works (BA only) | India + unrestricted remote only |
| **Remote OK / We Work Remotely** | ✅ works (BA only) | keyless remote feeds |

Cloud runs use `--no-apis`, so only the direct scrapers + LinkedIn publish by default.

### Why Indeed needs special handling

Indeed protects itself with **IP reputation**, not just a JavaScript challenge. From
GitHub's Azure runners, every URL returns:

```
403  Security Check - Indeed.com
```

This was verified with:

- plain HTTP (`requests`)
- `curl_cffi` with Chrome's TLS/JA3 fingerprint
- headless Chrome **and** headed Chrome under Xvfb
- the desktop, mobile (`/m/jobs`) and SEO (`/q-...-jobs.html`) surfaces
- Cloudflare WARP (sometimes `401 Authenticating...`)
- Jina Reader (also challenged)

The block follows the IP, so no scraper change can fix it. The project therefore
offers two honest paths:

1. **SimplyHired (owned by Indeed)** carries the same Indian listings. A
   separate, failure-tolerant `warp` job in `.github/workflows/scrape.yml`
   connects Cloudflare WARP, scrapes Indeed's SEO pages + SimplyHired, and
   uploads `<role>.warp.json`. `publish.py` merges that artifact with the
   normal scrape, so the site shows both `Indeed` and `SimplyHired` badges when
   WARP finds a clean IP. The job never blocks publication: if WARP is
   unavailable it contributes nothing and the three working portals still
   publish. The browser fallback is disabled inside this job because Chrome
   receives the same 401/403 and a hung `page.goto` would stall the runner.
2. **Local Indeed agent** (`automation/agent.py`) runs on a residential IP and
   pushes true Indeed rows to the same `data` branch. It is optional: the cloud
   site never depends on your PC being on.

> **Why the portal sometimes showed months-old jobs:** the vendor repos commit their
> `jobs.db` to git, so a fresh CI checkout contained old Indeed/Shine rows that were
> re-published as if current. `export.py` now drops anything older than `--max-days`
> (21 by default), so only fresh listings are published.

The design degrades gracefully:

- Each role runs in its own cloud job; one failure does not stop the others.
- Every source is independent: a portal that blocks the runner contributes 0 and the rest still publish.
- A pipeline or export error no longer aborts the run — portal/API jobs are still written.
- `publish` runs with `if: always()` and **merges**, so data is never removed.
- Missing API keys are skipped silently; the direct scrapers need no keys at all.

The vendor Playwright source is still disabled in the cloud (`--no-playwright`); the new
`automation/portal_scrapers.py` handles Naukri, Indeed and SimplyHired itself.

---

## Useful commands

```bash
# exporter only (existing SQLite DB)
python automation/export.py --db path/to/jobs.db --role uiux --out web/data/uiux.json

# local production build
cd web && npm run build && npm run start

# check the published data branch
git fetch origin data
git show origin/data:manifest.json

# local agent (PC, residential IP)
python automation/agent.py --dry-run --force

# checks (CI runs the same on every pull request)
pip install -r automation/requirements.txt pytest && python -m pytest -q tests
cd web && npm run lint && npm run typecheck && npm test && npm run build
```

---

## Contact

Feature request, bug, or issue? Email **heyjarvis.03@gmail.com**.

---

## License / use

Personal job-discovery project. Job listings and trademarks belong to their respective portals. Always link back to the original posting.
