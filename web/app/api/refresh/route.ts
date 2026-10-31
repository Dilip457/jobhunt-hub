import { NextRequest } from "next/server";
import { dispatchWorkflow, getRunStatus, isConfigured, REFRESH_COOLDOWN_MINUTES } from "@/lib/github";
import { isRoleSlug, type RoleSlug } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function originAllowed(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;

  try {
    const host = new URL(origin).hostname;
    if (host === "localhost" || host === "127.0.0.1") return true;
    if (host.endsWith(".vercel.app")) return true;

    const site = process.env.NEXT_PUBLIC_SITE_URL;
    if (site && new URL(site).hostname === host) return true;

    const vercelHost = process.env.VERCEL_URL;
    if (vercelHost && vercelHost === host) return true;

    return false;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  if (!originAllowed(request)) {
    return Response.json({ error: "Blocked origin" }, { status: 403 });
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
