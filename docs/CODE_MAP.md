# Code Map — JobHunt Hub

This is the repository lookup table: **every important action, flow, component and data item → the file and symbol that owns it**.

- Mapped against the application code at `f450469` (2026-10-21).
- Local paths are relative to the repository root.
- “Vendor” paths are in the three scraper repositories. Actions checks them out at runtime under `vendor/<role>`; they are **not committed here**.
- When a route, component, source, score rule, workflow or asset is added or removed, update this file in the same change.

---

## 1. The whole system in one trace

### A. Vendor-scored jobs (vendor LinkedIn / company-page pipeline)

```text
Vendor repo config.py
  └─ RESUME_PROFILE → skills, tools, domains, target roles, years
        ↓
Vendor repo scoring_engine.py
  └─ ScoringEngine.compute_score()
        ↓
Vendor repo main.py + SQLite DB
        ↓
automation/run_source.py
  └─ run() imports and patches vendor config/scoring/main
        ↓
automation/export.py
  └─ export() reads match_score + score_parts from SQLite
        ↓
artifacts/<role>.json
        ↓
automation/publish.py
  └─ merge_payloads() → force-push orphan data branch
        ↓
data branch: genai.json · data.json · uiux.json · manifest.json · vercel.json
        ↓
web/lib/github.ts → web/lib/service.ts → web/app/api/jobs/route.ts
        ↓
web/components/JobDashboard.tsx → JobCard.tsx → ScoreRing.tsx
```

### B. Direct portal and API/ATS jobs

```text
automation/portal_scrapers.py
  ├─ Shine · Foundit · Naukri · Indeed · SimplyHired
  └─ uses api_sources.build_job()
        ↓
automation/api_sources.py
  ├─ score_job()  (title + snippet keyword score)
  ├─ Adzuna · Jooble · JSearch · Remotive · Himalayas
  └─ ATS: Greenhouse · Lever · Ashby · SmartRecruiters
        ↓
merge into the same artifacts/<role>.json
```

### C. Refresh and deployment loop

```text
Hidden dashboard shortcut (Alt+Shift+R)
  → web/components/JobDashboard.tsx triggerRefresh()
  → POST /api/refresh
  → web/app/api/refresh/route.ts
  → web/lib/github.ts dispatchWorkflow()
  → .github/workflows/scrape.yml
  → artifacts + data branch
  → /api/status polling → fresh=1 reload
```

---

## 2. Entry points

| What starts here | File | Key symbol / command |
|---|---|---|
| Home page `/` | `web/app/page.tsx` | `HomePage` |
| One role dashboard `/jobs/[role]` | `web/app/jobs/[role]/page.tsx` | `RolePage`, `generateStaticParams`, `generateMetadata` |
| Jobs API | `web/app/api/jobs/route.ts` | `GET` |
| Run-status API | `web/app/api/status/route.ts` | `GET` |
| Refresh API | `web/app/api/refresh/route.ts` | `POST`, `originAllowed` |
| Daily / manual scrape | `.github/workflows/scrape.yml` | jobs `prepare`, `scrape`, `warp`, `publish` |
| Vendor pipeline + export | `automation/run_source.py` | `main()`, `run()` |
| Direct portal scrapers | `automation/portal_scrapers.py` | `main()`, `collect_portal_jobs()` |
| Cloud-safe APIs + ATS | `automation/api_sources.py` | `main()`, `collect_api_jobs()` |
| Publish to `data` branch | `automation/publish.py` | `main()`, `merge_payloads()` |
| Optional local PC agent | `automation/agent.py` | `main()` |
| Web development | `web/package.json` | `npm run dev`, `npm run build`, `npm run start` |
| Production deploy | Vercel dashboard | Root Directory `web`; there is no `vercel.json` |

---

## 3. Repository map

