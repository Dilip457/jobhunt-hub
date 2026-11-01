import type { Job, RoleSlug, ScoreParts } from "./types";
import { experienceBandPriority, experiencePriority } from "./utils";

/**
 * The scraper's score rules, mirrored so the match signal can draw a job
 * whose file predates `score_parts` (publish.py adds them at the next
 * scrape). Token lists and caps are copies of ROLE_TITLE_TOKENS, ROLE_SKILLS,
 * ROLE_TOOLS, MAX_TITLE_HITS and MAX_SKILL_HITS in automation/api_sources.py;
 * change them there first, then here.
 */
const MAX_TITLE_HITS = 2;
const MAX_SKILL_HITS = 6;

const TITLE_TOKENS: Record<RoleSlug, string[]> = {
  genai: ["ai", "ml", "machine learning", "generative", "genai", "llm", "nlp",
    "deep learning", "artificial intelligence", "data scientist", "prompt"],
  data: ["data engineer", "data", "etl", "elt", "big data", "analytics engineer",
    "spark", "pyspark", "data warehouse", "databricks", "snowflake", "sql"],
  uiux: ["ux", "ui", "designer", "design", "interaction", "visual", "figma",
    "user experience", "product design"],
  ba: ["business analyst", "business analysis", "business systems analyst",
    "data analyst", "data analysis", "analyst"],
  sde: ["software engineer", "software developer", "software development engineer",
    "sde", "backend", "back end", "full stack", "fullstack", ".net",
    "dotnet", "asp.net", "api developer", "application developer",
    "platform engineer", "developer", "engineer", "programmer"],
};

const SKILLS: Record<RoleSlug, string[]> = {
  genai: ["llm", "rag", "langchain", "pytorch", "tensorflow", "transformers", "nlp",
    "generative", "prompt", "vector", "embedding", "fine-tun", "hugging face",
    "openai", "diffusion", "mlops", "deep learning"],
  data: ["spark", "pyspark", "airflow", "dbt", "kafka", "snowflake", "databricks",
    "etl", "elt", "warehouse", "sql", "python", "aws", "glue", "redshift",
    "bigquery", "data pipeline", "hadoop", "scala", "azure"],
  uiux: ["figma", "sketch", "adobe xd", "prototyp", "wireframe", "user research",
    "usability", "design system", "interaction design", "ux", "ui",
    "responsive", "accessibility", "html", "css", "framer", "invision"],
  ba: ["requirement gathering", "requirement elicitation", "requirement management",
    "brd", "frd", "business requirement", "functional requirement", "user story",
    "user stories", "acceptance criteria", "gap analysis", "process mapping",
    "process improvement", "stakeholder", "uat", "user acceptance testing",
    "wireframe", "data visualization", "data visualisation", "sql", "agile",
    "scrum", "sprint", "jira", "confluence", "visio", "excel", "power bi",
    "tableau", "balsamiq", "figma", "postman", "api testing", "api"],
  sde: ["c#", ".net", "dotnet", "asp.net", "rest api", "api", "python",
    "react", "javascript", "typescript", "java", "azure", "sql",
    "microservice", "docker", "kubernetes", "ci/cd", "github actions",
    "git", "flask", "entity framework", "mongodb", "redis",
    "unit test", "system design", "data structure", "algorithm"],
};

const TOOLS: Record<RoleSlug, string[]> = {
  genai: ["langchain", "pytorch", "tensorflow", "transformers", "hugging face", "openai"],
  data: ["spark", "pyspark", "airflow", "dbt", "kafka", "snowflake", "databricks",
    "sql", "python", "aws", "glue", "redshift", "bigquery", "hadoop", "scala", "azure"],
  uiux: ["figma", "sketch", "adobe xd", "html", "css", "framer", "invision"],
  ba: ["sql", "jira", "confluence", "visio", "excel", "power bi", "tableau", "balsamiq",
    "figma", "postman"],
  sde: ["c#", ".net", "dotnet", "asp.net", "python", "react", "javascript", "typescript",
    "java", "azure", "sql", "docker", "kubernetes", "github actions", "git", "flask",
    "entity framework", "mongodb", "redis"],
};

function escape(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** api_sources._hit: short tokens need boundaries ("ui" is in "build"). */
function hit(token: string, text: string): boolean {
  if (token.length <= 3) {
    return new RegExp(`(?<![a-z0-9])${escape(token)}(?![a-z0-9])`).test(text);
  }
  return text.includes(token);
}

function count(tokens: string[], text: string): number {
  return tokens.reduce((hits, token) => hits + (hit(token, text) ? 1 : 0), 0);
}

function part(hits: number, allowance: number): number {
  const cap = Math.max(1, Math.min(MAX_SKILL_HITS, allowance));
  return Math.round((1000 * Math.min(hits, cap)) / cap) / 10;
}

/**
 * The parts the scraper would publish for this job, from the fields the file
 * carries. The experience part follows the dashboard's own ranking bands
 * (utils.ts), which agree with the scraper's rule at the ends of the range.
 */
export function estimateParts(job: Job, role: RoleSlug): ScoreParts {
  const title = job.title.toLowerCase();
  const text = `${job.title} ${job.snippet ?? ""}`.toLowerCase();
  const tools = TOOLS[role];
  const practices = SKILLS[role].filter((skill) => !tools.includes(skill));
  const parts: ScoreParts = {
    role: Math.round((1000 * Math.min(count(TITLE_TOKENS[role], title), MAX_TITLE_HITS)) / MAX_TITLE_HITS) / 10,
    skill: part(count(practices, text), practices.length),
    tool: part(count(tools, text), tools.length),
  };
  if (role === "sde") parts.experience = [100, 60, 25, 0][experienceBandPriority(job)];
  if (role === "ba") parts.experience = [100, 75, 50, 0][experiencePriority(job)];
  return parts;
}
