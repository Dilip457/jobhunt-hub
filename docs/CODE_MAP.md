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
data branch: genai.json · data.json · uiux.json · ba.json · sde.json · manifest.json · vercel.json
        ↓
web/lib/github.ts → web/lib/service.ts → web/app/api/jobs/route.ts
        ↓
web/components/JobDashboard.tsx → UpdatesTicker.tsx, HeroGate.tsx, StatsBar.tsx, BestMatch.tsx, MatchSignal.tsx, JobCard.tsx
```

### B. Direct portal and API/ATS jobs

```text
automation/portal_scrapers.py
  ├─ Shine · Foundit · Naukri · Indeed · SimplyHired
  └─ uses api_sources.build_job()
        ↓
automation/api_sources.py
  ├─ score_job()  (title + snippet keyword score)
  ├─ Remotive · Himalayas · Remote OK · We Work Remotely
  └─ ATS: Workday · Greenhouse · Lever · Ashby · SmartRecruiters
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
│  ├─ experience-probe.yml       # manual: show what cards will say for live postings
│  └─ ci.yml                     # pytest, lint, typecheck, web tests, build on PRs
├─ automation/
│  ├─ run_source.py              # vendor wrapper: config patches, pipeline, export
│  ├─ export.py                  # vendor SQLite → public job JSON
│  ├─ portal_scrapers.py         # direct Naukri/Foundit/Indeed/Shine/SimplyHired
│  ├─ api_sources.py             # APIs, ATS boards, simple score, build_job
│  ├─ enrich_experience.py       # reads experience from the posting page (LinkedIn, Foundit, others)
│  ├─ publish.py                 # merge artifacts + force-push data branch
│  ├─ matrix.py                  # role → vendor repo matrix
│  ├─ roles.py                   # role list + vendor repos from profiles/
│  ├─ agent.py                   # optional local residential-IP agent
│  ├─ install-agent.ps1          # optional Windows Task Scheduler setup
│  ├─ run-agent.ps1              # Task Scheduler entry point
│  ├─ companies.json             # company career boards (Workday, Greenhouse, Lever, Ashby, SmartRecruiters)
│  ├─ validate_companies.py      # check companies.json against the live feeds
│  └─ requirements.txt           # portal scraper dependencies
├─ tests/                        # pytest suite (export, scoring, publish, roles, run_source)
├─ profiles/
│  ├─ genai.json                 # role search config, NOT a resume, NOT a resume
│  ├─ data.json
│  ├─ uiux.json
│  └─ ba.json
├─ web/
│  ├─ app/
│  │  ├─ layout.tsx              # fonts, metadata, favicon, GLB preload
│  │  ├─ page.tsx                # /
│  │  ├─ globals.css             # all visual styling and responsive layout
│  │  ├─ jobs/[role]/page.tsx    # /jobs/genai|data|uiux|ba|sde
│  │  └─ api/{jobs,refresh,status}/route.ts
│  ├─ components/
│  │  ├─ IntroPage.tsx            # dynamic loader for the cinematic
│  │  ├─ IntroBoot.tsx            # clean first paint / loading screen
│  │  ├─ CinematicIntro.tsx       # Three.js scene, phases, camera, walk
│  │  ├─ StaticIntro.tsx          # reduced-motion / WebGL fallback
│  │  ├─ RoleDestinations.tsx     # four accessible role cards
│  │  ├─ JobDashboard.tsx         # dashboard state, filters, refresh polling
│  │  ├─ Filters.tsx              # search/city/source/score/experience/date/sort
│  │  ├─ JobCard.tsx              # one job card: role light, then it turns over to its back
│  │  ├─ UpdatesTicker.tsx        # strip below the header, scrolls away: new since the last scrape
│  │  ├─ HeroGate.tsx             # the destination gate beside the title, in CSS
│  │  ├─ BestMatch.tsx            # the role's top job as a solid tile
│  │  ├─ MatchSignal.tsx          # radar of the top job's score parts + match bands
│  │  ├─ StatsBar.tsx             # job/company/source/updated figures, set as type
│  │  ├─ RoleSwitcher.tsx         # in-dashboard role tabs
│  │  ├─ ConfirmRefresh.tsx       # hidden-refresh confirmation dialog
│  │  ├─ RefreshPanel.tsx         # queued/running/success/failed progress
│  │  ├─ BrandMark.tsx            # "Next Step" brand mark: CSS 3D steps, a red dot climbing
│  │  ├─ AnimatedFavicon.tsx      # transparent canvas favicon, 8 fps, pauses while the scene or scrolling is busy
│  │  └─ Icons.tsx                # inline SVG icon set
│  ├─ lib/
│  │  ├─ types.ts                 # Job, RoleData, StatusResponse, RoleMeta
│  │  ├─ roles.ts                 # role labels, accents, blurbs
│  │  ├─ service.ts               # data branch first, seed fallback
│  │  ├─ github.ts                # Contents API, Actions status, dispatch
│  │  ├─ prefetch.ts              # warm /api/jobs during the intro
│  │  ├─ renderQuality.ts         # frame-time governor for the intro's pixel ratio
│  │  ├─ fallback.ts              # seed JSON fallback
│  │  ├─ rank.ts                  # role order, top match, score axes, match bands
│  │  ├─ estimate.ts              # browser copy of the scraper's score parts
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
| `/jobs/genai` | `web/app/jobs/[role]/page.tsx` | `generateStaticParams`, `RolePage` | Pre-renders the four valid roles |
| `/jobs/data` | `web/app/jobs/[role]/page.tsx` | `generateMetadata`, `RolePage` | Role label and metadata |
| `/jobs/uiux` | `web/app/jobs/[role]/page.tsx` | `RolePage` | Renders `JobDashboard` |
| `/jobs/ba` | `web/app/jobs/[role]/page.tsx` | `RolePage` | Business Analyst dashboard (entry-level first) |
| `/jobs/sde` | `web/app/jobs/[role]/page.tsx` | `RolePage` | Software Development Engineer dashboard |
| Invalid role | `web/app/jobs/[role]/page.tsx` | `redirect("/")` | Unknown slug returns home |
| App shell | `web/app/layout.tsx` | `metadata`, `viewport`, `RootLayout`, `AnimatedFavicon` | Fonts, `noindex`, theme colour, versioned favicon/manifest links, GLB preload |

