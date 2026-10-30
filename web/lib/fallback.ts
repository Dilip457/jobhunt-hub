import genaiSeed from "@/data/genai.json";
import dataSeed from "@/data/data.json";
import uiuxSeed from "@/data/uiux.json";
import baSeed from "@/data/ba.json";
import manifestSeed from "@/data/manifest.json";
import type { Manifest, RoleData, RoleSlug } from "./types";

const SEEDS: Record<RoleSlug, RoleData> = {
  genai: genaiSeed as unknown as RoleData,
  data: dataSeed as unknown as RoleData,
  uiux: uiuxSeed as unknown as RoleData,
  ba: baSeed as unknown as RoleData,
};

export function fallbackRoleData(role: RoleSlug): RoleData {
  return { ...SEEDS[role], demo: true };
}

export function fallbackManifest(): Manifest {
  return manifestSeed as unknown as Manifest;
}
