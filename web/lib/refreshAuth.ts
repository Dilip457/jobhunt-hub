import { timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;
type Clock = () => number;

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

// ── Wrong-password lockout ───────────────────────────────────────────────────

/** Wrong passwords one client may send within the window before it is locked. */
export const MAX_FAILURES_PER_CLIENT = 5;
/** More wrong passwords than this from all clients together locks everyone. */
export const MAX_FAILURES_GLOBAL = 30;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;
/** Answering a wrong password this much later slows a guessing script further. */
export const WRONG_KEY_DELAY_MS = 750;
/** Used when a request carries no client IP: those requests share one bucket. */
export const UNKNOWN_CLIENT = "unknown";

export interface AttemptLimiterOptions {
  maxFailures?: number;
  globalMaxFailures?: number;
  windowMs?: number;
  lockMs?: number;
  /** Most clients tracked at once; the oldest is dropped beyond this. */
  maxClients?: number;
  now?: Clock;
}

export interface AttemptLimiter {
  /** Milliseconds `client` must still wait (its own lock or the global one); 0 if free. */
  lockedFor(client: string): number;
  recordFailure(client: string): void;
  /** A correct password clears that client's failures. */
  recordSuccess(client: string): void;
  /** Clients currently tracked (for tests). */
  size(): number;
}

interface ClientEntry {
  /** Times of recent failures, oldest first; never longer than maxFailures. */
  failures: number[];
  lockedUntil: number;
}

/**
 * Counts wrong passwords in this instance's memory, so like the caches in
 * ttlCache.ts it is best effort: a cold start or a second instance starts
 * empty. It still turns unlimited guessing into a handful per quarter hour.
 *
 * The global cap stops a guesser who rotates IPs. While it is in force the
 * owner is locked out too; for a button that only starts a scrape that is an
 * acceptable price, and it lifts on its own after `lockMs`.
 */
export function createAttemptLimiter(options: AttemptLimiterOptions = {}): AttemptLimiter {
  const {
    maxFailures = MAX_FAILURES_PER_CLIENT,
    globalMaxFailures = MAX_FAILURES_GLOBAL,
    windowMs = FAILURE_WINDOW_MS,
    lockMs = LOCKOUT_MS,
    maxClients = 1000,
    now = Date.now,
  } = options;
  const clients = new Map<string, ClientEntry>();
  let globalFailures: number[] = [];
  let globalLockedUntil = 0;

  const recent = (times: number[], at: number) => times.filter((time) => time > at - windowMs);

  function prune(at: number) {
    for (const [client, entry] of clients) {
      entry.failures = recent(entry.failures, at);
      if (entry.failures.length === 0 && entry.lockedUntil <= at) clients.delete(client);
    }
    // Map keeps insertion order and recordFailure re-inserts on every update,
    // so the first entries are the ones least recently seen.
    for (const client of clients.keys()) {
      if (clients.size <= maxClients) break;
      clients.delete(client);
    }
  }

  return {
    lockedFor(client) {
      const at = now();
      const own = clients.get(client)?.lockedUntil ?? 0;
      return Math.max(0, own - at, globalLockedUntil - at);
    },
    recordFailure(client) {
      const at = now();
      const entry = clients.get(client) ?? { failures: [], lockedUntil: 0 };
      entry.failures = [...recent(entry.failures, at), at];
      if (entry.failures.length >= maxFailures) {
        entry.lockedUntil = at + lockMs;
        entry.failures = [];
      }
      clients.delete(client);
      clients.set(client, entry);

      globalFailures = [...recent(globalFailures, at), at];
      if (globalFailures.length > globalMaxFailures) {
        globalLockedUntil = at + lockMs;
        globalFailures = [];
      }
      prune(at);
    },
    recordSuccess(client) {
      clients.delete(client);
    },
    size() {
      return clients.size;
    },
  };
}

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * The client IP the lockout is keyed by. Vercel overwrites x-forwarded-for,
 * x-real-ip and x-vercel-forwarded-for with the connecting client's address
 * (it does not forward external values, to prevent spoofing), so on Vercel a
 * client cannot pick its own bucket. x-vercel-forwarded-for comes first
 * because a proxy placed in front of Vercel could rewrite x-forwarded-for.
 * Off Vercel these headers are only as trustworthy as the proxy in front;
 * if a client can set them, the global cap still bounds guessing.
 */
export function clientIp(headers: HeaderSource): string {
  for (const name of ["x-vercel-forwarded-for", "x-real-ip", "x-forwarded-for"]) {
    const first = headers.get(name)?.split(",")[0]?.trim();
    // Cap the length so a junk header cannot bloat the tracking map.
    if (first) return first.slice(0, 64);
  }
  return UNKNOWN_CLIENT;
}

export type GuardedAccess =
  | { access: "ok" | "invalid" | "disabled" }
  | { access: "locked"; minutesLeft: number };

/**
 * This instance's limiter, used by /api/refresh and /api/jobs?fresh. Next can
 * bundle each route with its own copy of this module, so it is kept on
 * globalThis to make both routes count into one limiter within a process.
 */
const limiterHolder = globalThis as typeof globalThis & { __jobhuntRefreshLimiter?: AttemptLimiter };
export const refreshLimiter = (limiterHolder.__jobhuntRefreshLimiter ??= createAttemptLimiter());

/**
 * checkRefreshKey behind the wrong-password lockout. The lock is checked
 * before the key, so a locked client is refused even with the right password;
 * otherwise a guesser would learn when it hit the right one. "open" (local
 * development) and "disabled" never touch the limiter. An absent key is not
 * a guess, so it is refused without counting.
 */
export function checkRefreshAttempt(
  given: string | null | undefined,
  client: string,
  limiter: AttemptLimiter = refreshLimiter,
  env: Env = process.env,
): GuardedAccess {
  const mode = refreshMode(env);
  if (mode !== "token") return { access: checkRefreshKey(given, env) };

  const wait = limiter.lockedFor(client);
  if (wait > 0) return { access: "locked", minutesLeft: Math.ceil(wait / 60_000) };

  const access = checkRefreshKey(given, env);
  if (access === "ok") limiter.recordSuccess(client);
  else if (given) limiter.recordFailure(client);
  return { access };
}

export function wrongKeyDelay(ms: number = WRONG_KEY_DELAY_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
