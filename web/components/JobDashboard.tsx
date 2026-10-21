"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { getRole } from "@/lib/roles";
import type { Job, RoleData, RoleSlug, RunState, StatusResponse } from "@/lib/types";
import { cityCounts, matchesExperience, type ExperienceBucket } from "@/lib/utils";
import { prefetchRole, takePrefetchedRole } from "@/lib/prefetch";
import Filters from "./Filters";
import { AlertIcon, MailIcon, RouteIcon, SparkIcon } from "./Icons";
import ConfirmRefresh from "./ConfirmRefresh";
import JobCard from "./JobCard";
import RefreshPanel from "./RefreshPanel";
import RoleSwitcher from "./RoleSwitcher";
import StatsBar from "./StatsBar";

const PAGE_SIZE = 24;

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
  const [visible, setVisible] = useState(PAGE_SIZE);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 6500);
  }, []);

  // ── Initial filter state from the URL ──────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setQuery(params.get("q") ?? "");
    setCity(params.get("city") ?? "all");
    setSource(params.get("source") ?? "all");
    setScore(params.get("score") ?? "all");
    const exp = params.get("exp");
    if (exp) setExperience(exp as ExperienceBucket);
    setDateRange(params.get("days") ?? "all");
    setSort(params.get("sort") ?? "score");
  }, []);

  // Hidden admin shortcut: no visible refresh control and no separate admin URL.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || !event.shiftKey || event.key.toLowerCase() !== "r") return;
      const target = event.target as HTMLElement | null;
      if (target && target.closest("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      if (status?.state === "queued" || status?.state === "running") {
        pushToast("info", "A scrape is already running.");
        return;
      }
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

    const fresh = freshRef.current ? "&fresh=1" : "";
    freshRef.current = false;
    const warm = fresh ? null : takePrefetchedRole(role);
    const request =
      warm ??
      fetch(`/api/jobs?role=${role}${fresh}`).then((response) => {
        if (!response.ok) throw new Error("Could not load jobs");
        return response.json() as Promise<RoleData>;
      });

    request
      .then((payload) => {
        if (!cancelled) {
          setData(payload);
          setVisible(PAGE_SIZE);
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
  useEffect(() => {
    const params = new URLSearchParams();
    if (query) params.set("q", query);
    if (city !== "all") params.set("city", city);
    if (source !== "all") params.set("source", source);
    if (score !== "all") params.set("score", score);
    if (experience !== "all") params.set("exp", experience);
    if (dateRange !== "all") params.set("days", dateRange);
    if (sort !== "score") params.set("sort", sort);
    const next = params.toString();
    const base = pathname || `/jobs/${role}`;
    window.history.replaceState(null, "", next ? `${base}?${next}` : base);
  }, [city, dateRange, experience, pathname, query, role, score, sort, source]);

  // ── Status + polling ───────────────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    fetch(`/api/status?role=${role}`)
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
        const response = await fetch(`/api/status?role=${role}`);
        setStatus((await response.json()) as StatusResponse);
      } catch {
        /* keep the last known state */
      }
    }, 8000);
    return () => window.clearInterval(timer);
  }, [status, role]);

  const previousState = useRef<RunState | null>(null);
  useEffect(() => {
    if (!status) return;
    const before = previousState.current;
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
      return;
    }
    const startedAt = status?.startedAt ? new Date(status.startedAt).getTime() : Date.now();
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [refreshOpen, status?.startedAt]);

  async function triggerRefresh() {
    setRefreshOpen(true);
    try {
      const response = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });

      if (response.status === 202) {
        pushToast("info", "Scrape queued. This usually takes 10–15 minutes.");
        setStatus((current) => (current ? { ...current, state: "queued" } : current));
      } else if (response.status === 409) {
        setRefreshOpen(false);
        pushToast("info", "A scrape is already running.");
      } else if (response.status === 429) {
        setRefreshOpen(false);
        const payload = (await response.json()) as { error?: string };
        pushToast("info", payload.error ?? "Please wait before refreshing again.");
      } else if (response.status === 503) {
        setRefreshOpen(false);
        pushToast("error", "Refresh is not configured on this deployment yet.");
      } else {
        setRefreshOpen(false);
        pushToast("error", "Could not start the scrape.");
      }
    } catch {
      setRefreshOpen(false);
      pushToast("error", "Could not reach the refresh service.");
    }
  }

  useEffect(() => {
    setConfirmOpen(false);
  }, [role]);

  function switchRole(next: RoleSlug) {
    if (next === role) return;
    void prefetchRole(next);
    router.push(`/jobs/${next}`);
  }

  // ── Derived list ───────────────────────────────────────────────────────────
  const jobs = useMemo<Job[]>(() => data?.jobs ?? [], [data]);
  const cities = useMemo(() => cityCounts(jobs), [jobs]);
  const sources = useMemo(() => Object.keys(data?.sources ?? {}).sort(), [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
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
      if (dateRange !== "all") {
        if (!job.posted_date) return false;
        const days = (now - new Date(`${job.posted_date}T00:00:00`).getTime()) / 86_400_000;
        if (days > Number(dateRange)) return false;
      }
      return true;
    });

    return list.sort((a, b) => {
      if (sort === "date") return (b.posted_date ?? "").localeCompare(a.posted_date ?? "");
      if (sort === "company") return a.company.localeCompare(b.company);
      return b.score - a.score;
    });
  }, [jobs, query, city, source, score, experience, dateRange, sort]);

  useEffect(() => {
    setVisible(PAGE_SIZE);
  }, [query, city, source, score, experience, dateRange, sort, role]);

  const shownJobs = filtered.slice(0, visible);

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
            <span className="brand-mark">
              <SparkIcon width={17} height={17} />
            </span>
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
              {roleMeta.blurb} Curated from Naukri, Foundit, Indeed, Shine and LinkedIn, with
              deduplicated links and a transparent match signal.
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

        <div id="jobs" className="dashboard-jobs-anchor" />

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

            {visible < filtered.length ? (
              <div className="load-more">
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setVisible((count) => count + PAGE_SIZE)}
                >
                  Load {Math.min(PAGE_SIZE, filtered.length - visible)} more
                </button>
              </div>
            ) : null}
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
              The cinematic guide head uses the Lee Perry-Smith head study (Infinite Realities,
              CC BY 3.0). The body and motion are a custom Three.js prototype, not a final
              production character.
            </p>
            <details className="credits-details">
              <summary>Asset license &amp; notes</summary>
              <p>
                Head geometry and textures: Lee Perry-Smith / Infinite Realities, licensed under
                Creative Commons Attribution 3.0. Source distributed with the three.js examples.
                Facial animation is not rigged; only camera and body motion are animated.
              </p>
            </details>
          </div>
        </section>
      </main>

      <ConfirmRefresh
        open={confirmOpen}
        roleLabel={roleMeta.label}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          void triggerRefresh();
        }}
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
