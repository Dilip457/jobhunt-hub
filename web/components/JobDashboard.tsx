"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getRole } from "@/lib/roles";
import { filterSearch, knownOrAll, parseFilterParams } from "@/lib/filters";
import {
  REFRESH_DISABLED_MESSAGE,
  REFRESH_TOKEN_HEADER,
  type Job,
  type RefreshAccepted,
  type RoleData,
  type RoleSlug,
  type RunState,
  type StatusResponse,
} from "@/lib/types";
import {
  cityCounts,
  compareNewest,
  experienceBandPriority,
  experiencePriority,
  matchesExperience,
  postedWithinDays,
  type ExperienceBucket,
} from "@/lib/utils";
import { prefetchRole, takePrefetchedRole } from "@/lib/prefetch";
import { passwordError, type RefreshRejection } from "@/lib/refreshPrompt";
import Filters from "./Filters";
import BrandMark from "./BrandMark";
import { AlertIcon, MailIcon, RouteIcon, SparkIcon } from "./Icons";
import ConfirmRefresh from "./ConfirmRefresh";
import JobCard from "./JobCard";
import Pagination from "./Pagination";
import RefreshPanel from "./RefreshPanel";
import RoleSwitcher from "./RoleSwitcher";
import StatsBar from "./StatsBar";

const PAGE_SIZE = 8;
const REFRESH_KEY_STORAGE = "jobhunt.refreshKey";
/** Give up waiting if GitHub has not listed the dispatched run after this long. */
const AWAIT_RUN_TIMEOUT_MS = 5 * 60_000;

/** A dispatch this browser is waiting on: GitHub accepted it but may not list it yet. */
interface PendingRun {
  role: RoleSlug;
  /** Server time of the dispatch (dispatchedAt from POST /api/refresh). */
  since: string;
  requestedAt: number;
}

/**
 * While a dispatch is pending, ask for runs created after it, or the poll
 * would report the previous run as if it were the one just started.
 */
function statusUrl(role: RoleSlug, pending: PendingRun | null): string {
  const since = pending && pending.role === role ? `&since=${encodeURIComponent(pending.since)}` : "";
  return `/api/status?role=${role}${since}`;
}

interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

interface Props {
  role: RoleSlug;
}