```text
jobhunt-hub/
├─ .github/workflows/
│  ├─ scrape.yml                 # daily scrape, WARP, publish
│  ├─ warp-sources.yml           # manual all-source WARP test
│  ├─ warp-probe.yml             # manual Indeed/WARP diagnostics
│  └─ indeed-probe.yml           # manual portal-access diagnostics
├─ automation/
│  ├─ run_source.py              # vendor wrapper: config patches, pipeline, export
│  ├─ export.py                  # vendor SQLite → public job JSON
│  ├─ portal_scrapers.py         # direct Naukri/Foundit/Indeed/Shine/SimplyHired
│  ├─ api_sources.py             # APIs, ATS boards, simple score, build_job
│  ├─ publish.py                 # merge artifacts + force-push data branch
│  ├─ matrix.py                  # role → vendor repo matrix
│  ├─ agent.py                   # optional local residential-IP agent
│  ├─ install-agent.ps1          # optional Windows Task Scheduler setup
│  ├─ run-agent.ps1              # Task Scheduler entry point
│  ├─ companies.json             # public ATS company tokens
│  ├─ requirements.txt           # portal scraper dependencies
│  ├─ indeed_probe.py            # Indeed access probe
│  ├─ indeed_probe2.py           # Indeed HTTP probe
│  ├─ warp_probe2.py             # WARP session/browser probe
│  └─ warp_proxy_test.py         # WARP proxy-mode probe
├─ profiles/
│  ├─ genai.json                 # role search config, NOT a resume
│  ├─ data.json
│  └─ uiux.json
├─ web/
│  ├─ app/
│  │  ├─ layout.tsx              # fonts, metadata, GLB preload
│  │  ├─ page.tsx                # /
│  │  ├─ globals.css             # all visual styling and responsive layout
│  │  ├─ jobs/[role]/page.tsx    # /jobs/genai|data|uiux
│  │  └─ api/{jobs,refresh,status}/route.ts
│  ├─ components/
│  │  ├─ IntroPage.tsx            # dynamic loader for the cinematic
│  │  ├─ IntroBoot.tsx            # clean first paint / loading screen
│  │  ├─ CinematicIntro.tsx       # Three.js scene, phases, camera, walk
│  │  ├─ StaticIntro.tsx          # reduced-motion / WebGL fallback
│  │  ├─ RoleDestinations.tsx     # three accessible role cards
│  │  ├─ JobDashboard.tsx         # dashboard state, filters, refresh polling
│  │  ├─ Filters.tsx              # search/city/source/score/experience/date/sort
│  │  ├─ JobCard.tsx              # one job card
│  │  ├─ ScoreRing.tsx            # score ring
│  │  ├─ StatsBar.tsx             # job/company/source/updated stats
│  │  ├─ RoleSwitcher.tsx         # in-dashboard role tabs
│  │  ├─ ConfirmRefresh.tsx       # hidden-refresh confirmation dialog
│  │  ├─ RefreshPanel.tsx         # queued/running/success/failed progress
│  │  └─ Icons.tsx                # inline SVG icon set
│  ├─ lib/
│  │  ├─ types.ts                 # Job, RoleData, StatusResponse, RoleMeta
│  │  ├─ roles.ts                 # role labels, accents, blurbs
│  │  ├─ service.ts               # data branch first, seed fallback
│  │  ├─ github.ts                # Contents API, Actions status, dispatch
│  │  ├─ prefetch.ts              # warm /api/jobs during the intro
│  │  ├─ fallback.ts              # seed JSON fallback
│  │  └─ utils.ts                 # score tiers, dates, filters, labels
│  ├─ data/                       # committed seed JSON
│  ├─ public/models/student/      # GLB, scene/portrait posters, attribution
│  ├─ next.config.mjs
│  ├─ package.json
│  └─ .env.example
├─ docs/
│  ├─ ARCHITECTURE.md             # system design and decisions
│  ├─ IMPLEMENTATION.md           # file-by-file implementation and operations
│  └─ CODE_MAP.md                 # this lookup table
├─ README.md
└─ .gitignore
```

---

## 4. Frontend — routes, components and data access

### 4.1 Routes and shell

| Path | File | Symbols | Responsibility |
|---|---|---|---|
| `/` | `web/app/page.tsx` | `HomePage` | Renders `IntroPage` |
| `/jobs/genai` | `web/app/jobs/[role]/page.tsx` | `generateStaticParams`, `RolePage` | Pre-renders the three valid roles |
| `/jobs/data` | `web/app/jobs/[role]/page.tsx` | `generateMetadata`, `RolePage` | Role label and metadata |
| `/jobs/uiux` | `web/app/jobs/[role]/page.tsx` | `RolePage` | Renders `JobDashboard` |
| Invalid role | `web/app/jobs/[role]/page.tsx` | `redirect("/")` | Unknown slug returns home |
| App shell | `web/app/layout.tsx` | `metadata`, `viewport`, `RootLayout` | Fonts, `noindex`, theme colour, GLB preload |

`web/app/globals.css` owns:

- design tokens and palette (`:root`)
- shared brand and top bar
- cinematic intro, canvas, poster, vignette
- boot / loading screen
- in-scene role dock and mobile sheet
- static / reduced-motion intro
- dashboard, stats, filters, job grid, score ring, states
- modal, refresh panel and toasts
- responsive rules and `prefers-reduced-motion: reduce`

### 4.2 Component ownership

