import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { dispatchWorkflow, getRunStatus, isConfigured, REFRESH_COOLDOWN_MINUTES } from "@/lib/github";
import { isRoleSlug, REFRESH_TOKEN_HEADER, type RoleSlug } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function hostOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return null;
  }
}

/**
 * Same-origin check. A browser always sends Origin on a cross-site POST, so a
 * missing Origin means a script (curl), not the dashboard, and is refused.
 * Only this deployment's own hosts are accepted; the old blanket
 * `*.vercel.app` rule let any Vercel-hosted page trigger a scrape.
 */
function originAllowed(request: NextRequest): boolean {
  const host = hostOf(request.headers.get("origin"));
  if (!host) return false;
  if (host === "localhost" || host === "127.0.0.1") return true;

  const allowed = [
    hostOf(request.headers.get("x-forwarded-host") ?? request.headers.get("host")),
    hostOf(process.env.NEXT_PUBLIC_SITE_URL),
    hostOf(process.env.VERCEL_URL),
    hostOf(process.env.VERCEL_BRANCH_URL),
    hostOf(process.env.VERCEL_PROJECT_PRODUCTION_URL),
  ];
  return allowed.includes(host);
}

/**
 * When REFRESH_TOKEN is set on the deployment, a refresh must carry it. Hiding
 * the button was only a UX guard; this is the actual access control.
 */
function tokenAllowed(request: NextRequest): boolean {
  const expected = process.env.REFRESH_TOKEN ?? "";
  if (!expected) return true;
  const given = request.headers.get(REFRESH_TOKEN_HEADER) ?? "";
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return Response.json({ error: "Blocked origin" }, { status: 403 });
  }

  if (!tokenAllowed(request)) {
    return Response.json({ error: "A valid refresh key is required." }, { status: 401 });
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

  const status = await getRunStatus(role === "all" ? null : role);

  if (status.state === "queued" || status.state === "running") {
    return Response.json(
      { error: "A scrape is already running.", runUrl: status.runUrl },
      { status: 409 },
    );
  }

  if (status.canRefresh === false && !status.cooldownMinutesLeft) {
    // Not a cooldown: the status check itself failed (e.g. a bad token).
    return Response.json(
      { error: status.message ?? "Could not check the current run.", status: 502 },
      { status: 502 },
    );
  }

  if (status.canRefresh === false) {
    return Response.json(
      {
        error: `Recently refreshed. Try again in ${status.cooldownMinutesLeft ?? REFRESH_COOLDOWN_MINUTES} minutes.`,
        cooldownMinutesLeft: status.cooldownMinutesLeft,
      },
      { status: 429 },
    );
  }

  const target: RoleSlug | "all" = role === "all" ? "all" : (role as RoleSlug);
  const result = await dispatchWorkflow(target);
  if (!result.ok) {
    return Response.json(
      { error: "Could not start the scrape.", status: result.status, detail: result.detail },
      { status: 502 },
    );
  }

  return Response.json({ ok: true, role, state: "queued" }, { status: 202 });
}