export default function JobDashboard({ role }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const roleMeta = getRole(role);

  const [data, setData] = useState<RoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const freshRef = useRef(false);

  const [query, setQuery] = useState("");
  const [city, setCity] = useState("all");
  const [source, setSource] = useState("all");
  const [score, setScore] = useState("all");
  const [experience, setExperience] = useState<ExperienceBucket>("all");
  const [dateRange, setDateRange] = useState("all");
  const [sort, setSort] = useState("score");
  const [showScores, setShowScores] = useState(true);
  const [page, setPage] = useState(1);
  // Filters and page are read from the URL once on mount. Until then a filter
  // change must not reset the page, or a shared "?page=3" link would land on 1.
  const [hydrated, setHydrated] = useState(false);
  const lastFilterKey = useRef<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState("");
  const [rememberKey, setRememberKey] = useState(true);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyChecking, setKeyChecking] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const refreshStartRef = useRef<number | null>(null);
  const pendingRunRef = useRef<PendingRun | null>(null);
  // Read by the jobs loader, which only re-runs on a role or reload change.
  const refreshKeyRef = useRef("");
  // Set when the dialog is cancelled while the password is being checked.
  const keyCheckCancelledRef = useRef(false);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 6500);
  }, []);

  // ── Initial filter state from the URL ──────────────────────────────────────
  // Values the menus cannot show fall back to their defaults (lib/filters.ts).
  useEffect(() => {
    const initial = parseFilterParams(new URLSearchParams(window.location.search));
    setQuery(initial.query);
    setCity(initial.city);
    setSource(initial.source);
    setScore(initial.score);
    setExperience(initial.experience);
    setDateRange(initial.dateRange);
    setSort(initial.sort);
    setPage(initial.page);
    setHydrated(true);
  }, []);

  // Hidden admin shortcut: no visible refresh control and no separate admin URL.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "r") return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (status?.refreshDisabled) {
        pushToast("error", REFRESH_DISABLED_MESSAGE);
        return;
      }
      if (status?.state === "queued" || status?.state === "running") {
        pushToast("info", "A scrape is already running.");
        return;
      }
      setKeyError(null);
      // Reopening clears an earlier cancel, so a password check still in
      // flight can report its result in this dialog.
      keyCheckCancelledRef.current = false;
      setConfirmOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [status, pushToast]);

  // ── Load jobs for the route role ───────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData((current) => (current?.role === role ? current : null));

    // After a refresh, skip every cache. The server only honours `fresh` with
    // the refresh key, and the unique value keeps the CDN out of the way.
    const fresh = freshRef.current ? `&fresh=${Date.now()}` : "";
    freshRef.current = false;
    const warm = fresh ? null : takePrefetchedRole(role);
    const headers: Record<string, string> = {};
    if (fresh && refreshKeyRef.current) headers[REFRESH_TOKEN_HEADER] = refreshKeyRef.current;
    const request =
      warm ??
      fetch(`/api/jobs?role=${role}${fresh}`, { headers }).then((response) => {
        if (!response.ok) throw new Error("Could not load jobs");
        return response.json() as Promise<RoleData>;
      });

    request
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [role, reloadKey]);

  // ── Keep filters shareable without a role parameter ────────────────────────
  // Wait until the URL has been read: the first commit runs before Next.js has
  // patched history, so writing then wipes its state (Back stops working) and,
  // under StrictMode, clears the query before it is read. Passing the current
  // state on keeps Next's history entry intact.
  useEffect(() => {
    if (!hydrated) return;
    const next = filterSearch({ query, city, source, score, experience, dateRange, sort, page });
    const base = pathname || `/jobs/${role}`;
    const url = next ? `${base}?${next}` : base;
    if (url === `${window.location.pathname}${window.location.search}`) return;
    window.history.replaceState(window.history.state, "", url);
  }, [city, dateRange, experience, hydrated, page, pathname, query, role, score, sort, source]);

  // ── Status + polling ───────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    fetch(statusUrl(role, pendingRunRef.current))
      .then((response) => response.json() as Promise<StatusResponse>)
      .then((payload) => {
        if (active) setStatus(payload);
      })
      .catch(() => {
        /* status is optional */
      });
    return () => {
      active = false;
    };
  }, [role, reloadKey]);

  useEffect(() => {
    if (!status || (status.state !== "queued" && status.state !== "running")) return;
    const timer = window.setInterval(async () => {
      try {
        const pending = pendingRunRef.current;
        const response = await fetch(statusUrl(role, pending));
        const next = (await response.json()) as StatusResponse;
        if (pending && (next.awaitingRun || next.state === "idle")) {
          if (Date.now() - pending.requestedAt > AWAIT_RUN_TIMEOUT_MS) {
            pendingRunRef.current = null;
            setRefreshOpen(false);
            pushToast("error", "GitHub has not started the run yet. Check the Actions tab.");
            setStatus({ ...next, state: "idle", awaitingRun: false });
            return;
          }
          // "idle" while waiting means the check itself failed; keep waiting.
          if (next.state === "idle") return;
        }
        setStatus(next);
      } catch {
        /* keep the last known state */
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [status, role, pushToast]);

  const previousState = useRef<RunState | null>(null);
  useEffect(() => {
    if (!status) return;
    const before = previousState.current;
    if (status.state === "success" || status.state === "failed" || status.state === "cancelled") {
      pendingRunRef.current = null;
    }
    if (before && before !== status.state) {
      if (status.state === "success") {
        freshRef.current = true;
        setReloadKey((key) => key + 1);
        pushToast("success", "Fresh jobs loaded.");
        setRefreshOpen(false);
      } else if (status.state === "failed") {
        pushToast("error", "The scrape failed. Check the run log.");
        setRefreshOpen(false);
      } else if (status.state === "cancelled") {
        pushToast("info", "The scrape was cancelled before it finished.");
        setRefreshOpen(false);
      }
    }
    previousState.current = status.state;
  }, [status, pushToast]);

  useEffect(() => {
    if (!refreshOpen) {
      setElapsed(0);
      refreshStartRef.current = null;
      return;
    }
    // Count from the moment refresh was requested, not from the previous run.
    // status.startedAt can still point at yesterday's run until GitHub reports
    // the queued run.
    const startedAt =
      refreshStartRef.current ??
      (status?.startedAt ? new Date(status.startedAt).getTime() : Date.now());
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [refreshOpen, status?.startedAt]);

  // The refresh password is remembered on this browser only (if the owner
  // ticks "Remember on this device"), so it is typed once per device.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(REFRESH_KEY_STORAGE) ?? "";
      refreshKeyRef.current = stored;
      setRefreshKey(stored);
    } catch {
      /* storage can be unavailable (private mode) */
    }
  }, []);

  /**
   * Keep the accepted password for this page (the jobs reload after a refresh
   * sends it) and store it only when the owner asked to be remembered.
   */
  function rememberRefreshKey(value: string, remember: boolean) {
    refreshKeyRef.current = value;
    const stored = remember ? value : "";
    setRefreshKey(stored);
    try {
      if (stored) window.localStorage.setItem(REFRESH_KEY_STORAGE, stored);
      else window.localStorage.removeItem(REFRESH_KEY_STORAGE);
    } catch {
      /* ignore */
    }
  }

  /**
   * Report a failure that happened before the password was checked. With a
   * typed password the dialog stays open: closing it would make browsers treat
   * the unchecked password as a successful sign-in and offer to save it.
   */
  function failBeforePasswordCheck(key: string, message: string) {
    if (key && !keyCheckCancelledRef.current) {
      setKeyError(message);
      setConfirmOpen(true);
      return;
    }
    setConfirmOpen(false);
    pushToast("error", message);
  }

  async function triggerRefresh(key: string, remember: boolean) {
    setRememberKey(remember);
    setKeyError(null);
    // Request headers only carry Latin-1, so fetch would throw on such a
    // password; REFRESH_TOKEN cannot contain those characters either.
    if (/[^\u0000-ÿ]/.test(key)) {
      setKeyError("Wrong password. It can only contain standard keyboard characters.");
      setConfirmOpen(true);
      return;
    }
    setKeyChecking(true);
    keyCheckCancelledRef.current = false;
    const requestedAt = Date.now();
    let response: Response;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (key) headers[REFRESH_TOKEN_HEADER] = key;
      response = await fetch("/api/refresh", {
        method: "POST",
        headers,
        body: JSON.stringify({ role }),
      });
    } catch {
      setKeyChecking(false);
      failBeforePasswordCheck(key, "Could not reach the refresh service. Try again.");
      return;
    }
    setKeyChecking(false);

    try {
      // A wrong password or a lockout keeps the dialog open with the reason.
      const payload = (await response.json().catch(() => ({}))) as RefreshRejection & {
        detail?: string;
        status?: number;
      } & Partial<RefreshAccepted>;
      const inline = passwordError(response.status, payload, Boolean(key));
      if (inline) {
        if (response.status === 401) {
          rememberRefreshKey("", remember);
          // The dialog asks for a password only when status says so; make sure it does now.
          setStatus((current) => ({ configured: true, state: "idle", role, ...current, refreshProtected: true }));
        }
        // Do not bring back a dialog the owner has already cancelled.
        if (!keyCheckCancelledRef.current) {
          setKeyError(inline);
          setConfirmOpen(true);
        }
        return;
      }

      // Refresh switched off is answered before the password is looked at.
      if (response.status === 503 && payload.code === "refresh_disabled") {
        setStatus((current) => ({ configured: true, state: "idle", role, ...current, refreshDisabled: true }));
        failBeforePasswordCheck(key, payload.error ?? REFRESH_DISABLED_MESSAGE);
        return;
      }

      setConfirmOpen(false);
      if (key) rememberRefreshKey(key, remember);

      if (response.status === 202) {
        refreshStartRef.current = requestedAt;
        setRefreshOpen(true);
        pendingRunRef.current = {
          role,
          since: payload.dispatchedAt ?? new Date(requestedAt).toISOString(),
          requestedAt: Date.now(),
        };
        pushToast("info", "Scrape queued. This usually takes 5–25 minutes.");
        // Until GitHub lists the new run, the link and times belong to the
        // previous one, so drop them. A missing status still starts polling.
        setStatus((current) => ({
          configured: true,
          role,
          ...current,
          state: "queued",
          awaitingRun: true,
          runUrl: undefined,
          startedAt: undefined,
        }));
      } else if (response.status === 409) {
        pushToast("info", "A scrape is already running.");
      } else if (response.status === 429) {
        pushToast("info", payload.error ?? "Please wait before refreshing again.");
      } else if (response.status === 503) {
        pushToast("error", payload.error ?? "Refresh is not configured on this deployment yet.");
      } else {
        const reason = payload.detail
          ? ` — ${payload.status ?? "GitHub"}: ${payload.detail.slice(0, 140)}`
          : "";
        pushToast("error", `${payload.error ?? "Could not start the scrape."}${reason}`);
      }
    } catch {
      setConfirmOpen(false);
      setRefreshOpen(false);
      pushToast("error", "Could not reach the refresh service.");
    }
  }

  useEffect(() => {
    setConfirmOpen(false);
    setKeyError(null);
    // A pending dispatch belongs to the role it was started from.
    if (pendingRunRef.current && pendingRunRef.current.role !== role) pendingRunRef.current = null;
  }, [role]);

  function switchRole(next: RoleSlug) {
    if (next === role) return;
    void prefetchRole(next);
    router.push(`/jobs/${next}`);
  }

  // ── Derived list ───────────────────────────────────────────────────────────
  const jobs = useMemo<Job[]>(() => data?.jobs ?? [], [data]);
  const cities = useMemo(() => cityCounts(jobs), [jobs]);
  // The totals can miss a source that still has jobs; list every source a job uses.
  const sources = useMemo(
    () => [...new Set([...Object.keys(data?.sources ?? {}), ...jobs.map((job) => job.source)])].sort(),
    [data, jobs],
  );

  // City and source options come from the data, so a shared link's value is
  // checked once this role's jobs are in; one no job has falls back to "all".
  useEffect(() => {
    if (!hydrated || !data || data.role !== role) return;
    const nextCity = knownOrAll(city, cities.map((item) => item.city));
    if (nextCity !== city) setCity(nextCity);
    const nextSource = knownOrAll(source, sources);
    if (nextSource !== source) setSource(nextSource);
  }, [cities, city, data, hydrated, role, source, sources]);

  // Typing updates the search box at once; the list of a few thousand jobs
  // is re-filtered when React has a free moment, so keystrokes never wait
  // for it.
  const deferredQuery = useDeferredValue(query);
  const filtered = useMemo(() => {
    const needle = deferredQuery.trim().toLowerCase();
    const now = Date.now();

    const list = jobs.filter((job) => {
      if (needle) {
        const haystack =
          `${job.title} ${job.company} ${job.location} ${job.source} ${job.snippet ?? ""}`.toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (city !== "all" && job.location !== city) return false;
      if (source !== "all" && job.source !== source) return false;
      if (score !== "all" && job.score < Number(score)) return false;
      if (!matchesExperience(job, experience)) return false;
      // Some boards publish no date; fall back to when we first saw the job
      // instead of hiding it from every date filter.
      if (dateRange !== "all" && !postedWithinDays(job, Number(dateRange), now)) return false;
      return true;
    });

    return list.sort((a, b) => {
      if (sort === "date") return compareNewest(a, b);
      if (sort === "company") return a.company.localeCompare(b.company);
      // Business Analyst is an entry/1–3 year track: keep those roles first
      // even when a senior listing has a slightly higher raw match score.
      if (role === "ba") {
        const priority = experiencePriority(a) - experiencePriority(b);
        if (priority !== 0) return priority;
      }
      // SDE targets 3–8 years, so that band leads the score ordering.
      if (role === "sde") {
        const priority = experienceBandPriority(a) - experienceBandPriority(b);
        if (priority !== 0) return priority;
      }
      return b.score - a.score;
    });
  }, [jobs, deferredQuery, city, source, score, experience, dateRange, sort, role]);

  // Any filter, sort or role change starts again from page 1.
  const filterKey = [role, query, city, source, score, experience, dateRange, sort].join("\u0000");
  useEffect(() => {
    if (!hydrated) return;
    if (lastFilterKey.current !== null && lastFilterKey.current !== filterKey) setPage(1);
    lastFilterKey.current = filterKey;
  }, [filterKey, hydrated]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  // Clamp rather than store: a refresh that shrinks the list keeps a valid page.
  const currentPage = Math.min(page, pageCount);
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const shownJobs = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  function goToPage(next: number) {
    setPage(Math.min(Math.max(1, next), pageCount));
    resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function resetFilters() {
    setQuery("");
    setCity("all");
    setSource("all");
    setScore("all");
    setExperience("all");
    setDateRange("all");
    setSort("score");
  }

  const liveCount = data ? data.count : 0;

  return (
    <div className="dashboard">
      <div className="dashboard-ambient" aria-hidden>
        <span className="dashboard-glow dashboard-glow-red" />
        <span className="dashboard-glow dashboard-glow-blue" />
        <span className="dashboard-grid" />
      </div>

      <header className="dashboard-header">
        <div className="shell dashboard-header-inner">
          <Link className="brand-lockup" href="/" aria-label="JobHunt India home">
            <BrandMark />
            <span className="brand-copy">
              <strong>JOBHUNT</strong>
              <span>INDIA / 2026</span>
            </span>
          </Link>

          <RoleSwitcher role={role} onChange={switchRole} />

          <div className="dashboard-header-actions">
            <span className="live-pill">
              <span className="status-dot" />
              Live
            </span>
            <Link className="journey-link" href="/">
              <RouteIcon width={15} height={15} />
              Journey
            </Link>
          </div>
        </div>
      </header>

      <main className="shell dashboard-main">
        <section className="dashboard-hero">
          <div className="dashboard-hero-copy">
            <p className="eyebrow">
              <span className="eyebrow-line" />
              Destination reached · {roleMeta.label}
            </p>
            <h1>{roleMeta.fullLabel}</h1>
            <p className="hero-lede">
              {roleMeta.blurb} Curated from Naukri, Foundit, Indeed, Shine, LinkedIn, Wellfound,
              IIBA and more, with deduplicated links and a transparent match signal.
            </p>
            <div className="hero-actions">
              <a className="primary-btn" href="#jobs">
                Explore {liveCount ? liveCount.toLocaleString("en-IN") : "live"} jobs
              </a>
              <Link className="ghost-btn" href="/">
                Change destination
              </Link>
            </div>
          </div>

          <div className="dashboard-hero-art" aria-hidden>
            <span className="hero-art-orbit hero-art-orbit-a" />
            <span className="hero-art-orbit hero-art-orbit-b" />
            <span className="hero-art-core" />
            <span className="hero-art-label">NEXT / MOVE</span>
          </div>
        </section>

        {data?.demo ? (
          <div className="notice">
            <AlertIcon width={16} height={16} />
            <span>
              Showing seed data so you can explore the portal. Run the scraper once to replace it
              with live listings.
            </span>
          </div>
        ) : null}

        {data ? <StatsBar data={data} role={roleMeta} status={status} /> : null}

        <div id="jobs" ref={resultsRef} className="dashboard-jobs-anchor" />

        <Filters
          query={query}
          setQuery={setQuery}
          city={city}
          setCity={setCity}
          cities={cities}
          source={source}
          setSource={setSource}
          sources={sources}
          score={score}
          setScore={setScore}
          experience={experience}
          setExperience={setExperience}
          dateRange={dateRange}
          setDateRange={setDateRange}
          sort={sort}
          setSort={setSort}
          showScores={showScores}
          setShowScores={setShowScores}
          onReset={resetFilters}
          shown={filtered.length}
          total={jobs.length}
        />

        <div className="sr-only" aria-live="polite">
          {loading ? "Loading jobs" : `${filtered.length} jobs match the current filters`}
        </div>

        {error ? (
          <div className="state-box">
            <AlertIcon width={22} height={22} />
            <h3>Could not load jobs</h3>
            <p>{error}</p>
            <button type="button" className="primary-btn" onClick={() => setReloadKey((key) => key + 1)}>
              Try again
            </button>
          </div>
        ) : loading && !data ? (
          <div className="job-grid job-grid-loading" aria-hidden>
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="job-card skeleton" key={index} />
            ))}
          </div>
        ) : shownJobs.length === 0 ? (
          <div className="state-box">
            <SparkIcon width={22} height={22} />
            <h3>No matching jobs found for this role yet.</h3>
            <p>Change the role, broaden the search, or clear the filters to see more.</p>
            <div className="state-actions">
              <button type="button" className="primary-btn" onClick={resetFilters}>
                Clear filters
              </button>
              <Link className="ghost-btn" href="/">
                Change role
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className={`job-grid ${loading ? "is-loading" : ""}`}>
              {shownJobs.map((job, index) => (
                <JobCard
                  key={`${job.source}-${job.id}`}
                  job={job}
                  showScore={showScores}
                  index={index}
                />
              ))}
            </div>

            <Pagination
              page={currentPage}
              pageCount={pageCount}
              pageSize={PAGE_SIZE}
              total={filtered.length}
              onChange={goToPage}
            />
          </>
        )}

        <section className="dashboard-info">
          <div className="info-card">
            <p className="info-kicker">THE PIPELINE</p>
            <h2>Real listings. Real links. No mock data.</h2>
            <ol>
              <li>A GitHub Action scrapes public job listings every morning at 7 AM IST.</li>
              <li>Each listing is scored, de-duplicated and linked to its original posting.</li>
              <li>Results are published as JSON; this dashboard reads the published data.</li>
              <li>Filters and role changes never trigger a scrape or spend a workflow run.</li>
            </ol>
          </div>

          <div className="info-card info-card-accent">
            <p className="info-kicker">CONTACT / CREDITS</p>
            <h2>Built in the open.</h2>
            <p>
              Feature request, bug, or issue?{" "}
              <a href="mailto:heyjarvis.03@gmail.com">
                <MailIcon width={13} height={13} /> heyjarvis.03@gmail.com
              </a>
            </p>
            <p className="credits-copy">
              The cinematic guide is a stylized CC0 “Casual Man” base by Grab3D, optimized and
              modified for this site. It is a prototype, not a final production character.
            </p>
            <details className="credits-details">
              <summary>Asset license &amp; notes</summary>
              <p>
                Character base: “Casual Man” by Grab3D, released under CC0 1.0. Source:
                grab3d.com. Changes: simplified mesh, 1024px WebP textures, blue-black jacket,
                runtime glasses, and a generated breathing idle. The model has no facial
                blendshapes or lip-sync rig; only camera, body and walk motion are animated.
                Full attribution ships in <code>web/public/models/student/ATTRIBUTION.txt</code>.
              </p>
            </details>
          </div>
        </section>
      </main>

      <ConfirmRefresh
        open={confirmOpen}
        roleLabel={roleMeta.label}
        needsKey={Boolean(status?.refreshProtected)}
        initialKey={refreshKey}
        initialRemember={rememberKey}
        error={keyError}
        busy={keyChecking}
        onCancel={() => {
          keyCheckCancelledRef.current = true;
          setConfirmOpen(false);
          setKeyError(null);
        }}
        onConfirm={(key, remember) => void triggerRefresh(key, remember)}
      />

      <RefreshPanel
        open={refreshOpen}
        state={status?.state ?? "idle"}
        roleLabel={roleMeta.label}
        elapsed={elapsed}
        runUrl={status?.runUrl}
        runConfigured={status?.configured ?? true}
        onClose={() => setRefreshOpen(false)}
      />

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast is-${toast.kind}`}>
            {toast.text}
          </div>
        ))}
      </div>
    </div>
  );
}
