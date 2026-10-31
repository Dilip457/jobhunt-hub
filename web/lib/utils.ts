import type { Job } from "./types";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export interface Tier {
  label: string;
  color: string;
}

export function scoreTier(score: number): Tier {
  if (score >= 85) return { label: "Excellent match", color: "#34d399" };
  if (score >= 75) return { label: "Strong match", color: "#38bdf8" };
  if (score >= 65) return { label: "Good match", color: "#a78bfa" };
  if (score >= 50) return { label: "Fair match", color: "#fbbf24" };
  return { label: "Low match", color: "#94a3b8" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value.length <= 10 ? `${value}T00:00:00` : value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

export function timeAgo(value?: string | null): string {
  if (!value) return "never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "never";
  const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(value);
}

/**
 * Relative label for date-only values (YYYY-MM-DD). Unlike timeAgo(), a bare
 * date never reports hours — it reads as "today", "yesterday" or "N days ago".
 */
export function dateAgo(value?: string | null): string {
  if (!value) return "";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return timeAgo(value);

  const then = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(then.getTime())) return "";

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.max(0, Math.round((today.getTime() - then.getTime()) / 86_400_000));

  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return formatDate(value);
}

/** The listing's date for filtering and sorting: posted date, else first seen. */
export function jobDate(job: Pick<Job, "posted_date" | "first_seen">): string | null {
  const value = job.posted_date || job.first_seen || null;
  return value ? value.slice(0, 10) : null;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-IN").format(value);
}

export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function uniqueCompanies(jobs: Job[]): number {
  return new Set(jobs.map((j) => j.company.toLowerCase())).size;
}

export interface CityCount {
  city: string;
  count: number;
}

export function cityCounts(jobs: Job[]): CityCount[] {
  const map = new Map<string, number>();
  for (const job of jobs) {
    const city = job.location || "India";
    map.set(city, (map.get(city) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));
}

/**
 * LinkedIn's seniority labels, mapped to the filter buckets. The label itself
 * is what the card shows; this only decides which filter it answers to.
 */
const LEVEL_BUCKET: Record<string, Exclude<ExperienceBucket, "all">> = {
  internship: "fresher",
  "entry level": "fresher",
  associate: "mid",
  "mid-senior level": "senior",
  director: "lead",
  executive: "lead",
};

export function levelBucket(job: Pick<Job, "experience_level">): Exclude<ExperienceBucket, "all"> | null {
  const level = (job.experience_level ?? "").trim().toLowerCase();
  return level ? (LEVEL_BUCKET[level] ?? null) : null;
}

export function experienceLabel(job: Job): string {
  const min = job.experience_min;
  const max = job.experience_max;
  if (min == null && max == null) return job.experience_level || "Not stated in posting";
  if (min === 0 && (max === 0 || max == null)) return "Fresher / entry level";
  if (min != null && max != null && min === max) return `${min} yrs`;
  if (min != null && max != null) return `${min}–${max} yrs`;
  if (min != null) return `${min}+ yrs`;
  return `Up to ${max} yrs`;
}

export type ExperienceBucket = "all" | "fresher" | "mid" | "senior" | "lead";

export function matchesExperience(job: Job, bucket: ExperienceBucket): boolean {
  if (bucket === "all") return true;
  const min = job.experience_min ?? null;
  const max = job.experience_max ?? null;
  if (min == null && max == null) {
    // No years stated: a LinkedIn level answers its bucket; a posting that
    // states nothing is only listed under "Any level", never under "Fresher".
    const fromLevel = levelBucket(job);
    return fromLevel === bucket;
  }
  const lower = min ?? 0;
  const upper = max ?? (min != null ? min + 2 : 99);

  switch (bucket) {
    case "fresher":
      return lower <= 1;
    case "mid":
      return lower <= 5 && upper >= 2;
    case "senior":
      return lower >= 3 && lower <= 8;
    case "lead":
      return lower >= 6 || (job.title.toLowerCase().match(/\b(lead|principal|staff|architect|head|director|manager)\b/) !== null);
    default:
      return true;
  }
}

/**
 * Ranking used by the Business Analyst track. Fresher/entry-level roles come
 * first, then 1–3 year roles, then unspecified/mid roles, and senior roles
 * last. The score is still the tie-breaker inside each band.
 */
export function experiencePriority(job: Job): number {
  const min = job.experience_min ?? null;
  const max = job.experience_max ?? null;

  if (min != null) {
    if (min <= 1) return 0;
    if (min <= 3) return 1;
    if (min >= 6) return 3;
    return 2;
  }
  if (max != null) {
    if (max <= 1) return 0;
    if (max <= 3) return 1;
    if (max >= 6) return 3;
    return 2;
  }

  const level = levelBucket(job);
  if (level === "fresher") return 0;
  if (level === "mid") return 1;
  if (level === "lead") return 3;
  if (level === "senior") return 2;

  const text = `${job.title} ${job.snippet ?? ""}`.toLowerCase();
  if (/\b(fresher|entry[\s-]?level|graduate|intern|trainee|0\s*[-–]\s*1)\b/.test(text)) return 0;
  if (/\b(junior|associate|1\s*[-–]\s*3|1\s*[-–]\s*2|2\s*[-–]\s*3)\b/.test(text)) return 1;
  if (
    /\b(senior|lead|principal|staff|manager|director|head|architect|6\+?\s*years?|7\+?\s*years?|8\+?\s*years?)\b/.test(
      text,
    )
  ) {
    return 3;
  }
  return 2;
}

/**
 * Ranking used by the Software Development Engineer track. The profile targets
 * 3-8 years, so listings whose experience range overlaps that band come first,
 * then ones that only touch it, then roles that are clearly too senior, and
 * entry-level roles last. The score is still the tie-breaker inside each band.
 */
export function experienceBandPriority(job: Job): number {
  const BAND_LO = 3;
  const BAND_HI = 8;
  const text = `${job.title} ${job.snippet ?? ""}`.toLowerCase();
  // Title overrides first: a "Principal" title extracts an 8-year fallback,
  // which would otherwise look squarely in-band.
  if (/\b(principal|staff|architect|director|vp|vice president|head of|distinguished)\b/.test(text)) {
    return 2;
  }
  if (/\b(fresher|entry[\s-]?level|graduate|intern|trainee|junior)\b/.test(text)) return 3;

  const min = job.experience_min ?? null;
  const max = job.experience_max ?? null;

  if (min != null || max != null) {
    const start = min ?? (max as number);
    const end = max ?? (min as number);
    const low = Math.min(start, end);
    const high = Math.max(start, end);
    const overlap = Math.min(high, BAND_HI) - Math.max(low, BAND_LO) + 1;
    if (low >= BAND_LO && high <= BAND_HI) return 0;
    if (overlap >= 3) return 0;
    if (overlap >= 1) return 1;
    if (high < BAND_LO) return 3;
    return 2;
  }

  const level = levelBucket(job);
  if (level === "senior") return 0;
  if (level === "mid") return 1;
  if (level === "lead") return 2;
  if (level === "fresher") return 3;

  if (/\b(senior|lead|sde\s*(?:ii|2|iii|3)|engineer\s*(?:ii|2|iii|3)|specialist)\b/.test(text)) {
    return 0;
  }
  return 1;
}

export function initials(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  if (!clean || clean.toLowerCase() === "unknown") return "–";
  const parts = clean.split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("");
}

const SOURCE_COLORS: Record<string, string> = {
  linkedin: "#0a66c2",
  naukri: "#ff7555",
  indeed: "#2557a7",
  simplyhired: "#2557a7",
  foundit: "#f4a300",
  shine: "#f97316",
  timesjobs: "#e11d48",
  wellfound: "#0f172a",
  glassdoor: "#0caa41",
  instahyre: "#6366f1",
  "iiba career center": "#1f5fa8",
  "remote ok": "#f97316",
  "we work remotely": "#0ea5e9",
  cutshort: "#5851d3",
  hirist: "#2563eb",
  "company career pages": "#14b8a6",
  company_pages: "#14b8a6",
  playwright: "#8b5cf6",
};

export function sourceColor(source: string): string {
  return SOURCE_COLORS[source.toLowerCase()] ?? "#64748b";
}

/**
 * Page buttons to show for a pager: always the first and last page, the
 * current page with one neighbour each side, and "gap" where pages are skipped.
 * pageItems(6, 20) -> [1, "gap", 5, 6, 7, "gap", 20]
 */
export function pageItems(current: number, count: number): Array<number | "gap"> {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  const pages = new Set<number>([1, count, current - 1, current, current + 1]);
  // Near either end, show a run of five so the pager does not jump in width.
  if (current <= 4) [2, 3, 4, 5].forEach((page) => pages.add(page));
  if (current >= count - 3) [count - 4, count - 3, count - 2, count - 1].forEach((page) => pages.add(page));
  const sorted = [...pages].filter((page) => page >= 1 && page <= count).sort((a, b) => a - b);
  const items: Array<number | "gap"> = [];
  sorted.forEach((page, index) => {
    if (index > 0 && page - sorted[index - 1] > 1) items.push("gap");
    items.push(page);
  });
  return items;
}
