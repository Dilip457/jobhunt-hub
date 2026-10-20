"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_ROLE, ROLES, getRole } from "@/lib/roles";
import { isRoleSlug, type Job, type RoleData, type RoleSlug, type RunState, type StatusResponse } from "@/lib/types";
import {
  cityCounts,
  matchesExperience,
  type ExperienceBucket,
} from "@/lib/utils";
import Filters from "./Filters";
import { AlertIcon, MailIcon, RefreshIcon, SparkIcon } from "./Icons";
import ConfirmRefresh from "./ConfirmRefresh";
import JobCard from "./JobCard";
import RefreshPanel from "./RefreshPanel";
import RoleSelect from "./RoleSelect";
import StatsBar from "./StatsBar";

const PAGE_SIZE = 24;

interface Toast {
  id: number;
  kind: "info" | "success" | "error";
  text: string;
}

export default function Dashboard() {
  const [role, setRole] = useState<RoleSlug>(DEFAULT_ROLE);
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
  const [adminMode, setAdminMode] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [refreshOpen, setRefreshOpen] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const roleMeta = getRole(role);

  const pushToast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 6500);
  }, []);

  // ── Initial state from the URL ──────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlRole = params.get("role") ?? "";
    if (isRoleSlug(urlRole)) setRole(urlRole);
    setQuery(params.get("q") ?? "");
    setCity(params.get("city") ?? "all");
    setSource(params.get("source") ?? "all");
    setScore(params.get("score") ?? "all");
    const exp = params.get("exp");
    if (exp) setExperience(exp as ExperienceBucket);
    setDateRange(params.get("days") ?? "all");
    setSort(params.get("sort") ?? "score");

    // The refresh control is hidden from public visitors. Opening the site with
    // ?admin=1 reveals it for this browser session only.
    try {
      if (params.get("admin") === "1") {
        window.sessionStorage.setItem("jobhunt-admin", "1");
        setAdminMode(true);
      } else if (params.get("admin") === "0") {
        window.sessionStorage.removeItem("jobhunt-admin");
        setAdminMode(false);
      } else if (window.sessionStorage.getItem("jobhunt-admin") === "1") {
        setAdminMode(true);
      }
    } catch {
      // sessionStorage can be unavailable in strict privacy modes.
    }
  }, []);

  // ── Load jobs for the selected role ─────────────────────────────────────────
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const fresh = freshRef.current ? "&fresh=1" : "";
    freshRef.current = false;

    fetch(`/api/jobs?role=${role}${fresh}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Could not load jobs");
        return response.json() as Promise<RoleData>;
      })
      .then((payload) => {
        setData(payload);
        setVisible(PAGE_SIZE);
      })
      .catch((err: Error) => {
        if (err.name !== "AbortError") setError(err.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [role, reloadKey]);

  // ── Keep the URL shareable ──────────────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams();
    params.set("role", role);
    if (query) params.set("q", query);
    if (city !== "all") params.set("city", city);
    if (source !== "all") params.set("source", source);
    if (score !== "all") params.set("score", score);
    if (experience !== "all") params.set("exp", experience);
    if (dateRange !== "all") params.set("days", dateRange);
    if (sort !== "score") params.set("sort", sort);
    window.history.replaceState(null, "", `?${params.toString()}`);
  }, [role, query, city, source, score, experience, dateRange, sort]);

  // ── Poll GitHub Actions while a scrape runs ─────────────────────────────────
  useEffect(() => {
    let active = true;
    fetch(`/api/status?role=${role}`)
      .then((response) => response.json() as Promise<StatusResponse>)
      .then((payload) => {
        if (active) setStatus(payload);
      })
      .catch(() => {
        /* ignore */
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
        /* ignore */
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

  // ── Elapsed timer while the modal is open ───────────────────────────────────
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

  // ── Derived job list ────────────────────────────────────────────────────────
  const jobs = useMemo<Job[]>(() => data?.jobs ?? [], [data]);
  const cities = useMemo(() => cityCounts(jobs), [jobs]);
  const sources = useMemo(() => Object.keys(data?.sources ?? {}).sort(), [data]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const now = Date.now();

    const list = jobs.filter((job) => {
      if (needle) {
        const haystack = `${job.title} ${job.company} ${job.location} ${job.source} ${job.snippet ?? ""}`.toLowerCase();
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
  const running = status?.state === "queued" || status?.state === "running";

  function resetFilters() {
    setQuery("");
    setCity("all");
    setSource("all");
    setScore("all");
    setExperience("all");
    setDateRange("all");
    setSort("score");
  }

  return (
    <div className="app">
      <header className="site-header">
        <div className="shell header-inner">
          <a className="brand" href="/">
            <span className="brand-mark">
              <SparkIcon width={18} height={18} />
            </span>
            <span className="brand-text">
              <strong>JobHunt</strong>
              <span>India</span>
            </span>
          </a>

          <div className="header-actions">
            <RoleSelect value={role} onChange={setRole} />
            {adminMode ? (
              <button
                type="button"
                className={`admin-refresh-btn ${running ? "is-running" : ""}`}
                onClick={() => setConfirmOpen(true)}
                disabled={running}
                aria-label={running ? "Scrape in progress" : "Refresh jobs"}
                title={running ? "Scrape in progress" : "Refresh jobs"}
              >
                <RefreshIcon width={16} height={16} />
                {running ? "Scraping…" : "Refresh"}
              </button>
            ) : null}
          </div>
        </div>
      </header>

      <main className="shell">
        <section className="hero">
          <div className="hero-copy">
            <span className="hero-tag">
              <span className="pulse" />
              Updated daily across India
            </span>
            <h1>
              Find your next <span style={{ color: roleMeta.accent }}>{roleMeta.label}</span> role
            </h1>
            <p>{roleMeta.blurb} Curated from LinkedIn, Naukri, Indeed, Foundit, Shine and SimplyHired — filtered by city, experience and match score.</p>
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
          <div className="job-grid">
            {Array.from({ length: 6 }).map((_, index) => (
              <div className="job-card skeleton" key={index} />
            ))}
          </div>
        ) : shownJobs.length === 0 ? (
          <div className="state-box">
            <SparkIcon width={22} height={22} />
            <h3>No roles match these filters</h3>
            <p>Try a different city, clear the search, or widen the date range.</p>
            <button type="button" className="primary-btn" onClick={resetFilters}>
              Reset filters
            </button>
          </div>
        ) : (
          <>
            <div className={`job-grid ${loading ? "is-loading" : ""}`}>
              {shownJobs.map((job) => (
                <JobCard key={`${job.source}-${job.id}`} job={job} showScore={showScores} />
              ))}
            </div>

            {visible < filtered.length ? (
              <div className="load-more">
                <button type="button" className="ghost-btn" onClick={() => setVisible((count) => count + PAGE_SIZE)}>
                  Load {Math.min(PAGE_SIZE, filtered.length - visible)} more
                </button>
              </div>
            ) : null}
          </>
        )}

        <section className="explainer">
          <div className="explainer-card">
            <h3>How this works</h3>
            <ol>
              <li>A GitHub Action scrapes public job listings every morning at 7 AM IST.</li>
              <li>Each listing is scored against a reference profile and de-duplicated.</li>
              <li>Results are published as JSON, which this portal reads.</li>
              <li>New results appear automatically once a scrape publishes — no account needed.</li>
            </ol>
          </div>
          <div className="explainer-card">
            <h3>Being built in the open</h3>
            <p>
              Three role tracks — GenAI, Data Engineering and UI/UX — share one pipeline. Data is
              linked back to the original posting; we never republish full descriptions.
            </p>
            <div className="explainer-links">
              {ROLES.map((item) => (
                <button
                  key={item.slug}
                  type="button"
                  className="role-chip"
                  style={{ borderColor: item.accent, color: item.accent }}
                  onClick={() => setRole(item.slug)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <p className="explainer-contact">
              <MailIcon width={14} height={14} />
              <span>
                Feature request, bug, or issue?{" "}
                <a href="mailto:heyjarvis.03@gmail.com">heyjarvis.03@gmail.com</a>
              </span>
            </p>
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
