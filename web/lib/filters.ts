import type { ExperienceBucket } from "./utils";

/**
 * Fixed filter options, shared by the select menus and the URL parser so a
 * shared link can only ever select a value the menu can show.
 */
export interface FilterOption<T extends string = string> {
  value: T;
  label: string;
}

export const EXPERIENCE_OPTIONS: FilterOption<ExperienceBucket>[] = [
  { value: "all", label: "Any level" },
  { value: "fresher", label: "Fresher (0–1 yr)" },
  { value: "mid", label: "Mid (2–5 yrs)" },
  { value: "senior", label: "Senior (3–8 yrs)" },
  { value: "lead", label: "Lead / Principal" },
];

export const SCORE_OPTIONS: FilterOption[] = [
  { value: "all", label: "Any score" },
  { value: "60", label: "60%+" },
  { value: "70", label: "70%+" },
  { value: "80", label: "80%+" },
  { value: "90", label: "90%+" },
];

export const DATE_OPTIONS: FilterOption[] = [
  { value: "all", label: "Any time" },
  { value: "1", label: "Today" },
  { value: "3", label: "Last 3 days" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
];

export const SORT_OPTIONS: FilterOption[] = [
  { value: "score", label: "Best match" },
  { value: "date", label: "Newest first" },
  { value: "company", label: "Company A–Z" },
];

export interface UrlFilters {
  query: string;
  /** Checked against the loaded data later (see knownOrAll). */
  city: string;
  /** Checked against the loaded data later (see knownOrAll). */
  source: string;
  score: string;
  experience: ExperienceBucket;
  dateRange: string;
  sort: string;
  page: number;
}

function pick<T extends string>(value: string | null, options: FilterOption<T>[], fallback: T): T {
  const match = options.find((option) => option.value === value);
  return match ? match.value : fallback;
}

/**
 * Read the dashboard filters from a query string. Any value the menus cannot
 * show falls back to its default, so "?exp=junk" cannot hide jobs while the
 * menu reads "Any level".
 */
export function parseFilterParams(params: URLSearchParams): UrlFilters {
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    query: params.get("q") ?? "",
    city: params.get("city") || "all",
    source: params.get("source") || "all",
    score: pick(params.get("score"), SCORE_OPTIONS, "all"),
    experience: pick(params.get("exp"), EXPERIENCE_OPTIONS, "all"),
    dateRange: pick(params.get("days"), DATE_OPTIONS, "all"),
    sort: pick(params.get("sort"), SORT_OPTIONS, "score"),
    page: Number.isFinite(page) && page > 1 ? page : 1,
  };
}

/** Write the filters back as a query string, leaving defaults out. */
export function filterSearch(filters: UrlFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.city !== "all") params.set("city", filters.city);
  if (filters.source !== "all") params.set("source", filters.source);
  if (filters.score !== "all") params.set("score", filters.score);
  if (filters.experience !== "all") params.set("exp", filters.experience);
  if (filters.dateRange !== "all") params.set("days", filters.dateRange);
  if (filters.sort !== "score") params.set("sort", filters.sort);
  if (filters.page > 1) params.set("page", String(filters.page));
  return params.toString();
}

/**
 * City and source options come from the loaded jobs, so those two are checked
 * once data arrives: a value no job has would show 0 results under "All".
 */
export function knownOrAll(value: string, known: readonly string[]): string {
  return value === "all" || known.includes(value) ? value : "all";
}
