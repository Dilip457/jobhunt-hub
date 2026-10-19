import type { RoleMeta, RoleSlug } from "./types";

export const ROLES: RoleMeta[] = [
  {
    slug: "genai",
    label: "GenAI",
    fullLabel: "GenAI / AI Engineering",
    description: "LLM, RAG, agentic AI & machine learning roles",
    accent: "#8b5cf6",
    accentSoft: "rgba(139, 92, 246, 0.16)",
    blurb: "Generative AI, LLM, RAG and applied ML roles across India.",
  },
  {
    slug: "data",
    label: "Data Engineer",
    fullLabel: "Data Engineering",
    description: "PySpark, Databricks, ETL & cloud data platforms",
    accent: "#22d3ee",
    accentSoft: "rgba(34, 211, 238, 0.16)",
    blurb: "Data engineering, pipelines, lakehouse and analytics roles.",
  },
  {
    slug: "uiux",
    label: "UI/UX",
    fullLabel: "UI / UX Design",
    description: "Product, UX, UI & interaction design roles",
    accent: "#f472b6",
    accentSoft: "rgba(244, 114, 182, 0.16)",
    blurb: "Product design, UX research and interaction design roles.",
  },
];

export const DEFAULT_ROLE: RoleSlug = "genai";

export function getRole(slug: RoleSlug): RoleMeta {
  return ROLES.find((r) => r.slug === slug) ?? ROLES[0];
}
