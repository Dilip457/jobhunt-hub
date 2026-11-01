import { NextRequest } from "next/server";
import { dispatchWorkflow, getRunStatus, isConfigured, REFRESH_COOLDOWN_MINUTES } from "@/lib/github";
import { checkRefreshAttempt, clientIp, wrongKeyDelay } from "@/lib/refreshAuth";
import { TOO_MANY_ATTEMPTS_CODE, tooManyAttemptsMessage } from "@/lib/refreshPrompt";
import { createKeyedLock } from "@/lib/ttlCache";
import {
  isRoleSlug,
  REFRESH_DISABLED_MESSAGE,
  REFRESH_TOKEN_HEADER,
  type RefreshAccepted,
  type RoleSlug,
  type StatusResponse,
} from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GitHub's dispatch API returns before the new run is listed, so for a short
 * while a second POST would see no active run and dispatch again. Hold a
 * per-role lock across that window. It lives in this instance's memory, so it
 * is best effort; the run-status check still covers the slower case.
 */
const DISPATCH_LOCK_MS = 60_000;
const dispatchLock = createKeyedLock(DISPATCH_LOCK_MS);

function hostOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Same-origin (CSRF) check. A browser always sends Origin on a cross-site
 * POST and a page cannot forge it, so a page on another site cannot use the
 * owner's remembered key. Only this deployment's own hosts are accepted; the
 * old blanket `*.vercel.app` rule let any Vercel-hosted page trigger a scrape.
 * A script can set Origin and Host to anything, so this is not access control:
 * the refresh key is (see checkRefreshKey).
 */
function originAllowed(request: NextRequest): boolean {
  const host = hostOf(request.headers.get("origin"));
  if (!host) return false;
  if (process.env.NODE_ENV !== "production" && (host === "localhost" || host === "127.0.0.1")) {
    return true;
  }

  const allowed = [
    hostOf(request.headers.get("x-forwarded-host") ?? request.headers.get("host")),
    hostOf(process.env.NEXT_PUBLIC_SITE_URL),
    hostOf(process.env.VERCEL_URL),
    hostOf(process.env.VERCEL_BRANCH_URL),
    hostOf(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  ];
  return allowed.includes(host);
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return Response.json({ error: "Blocked origin" }, { status: 403 });
  }

  // The refresh key (the owner's password) is the access control; hiding the
  // control is only a UX guard. A production build without REFRESH_TOKEN
  // refuses every refresh. Wrong passwords are rate limited, so a short,
  // memorable one cannot be guessed by brute force (see refreshAuth.ts).
  const given = request.headers.get(REFRESH_TOKEN_HEADER);
  const result = checkRefreshAttempt(given, clientIp(request.headers));
  if (result.access === "disabled") {
    return Response.json({ error: REFRESH_DISABLED_MESSAGE, code: "refresh_disabled" }, { status: 503 });
  }
  if (result.access === "locked") {
    return Response.json(
      {
        error: tooManyAttemptsMessage(result.minutesLeft),
        code: TOO_MANY_ATTEMPTS_CODE,
        minutesLeft: result.minutesLeft,
      },
      { status: 429, headers: { "Retry-After": String(result.minutesLeft * 60) } },
    );
  }
  if (result.access === "invalid") {
    await wrongKeyDelay();
    return Response.json({ error: given ? "Wrong password." : "A password is required." }, { status: 401 });
  }

  let role: string;
  try {
    const body = (await request.json()) as { role?: string };
    role = body.role ?? "";
  } catch {
    return Response.json({ error: "Invalid body" }, { status: 400 });
  }

  if (role !== "all" && !isRoleSlug(role)) {
    return Response.json({ error: "Unknown role" }, { status: 400 });
  }

  if (!isConfigured()) {
    return Response.json(
      { error: "Refresh is not configured on this deployment." },
      { status: 503 },
    );
  }

  const target: RoleSlug | "all" = role === "all" ? "all" : (role as RoleSlug);
  if (!dispatchLock.tryAcquire(target)) {
    return Response.json({ error: "A scrape was just started." }, { status: 409 });
  }

  // Release the lock on every path that did not dispatch, so a retry is not
  // blocked; after a dispatch it expires on its own once GitHub lists the run.
  const refuse = (body: Record<string, unknown>, status: number) => {
    dispatchLock.release(target);
    return Response.json(body, { status });
  };

  let status: StatusResponse;
  try {
    status = await getRunStatus(role === "all" ? null : (role as RoleSlug), { fresh: true });
  } catch {
    return refuse({ error: "Could not reach GitHub to check the current run." }, 502);
  }

  if (status.state === "queued" || status.state === "running") {
    return refuse({ error: "A scrape is already running.", runUrl: status.runUrl }, 409);
  }

  if (status.canRefresh === false && !status.cooldownMinutesLeft) {
    // Not a cooldown: the status check itself failed (e.g. a bad token).
    return refuse({ error: status.message ?? "Could not check the current run.", status: 502 }, 502);
  }

  if (status.canRefresh === false) {
    return refuse(
      {
        error: `Recently refreshed. Try again in ${status.cooldownMinutesLeft ?? REFRESH_COOLDOWN_MINUTES} minutes.`,
        cooldownMinutesLeft: status.cooldownMinutesLeft,
      },
      429,
    );
  }

  // Taken before the call: GitHub creates the run after this moment, and
  // /api/status?since= uses it to tell the new run from the previous one.
  const dispatchedAt = new Date().toISOString();
  const dispatch = await dispatchWorkflow(target);
  if (!dispatch.ok) {
    return refuse({ error: "Could not start the scrape.", status: dispatch.status, detail: dispatch.detail }, 502);
  }

  const body: RefreshAccepted = { ok: true, role: target, state: "queued", dispatchedAt };
  return Response.json(body, { status: 202 });
}
