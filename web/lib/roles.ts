import type { RoleMeta, RoleSlug } from "./types";

export const ROLES: RoleMeta[] = [
  {
    slug: "genai",
    label: "GenAI",
    fullLabel: "GenAI / AI Engineering",
    description: "LLM, RAG, agentic AI & machine learning roles",
    accent: "#FF304F",
    accentSoft: "rgba(255, 48, 79, 0.16)",
    blurb: "Generative AI, LLM, RAG and applied ML roles across India.",
  },
  {
    slug: "data",
    label: "Data Engineer",
    fullLabel: "Data Engineering",
    description: "PySpark, Databricks, ETL & cloud data platforms",
    accent: "#287BFF",
    accentSoft: "rgba(40, 123, 255, 0.16)",
    blurb: "Data engineering, pipelines, lakehouse and analytics roles.",
  },
  {
    slug: "uiux",
    label: "UI/UX",
    fullLabel: "UI / UX Design",
    description: "Product, UX, UI & interaction design roles",
    accent: "#FFFFFF",
    accentSoft: "rgba(255, 255, 255, 0.12)",
    blurb: "Product design, UX research and interaction design roles.",
  },
];

export const DEFAULT_ROLE: RoleSlug = "genai";

export function getRole(slug: RoleSlug): RoleMeta {
  return ROLES.find((r) => r.slug === slug) ?? ROLES[0];
}
