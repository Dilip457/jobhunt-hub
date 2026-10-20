# JobHunt India

A public, daily-updated job portal for three role tracks — **GenAI**, **Data Engineering** and **UI/UX** — built from three existing Python scrapers.

- **UI:** Next.js on Vercel
- **Scraper:** GitHub Actions only — **direct portal scrapers** (Naukri, Foundit, Indeed, Shine, SimplyHired) + LinkedIn, plus optional keyless boards (no PC required)
- **Data:** compact JSON on an orphan `data` branch
- **Database:** none
- **Cost:** ₹0/month

---

## Documentation

- **[Architecture](docs/ARCHITECTURE.md)** — components, data flow, branch model, caching, failure handling and design decisions.
- **[Implementation](docs/IMPLEMENTATION.md)** — workflow jobs, scraper internals, publisher merge logic, API routes, data contract, deployment and troubleshooting.

---

## How it works

```
GitHub Actions (07:00 IST or manual — runs entirely in the cloud, no PC needed)
  ├─ checkout each scraper repo
  ├─ patch config for pan-India search
  ├─ run pipeline → SQLite            (LinkedIn + company career pages)
  ├─ scrape Naukri / Foundit / Indeed / Shine directly
  │    (plain HTTP for Shine & Foundit, real Chrome via Playwright for Naukri)
  ├─ scrape Indeed SEO + SimplyHired through an isolated WARP job
  ├─ optional: keyless ATS boards     (Greenhouse/Lever/Ashby/SmartRecruiters)
  └─ export compact JSON (no PII, no full descriptions)
            │
            ▼
   orphan `data` branch (single commit, JSON is MERGED, never clobbered)
     manifest.json · genai.json · data.json · uiux.json
            │
            ▼
Vercel — Next.js
  ├─ role dropdown + filters
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
├─ automation/
│  ├─ run_source.py               # run a vendor scraper with portal overrides
│  ├─ portal_scrapers.py          # direct Naukri / Foundit / Indeed / Shine / SimplyHired scrapers
│  ├─ api_sources.py              # optional: ATS boards + job APIs
│  ├─ companies.json              # company ATS tokens (edit freely, no key)
│  ├─ export.py                   # SQLite → compact public JSON
│  ├─ publish.py                  # rebuild the orphan `data` branch (merges)
│  ├─ matrix.py                   # workflow matrix helper
│  ├─ agent.py                    # OPTIONAL local PC agent (residential IP)
│  ├─ install-agent.ps1           # optional PC setup + scheduled task
│  └─ run-agent.ps1               # optional Task Scheduler entry point
├─ profiles/
│  ├─ genai.json
│  ├─ data.json
│  └─ uiux.json
└─ web/                           # Next.js 15 app (Vercel root)
   ├─ app/
   │  ├─ page.tsx
   │  ├─ globals.css
   │  └─ api/{jobs,refresh,status}/route.ts
   ├─ components/
   ├─ lib/
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

### Optional: keyless ATS boards and job APIs

`automation/api_sources.py` still contains keyless company ATS boards and optional official
APIs. They are **off in the cloud workflow** (`--no-apis`) because the direct scrapers are the
primary source; remove the flag to re-enable them.

| Source | What it adds | Key needed |
|---|---|---|
| **Company ATS boards** | Real openings pulled straight from companies' own hiring systems (Greenhouse, Lever, Ashby, SmartRecruiters) | **none** — public JSON |
| **Adzuna** | Aggregated India listings across many boards | `ADZUNA_APP_ID`, `ADZUNA_APP_KEY` (free) |
| **Jooble** | Aggregated India listings | `JOOBLE_API_KEY` (free) |
| **Google Jobs** (JSearch) | Google-for-Jobs index | `JSEARCH_API_KEY` (free tier) |
| **Remotive** | Remote roles | none |
| **Himalayas** | Remote roles | none |

The ATS board list lives in `automation/companies.json` — add any company token you
like; invalid ones are skipped automatically. No signup, no card, no key.

**Missing keys are simply skipped**, so the site keeps working with whatever you configure.
Results are filtered to India + Remote and de-duplicated against the scraper output.

### Add the keys (GitHub → Settings → Secrets and variables → Actions)

| Secret | Where to get it |
|---|---|
| `ADZUNA_APP_ID` / `ADZUNA_APP_KEY` | free signup at <https://developer.adzuna.com/signup> |
| `JOOBLE_API_KEY` | free key at <https://jooble.org/api/about> |
| `JSEARCH_API_KEY` | free RapidAPI key at <https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch> |

Test any of them locally:

```bash
ADZUNA_APP_ID=... ADZUNA_APP_KEY=... \
  python automation/api_sources.py --role data --profile profiles/data.json \
    --out /tmp/apis.json
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
available*) that runs the full pipeline from your PC only when the data is stale — so it
catches up whenever the PC is next on. See `automation/agent.py` (`--dry-run`, `--force`).

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

