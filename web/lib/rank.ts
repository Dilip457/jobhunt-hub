import { estimateParts } from "./estimate";
import type { Job, RoleSlug, ScoreParts } from "./types";
import { experienceBandPriority, experiencePriority } from "./utils";

/**
 * The default order of a role's list: the role's experience rule first, then
 * the match score. Business Analyst is an entry/1–3 year track, so those
 * roles lead even when a senior listing has a slightly higher raw score; SDE
 * targets 3–8 years, so that band leads its ordering.
 */
export function compareByRole(role: RoleSlug): (a: Job, b: Job) => number {
  return (a, b) => {
    if (role === "ba") {
      const priority = experiencePriority(a) - experiencePriority(b);
      if (priority !== 0) return priority;
    }
    if (role === "sde") {
      const priority = experienceBandPriority(a) - experienceBandPriority(b);
      if (priority !== 0) return priority;
    }
    return b.score - a.score;
  };
}

export function rankJobs(jobs: Job[], role: RoleSlug): Job[] {
  return [...jobs].sort(compareByRole(role));
}

/** The job the role's list opens with, whatever the filters say. */
export function topMatch(jobs: Job[], role: RoleSlug): Job | null {
  return rankJobs(jobs, role)[0] ?? null;
}

/** Jobs first collected in the last couple of days (publish.py sets is_new), best first. */
export function newJobs(jobs: Job[], role: RoleSlug): Job[] {
  return rankJobs(
    jobs.filter((job) => job.is_new),
    role,
  );
}

export interface ScoreAxis {
  key: keyof ScoreParts;
  label: string;
  value: number;
}

const AXIS_LABELS: Record<keyof ScoreParts, string> = {
  role: "Role fit",
  skill: "Skills",
  tool: "Tools",
  experience: "Experience",
  domain: "Domain",
};

const AXIS_ORDER: Array<keyof ScoreParts> = ["role", "skill", "tool", "experience", "domain"];

/**
 * The published parts of a job's score, in display order, each 0–100. Empty
 * when the scraper published none: older files carry no parts, and a set that
 * is all zeros was a placeholder, not a breakdown.
 */
export function scoreAxes(job: Pick<Job, "score_parts">): ScoreAxis[] {
  const parts = job.score_parts;
  if (!parts) return [];
  const axes = AXIS_ORDER.flatMap((key) => {
    const value = parts[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    return [{ key, label: AXIS_LABELS[key], value: Math.max(0, Math.min(100, value)) }];
  });
  return axes.some((axis) => axis.value > 0) ? axes : [];
}

export interface MatchAxes {
  axes: ScoreAxis[];
  /** True when the parts came from the browser's copy of the rules, not the file. */
  estimated: boolean;
}

/** The radar needs this many parts; fewer are drawn as bars only. */
export const RADAR_MIN_AXES = 3;

/**
 * The axes the match signal draws for a job: the published parts when the
 * file carries enough of them for a radar, else the browser's estimate from
 * the same rules (estimate.ts). Older files have no parts, or only the two
 * from before the tools part was split out; both fall back.
 */
export function matchAxes(job: Job | null, role: RoleSlug): MatchAxes {
  if (!job) return { axes: [], estimated: false };
  const published = scoreAxes(job);
  if (published.length >= RADAR_MIN_AXES) return { axes: published, estimated: false };
  const estimated = scoreAxes({ score_parts: estimateParts(job, role) });
  return estimated.length > 0 ? { axes: estimated, estimated: true } : { axes: published, estimated: false };
}

export interface MatchBand {
  label: string;
  count: number;
}

const BANDS: Array<[string, number, number]> = [
  ["90+", 90, Infinity],
  ["80–89", 80, 90],
  ["70–79", 70, 80],
  ["60–69", 60, 70],
  ["Under 60", -Infinity, 60],
];

/** How many of the jobs fall in each match band, best band first. */
export function matchBands(jobs: Array<Pick<Job, "score">>): MatchBand[] {
  return BANDS.map(([label, min, max]) => ({
    label,
    count: jobs.filter((job) => job.score >= min && job.score < max).length,
  }));
}