| Component | Path | Key symbols | Owns |
|---|---|---|---|
| Dynamic intro loader | `web/components/IntroPage.tsx` | `CinematicIntro` dynamic import, `IntroBoot` loading | Keeps the first paint free of HI and role cards |
| Boot screen | `web/components/IntroBoot.tsx` | `IntroBoot` | Brand, loader, no headline, no role cards |
| Cinematic scene | `web/components/CinematicIntro.tsx` | `CinematicIntro`, `Phase`, `SceneController`, `createIdleClip`, `installCleanClothing`, `NECK_SEAM_BAND`, `TEE_V`, `travelProfile`, `travelDuration`, `applyPhase`, `updateCharacter`, `updateTurntable`, `updateCamera`, `onPointerDown`, `onPointerMove` | Greeting, pullback, path, turn, walk, gates, clean clothing material split, vertex-tinted neck seam and fragment-masked white tee panel, selection, turntable drag/optional auto-rotate, departure |
| Static fallback | `web/components/StaticIntro.tsx` | `StaticIntro`, `STATIC_GREETING_MS` | `HI.` for 4 s, then the three destinations; no canvas |
| Role cards | `web/components/RoleDestinations.tsx` | `RoleDestinations` | Accessible buttons for GenAI / Data / UI/UX |
| Dashboard controller | `web/components/JobDashboard.tsx` | `JobDashboard`, `PAGE_SIZE`, `triggerRefresh`, `switchRole`, `resetFilters`, `filtered`, `shownJobs` | Route data, filters, URL sync, pagination, role switch, refresh state |
| Filters UI | `web/components/Filters.tsx` | `Filters` | Search, city, experience, source, match floor, posted range, sort, score visibility, reset |
| Job card | `web/components/JobCard.tsx` | `JobCard`, `avatarHue` | Source badge, NEW badge, title, company, location, experience, snippet, dates, score, Apply |
| Score ring | `web/components/ScoreRing.tsx` | `ScoreRing` | Overall score as a ring, tier and accessible label |
| Stats | `web/components/StatsBar.tsx` | `StatsBar` | Open jobs, companies, sources, last updated |
| Role switcher | `web/components/RoleSwitcher.tsx` | `RoleSwitcher` | In-dashboard role tabs |
| Refresh confirmation | `web/components/ConfirmRefresh.tsx` | `ConfirmRefresh` | “Refresh … jobs?” dialog; Escape/backdrop cancel |
| Refresh progress | `web/components/RefreshPanel.tsx` | `RefreshPanel`, `STEPS`, `activeStep` | Queued/running/success/failed progress, elapsed time, run log link |
| Icons | `web/components/Icons.tsx` | `SearchIcon`, `ChevronDownIcon`, `RefreshIcon`, `MapPinIcon`, `BuildingIcon`, `CalendarIcon`, `ExternalIcon`, `CheckIcon`, `CloseIcon`, `SparkIcon`, `MailIcon`, `BriefcaseIcon`, `LayersIcon`, `GlobeIcon`, `AlertIcon`, `GithubIcon`, `CodeIcon`, `FilterIcon`, `EyeIcon`, `ArrowRightIcon`, `ArrowLeftIcon`, `PlayIcon`, `RouteIcon` | Inline SVG icon set |

### 4.3 Data access and shared logic

| File | Key symbols | Owns |
|---|---|---|
| `web/lib/types.ts` | `RoleSlug`, `ROLE_SLUGS`, `isRoleSlug`, `ScoreParts`, `Job`, `RoleData`, `Manifest`, `StatusResponse`, `RoleMeta` | The public data contract |
| `web/lib/roles.ts` | `ROLES`, `DEFAULT_ROLE`, `getRole` | Labels, descriptions, accents and blurbs |
| `web/lib/service.ts` | `getRoleData`, `getManifest` | Reads the `data` branch, falls back to seed JSON |
| `web/lib/github.ts` | `readJsonFromDataBranch`, `getRunStatus`, `dispatchWorkflow`, `REFRESH_COOLDOWN_MINUTES`, `isConfigured` | All server-side GitHub access |
| `web/lib/prefetch.ts` | `prefetchRole`, `takePrefetchedRole` | Starts `/api/jobs` during the intro and consumes it once |
| `web/lib/fallback.ts` | `fallbackRoleData`, `fallbackManifest` | Seed data with `demo: true` |
| `web/lib/utils.ts` | `scoreTier`, `dateAgo`, `timeAgo`, `formatNumber`, `formatDuration`, `uniqueCompanies`, `cityCounts`, `experienceLabel`, `matchesExperience`, `sourceColor`, `initials` | Display and filter helpers |

### 4.4 Static assets

| Asset | Path | Used by |
|---|---|---|
| 3D character | `web/public/models/student/student.glb` (3,684,764 B; 2048px basecolour, 1024px supporting maps) | `CinematicIntro.tsx` `MODEL_URL`; preloaded in `layout.tsx`; textured head/hands/shoes plus runtime clean-clothing groups |
| Wide scene poster | `web/public/models/student/scene.webp` | `.intro-poster` and `.static-intro-scene` in `globals.css` |
| Portrait reference | `web/public/models/student/portrait.webp` | Reference render only; not used as the loading background |
| Attribution | `web/public/models/student/ATTRIBUTION.txt` | Asset license, modifications and prototype limitations |

---

## 5. Cinematic intro flow

All timing and phase logic is in `web/components/CinematicIntro.tsx`.

| Phase | UI / scene | Duration or gate | Code |
|---|---|---|---|
| `loading` | Boot chrome + loader; no `HI.`, no cards | Ends when scene + GLB are ready | `IntroPage.tsx` loading fallback; `CinematicIntro` loader block |
| `greeting` | `HI.` close-up | `GREETING_MS = 4000` | `handleSceneReady()` → `setPhase("greeting")`; timer from `phase` |
| `reveal` | Camera pullback; gates fade in; tagline | `REVEAL_SECONDS = 2.8` | `updateCamera()` `reveal` branch; gate visibility |
| `approach` | Guide turns and walks to selector | `travelDuration(abs(SELECTOR_Z)) + 0.95` | `travelProfile()`, `updateCharacter()` |
| `selecting` | Three role cards, gates lit; drag-to-rotate / auto-rotate toggle | Stays until selection or skip | `RoleDestinations`; `updateTurntable()`, `.intro-rotate-toggle` |
| `departing` | Selected gate, walk toward it, “Destination locked” | `travelDuration(distance) + 0.24` | `handleSelect()` → `walkTo()` |
| `transition` | Arrival sweep; prefetched jobs | Completes `850 ms` after departure | `complete()` → `prefetchRole()` + `router.push()` |

