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

/**
 * The "Posted" filter. Many boards publish no date (posted_date is null), so
 * the first-seen date stands in; a job with neither date matches no range.
 */
export function postedWithinDays(
  job: Pick<Job, "posted_date" | "first_seen">,
  days: number,
  now: number = Date.now(),
): boolean {
  const day = jobDate(job);
  if (!day) return false;
  const age = (now - new Date(`${day}T00:00:00`).getTime()) / 86_400_000;
  return age <= days;
}

/** "Newest first" order, on the same posted-else-first-seen date; undated jobs last. */
export function compareNewest(
  a: Pick<Job, "posted_date" | "first_seen">,
  b: Pick<Job, "posted_date" | "first_seen">,
): number {
  return (jobDate(b) ?? "").localeCompare(jobDate(a) ?? "");
}

/** The card's date line: "Posted …" when the board gave a date, else "First seen …". */
export function jobDateLabels(job: Pick<Job, "posted_date" | "first_seen">): {
  posted: string | null;
  seen: string | null;
} {
  return {
    posted: job.posted_date ? `Posted ${dateAgo(job.posted_date)}` : null,
    seen: job.first_seen ? `First seen ${dateAgo(job.first_seen)}` : null,
  };
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

/**
 * The value when it is an absolute http(s) link, else null. Job links come from
 * scraped pages, so a listing could carry javascript:, data: or a link that
 * hides its real host behind user:password@.
 */
export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || /[\u0000-\u0020\u007f]/.test(text)) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || !url.hostname) return null;
    return text;
  } catch {
    return null;
  }
}

/** Where a job's Apply link goes: its apply link if safe, else its listing link. */
export function jobHref(job: { url?: unknown; apply_url?: unknown }): string | undefined {
  return safeHttpUrl(job.apply_url) ?? safeHttpUrl(job.url) ?? undefined;
}

/**
 * Keep only jobs with a safe listing link, and drop an unsafe apply link. The
 * publisher does this too; this covers a data branch written by anything else.
 */
export function withSafeLinks<T extends { url?: unknown; apply_url?: unknown }>(jobs: T[]): T[] {
  const kept: T[] = [];
  for (const job of jobs) {
    if (!safeHttpUrl(job.url)) continue;
    if (job.apply_url && !safeHttpUrl(job.apply_url)) {
      const copy = { ...job };
      delete copy.apply_url;
      kept.push(copy);
    } else {
      kept.push(job);
    }
  }
  return kept;
}

export interface CompanyHue {
  /** The company's colour: the wordmark, the corner bloom and Apply on hover. */
  color: string;
  /** Text on a fill of that colour: near-black or white, whichever reads better. */
  ink: string;
  /** The same hue lightened until it reads on the card (4.5:1): the wordmark. */
  text: string;
}

const HUE_SATURATION = 72;
const HUE_LIGHTNESS = 56;
const INK_DARK = "#08090d";
/** The card's face colour, which the wordmark has to read against. */
const CARD_RGB: [number, number, number] = [16, 19, 26];
const TEXT_CONTRAST = 4.5;

/**
 * A colour of the company's own, from its name: the same company always gets
 * the same hue, and different names spread around the wheel. FNV-1a with a
 * final avalanche, so every letter moves the hue, not mostly the last one.
 * companyHue("Codemonk").color === companyHue("codemonk ").color
 */
export function companyHue(company: string): CompanyHue {
  let hash = 0x811c9dc5;
  for (const char of company.trim().toLowerCase()) hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  const hue = (hash >>> 0) % 360;
  const [r, g, b] = hslToRgb(hue, HUE_SATURATION / 100, HUE_LIGHTNESS / 100);
  const light = relativeLuminance(r, g, b);
  // WCAG contrast of the fill against white and against the near-black ink.
  const onWhite = 1.05 / (light + 0.05);
  const onDark = (light + 0.05) / (relativeLuminance(8, 9, 13) + 0.05);
  const card = relativeLuminance(...CARD_RGB);
  let textLightness = HUE_LIGHTNESS;
  while (textLightness < 90) {
    const [tr, tg, tb] = hslToRgb(hue, HUE_SATURATION / 100, textLightness / 100);
    if ((relativeLuminance(tr, tg, tb) + 0.05) / (card + 0.05) >= TEXT_CONTRAST) break;
    textLightness += 2;
  }
  return {
    color: `hsl(${hue} ${HUE_SATURATION}% ${HUE_LIGHTNESS}%)`,
    ink: onDark >= onWhite ? INK_DARK : "#ffffff",
    text: `hsl(${hue} ${HUE_SATURATION}% ${textLightness}%)`,
  };
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
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
  internshala: "#0091d5",
  apna: "#7c3aed",
  unstop: "#1d4ed8",
  workable: "#00756a",
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
