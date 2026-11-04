import { readJsonFromDataBranch } from "./github";
import { fallbackRoleData } from "./fallback";
import { createTtlCache } from "./ttlCache";
import type { RoleData, RoleSlug } from "./types";
import { withSafeLinks } from "./utils";

/**
 * The GitHub read is cached in memory for about as long as the edge caches the
 * response, so a CDN miss (or a URL with an extra query parameter) does not
 * spend a GitHub API call each time. A failed read that fell back to the seed
 * data is retried sooner. The old Next.js data cache kept a new publish hidden
 * for much longer than the edge TTL; this cache is bounded and a token-backed
 * `fresh` load (the admin's reload after a refresh) replaces it at once.
 */
export const ROLE_CACHE_SECONDS = 60;
const FALLBACK_CACHE_SECONDS = 15;

const roleCache = createTtlCache<RoleSlug, RoleData>((data) =>
  (data.demo ? FALLBACK_CACHE_SECONDS : ROLE_CACHE_SECONDS) * 1000,
);

async function loadRoleData(role: RoleSlug): Promise<RoleData> {
  try {
    const live = await readJsonFromDataBranch<RoleData>(`${role}.json`, { noStore: true });
    if (live && live.role && Array.isArray(live.jobs)) {
      const jobs = withSafeLinks(live.jobs);
      return { ...live, jobs, count: jobs.length, demo: live.demo ?? false };
    }
  } catch {
    // fall through to seed data
  }
  return fallbackRoleData(role);
}

/**
 * Load a role's jobs: live `data` branch first, seeded JSON as fallback.
 * `fresh` skips the in-memory cache; only honour it for a valid refresh key.
 */
export async function getRoleData(role: RoleSlug, options: { fresh?: boolean } = {}): Promise<RoleData> {
  return roleCache.get(role, () => loadRoleData(role), { fresh: options.fresh });
}
