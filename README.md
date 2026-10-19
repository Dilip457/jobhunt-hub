# JobHunt India

A public, daily-updated job portal for three role tracks — **GenAI**, **Data Engineering** and **UI/UX** — built from three existing Python scrapers.

- **UI:** Next.js on Vercel
- **Scraper:** GitHub Actions (cron + manual refresh)
- **Data:** compact JSON on an orphan `data` branch
- **Database:** none
- **Cost:** ₹0/month

---

## How it works

```
GitHub Actions (07:00 IST or manual)
  ├─ checkout each scraper repo
  ├─ patch config for pan-India search
  ├─ run pipeline → SQLite
  └─ export compact JSON (no PII, no full descriptions)
            │
            ▼
   orphan `data` branch (single commit)
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
│  └─ publish.py                  # rebuild the orphan `data` branch
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

# run it + write the portal JSON
python automation/run_source.py \
  --role uiux \
  --repo-dir vendor/uiux \
  --out web/data/uiux.json \
  --sources linkedin naukri indeed foundit shine timesjobs wellfound company_pages \
  --no-validate
```

The wrapper patches the vendor repo in memory (pan-India locations, no hard experience rejects, no dashboard generation). It does not edit the scraper repos.

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

If a role's scrape fails or returns zero jobs, the publisher **keeps the previous JSON** for that role instead of blanking the site.

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

---

## Add or change a role

1. Add `profiles/<slug>.json` with `repo`, `db`, `sources`, `min_score`.
2. Add the slug to `ROLES` in `web/lib/roles.ts`.
3. Add it to the workflow's `workflow_dispatch` choices and `prepare` job.
4. Add seed JSON at `web/data/<slug>.json` (optional).
5. Add it to `ROLES` in `automation/publish.py`.

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

Datacenter IPs are often blocked by job boards. The workflow is designed to degrade gracefully:

- Each role runs in its own job; one failure does not stop the others.
- `publish` runs with `if: always()`.
- Previous JSON is preserved for failed roles.
- If cloud IPs are blocked, register a **self-hosted GitHub runner** on your PC. The same workflow will use your residential IP with no code changes.

To enable Playwright sources, set `"playwright": true` in a profile and add `playwright` to its `sources`. The wrapper points it at the runner's bundled Chromium.

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
```

---

## License / use

Personal job-discovery project. Job listings and trademarks belong to their respective portals. Always link back to the original posting.