`web/app/globals.css` owns:

- design tokens and palette (`:root`)
- shared brand and top bar
- cinematic intro, canvas, poster, vignette
- boot / loading screen
- in-scene role dock and mobile sheet
- static / reduced-motion intro
- dashboard: updates ticker (facts + new jobs), edge lights, hero gate, figures, best-match tile, match signal (radar + bands, estimated when the file has no parts), filters (scroll with the page), job grid and card (role light, then turns over to words + score bars + Apply), pager, states
- modal, refresh panel and toasts
- responsive rules and `prefers-reduced-motion: reduce`

### 4.2 Component ownership

| Component | Path | Key symbols | Owns |
|---|---|---|---|
| Dynamic intro loader | `web/components/IntroPage.tsx` | `CinematicIntro` dynamic import, `IntroBoot` loading | Keeps the first paint free of HI and role cards |
| Boot screen | `web/components/IntroBoot.tsx` | `IntroBoot` | Brand, loader, no headline, no role cards |
| Cinematic scene | `web/components/CinematicIntro.tsx` | `CinematicIntro`, `Phase`, `SceneController`, `createIdleClip`, `adductWalkClip`, `WALK_ADDUCTION`, `IDLE_ADDUCTION`, `HAND_TWIST`, `installCleanClothing`, `SKIN_BAND`, `TEE_V`, `TEE_FACING`, `cameraFovForAspect`, `narrowFactor`, `shortViewportFactor`, `updateSelectorShot`, `travelProfile`, `travelDuration`, `applyPhase`, `updateCharacter`, `updateTurntable`, `updateCamera`, `onPointerDown`, `onPointerMove` | Greeting, pullback, path, turn, walk, gates, clean clothing material split, fragment-masked white tee panel and skin collar band, split walk/idle adduction, palm-inward idle hands, aspect- and height-aware selector camera, gate-fitting departure tracking, selection, turntable drag/optional auto-rotate, transition |
| Static fallback | `web/components/StaticIntro.tsx` | `StaticIntro`, `STATIC_GREETING_MS` | `HI.` for 4 s, then the four destinations; no canvas |
| Role cards | `web/components/RoleDestinations.tsx` | `RoleDestinations` | Accessible buttons for GenAI / Data / UI/UX / Business Analyst |
| Dashboard controller | `web/components/JobDashboard.tsx` | `JobDashboard`, `PAGE_SIZE`, `triggerRefresh`, `switchRole`, `resetFilters`, `filtered`, `shownJobs` | Route data, filters, URL sync, pagination, role switch, refresh state |
| Filters UI | `web/components/Filters.tsx` | `Filters` | Search, city, experience, source, match floor, posted range, sort, score visibility, reset |
| Job card | `web/components/JobCard.tsx` | `JobCard`, `FLIP_MS` | Front: company wordmark in its own colour (`companyHue`) with a corner bloom, score in white with tier word and a New chip under it, title, city · experience, snippet, source · date, Apply (outlined, fills with the company colour on hover). Back: the listing's words, the score's parts as bars (`matchAxes()`), company · city, Apply. Lights in the role colour where the pointer lands and turns over after 1.2 s (hover-capable pointers, motion not reduced); a click, tap, Enter or Space anywhere but Apply turns it over or back |
| Updates ticker | `web/components/UpdatesTicker.tsx` | `UpdatesTicker`, `SHOWN` | Strip just below the sticky header, outside it, so it scrolls away with the page: updated-when, job and company counts, top match, then the new-since-last-scrape jobs; pauses on hover, static when motion is reduced |
| Hero gate | `web/components/HeroGate.tsx` | `HeroGate` | The role's gate beside the title, CSS only |
| Best match | `web/components/BestMatch.tsx` | `BestMatch` | The top job of the role's default order as a solid tile linking to the posting |
| Match signal | `web/components/MatchSignal.tsx` | `MatchSignal` | Radar of the top job's score parts (3+ parts, from the file or `estimate.ts`), parts bars, a footnote when estimated, jobs by match band |
| Score estimate | `web/lib/estimate.ts` | `estimateParts` | The scraper's `score_parts()` in the browser: copies of `ROLE_TITLE_TOKENS`, `ROLE_SKILLS`, `ROLE_TOOLS` and the caps; experience from `utils.ts` bands |
| Ranking | `web/lib/rank.ts` | `compareByRole`, `rankJobs`, `topMatch`, `newJobs`, `scoreAxes`, `matchBands` | The role's default order shared by the list and the overview; parts and bands for the signal panel |
| Stats | `web/components/StatsBar.tsx` | `StatsBar` | Open jobs, companies, sources, time since the last scrape, as type under the title |
| Role switcher | `web/components/RoleSwitcher.tsx` | `RoleSwitcher` | In-dashboard role tabs |
| Refresh confirmation | `web/components/ConfirmRefresh.tsx` | `ConfirmRefresh` | “Refresh … jobs?” dialog; password form (hidden `username` + `current-password` field, so browsers offer to save it), “Remember on this device”, inline “Wrong password” / lockout error (`aria-live`); Escape/backdrop cancel |
| Refresh progress | `web/components/RefreshPanel.tsx` | `RefreshPanel`, `STEPS`, `activeStep` | Queued/running/success/failed progress, elapsed time, run log link |
| Brand mark | `web/components/BrandMark.tsx` | `BrandMark` | "Next Step": three isometric CSS 3D steps (top one blue) and a red dot hopping up them every 3.6 s (`brand-climb` in `globals.css`); em-sized, 42px desktop / 36px phone; the dot rests on the top step under `prefers-reduced-motion` |
| Animated favicon | `web/components/AnimatedFavicon.tsx` | `AnimatedFavicon`, `drawScene`, `dotPosition`, `project`, `paint` | Draws the Next Step mark (the geometry of `favicon.svg`) with the red dot hopping on the CSS mark's 3.6 s timing, on a 64×64 transparent canvas at 8 fps, updates every icon link, pauses when hidden, while `<html data-scene-busy>` is set and for 400 ms after scroll or pointer input, and defers to the static files under `prefers-reduced-motion` |
| Icons | `web/components/Icons.tsx` | `SearchIcon`, `ChevronDownIcon`, `RefreshIcon`, `MapPinIcon`, `BuildingIcon`, `CalendarIcon`, `ExternalIcon`, `CheckIcon`, `CloseIcon`, `SparkIcon`, `MailIcon`, `BriefcaseIcon`, `LayersIcon`, `GlobeIcon`, `AlertIcon`, `GithubIcon`, `CodeIcon`, `FilterIcon`, `EyeIcon`, `ArrowRightIcon`, `ArrowLeftIcon`, `PlayIcon`, `RouteIcon` | Inline SVG icon set |

