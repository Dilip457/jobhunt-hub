import type { RoleData, RoleSlug } from "./types";

const cache = new Map<RoleSlug, Promise<RoleData>>();

/**
 * Warm the jobs request while the cinematic transition is still playing.
 * The dashboard consumes the same promise once, so the data is not fetched twice.
 */
export function prefetchRole(role: RoleSlug): Promise<RoleData> {
  const existing = cache.get(role);
  if (existing) return existing;

  const request = fetch(`/api/jobs?role=${role}`)
    .then((response) => {
      if (!response.ok) throw new Error("Could not load jobs");
      return response.json() as Promise<RoleData>;
    })
    .catch((error: unknown) => {
      cache.delete(role);
      throw error;
    });

  cache.set(role, request);
  return request;
}

/** Return a warm request once. A miss falls back to a normal fetch. */
export function takePrefetchedRole(role: RoleSlug): Promise<RoleData> | null {
  const request = cache.get(role);
  if (!request) return null;
  cache.delete(role);
  return request;
}