Key guards:

- Cards are rendered only when `phase === "selecting"`. The greeting, reveal and approach never render cards.
- Gates are hidden while `phase === "greeting"`; the pullback reveals them.
- `GREETING_MS` starts after the phase has committed, not before the first painted frame.
- The 12-second model/WebGL timeout sets `failed`, which renders `StaticIntro`.
- `Skip intro` calls `skipToRoles()`; `Skip journey` calls `skipJourney()`.
- Every full load plays the greeting; there is no localStorage bypass.
- `prefers-reduced-motion` or a WebGL/model failure renders `StaticIntro` instead of the canvas.

Static fallback timing:

```text
StaticIntro mounts
  → HI. + destination cards hidden
  → 4000 ms
  → role cards rendered, HI. removed
```

Source: `web/components/StaticIntro.tsx` (`STATIC_GREETING_MS`).

---

## 6. Dashboard actions and flow

`web/components/JobDashboard.tsx` is the controller.

| Action | Trigger | Code path |
|---|---|---|
| Load a role | Route mount or role change | `fetch("/api/jobs?role=…")` or `takePrefetchedRole()` |
| Prefetch a role | Intro selection or dashboard role switch | `web/lib/prefetch.ts` `prefetchRole()` |
| Search | Filter input | `query` → `filtered` over title/company/location/source/snippet |
| Filter city | City select | exact `job.location` match |
| Filter source | Source select | exact `job.source` match |
| Filter match score | Match select | `job.score >= Number(score)` |
| Filter experience | Experience select | `matchesExperience()` in `web/lib/utils.ts` |
| Filter posted date | Posted select | `job.posted_date` age in days |
| Sort | Sort select | score / date / company |
| Load more | Button | `visible += PAGE_SIZE` (`PAGE_SIZE = 24`) |
| Share filters | Any filter change | `window.history.replaceState` with query params |
| Switch role | Role tabs | `prefetchRole(next)` + `router.push("/jobs/<role>")` |
| Retry load | Error state | `setReloadKey(k + 1)` |
| Open refresh | `Alt+Shift+R` | keydown listener → `setConfirmOpen(true)` |
| Confirm refresh | Dialog | `triggerRefresh()` → `POST /api/refresh` |
| Poll refresh | Queued/running status | `/api/status` every 8 seconds |
| Load fresh jobs | State changes to success | `freshRef.current = true` → `/api/jobs?role=…&fresh=1` |
| Show toast | Refresh/load outcomes | `pushToast()` |

URL parameters:

```text
q · city · source · score · exp · days · sort
```

Read and written in `JobDashboard.tsx`; select options in `Filters.tsx`.

---

## 7. API routes

| Route | File | Request | Success | Failure / notes |
|---|---|---|---|---|
| `GET /api/jobs` | `web/app/api/jobs/route.ts` | `role=genai`, `data` or `uiux`; optional `fresh=1` | `RoleData` JSON | `400` unknown role; `502` load error; `s-maxage=60` unless `fresh` |
| `GET /api/status` | `web/app/api/status/route.ts` | optional `role` | `StatusResponse` | Always `no-store`; returns idle message if GitHub is unreachable |
| `POST /api/refresh` | `web/app/api/refresh/route.ts` | `{ "role": "<role>" }` | `202 { ok, role, state: "queued" }` | `403` blocked origin; `400` bad body/role; `503` unconfigured; `409` already running; `429` cooldown; `502` dispatch failed |

Origin check: localhost, `*.vercel.app`, `NEXT_PUBLIC_SITE_URL` host, or `VERCEL_URL` host.

Underlying GitHub calls: `web/lib/github.ts`

- `readJsonFromDataBranch()` — Contents API when `GITHUB_TOKEN` exists, raw GitHub otherwise.
- `getRunStatus()` — latest matching `scrape.yml` run, state mapping and 25-minute cooldown.
- `dispatchWorkflow()` — `workflow_dispatch` with `{ role }`.

---

## 8. Match score and resume profiles — exact code paths

### 8.1 There is no resume upload in this repository

The public app does **not** have:

- an upload component (`input type="file"`)
- an upload API route
- PDF/DOCX parsing
- a candidate profile store or database
- login/accounts
- per-visitor scoring

The public export intentionally contains job data only, with no candidate/profile PII. See `automation/export.py` and `docs/ARCHITECTURE.md` §11.

### 8.2 Where the resume-derived profiles actually live

The profiles are **hardcoded structured dictionaries** in the three external scraper repositories:

| Role | External repository | Resume profile symbol | Scoring engine | Candidate years |
|---|---|---|---|---|
| GenAI | `Dilip457/Job-Hunt-for-GenAI-Profile` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 2.7 |
| Data | `Dilip457/DataEngineer_JobHunt` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 3.9 |
| UI/UX | `Dilip457/UI-UX-Job_Hunt` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 4.0 |

Linked files:

