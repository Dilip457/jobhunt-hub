export type RoleSlug = "genai" | "data" | "uiux";

export const ROLE_SLUGS: RoleSlug[] = ["genai", "data", "uiux"];

export function isRoleSlug(value: string): value is RoleSlug {
  return (ROLE_SLUGS as string[]).includes(value);
}

export interface ScoreParts {
  role?: number;
  skill?: number;
  experience?: number;
  tool?: number;
  domain?: number;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string;
  url: string;
  apply_url?: string;
  source: string;
  posted_date: string | null;
  score: number;
  score_parts?: ScoreParts;
  experience_min?: number | null;
  experience_max?: number | null;
  snippet?: string;
  is_new?: boolean;
  first_seen?: string | null;
}

export interface RoleData {
  role: RoleSlug;
  generated_at: string;
  count: number;
  sources: Record<string, number>;
  jobs: Job[];
  demo?: boolean;
}

export interface ManifestRole {
  role: RoleSlug;
  count: number;
  generated_at: string;
  sources: Record<string, number>;
  demo?: boolean;
  status?: string;
}

export interface Manifest {
  generated_at: string;
  data_commit?: string;
  demo?: boolean;
  roles: Partial<Record<RoleSlug, ManifestRole>>;
}

export type RunState = "idle" | "queued" | "running" | "success" | "failed" | "cancelled";

export interface StatusResponse {
  configured: boolean;
  state: RunState;
  role: RoleSlug | null;
  message?: string;
  startedAt?: string;
  updatedAt?: string;
  lastRunAt?: string;
  runUrl?: string;
  canRefresh?: boolean;
  cooldownMinutesLeft?: number;
  demo?: boolean;
}

export interface RoleMeta {
  slug: RoleSlug;
  label: string;
  fullLabel: string;
  description: string;
  accent: string;
  accentSoft: string;
  blurb: string;
}
