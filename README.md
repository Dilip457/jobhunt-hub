# JobHunt India

A public, daily-updated job portal for three role tracks — **GenAI**, **Data Engineering** and **UI/UX** — built from three existing Python scrapers.

- **UI:** Next.js on Vercel
- **Scraper:** GitHub Actions (cloud-safe sources) + a local PC agent (residential-IP sources)
- **Data:** compact JSON on an orphan `data` branch
- **Database:** none
- **Cost:** ₹0/month

---

## How it works

```
Cloud: GitHub Actions (07:00 IST or manual — LinkedIn, company pages, Indeed/Shine)
  ├─ checkout each scraper repo
  ├─ patch config for pan-India search
  ├─ run pipeline → SQLite
  └─ export compact JSON (no PII, no full descriptions)
            │
PC: local agent (every 15 min, at logon, at startup — Naukri, Indeed, Foundit, …)
  ├─ runs only when the published data is stale (catch-up) or on demand
  ├─ full source list incl. a real browser (residential IP)
  └─ export compact JSON
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

---

## Repository layout

```
jobhunt-hub/
├─ .github/workflows/scrape.yml   # cron + manual dispatch + publish
├─ automation/
│  ├─ run_source.py               # run a vendor scraper with portal overrides
│  ├─ export.py                   # SQLite → compact public JSON
│  ├─ publish.py                  # rebuild the orphan `data` branch (merges)
│  ├─ matrix.py                   # workflow matrix helper
│  ├─ agent.py                    # local PC agent (residential-IP scraping)
│  ├─ install-agent.ps1           # one-time PC setup + scheduled task
│  └─ run-agent.ps1               # Task Scheduler entry point
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

---

## Local agent (residential-IP sources)

Naukri, Indeed and Foundit block datacenter IPs, so they return nothing from GitHub's
runners. The **local agent** runs the exact same pipeline from your own PC, where those
portals work — including the vendor browser scraper (`playwright`) for GenAI/Data.

**It never needs your PC on at a fixed time.** It runs on a Windows Scheduled Task every
15 minutes, at logon and at startup, with *"start when available"*, and it scrapes only
when the published data is stale. So whenever the PC is next on, it catches up within
minutes.

One-time setup (Windows, run once):

```powershell
powershell -ExecutionPolicy Bypass -File .\automation\install-agent.ps1
```

That will:

1. clone the three scraper repos into `vendor\<role>`;
2. create one Python virtualenv per role under `vendor\venvs\<role>`;
3. register the scheduled task **JobHunt India Agent**.

Useful flags:

```powershell
# just install environments, don't touch the scheduled task
.\automation\install-agent.ps1 -SkipTask

# also download a Chromium build for the browser scraper (needs Google Chrome otherwise)
.\automation\install-agent.ps1 -InstallBrowsers
```

Manual control:

```bash
python automation/agent.py --dry-run          # show what it would do
python automation/agent.py --force            # scrape all roles now
python automation/agent.py --roles uiux       # just one role
```

Logs live in `vendor\agent.log`.

**Merging:** `publish.py` unions each run with the previously published file, so the
always-on cloud run (LinkedIn-heavy) and the fuller local run never overwrite each other.
Jobs older than 21 days are dropped.

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

1. User clicks **Refresh**.
2. `POST /api/refresh` checks for an active run and a 25-minute cooldown, then calls the GitHub `workflow_dispatch` API.
3. The UI polls `/api/status` every 8 seconds.
4. When the run succeeds, the page re-fetches `/api/jobs?fresh=1` and shows the new `generated_at`.

Protections:

- GitHub Actions `concurrency: jobhunt-scrape` serialises runs.
- 25-minute cooldown per role (`lib/github.ts`).
- Same-origin check on the POST route.
- Seeded data remains visible if GitHub is unreachable.
- Refresh triggers the **cloud** pass (LinkedIn, company pages, Indeed/Shine). The blocked
  Indian portals are refreshed by the local agent whenever your PC is next online.

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

## Scraper reliability

Job boards treat datacenter and residential IPs very differently:

| Source | Cloud runner | Local agent |
|---|---|---|
| LinkedIn | ✅ works | ✅ works |
| Company career pages | ✅ works | ✅ works |
| Indeed / Shine (UI/UX) | ✅ sometimes | ✅ works |
| Naukri | ❌ `406` bot wall | ✅ with browser |
| Indeed (GenAI/Data), Foundit | ❌ `403` / dead API | ✅ with browser |

The design degrades gracefully:

- Each role runs in its own cloud job; one failure does not stop the others.
- `publish` runs with `if: always()` and **merges**, so richer local data is never lost.
- Previous JSON is preserved for failed roles.
- The local agent covers the blocked Indian portals and catches up whenever the PC is on.

Playwright is enabled per profile (`"playwright": true`) and is used only by the local
agent. The cloud workflow runs with `--no-playwright` to stay fast and within its time
limit. If Google Chrome is installed the agent uses it; otherwise run
`install-agent.ps1 -InstallBrowsers`.

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

## License / use

Personal job-discovery project. Job listings and trademarks belong to their respective portals. Always link back to the original posting.