- GenAI: <https://github.com/Dilip457/Job-Hunt-for-GenAI-Profile/blob/main/config.py>
- GenAI scoring: <https://github.com/Dilip457/Job-Hunt-for-GenAI-Profile/blob/main/scoring_engine.py>
- Data: <https://github.com/Dilip457/DataEngineer_JobHunt/blob/main/config.py>
- Data scoring: <https://github.com/Dilip457/DataEngineer_JobHunt/blob/main/scoring_engine.py>
- UI/UX: <https://github.com/Dilip457/UI-UX-Job_Hunt/blob/main/config.py>
- UI/UX scoring: <https://github.com/Dilip457/UI-UX-Job_Hunt/blob/main/scoring_engine.py>

These are different preloaded profiles, one per role track. They are **not** the current visitor's resume.

### 8.3 How the profile enters the pipeline

| Step | File | Symbol / action |
|---|---|---|
| 1. Checkout vendor repo | `.github/workflows/scrape.yml` | step `Checkout scraper repo` → `vendor/${{ matrix.role }}` |
| 2. Choose role/repo | `automation/matrix.py` | `REPOS`, `main()` |
| 3. Load role search config | `profiles/<role>.json` | `repo`, `db`, `sources`, `keywords`, `cities`, `min_score`, `max_days` (search config, not the resume) |
| 4. Import vendor config | `automation/run_source.py` | `run()` → `importlib.import_module("config")` |
| 5. Patch search/scoring | `automation/run_source.py` | `_patch_config()`, `_patch_scoring()` |
| 6. Run vendor pipeline | `automation/run_source.py` | `main_module.JobSearchPipeline(sources=...)` |
| 7. Score each job | Vendor `scoring_engine.py` | `ScoringEngine.compute_score()`, `score_batch()` |
| 8. Store in vendor DB | Vendor `main.py` / `config.py` | SQLite `DB_PATH` |
| 9. Export public fields | `automation/export.py` | `export()` selects `match_score`, `role_match`, `skill_match`, `experience_match`, `tool_match`, `domain_match` |

`run_source._patch_scoring()` disables the vendor **hard experience rejection**:

```text
ScoringEngine._check_experience_strict = lambda ...: (True, "experience filter disabled")
```

The experience component can still lower a score; the job is just not rejected for years alone.

### 8.4 What is compared

Vendor scoring engines compare:

- **Role / title** — matches against role-title keyword tiers.
- **Skills** — candidate profile skill keywords found in the job description.
- **Tools / frameworks** — profile frameworks, cloud tools, design tools and related keywords.
- **Experience** — candidate's hardcoded years vs. years extracted from the JD/title.
- **Domain** — industry/domain keywords found in the JD.
- **Location** — preferred-location bonus, with strict location checks in GenAI/Data.
- **Source bypass** — some job-board sources are elevated to 65 when role/location match, even if the weighted score is below the floor.

Weights:

| Role | Role | Skill | Tool/framework | Experience | Domain |
|---|---:|---:|---:|---:|---:|
| GenAI | 35% | 35% | 15% | 10% | 5% |
| Data | 35% | 35% | 15% | 10% | 5% |
| UI/UX | 30% | 30% | 20% | 10% | 10% |

The final vendor score is the weighted sum, plus a location bonus (up to 3 points), capped at 100. A source-specific bypass may raise a qualifying job-board result to 65.

Profile fields consumed:

```text
years_of_experience
core_skills
programming_languages
ai_frameworks / data_frameworks / design_tools
llm_models / cloud_skills / storage_formats / ai_tools / frontend_skills
research_methods / standards
domains
industry_keywords
target_role_keywords
```

Not used by the scoring engines:

- `experience_highlights`
- individual project records
- any uploaded resume file

**Project exposure is therefore not directly compared.** Domain/industry keywords may reflect project background indirectly, but there is no project-by-project matching.

### 8.5 Direct portal and API/ATS scoring (a different score)

Not every job uses the vendor resume engine.

`automation/portal_scrapers.py` imports:

```python
from api_sources import ROLE_SEARCH_TERMS, build_job, title_relevant
```

`automation/api_sources.py` owns:

| Symbol | Purpose |
|---|---|
| `ROLE_TITLE_TOKENS` | Role title keywords |
| `ROLE_TITLE_EXCLUDE` | Obvious wrong-role titles |
| `ROLE_SKILLS` | Role skill keywords |
| `title_relevant()` | Rejects unrelated titles |
| `score_job()` | Base 30, +8 per title hit, +3 per skill hit, capped at 97 |
| `build_job()` | Builds the public job object and calls `score_job()` |

This is a **title + snippet keyword score**, not the hardcoded resume profile score.

Consequences:

- Vendor LinkedIn/company-page jobs can carry the resume-style score and `score_parts`.
- Direct portal and API/ATS jobs carry the simpler score; their `score_parts` are zeroed by `build_job()`.
- The merged board can therefore contain two scoring methods side by side.

### 8.6 How the score reaches the UI

| Layer | File | Symbol |
|---|---|---|
| Vendor DB | External SQLite | `match_score`, `role_match`, `skill_match`, `experience_match`, `tool_match`, `domain_match` |
| Export | `automation/export.py` | `score: round(match_score, 1)`, `score_parts` object |
| Publish | `automation/publish.py` | `merge_payloads()` preserves the highest score on duplicates |
| Type | `web/lib/types.ts` | `Job.score`, `ScoreParts` |
| API | `web/app/api/jobs/route.ts` | returns `RoleData` |
| Dashboard | `web/components/JobDashboard.tsx` | filter by `score`, sort by `score`, pass `showScore` |
| Card | `web/components/JobCard.tsx` | renders `ScoreRing` and tier label |
| Ring | `web/components/ScoreRing.tsx` | `Math.round(score)` and accessible match label |
| Tier labels | `web/lib/utils.ts` | `scoreTier()`: ≥85 Excellent, ≥75 Strong, ≥65 Good, ≥50 Fair, else Low |

