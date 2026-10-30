import type { RoleMeta, RoleSlug } from "./types";

export const ROLES: RoleMeta[] = [
  {
    slug: "genai",
    label: "GenAI",
    shortLabel: "GenAI",
    fullLabel: "GenAI / AI Engineering",
    description: "LLM, RAG, agentic AI & machine learning roles",
    accent: "#FF304F",
    accentSoft: "rgba(255, 48, 79, 0.16)",
    blurb: "Generative AI, LLM, RAG and applied ML roles across India.",
  },
  {
    slug: "data",
    label: "Data Engineer",
    shortLabel: "Data",
    fullLabel: "Data Engineering",
    description: "PySpark, Databricks, ETL & cloud data platforms",
    accent: "#287BFF",
    accentSoft: "rgba(40, 123, 255, 0.16)",
    blurb: "Data engineering, pipelines, lakehouse and analytics roles.",
  },
  {
    slug: "uiux",
    label: "UI/UX",
    shortLabel: "UI/UX",
    fullLabel: "UI / UX Design",
    description: "Product, UX, UI & interaction design roles",
    accent: "#FFFFFF",
    accentSoft: "rgba(255, 255, 255, 0.12)",
    blurb: "Product design, UX research and interaction design roles.",
  },
  {
    slug: "ba",
    label: "Business Analyst",
    shortLabel: "BA",
    fullLabel: "Business Analyst",
    description: "Requirements, BRD/FRD, SQL, UAT & Agile delivery",
    accent: "#8B5CF6",
    accentSoft: "rgba(139, 92, 246, 0.16)",
    blurb:
      "Business analysis, requirements, UAT and Agile delivery roles. Fresher, entry-level and 1–3 year roles are ranked first; senior roles stay available below.",
  },
  {
    slug: "sde",
    label: "SDE",
    shortLabel: "SDE",
    fullLabel: "Software Development Engineer",
    description: "Backend, full-stack, API & cloud engineering",
    accent: "#22C55E",
    accentSoft: "rgba(34, 197, 94, 0.16)",
    blurb:
      "Software engineering roles — backend, full-stack, API and cloud — ranked by match to a .NET, Python, React and Azure profile.",
  },
];

export const DEFAULT_ROLE: RoleSlug = "genai";

export function getRole(slug: RoleSlug): RoleMeta {
  return ROLES.find((r) => r.slug === slug) ?? ROLES[0];
}
