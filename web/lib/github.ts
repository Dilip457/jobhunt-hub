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

  // With a token, use the Contents API (rate-limit friendly, private-safe).
  // Without a token, fall back to the public raw CDN so a public repo still works.
  if (TOKEN) {
    const response = await ghFetch(
      `/repos/${REPO}/contents/${file}?ref=${DATA_BRANCH}`,
      cacheInit(options),
    );
    if (response.ok) {
      const payload = (await response.json()) as { content?: string; encoding?: string };
      if (payload.content) {
        const text = Buffer.from(payload.content, "base64").toString("utf-8");
        return JSON.parse(text) as T;
      }
    }
  }

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

async function fetchRuns(perPage = 12): Promise<ActionsRun[]> {
  const response = await ghFetch(
    `/repos/${REPO}/actions/workflows/${WORKFLOW}/runs?per_page=${perPage}`,
    cacheInit({ noStore: true }),
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { workflow_runs?: ActionsRun[] };
  return payload.workflow_runs ?? [];
}

function runMatchesRole(run: ActionsRun, role: RoleSlug | null): boolean {
  if (!role) return true;
  const title = (run.display_title ?? "").toLowerCase();
  if (title.includes("all")) return true;
  return title.includes(role);
}

function toState(run: ActionsRun): StatusResponse["state"] {
  if (run.status === "queued" || run.status === "requested" || run.status === "waiting") return "queued";
  if (run.status === "in_progress") return "running";
  if (run.conclusion === "success") return "success";
  if (run.conclusion === "cancelled") return "cancelled";
  if (run.conclusion) return "failed";
  return "idle";
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

  const runs = (await fetchRuns()).filter((run) => runMatchesRole(run, role));

  if (runs.length === 0) {
    return {
      configured: true,
      state: "idle",
      role,
      canRefresh: true,
      cooldownMinutesLeft: 0,
      message: "No scrape has run yet.",
    };
  }

  const latest = runs[0];
  const state = toState(latest);
  const lastRunAt = latest.updated_at ?? latest.created_at;
  const ageMinutes = (Date.now() - new Date(lastRunAt).getTime()) / 60000;
  const onCooldown = ageMinutes < REFRESH_COOLDOWN_MINUTES;
  const active = state === "queued" || state === "running";

  return {
    configured: true,
    state,
    role,
    startedAt: latest.run_started_at ?? latest.created_at,
    updatedAt: latest.updated_at,
    lastRunAt,
    runUrl: latest.html_url,
    canRefresh: !active && !onCooldown,
    cooldownMinutesLeft: onCooldown ? Math.ceil(REFRESH_COOLDOWN_MINUTES - ageMinutes) : 0,
  };
}

export async function dispatchWorkflow(role: RoleSlug): Promise<boolean> {
  if (!isConfigured()) return false;

  const response = await ghFetch(`/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref: DISPATCH_REF, inputs: { role } }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error(`[github] dispatch failed ${response.status}: ${detail.slice(0, 300)}`);
  }

  return response.ok || response.status === 204;
}