### 4.3 Data access and shared logic

| File | Key symbols | Owns |
|---|---|---|
| `web/lib/types.ts` | `RoleSlug`, `ROLE_SLUGS`, `isRoleSlug`, `ScoreParts`, `Job`, `RoleData`, `Manifest`, `StatusResponse`, `RoleMeta` (`shortLabel`) | The public data contract |
| `web/lib/roles.ts` | `ROLES`, `DEFAULT_ROLE`, `getRole` | Labels, short labels, descriptions, accents and blurbs |
| `web/lib/service.ts` | `getRoleData` | Reads the `data` branch, falls back to seed JSON |
| `web/lib/github.ts` | `readJsonFromDataBranch` (raw media type, works above 1 MB), `getRunStatus`, `runRole`, `cooldownRemaining`, `dispatchWorkflow`, `REFRESH_COOLDOWN_MINUTES`, `isConfigured`, `isRefreshProtected` | All server-side GitHub access |
| `web/lib/refreshAuth.ts` | `refreshMode`, `checkRefreshKey`, `checkRefreshAttempt`, `createAttemptLimiter`, `refreshLimiter`, `clientIp`, `wrongKeyDelay` | Refresh password check and the in-memory wrong-password lockout (5 per IP / over 30 overall in 15 min → 15 min lock) |
| `web/lib/refreshPrompt.ts` | `passwordError`, `tooManyAttemptsMessage`, `TOO_MANY_ATTEMPTS_CODE`, `WRONG_PASSWORD_MESSAGE` | Password dialog copy shared by the dashboard and `/api/refresh` |
| `web/lib/prefetch.ts` | `prefetchRole`, `takePrefetchedRole` | Starts `/api/jobs` during the intro and consumes it once |
| `web/lib/renderQuality.ts` | `createQualityGovernor` | Steps the WebGL pixel ratio down when frames run long and back up when there is headroom (see ARCHITECTURE 4.5.1) |
| `web/lib/fallback.ts` | `fallbackRoleData` | Seed data with `demo: true` |
| `web/lib/utils.ts` | `scoreTier`, `dateAgo`, `timeAgo`, `formatNumber`, `formatDuration`, `uniqueCompanies`, `cityCounts`, `experienceLabel`, `matchesExperience`, `experiencePriority`, `experienceBandPriority`, `sourceColor`, `companyHue`, `initials` | Display and filter helpers; `experiencePriority` puts fresher/1–3 year BA roles first, `experienceBandPriority` puts 3–8 year SDE roles first |

### 4.4 Static assets

| Asset | Path | Used by |
|---|---|---|
| 3D character | `web/public/models/student/student.glb` (3,684,764 B; 2048px basecolour, 1024px supporting maps) | `CinematicIntro.tsx` `MODEL_URL`; preloaded in `layout.tsx`; textured head/hands/shoes plus runtime clean-clothing groups |
| Wide scene poster | `web/public/models/student/scene.webp` | `.intro-poster` and `.static-intro-scene` in `globals.css` |
| Portrait reference | `web/public/models/student/portrait.webp` | Reference render only; not used as the loading background |
| Attribution | `web/public/models/student/ATTRIBUTION.txt` | Asset license, modifications and prototype limitations |
| Favicon source | `web/public/favicon.svg` | Transparent Next Step mark on a 32-unit grid (three isometric steps, ink outlines, red dot on the top step); SMIL hop for browsers that animate SVG favicons |
| Favicon fallbacks | `web/public/favicon.ico`, `favicon-{16,32,48}.png`, `apple-touch-icon.png`, `icon-{192,512}.png` | Rendered from `favicon.svg`: tab sizes transparent; Apple and PWA icons on the dark ground inside the maskable safe zone; links versioned `?v=7` |
| PWA manifest | `web/public/manifest.json` | Installable app metadata and shortcuts to the four role pages |

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