The UI currently shows only the **overall** score. `score_parts` is available in the data contract but is not rendered as a breakdown.

### 8.7 Important limitation

If the intended feature is “upload my resume and get jobs matched to my skills, experience and projects”, that flow does **not** exist yet. Implementing it would require:

1. A resume upload route/component.
2. PDF/DOCX text extraction.
3. A structured candidate profile store.
4. Per-visitor skill/experience/project extraction.
5. A scoring endpoint that compares that profile with each JD.
6. Authentication/privacy handling for stored resumes.

The current implementation is a **preloaded, per-role prototype score**, not a user-personalised matching system.

---

## 9. Automation and publishing

### 9.1 `scrape.yml` jobs

| Job | Depends on | Purpose | Main files |
|---|---|---|---|
| `prepare` | — | Builds role matrix | `automation/matrix.py` |
| `scrape` | `prepare` | Checks out vendor repo, installs deps, runs vendor pipeline + export (`--no-playwright`; direct portal scrapers own Naukri/Indeed) | `automation/run_source.py`, `automation/export.py` |
| `warp` | `prepare` | Cloudflare WARP job for Indeed SEO + SimplyHired | `automation/portal_scrapers.py` |
| `publish` | `prepare`, `scrape`, `warp` | Downloads all artifacts, merges and force-pushes `data` branch | `automation/publish.py` |

Schedule: `30 21 * * *` UTC = 03:00 IST. Manual dispatch accepts `all | genai | data | uiux`.

### 9.2 Role configuration and vendor mapping

| Role | Local profile | Vendor repo | DB |
|---|---|---|---|
| `genai` | `profiles/genai.json` | `Dilip457/Job-Hunt-for-GenAI-Profile` | `genai_jobs.db` |
| `data` | `profiles/data.json` | `Dilip457/DataEngineer_JobHunt` | `de_jobs.db` |
| `uiux` | `profiles/uiux.json` | `Dilip457/UI-UX-Job_Hunt` | `jobs.db` |

`profiles/*.json` are **search configs**, not candidate resumes. They control keywords, cities, sources, minimum score and freshness.

### 9.3 Vendor wrapper (`automation/run_source.py`)

| Function | Responsibility |
|---|---|
| `_patch_config()` | Pan-India locations, score floor, day window, workers, keyword cap |
| `_patch_scoring()` | Disables hard experience rejection |
| `_patch_sources()` | LinkedIn geo IDs and portal search URLs |
| `_disable_dashboard()` | Stops vendor HTML dashboard generation |
| `_disable_validation()` | Replaces link validation with a fast pass for `--no-validate` |
| `run()` | Imports vendor config/scoring/main, runs pipeline, exports DB, merges portal + API jobs, writes artifact |
| `main()` | CLI argument parsing |

Vendor touchpoints used by the wrapper:

| Vendor file | Called from | Symbols touched |
|---|---|---|
| `config.py` | `_patch_config()`, `_patch_sources()` | `DB_PATH`, `PREFERRED_LOCATIONS`, `MIN_MATCH_SCORE`, `MAX_DAYS_OLD`, `MAX_WORKERS` |
| `scoring_engine.py` | `_patch_scoring()` | `ScoringEngine._check_experience_strict` |
| `main.py` | `run()` | `JobSearchPipeline`, `SCRAPER_REGISTRY`, `DashboardGenerator` |
| `scrapers/linkedin_scraper.py` | `_patch_sources()` | `LinkedInScraper.GEO_IDS` |
| `scrapers/playwright_scraper.py` | `_patch_sources()` | `PORTAL_SEARCHES`, `CHROME_PATHS` |
| `link_validator.py` | `_disable_validation()` | `LinkValidator.validate` |
| `genai_jobs.db` / `de_jobs.db` / `jobs.db` | `run()` | SQLite source for `automation/export.py` |

### 9.4 Direct portal sources (`automation/portal_scrapers.py`)

| Source | Function | Technique |
|---|---|---|
| Shine | `fetch_shine()` | HTTP + HTML |
| Foundit | `fetch_foundit()` | JSON search endpoint |
| Naukri | `fetch_naukri()` | Playwright + real Chrome |
| Indeed | `fetch_indeed()` → `_fetch_indeed_http()`, `_fetch_indeed_browser()` | HTTP first, browser fallback |
| SimplyHired | `fetch_simplyhired()` | HTTP |

Shared helpers: `_session()`, `_relative_date()`, `_absolute()`, `_open_browser()`, `_new_page()`, `_proxy_kwargs()`, `_warp_reconnect()`, `collect_portal_jobs()`, `merge_portal_jobs()`.

### 9.5 Cloud-safe APIs and ATS (`automation/api_sources.py`)

