import type { RoleSlug, StatusResponse } from "./types";

const GITHUB_API = "https://api.github.com";

const REPO = process.env.GITHUB_REPO ?? "";
const TOKEN = process.env.GITHUB_TOKEN ?? "";
const WORKFLOW = process.env.GITHUB_WORKFLOW ?? "scrape.yml";
const DATA_BRANCH = process.env.GITHUB_DATA_BRANCH ?? "data";
const DISPATCH_REF = process.env.GITHUB_DISPATCH_REF ?? "main";

export const REFRESH_COOLDOWN_MINUTES = 25;

export function isConfigured(): boolean {
  return Boolean(REPO && TOKEN);
}

export function isRefreshProtected(): boolean {
  return Boolean(process.env.REFRESH_TOKEN);
}

export function hasRepo(): boolean {
  return Boolean(REPO);
}

function headers(): Record<string, string> {
  const result: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jobhunt-hub",
  };
  if (TOKEN) result.Authorization = `Bearer ${TOKEN}`;
  return result;
}

interface CacheOptions {
  revalidate?: number;
  noStore?: boolean;
  tags?: string[];
}

function cacheInit(options: CacheOptions): RequestInit {
  if (options.noStore) return { cache: "no-store" };
  const next: Record<string, unknown> = {};
  if (typeof options.revalidate === "number") next.revalidate = options.revalidate;
  if (options.tags?.length) next.tags = options.tags;
  return Object.keys(next).length ? ({ next } as RequestInit) : {};
}

async function ghFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      ...headers(),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

/** Read a JSON file from the published `data` branch via the Contents API. */
export async function readJsonFromDataBranch<T>(
  file: string,
  options: CacheOptions = {},
): Promise<T | null> {
  if (!hasRepo()) return null;

  // With a token, use the Contents API with the raw media type. The default
  // JSON media type only inlines files up to 1 MB and returns an empty
  // `content` above that; role files are past 1 MB, which used to push every
  // read onto the minutes-cached raw CDN. The raw media type serves files up
  // to 100 MB and works for private repositories.
  if (TOKEN) {
    const response = await ghFetch(`/repos/${REPO}/contents/${file}?ref=${DATA_BRANCH}`, {
      ...cacheInit(options),
      headers: { Accept: "application/vnd.github.raw+json" },
    });
    if (response.ok) {
      return (await response.json()) as T;
    }
    console.error(`[github] contents read failed for ${file}: ${response.status}`);
  }

  // Without a token (or if the API call failed), fall back to the public raw
  // CDN so a public repo still works. It is cached for a few minutes.
  const raw = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${DATA_BRANCH}/${file}`,
    cacheInit(options),
  );
  if (!raw.ok) return null;
  return (await raw.json()) as T;
}

export interface ActionsRun {
  id: number;
  status: string;
  conclusion: string | null;
  display_title: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  html_url: string;
}

async function fetchRuns(perPage = 12): Promise<{ runs: ActionsRun[]; error?: string }> {
  const response = await ghFetch(
    `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=${perPage}`,
    cacheInit({ noStore: true }),
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      runs: [],
      error: `GitHub API ${response.status}${detail ? `: ${detail.slice(0, 180)}` : ""}`,
    };
  }
  const payload = (await response.json()) as { workflow_runs?: ActionsRun[] };
  return { runs: payload.workflow_runs ?? [] };
}

/**
 * The workflow names each run "Scrape <role>" (run-name in scrape.yml), and
 * scheduled runs are "Scrape all". Parse that exact shape instead of looking
 * for substrings, so a role slug that happens to appear inside another word
 * can never match the wrong run.
 */
export function runRole(run: Pick<ActionsRun, "display_title">): string | null {
  const match = /^scrape\s+([a-z0-9_-]+)\s*$/i.exec((run.display_title ?? "").trim());
  return match ? match[1].toLowerCase() : null;
}

export function runMatchesRole(run: Pick<ActionsRun, "display_title">, role: RoleSlug | null): boolean {
  if (!role) return true;
  const target = runRole(run);
  return target === "all" || target === role;
}

function toState(run: ActionsRun): StatusResponse["state"] {
  if (run.status === "queued" || run.status === "requested" || run.status === "waiting") return "queued";
  if (run.status === "in_progress") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion) return "failed";
  return "idle";
}

/**
 * Minutes left before another refresh is allowed. The cooldown only follows a
 * successful run: a failed or cancelled run published nothing, so retrying it
 * straight away is the useful thing to do.
 */
export function cooldownRemaining(
  state: StatusResponse["state"],
  lastRunAt: string,
  now: number = Date.now(),
): number {
  if (state !== "success") return 0;
  const ageMinutes = (now - new Date(lastRunAt).getTime()) / 60000;
  if (!(ageMinutes < REFRESH_COOLDOWN_MINUTES)) return 0;
  return Math.ceil(REFRESH_COOLDOWN_MINUTES - ageMinutes);
}

export async function getRunStatus(role: RoleSlug | null): Promise<StatusResponse> {
  if (!isConfigured()) {
    return {
      configured: false,
      state: "idle",
      role,
      message: "Live refresh is enabled once this site is connected to GitHub.",
    };
  }

  const { runs: allRuns, error } = await fetchRuns();

  if (error) {
    return {
      configured: true,
      state: "idle",
      role,
      refreshProtected: isRefreshProtected(),
      canRefresh: false,
      message: `GitHub is not reachable with the configured token (${error}).`,
    };
  }

  const runs = allRuns.filter((run) => runMatchesRole(run, role));

  if (runs.length === 0) {
    return {
      configured: true,
      state: "idle",
      role,
      refreshProtected: isRefreshProtected(),
      canRefresh: true,
      cooldownMinutesLeft: 0,
      message: "No scrape has run yet.",
    };
  }

  const latest = runs[0];
  const state = toState(latest);
  const lastRunAt = latest.updated_at ?? latest.created_at;
  const active = state === "queued" || state === "running";
  const cooldownMinutesLeft = cooldownRemaining(state, lastRunAt);
  const onCooldown = cooldownMinutesLeft > 0;

  return {
    configured: true,
    state,
    role,
    refreshProtected: isRefreshProtected(),
    startedAt: latest.run_started_at ?? latest.created_at,
    updatedAt: latest.updated_at,
    lastRunAt,
    runUrl: latest.html_url,
    canRefresh: !active && !onCooldown,
    cooldownMinutesLeft,
  };
}

export interface DispatchResult {
  ok: boolean;
  status?: number;
  detail?: string;
}

export async function dispatchWorkflow(role: RoleSlug | "all"): Promise<DispatchResult> {
  if (!isConfigured()) return { ok: false, detail: "GitHub is not configured on this deployment." };

  try {
    const response = await ghFetch(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: DISPATCH_REF, inputs: { role } }),
    });

    if (response.ok || response.status === 204) return { ok: true };

    // A 401/403 here is almost always the token scope: the same token can read
    // runs (the status endpoint) but needs Actions: write to dispatch one.
    const body = await response.text().catch(() => "");
    const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
    console.error(`[github] dispatch failed ${response.status}: ${detail}`);
    return { ok: false, status: response.status, detail: detail || "GitHub returned no detail." };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Network error";
    console.error(`[github] dispatch threw: ${detail}`);
    return { ok: false, detail };
  }
}