If a role's scrape fails or returns zero jobs, the publisher **keeps the previous JSON** for that role instead of blanking the site. Otherwise it **merges** the new jobs with the previous ones (deduplicated by URL, highest score wins), so a lighter cloud run can never remove jobs found by the local agent.

---

## Refresh flow

The refresh control is **hidden from public visitors** so an accidental click cannot spend a workflow run. It is available only in admin mode:

1. Open `/?admin=1` once. This reveals a small **Refresh** button for the current browser session (stored in `sessionStorage`).
2. Click **Refresh**, then confirm in the dialog.
3. `POST /api/refresh` checks for an active run and a 25-minute cooldown, then calls the GitHub `workflow_dispatch` API.
4. The UI polls `/api/status` every 8 seconds.
5. When the run succeeds, the page re-fetches `/api/jobs?fresh=1` and shows the new `generated_at`.

Protections:

- Refresh button hidden from the public UI; admin-only via `?admin=1`.
- Confirmation dialog before a run is dispatched.
- GitHub Actions `concurrency: jobhunt-scrape` serialises runs.
- 25-minute cooldown per role (`lib/github.ts`).
- Same-origin check on the POST route.
- Seeded data remains visible if GitHub is unreachable.
- Refresh triggers the **cloud** pass (scrapers + official APIs). Everything runs on
  GitHub's servers; no PC is involved.

Hiding the button is a UX guard, not an authentication boundary: the API route is still
reachable. The cooldown and one-run concurrency limit keep accidental or repeated use
bounded. A secret token can be added to the route if hard access control is needed.

---

## Add or change a role

1. Add `profiles/<slug>.json` with `repo`, `db`, `sources`, `min_score`, and optionally
   `playwright`, `keywords`, `cities`.
2. Add the slug to `ROLES` in `web/lib/roles.ts`.
3. Add it to `REPOS` in `automation/matrix.py` and the workflow's `workflow_dispatch` choices.
4. Add seed JSON at `web/data/<slug>.json` (optional).
5. Add it to `ROLES` in `automation/publish.py` and `automation/agent.py`.

---

## Public-site guardrails

- **No PII:** the export strips resume/profile data. Only job metadata is published.
- **No full descriptions:** a 240-character snippet is kept; Apply links go to the original posting.
- **India + Remote only:** foreign listings are dropped during export.
- **`noindex` at launch:** set in `web/app/layout.tsx`. Remove it only after reviewing the legal model.
- **Respectful scraping:** rate limits, retries, no login walls, public pages only.
- **Job board terms:** LinkedIn/Naukri/Indeed restrict automated access. For a commercial or high-traffic public product, switch to official feeds (Adzuna, Jooble, Indeed Publisher) rather than scraping.

---

## Source reliability

Scrapers and optional APIs fail in different ways, so the pipeline can use both:

| Source | Cloud (GitHub Actions) | Notes |
|---|---|---|
| LinkedIn | ✅ works | guest API |
| **Naukri** | ✅ direct scrape | real Chrome; bundled headless shell gets `403` |
| **Foundit** | ✅ direct scrape | public `/middleware/jobsearch` JSON |
| **Shine** | ✅ direct scrape | static HTML search pages |
| **Indeed** | ⚠️ IP-blocked | Cloudflare `403 Security Check - Indeed.com` from Azure runner IPs, on every path |
| **SimplyHired** (Indeed inventory) | ✅ via WARP (optional) | Indeed's sister site; same Indian listings |
| Company ATS boards | ✅ works (optional) | Greenhouse / Lever / Ashby / SmartRecruiters, no key |
| Adzuna / Jooble / Google Jobs | ✅ works (optional, with keys) | official APIs, no PC |

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
```

---

## Contact

Feature request, bug, or issue? Email **heyjarvis.03@gmail.com**.

---

## License / use

Personal job-discovery project. Job listings and trademarks belong to their respective portals. Always link back to the original posting.