`web/components/JobDashboard.tsx` is the controller. The page, top to bottom:

```text
header: brand · RoleSwitcher · Live · Journey
  └─ UpdatesTicker        updated-when · jobs · companies · top match, then new since the last scrape (is_new), best first, each a link
edge lights             two fixed 3px strips in the role colour down the page's edges (.edge-light)
hero: h1 · lede · StatsBar (4 figures as type) · Explore / Change destination   |   HeroGate (role colour)
overview: BestMatch (topMatch, solid role-colour tile)   |   MatchSignal (radar of matchAxes: file parts or estimate.ts + match bands)
Filters (scroll with the page)
job grid: 8 JobCards per page (4 columns ≥1200px, 2 below, 1 ≤640px) → Pagination
info cards (pipeline, contact/credits)
```

The role colour (`roles.ts` `accent`) is set once as `--accent` on `.dashboard` and passed
to `HeroGate`, `BestMatch`, `MatchSignal` and `JobCard`.

| Action | Trigger | Code path |
|---|---|---|
| Load a role | Route mount or role change | `fetch("/api/jobs?role=…")` or `takePrefetchedRole()` |
| Prefetch a role | Intro selection or dashboard role switch | `web/lib/prefetch.ts` `prefetchRole()` |
| Search | Filter input | `query` → `filtered` over title/company/location/source/snippet |
| Filter city | City select | exact `job.location` match |
| Filter source | Source select | exact `job.source` match |
| Filter match score | Match select | `job.score >= Number(score)` |
| Filter experience | Experience select | `matchesExperience()` in `web/lib/utils.ts` |
| Filter posted date | Posted select | `postedWithinDays()`: `posted_date`, else `first_seen`, age in days |
| Sort | Sort select | score / date / company; the score order is `compareByRole(role)` in `web/lib/rank.ts` (BA entry levels first, SDE 3–8 year band first, then score) |
| Change page | Pager (`web/components/Pagination.tsx`) | `setPage(n)`; 8 jobs per page (`PAGE_SIZE = 8`), page numbers from `pageItems()` in `web/lib/utils.ts`; any filter, sort or role change goes back to page 1 |
| Share filters | Any filter or page change | `window.history.replaceState(window.history.state, …)` with query params (`page` included when > 1), only after the URL has been read (`hydrated`) |
| Switch role | Role tabs | `prefetchRole(next)` + `router.push("/jobs/<role>")` |
| Retry load | Error state | `setReloadKey(k + 1)` |
| Open refresh | `Alt+Shift+R` | keydown listener → `setConfirmOpen(true)` |
| Confirm refresh | Dialog | `triggerRefresh()` → `POST /api/refresh` |
| Poll refresh | Queued/running status | `/api/status` every 8 seconds, with `&since=<dispatchedAt>` while a dispatch is pending |
| Load fresh jobs | State changes to success | `freshRef.current = true` → `/api/jobs?role=…&fresh=<timestamp>` with `x-refresh-token` |
| Show toast | Refresh/load outcomes | `pushToast()` |
| Updates ticker | Data loaded | `UpdatesTicker`: the facts (`timeAgo(updatedAt)`, `jobs.length`, `uniqueCompanies()`, `topMatch()`), then `newJobs(jobs, role)` from `rank.ts`, first `SHOWN = 12`, on a CSS-translated track repeated once; pauses on hover/focus; "Nothing new since the last scrape" plus the facts when none |
| Best match tile | Data loaded | `best = topMatch(jobs, role)` (unfiltered list, the role's default order) → `BestMatch`; the tile links to the posting |
| Match signal | Data loaded | `MatchSignal`: `matchAxes(best, role)` (the file's parts when 3+, else `estimateParts()` with a footnote; radar when 3+ axes, bars otherwise) and `matchBands(jobs)` |
| Card hover | Pointer over a card | `JobCard` `aim()` sets `--mx`/`--my`; `enter()` adds `.is-lit`, and after `FLIP_MS` = 1200 ms swaps it for `.is-flipped` (`.job-card-inner` turns `rotateY(180deg)`; the away face is `inert`); `leave()` clears both; only when `(hover: hover) and (prefers-reduced-motion: no-preference)` |
| Card click | Click/tap on a card (not a link or button), or Enter/Space with it focused | `JobCard` `click()` / `key()` → `toggle()`: cancels a pending hover turn and toggles `.is-flipped`; on every device |

URL parameters:

```text
q · city · source · score · exp · days · sort
```

Read with `parseFilterParams()` and written with `filterSearch()` (`web/lib/filters.ts`), which also holds the select options `Filters.tsx` renders. A value the menus cannot show falls back to its default; `city` and `source` are checked once the role's jobs load.

---

## 7. API routes

| Route | File | Request | Success | Failure / notes |
|---|---|---|---|---|
| `GET /api/jobs` | `web/app/api/jobs/route.ts` | `role=genai`, `data`, `uiux` or `ba`; optional `fresh` (honoured only with a valid `x-refresh-token`) | `RoleData` JSON | `400` unknown role; `502` load error; `s-maxage=60` unless `fresh` is present (`private, no-store`) |
| `GET /api/status` | `web/app/api/status/route.ts` | optional `role`; optional `since` (ISO time) | `StatusResponse` | Always `no-store`; returns idle message if GitHub is unreachable; with `since`, reports `queued` + `awaitingRun` until a run created after it is listed |
| `POST /api/refresh` | `web/app/api/refresh/route.ts` | `{ "role": "<role>" }` | `202 { ok, role, state: "queued", dispatchedAt }` | `403` blocked origin; `401` missing/wrong password (wrong ones answered after ~750 ms); `429` `code: "too_many_attempts"` with `minutesLeft` while that IP (5 wrong in 15 min) or everyone (over 30 wrong in 15 min) is locked out; `503` refresh disabled (`code: "refresh_disabled"`, production without `REFRESH_TOKEN`) or unconfigured; `400` bad body/role; `409` already running or just dispatched; `429` cooldown; `502` dispatch failed |

Origin check (CSRF): the `Origin` header is required and must be the request host, the `NEXT_PUBLIC_SITE_URL` host, or one of `VERCEL_URL` / `VERCEL_BRANCH_URL` / `VERCEL_PROJECT_PRODUCTION_URL` (localhost too in development). The `x-refresh-token` header must match `REFRESH_TOKEN` (`web/lib/refreshAuth.ts`), the password or PIN the owner chose and set only in Vercel (a change needs a redeploy); a production build without `REFRESH_TOKEN` refuses every refresh. The lockout is checked before the password, so a locked IP is refused even with the right one; wrong passwords sent to `/api/jobs?fresh` count towards it too. It never applies in local development without a token.

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

The profiles are **hardcoded structured dictionaries** in the external scraper repositories (the BA track injects its own profile into the shared UI/UX repo at runtime):

| Role | External repository | Resume profile symbol | Scoring engine | Candidate years |
|---|---|---|---|---|
| GenAI | `Dilip457/Job-Hunt-for-GenAI-Profile` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 2.7 |
| Data | `Dilip457/DataEngineer_JobHunt` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 3.9 |
| UI/UX | `Dilip457/UI-UX-Job_Hunt` | `config.py` → `RESUME_PROFILE` | `scoring_engine.py` → `ScoringEngine` | 4.0 |
| Business Analyst | `Dilip457/UI-UX-Job_Hunt` (patched by `run_source.py`) | `run_source.py` → `BA_RESUME_PROFILE` | `run_source.py` → `_patch_ba_scoring` | 1 (fresher/1–3 yr target) |
| SDE | `Dilip457/UI-UX-Job_Hunt` (patched by `run_source.py`) | `run_source.py` → `SDE_RESUME_PROFILE` | `run_source.py` → `_patch_sde_scoring` | 4 (3–8 yr band target) |

Linked files:

- GenAI: <https://github.com/Dilip457/Job-Hunt-for-GenAI-Profile/blob/main/config.py>
- GenAI scoring: <https://github.com/Dilip457/Job-Hunt-for-GenAI-Profile/blob/main/scoring_engine.py>
- Data: <https://github.com/Dilip457/DataEngineer_JobHunt/blob/main/config.py>
- Data scoring: <https://github.com/Dilip457/DataEngineer_JobHunt/blob/main/scoring_engine.py>
- UI/UX: <https://github.com/Dilip457/UI-UX-Job_Hunt/blob/main/config.py>
- UI/UX scoring: <https://github.com/Dilip457/UI-UX-Job_Hunt/blob/main/scoring_engine.py>
- Business Analyst: `automation/run_source.py` → `BA_RESUME_PROFILE`, `_patch_ba_scoring`, `_patch_sources`
- SDE: `automation/run_source.py` → `SDE_RESUME_PROFILE`, `_patch_sde_scoring`, `_patch_sources`, `SDE_EXPERIENCE_BAND`

These are different preloaded profiles, one per role track. They are **not** the current visitor's resume.

### 8.3 How the profile enters the pipeline

| Step | File | Symbol / action |
|---|---|---|
| 1. Checkout vendor repo | `.github/workflows/scrape.yml` | step `Checkout scraper repo` → `vendor/${{ matrix.role }}` |
| 2. Choose role/repo | `automation/matrix.py` | `REPOS`, `main()` |
| 3. Load role search config | `profiles/<role>.json` | `repo`, `db`, `sources`, `keywords`, `cities`, `min_score`, `max_days` (search config, not the resume) |
| 4. Import vendor config | `automation/run_source.py` | `run()` → `importlib.import_module("config")` |
| 5. Patch search/scoring | `automation/run_source.py` | `_patch_config()`, `_patch_scoring()` |
| 5b. Patch concurrency | `automation/run_source.py` | `_patch_parallel_scrapers()` → threaded `JobSearchPipeline._run_scrapers` (`--parallel-sources`); portal collection starts in a background thread before step 6 and merges after step 9 (`--parallel-portals`, `INDEED_HTTP_ONLY`) |
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
| Business Analyst | 30% | 30% | 20% | 10% | 10% (BA role/tool scoring patched in `run_source.py`) |

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
from api_sources import ROLE_SEARCH_TERMS, build_job, to_date
```

`automation/api_sources.py` owns:

| Symbol | Purpose |
|---|---|
| `ROLE_TITLE_TOKENS` | Role title keywords |
| `ROLE_TITLE_EXCLUDE` | Obvious wrong-role titles |
| `ROLE_SKILLS` | Role skill keywords |
| `title_relevant()`, `title_tracks()` | Rejects unrelated titles; with `resolve_overlap=True` (collectors) a title several tracks accept goes to the one whose role it names; `publish.py` uses the default per-track rule |
| `score_job()` | Base 30, +8 per title hit (max 2), +3 per skill hit (max 6), BA/SDE experience nudges, capped at 88 (`SCORE_CAP`) |
| `score_parts()` | The parts behind `score_job()` on 0–100: `role` (title hits of the 2 allowed), `skill` (practices matched, of the skill allowance), `tool` (named products matched: the `ROLE_TOOLS` subset of `ROLE_SKILLS`, which the score counts as one allowance), and for SDE `experience` (`sde_band_adjust()` mapped from −9…+8) or for BA `experience` (entry title 100, senior 0, else 50) |
| `build_job()` | Builds the public job object and calls `score_job()` |

This is a **title + snippet keyword score**, not the hardcoded resume profile score.

Consequences:

- Vendor LinkedIn/company-page jobs carry the resume-style score and its five `score_parts`; portal and API/ATS jobs carry `score_parts()` (three or four parts).
- Direct portal and API/ATS jobs carry the simpler score. It is capped (2 title hits, 6 skills; at most 64 before BA/SDE nudges) so a keyword match cannot outrank a strong resume match; uncapped, Foundit's skill-tag lists scored up to 97 and filled the first page.
- The merged board can therefore contain two scoring methods side by side. The constants live at the top of `score_job()` in `api_sources.py`.

### 8.6 How the score reaches the UI

| Layer | File | Symbol |
|---|---|---|
| Vendor DB | External SQLite | `match_score`, `role_match`, `skill_match`, `experience_match`, `tool_match`, `domain_match` |
| Export | `automation/export.py` | `score: round(match_score, 1)`, `score_parts` object |
| Publish | `automation/publish.py` | `merge_payloads()` keeps the fresh copy; `dedupe_jobs()` keeps the best-scored copy across boards; `finalize_job()` keeps `score_parts`, computing them with `score_parts()` for jobs that have none or a set without `tool` |
| Type | `web/lib/types.ts` | `Job.score`, `ScoreParts` |
| API | `web/app/api/jobs/route.ts` | returns `RoleData` |
| Dashboard | `web/components/JobDashboard.tsx` | filter by `score`, sort by `score`, pass `showScore` |
| Card | `web/components/JobCard.tsx` | `Math.round(score)` in the role colour with the tier word and an accessible match label |
| Overview | `web/components/BestMatch.tsx`, `MatchSignal.tsx` | the top job's score as `/100`, its `score_parts` as a radar |
| Tier labels | `web/lib/utils.ts` | `scoreTier()`: ≥85 Excellent, ≥75 Strong, ≥65 Good, ≥50 Fair, else Low |

Cards show the **overall** score. `MatchSignal` draws the top job's `score_parts`: `api_sources.score_parts()` publishes `role` (title hits), `skill` (practices matched), `tool` (named products matched) and, for BA and SDE, `experience` (fit to the role's band), each 0–100; vendor jobs may add `domain`. When a file carries fewer than three, `web/lib/estimate.ts` reads the same parts from the listing in the browser and the panel says so.

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

Schedule: `30 21 * * *` UTC = 03:00 IST. Manual dispatch accepts `all | genai | data | uiux | ba`.

### 9.2 Role configuration and vendor mapping

| Role | Local profile | Vendor repo | DB |
|---|---|---|---|
| `genai` | `profiles/genai.json` | `Dilip457/Job-Hunt-for-GenAI-Profile` | `genai_jobs.db` |
| `data` | `profiles/data.json` | `Dilip457/DataEngineer_JobHunt` | `de_jobs.db` |
| `uiux` | `profiles/uiux.json` | `Dilip457/UI-UX-Job_Hunt` | `jobs.db` |
| `ba` | `profiles/ba.json` | `Dilip457/UI-UX-Job_Hunt` (patched) | `jobs.db` |
| `sde` | `profiles/sde.json` | `Dilip457/UI-UX-Job_Hunt` (patched) | `jobs.db` |

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

### 9.5 Keyless feeds and ATS (`automation/api_sources.py`)

| Source | Function |
|---|---|
| Remotive | `fetch_remotive()` |
| Himalayas | `fetch_himalayas()` |
| Remote OK | `fetch_remoteok()` |
| We Work Remotely | `fetch_weworkremotely()` |
| Greenhouse | `_greenhouse_postings()` |
| Lever | `_lever_postings()` |
| Ashby | `_ashby_postings()` |
| SmartRecruiters (India filter, paged) | `_smartrecruiters_postings()` |
| Workday (India facet, paged) | `_workday_postings()`, `_workday_india_facets()`, `_workday_posted()`, `_workday_location()` |
| Readers by ATS name | `ATS_POSTINGS` |
| One board → one role's jobs | `_board_jobs()`, with the stricter title rule `ats_title_ok()` |
| ATS collector | `fetch_ats()` |
| Collection/merge | `collect_api_jobs(..., sources=)`, `merge_api_jobs()` |

Company boards: `automation/companies.json` (`load_companies()`); check them against the live feeds with `automation/validate_companies.py` (`--write` prunes boards with no India postings).

### 9.6 Export (`automation/export.py`)

| Symbol | Responsibility |
|---|---|
| `normalize_location()` | India city aliases, remote/hybrid, foreign filtering; `strict=True` drops unknown places (global sources) |
| `export_location()` | Strict location rule for company career page rows, with a title/URL hint when the location is empty |
| `looks_foreign()` | Reject foreign-language/region titles |
| `extract_experience_with_source()` | Years from a board's experience field, then title/description ("stated"); only intern/fresher/entry-level words count as a title signal; level words such as "associate" or "senior" never produce numbers |
| `canonical_url()` | Remove tracking params for deduplication |
| `make_snippet()` | 240-character public snippet |
| `clean_company()`, `clean_title()`, `valid_url()` | Public-field cleanup; `clean_title()` removes HTML and keeps the role-bearing segments of a `\|` title |
| `normalize_title()`, `strip_company()` | Title text without HTML/extra whitespace (shared with `api_sources.py`); title without the company name for the foreign-place check |
| `export()` | SQLite → jobs array with score, parts, experience, first-seen |
| `main()` | CLI export |

The export deliberately excludes full descriptions, resumes and PII.

### 9.7 Publish and merge (`automation/publish.py`)

| Symbol | Responsibility |
|---|---|
| `_job_key()` | Canonical URL, fallback title/company/location |
| `merge_payloads()` | Union previous + fresh, fresh copy wins, oldest `first_seen` / `posted_date` (capped at `first_seen`), newest `last_seen`, retention (undated jobs still listed are exempt) + unseen filter, cross-board dedupe |
| `finalize_job()` | Cap `posted_date` at `first_seen`, recompute `is_new` from `first_seen`, keep or compute `score_parts` (all-zero sets and sets without `tool` are recomputed; still all-zero sets are dropped), drop redundant `apply_url` |
| `build_payloads()` | Per-role merge / fresh / kept-previous / missing decision |
| `previous_file()` / `read_previous()` | Read previous JSON from `origin/data` as UTF-8; `None` only when the file is absent, `PublishError` (publish aborts) on any other failure |
| `push_data_branch()` | Write `<role>.json`, `manifest.json`, branch-level `vercel.json`; push with `--force-with-lease` |
| `main()` | Fetch, build, push; retry when another publisher moved the branch; warn on kept-previous roles |

Data branch files:

```text
data/
├─ genai.json
├─ data.json
├─ uiux.json
├─ ba.json
├─ manifest.json
└─ vercel.json        # disables Vercel deployments for the JSON-only branch
```

### 9.8 Optional local agent

| File | Responsibility |
|---|---|
| `automation/agent.py` | Staleness check (oldest role's `generated_at`, compared as UTC times), lock/state, clears every `artifacts/<role>.*` before scraping (so a crashed or skipped role is not republished as fresh), per-role run, optional publish |
| `automation/install-agent.ps1` | Clone vendor repos, create venvs, register Windows task |
| `automation/run-agent.ps1` | Task Scheduler entry point |

This is optional; GitHub Actions is the primary scheduler.

### 9.9 CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`: `python -m pytest -q tests` with `automation/requirements.txt` installed (the packages the scrape job uses), then `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` in `web/`. (The one-off Indeed/WARP probe scripts and workflows were removed; they are in git history.)

---

## 10. Public data contract

Canonical TypeScript contract: `web/lib/types.ts` (`Job`, `RoleData`, `Manifest`, `StatusResponse`).

| Field | Type | Produced by | Used by |
|---|---|---|---|
| `role` | `"genai"`, `"data"`, `"uiux"`, `"ba"` or `"sde"` | `automation/export.py`, `automation/publish.py` | `web/lib/types.ts`, dashboard |
| `generated_at` | ISO string | `export.py`, `publish.py` | `StatsBar`, `UpdatesTicker` (when nothing is new) |
| `count` | number | `export.py`, `publish.py` | `StatsBar`, dashboard |
| `sources` | name → count | `export.py`, `portal_scrapers.py`, `api_sources.py`, `publish.py` | filters, stats |
| `jobs` | `Job[]` | all collectors | dashboard |
| `demo` | boolean | seed data / publish | demo notice |
| `Job.id` | string | export/build_job | card key |
| `Job.title` | string | export/build_job | search, card |
| `Job.company` | string | export/build_job | search, card |
| `Job.location` | string | export/build_job | filter, card |
| `Job.url` | string | export/build_job | dedupe, Apply fallback |
| `Job.apply_url` | string, omitted when equal to `url` | export/build_job | Apply |
| `Job.source` | string | export/build_job | filter, badge |
| `Job.posted_date` | date/null | export/build_job | date filter, card |
| `Job.score` | number | vendor engine or `score_job()` | filter, sort, card figure, best-match tile, match bands, ticker |
| `Job.score_parts` | `{role, skill, tool, experience?, domain?}`, 0–100 each; omitted when none or all zero | vendor export, `api_sources.score_parts()`, `publish.finalize_job()` | `MatchSignal` radar for the top match (`estimate.ts` stands in when fewer than three) |
| `Job.experience_min/max` | number/null | `extract_experience_with_source()` | experience label/filter |
| `Job.experience_source` | `"board"`, `"text"`, `"page"`, `"level"`, `"title"` or null | export/build_job/enrich_experience | where the experience came from; publish keeps page/level answers across runs |
| `Job.experience_level` | string/null | `enrich_experience.py` | LinkedIn's "Seniority level" when no years are stated; shown as-is |
| `Job.experience_checked` | date/null | `enrich_experience.py` | last posting-page look; retried after 7 days |
| `Job.snippet` | string | `make_snippet()` | search, card |
| `Job.is_new` | boolean | `publish.finalize_job()`: first seen ≤ 2 days ago | card's New tag, `UpdatesTicker` |
| `Job.first_seen` | date/null | export/publish merge | “First seen”; date filter fallback |
| `Job.last_seen` | date | `publish.stamp_seen()` | drops jobs unseen for 7 days |

Seed fallback: `web/data/genai.json`, `web/data/data.json`, `web/data/uiux.json`, `web/data/ba.json`, `web/data/sde.json` → `web/lib/fallback.ts`.

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
| Responsive intro framing | `CinematicIntro.tsx` (`cameraFovForAspect`, `narrowFactor`, `shortViewportFactor`, `updateSelectorShot`, departure block in `updateCamera`) | `globals.css` short-portrait / short-landscape role-sheet rules; captures at 320x568, 390x844, 768x1024 and 844x390 |
| Mobile role sheet height | `globals.css` `.intro-roles.intro-roles-cinematic` and short-screen media queries | panel `scrollHeight`/`clientHeight`, 12px bottom inset, no horizontal overflow |
| Character rotation | `CinematicIntro.tsx` (`AUTO_ROTATE_SPEED`, `AUTO_ROTATE_DELAY`, `DRAG_SENSITIVITY`, `autoRotate`/`autoRotateRef`, `updateTurntable()`) | `.intro-canvas.is-interactive`, `.intro-rotate-toggle` (`aria-pressed` starts `false`), `onPointer*` handlers |
| Character clothing / face materials | `CinematicIntro.tsx` (`installCleanClothing()`, `SKIN_BAND`, `TEE_V`, `TEE_FACING`, jacket vertex colour, fragment-space tee and skin masks, textured material roughness/normal scale) | `student.glb`, `ATTRIBUTION.txt`, lighting values in the same component |
| Role card content | `web/lib/roles.ts` | `RoleDestinations.tsx`, dashboard labels |
| Intro copy / phase UI | `CinematicIntro.tsx` render block | `web/app/globals.css` (`.intro-canvas`, `.intro-rotate-toggle`) |
| Boot screen | `web/components/IntroBoot.tsx` | `.intro-boot*` styles |
| Static / reduced-motion fallback | `web/components/StaticIntro.tsx` | `.static-*` styles |
| 3D model | `web/public/models/student/student.glb` | `MODEL_URL`, `installCleanClothing()`, `SKIN_BAND`, `TEE_V`, `adductWalkClip()`, turntable setup, `layout.tsx` preload, `ATTRIBUTION.txt` |
| Palette / spacing | `web/app/globals.css` `:root` | component class names |
| Dashboard filters | `web/components/Filters.tsx` + `JobDashboard.tsx` `filtered` | `web/lib/utils.ts` |
| Job card fields | `web/components/JobCard.tsx` | `web/lib/types.ts`, `export.py` |
| Company colour on a card | `web/lib/utils.ts` `companyHue()` (saturation, lightness, 4.5:1 text contrast) | `--hue`/`--hue-ink`/`--hue-text` set in `JobCard.tsx`; `.job-wordmark`, `.job-bloom`, `.job-new`, `.apply-btn` in `globals.css`; `tests/companyHue.test.ts` |
| Card light / turn-over | `JobCard.tsx` (`FLIP_MS`) | `.job-card` (perspective), `.job-card-inner`, `.job-face`, `.job-back`, `.job-parts`, `.job-card-light`, `.job-card:focus-visible` in `globals.css` |
| Edge lights | `globals.css` `.edge-light` | the two spans in `JobDashboard.tsx` |
| Filter bar placement | `globals.css` `.filters` (scrolls with the page) | `.dashboard-jobs-anchor` scroll margin |
| Grid columns per width | `globals.css` `.job-grid` (4 ≥1200px, 2, 1 ≤640px) | `PAGE_SIZE = 8` in `JobDashboard.tsx` |
| Updates ticker | `web/components/UpdatesTicker.tsx` (`SHOWN`, the facts) | `.ticker*` styles, `newJobs()`, `topMatch()` in `web/lib/rank.ts` |
| Hero gate | `web/components/HeroGate.tsx` | `.hero-gate`, `.gate*` styles |
| Best match choice | `web/lib/rank.ts` `topMatch()`, `compareByRole()` | `BestMatch.tsx`, the dashboard's score sort |
| Match signal parts / bands | `web/lib/rank.ts` `matchAxes()`, `scoreAxes()`, `matchBands()` | `MatchSignal.tsx`, `web/lib/estimate.ts`, `automation/api_sources.py` `score_parts()` |
| Score tier colours/labels | `web/lib/utils.ts` `scoreTier()` | `JobCard.tsx` |
| Resume profile / scoring keywords | External vendor `config.py` and `scoring_engine.py` (BA: `run_source.py` patches) | `automation/export.py`, `publish.py` |
| Simple portal/API score | `automation/api_sources.py` `score_job()` | `score_parts()` and `web/lib/estimate.ts` (keep the three in step; `ROLE_TOOLS` ⊆ `ROLE_SKILLS`), `build_job()`, portal/API collectors |
| Search keywords/cities/score floor | `profiles/<role>.json` | `run_source.py`, workflow |
| Add a portal source | `automation/portal_scrapers.py` `fetch_*`, `SOURCES` | `collect_portal_jobs()` |
| Add an API/ATS source | `automation/api_sources.py` `fetch_*`, `SOURCES` | `collect_api_jobs()` |
| Add a role track | `profiles/<role>.json`, `automation/matrix.py` `REPOS` | `web/lib/types.ts`, `roles.ts`, `publish.py` `ROLES`, `agent.py` `ROLES`, workflow choices; shared-vendor roles also need a patch in `run_source.py` |
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