| Source | Function |
|---|---|
| Adzuna | `fetch_adzuna()` |
| Jooble | `fetch_jooble()` |
| Google Jobs / JSearch | `fetch_jsearch()` |
| Remotive | `fetch_remotive()` |
| Himalayas | `fetch_himalayas()` |
| Greenhouse | `_greenhouse()` |
| Lever | `_lever()` |
| Ashby | `_ashby()` |
| SmartRecruiters | `_smartrecruiters()` |
| ATS collector | `fetch_ats()` |
| Collection/merge | `collect_api_jobs()`, `merge_api_jobs()` |

Company tokens: `automation/companies.json`.

### 9.6 Export (`automation/export.py`)

| Symbol | Responsibility |
|---|---|
| `normalize_location()` | India city aliases, remote/hybrid, foreign filtering |
| `looks_foreign()` | Reject foreign-language/region titles |
| `extract_experience()` | Parse experience ranges from title/description |
| `canonical_url()` | Remove tracking params for deduplication |
| `make_snippet()` | 240-character public snippet |
| `clean_company()`, `clean_title()`, `valid_url()` | Public-field cleanup |
| `export()` | SQLite → jobs array with score, parts, experience, first-seen |
| `main()` | CLI export |

The export deliberately excludes full descriptions, resumes and PII.

### 9.7 Publish and merge (`automation/publish.py`)

| Symbol | Responsibility |
|---|---|
| `_job_key()` | Canonical URL, fallback title/company/location |
| `merge_payloads()` | Union previous + fresh, highest score wins, oldest `first_seen` preserved, retention filter |
| `previous_file()` | Read previous JSON from `origin/data` |
| `main()` | Merge all `<role>*.json` artifacts, write `manifest.json` + branch-level `vercel.json`, force-push `data` |

Data branch files:

```text
data/
├─ genai.json
├─ data.json
├─ uiux.json
├─ manifest.json
└─ vercel.json        # disables Vercel deployments for the JSON-only branch
```

### 9.8 Optional local agent

| File | Responsibility |
|---|---|
| `automation/agent.py` | Staleness check, lock/state, per-role run, optional publish |
| `automation/install-agent.ps1` | Clone vendor repos, create venvs, register Windows task |
| `automation/run-agent.ps1` | Task Scheduler entry point |

This is optional; GitHub Actions is the primary scheduler.

### 9.9 Diagnostic workflows

| Workflow | Scripts | Purpose |
|---|---|---|
| `.github/workflows/indeed-probe.yml` | `indeed_probe.py`, `indeed_probe2.py` | Diagnose Indeed access |
| `.github/workflows/warp-probe.yml` | `indeed_probe2.py`, `warp_probe2.py`, `warp_proxy_test.py` | Diagnose WARP and browser access |
| `.github/workflows/warp-sources.yml` | `portal_scrapers.py` | Manual all-source WARP test |

---

## 10. Public data contract

Canonical TypeScript contract: `web/lib/types.ts` (`Job`, `RoleData`, `Manifest`, `StatusResponse`).

| Field | Type | Produced by | Used by |
|---|---|---|---|
| `role` | `"genai"`, `"data"` or `"uiux"` | `automation/export.py`, `automation/publish.py` | `web/lib/types.ts`, dashboard |
| `generated_at` | ISO string | `export.py`, `publish.py` | `StatsBar` |
| `count` | number | `export.py`, `publish.py` | `StatsBar`, dashboard |
| `sources` | name → count | `export.py`, `portal_scrapers.py`, `api_sources.py`, `publish.py` | filters, stats |
| `jobs` | `Job[]` | all collectors | dashboard |
| `demo` | boolean | seed data / publish | demo notice |
| `Job.id` | string | export/build_job | card key |
| `Job.title` | string | export/build_job | search, card |
| `Job.company` | string | export/build_job | search, card |
| `Job.location` | string | export/build_job | filter, card |
| `Job.url` | string | export/build_job | dedupe, Apply fallback |
| `Job.apply_url` | string | export/build_job | Apply |
| `Job.source` | string | export/build_job | filter, badge |
| `Job.posted_date` | date/null | export/build_job | date filter, card |
| `Job.score` | number | vendor engine or `score_job()` | filter, sort, ring |
| `Job.score_parts` | object | vendor DB via export | data contract; not rendered |
| `Job.experience_min/max` | number/null | `extract_experience()` | experience label/filter |
| `Job.snippet` | string | `make_snippet()` | search, card |
| `Job.is_new` | boolean | vendor DB | NEW badge |
| `Job.first_seen` | date/null | export/publish merge | “First seen” |

Seed fallback: `web/data/genai.json`, `web/data/data.json`, `web/data/uiux.json`, `web/data/manifest.json` → `web/lib/fallback.ts`.

---

## 11. Configuration, deployment and docs

### 11.1 Environment variables (`web/.env.example`)

| Variable | Used by | Purpose |
|---|---|---|
| `GITHUB_REPO` | `web/lib/github.ts` | `owner/repo` containing the `data` branch |
| `GITHUB_TOKEN` | `web/lib/github.ts` | Actions read/write + Contents read |
| `GITHUB_WORKFLOW` | `web/lib/github.ts` | Workflow filename, default `scrape.yml` |
| `GITHUB_DATA_BRANCH` | `web/lib/github.ts` | Default `data` |
| `GITHUB_DISPATCH_REF` | `web/lib/github.ts` | Default `main` |
| `NEXT_PUBLIC_SITE_URL` | `web/app/api/refresh/route.ts` | Origin allow-list |

