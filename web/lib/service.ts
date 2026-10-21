import { readJsonFromDataBranch } from "./github";
import { fallbackManifest, fallbackRoleData } from "./fallback";
import type { Manifest, RoleData, RoleSlug } from "./types";

/** Load a role's jobs: live `data` branch first, seeded JSON as fallback. */
export async function getRoleData(role: RoleSlug): Promise<RoleData> {
  try {
    // Always read the published data branch. The response is cached at the
    // edge for a short window; caching the GitHub read itself caused a newly
    // published scrape to stay invisible for much longer than the edge TTL.
    const live = await readJsonFromDataBranch<RoleData>(`${role}.json`, { noStore: true });
    if (live && live.role && Array.isArray(live.jobs)) {
      return { ...live, demo: live.demo ?? false };
    }
  } catch {
    // fall through to seed data
  }
  return fallbackRoleData(role);
}

export async function getManifest(): Promise<Manifest> {
  try {
    const live = await readJsonFromDataBranch<Manifest>("manifest.json", {
      revalidate: 60,
      tags: ["jobs"],
    });
    if (live?.roles) return live;
  } catch {
    // fall through to seed data
  }
  return fallbackManifest();
}
