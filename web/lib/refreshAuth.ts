import { timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

/**
 * How this deployment guards refresh:
 * - "token":    REFRESH_TOKEN is set; a request must carry it.
 * - "open":     no token, local development only (`next dev`), so a fresh
 *               checkout can try refresh without extra setup.
 * - "disabled": no token in a production build. Refresh fails closed; the
 *               origin check alone cannot stop curl, which sets any header.
 */
export type RefreshMode = "token" | "open" | "disabled";

export function refreshMode(env: Env = process.env): RefreshMode {
  if (env.REFRESH_TOKEN) return "token";
  return env.NODE_ENV === "production" ? "disabled" : "open";
}

export type RefreshAccess = "ok" | "invalid" | "disabled";

/** Check the refresh key a request carried against REFRESH_TOKEN. */
export function checkRefreshKey(given: string | null | undefined, env: Env = process.env): RefreshAccess {
  const mode = refreshMode(env);
  if (mode === "open") return "ok";
  if (mode === "disabled") return "disabled";
  const a = Buffer.from(given ?? "");
  const b = Buffer.from(env.REFRESH_TOKEN ?? "");
  return a.length === b.length && timingSafeEqual(a, b) ? "ok" : "invalid";
}
