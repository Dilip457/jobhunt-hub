import { readJsonFromDataBranch } from "./github";
import { fallbackManifest, fallbackRoleData } from "./fallback";
import type { Manifest, RoleData, RoleSlug } from "./types";

/** Load a role's jobs: live `data` branch first, seeded JSON as fallback. */
export async function getRoleData(role: RoleSlug, fresh = false): Promise<RoleData> {
  try {
    const live = await readJsonFromDataBranch<RoleData>(
      `${role}.json`,
      fresh ? { noStore: true } : { revalidate: 60, tags: ["jobs", `jobs:${role}`] },
    );
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