### 11.2 Deployment

- Vercel Root Directory: `web`.
- Build: `npm run build`; start: `npm run start`.
- There is no `vercel.json` in the application; configuration lives in the Vercel project.
- `publish.py` writes a branch-level `vercel.json` on the JSON-only `data` branch to disable deployments for that branch.
- Pushing `main` triggers a production deployment.
- GitHub Actions is the scraper; Vercel only serves UI and API routes.

### 11.3 Documentation ownership

| Document | Covers |
|---|---|
| `README.md` | Product overview, setup, deployment, experience |
| `docs/ARCHITECTURE.md` | System design, failure handling, privacy, decisions |
| `docs/IMPLEMENTATION.md` | File-by-file implementation, workflow internals, API contract, operations |
| `docs/CODE_MAP.md` | This action/flow/component → file lookup |

---

## 12. Where do I change…?

| Change | Edit here first | Then check |
|---|---|---|
| Intro greeting length | `web/components/CinematicIntro.tsx` (`GREETING_MS`) | static fallback `STATIC_GREETING_MS` |
| Pullback / walk timing | `CinematicIntro.tsx` (`REVEAL_SECONDS`, `WALK_SPEED`, `TURN_DELAY`, `SELECTOR_Z`) | `travelDuration()`, `travelProfile()` |
| Character rotation | `CinematicIntro.tsx` (`AUTO_ROTATE_SPEED`, `AUTO_ROTATE_DELAY`, `DRAG_SENSITIVITY`, `autoRotate`/`autoRotateRef`, `updateTurntable()`) | `.intro-canvas.is-interactive`, `.intro-rotate-toggle` (`aria-pressed` starts `false`), `onPointer*` handlers |
| Character clothing / face materials | `CinematicIntro.tsx` (`installCleanClothing()`, `NECK_SEAM_BAND`, `TEE_V`, `TEE_FACING`, jacket/pants/skin vertex colours, fragment-space tee mask, textured material roughness/normal scale) | `student.glb`, `ATTRIBUTION.txt`, lighting values in the same component |
| Role card content | `web/lib/roles.ts` | `RoleDestinations.tsx`, dashboard labels |
| Intro copy / phase UI | `CinematicIntro.tsx` render block | `web/app/globals.css` (`.intro-canvas`, `.intro-rotate-toggle`) |
| Boot screen | `web/components/IntroBoot.tsx` | `.intro-boot*` styles |
| Static / reduced-motion fallback | `web/components/StaticIntro.tsx` | `.static-*` styles |
| 3D model | `web/public/models/student/student.glb` | `MODEL_URL`, `installCleanClothing()`, `NECK_SEAM_BAND`, `TEE_V`, turntable setup, `layout.tsx` preload, `ATTRIBUTION.txt` |
| Palette / spacing | `web/app/globals.css` `:root` | component class names |
| Dashboard filters | `web/components/Filters.tsx` + `JobDashboard.tsx` `filtered` | `web/lib/utils.ts` |
| Job card fields | `web/components/JobCard.tsx` | `web/lib/types.ts`, `export.py` |
| Score tier colours/labels | `web/lib/utils.ts` `scoreTier()` | `ScoreRing.tsx`, `JobCard.tsx` |
| Resume profile / scoring keywords | External vendor `config.py` and `scoring_engine.py` | `automation/export.py`, `publish.py` |
| Simple portal/API score | `automation/api_sources.py` `score_job()` | `build_job()`, portal/API collectors |
| Search keywords/cities/score floor | `profiles/<role>.json` | `run_source.py`, workflow |
| Add a portal source | `automation/portal_scrapers.py` `fetch_*`, `SOURCES` | `collect_portal_jobs()` |
| Add an API/ATS source | `automation/api_sources.py` `fetch_*`, `SOURCES` | `collect_api_jobs()` |
| Add a role track | `profiles/<role>.json`, `automation/matrix.py` `REPOS` | `web/lib/types.ts`, `roles.ts`, `publish.py` `ROLES`, `agent.py` `ROLES`, workflow choices |
| Refresh cooldown | `web/lib/github.ts` `REFRESH_COOLDOWN_MINUTES` | refresh API + dialog copy |
| Retention window | `automation/publish.py` `DEFAULT_RETENTION_DAYS` | workflow `--retention-days` |
| Schedule | `.github/workflows/scrape.yml` cron | `docs/ARCHITECTURE.md` |
| Contact email | `JobDashboard.tsx`, `StaticIntro.tsx` | `README.md` |
| API caching | `web/app/api/jobs/route.ts` headers | `web/lib/service.ts` |
| Published JSON shape | `automation/export.py`, `automation/publish.py` | `web/lib/types.ts`, `web/data/*.json` |

---

## 13. Maintenance checklist

- New route or API → add it to §2 and §4/§7.
- New component → add it to §4.2.
- New scraper/source → add it to §9 and the workflow/profile.
- New score rule → document it in §8 and the vendor repo path.
- New asset → add it to §4.4.
- New env variable → add it to §11.1 and `web/.env.example`.
- Removed file → remove all references from this map.
- Keep `README.md`, `ARCHITECTURE.md` and `IMPLEMENTATION.md` consistent with this map.
