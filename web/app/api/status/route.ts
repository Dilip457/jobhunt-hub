import { NextRequest } from "next/server";
import { getRunStatus } from "@/lib/github";
import { isRoleSlug } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** `since` is the dispatchedAt a refresh returned; anything unparsable is ignored. */
function parseSince(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("role") ?? "";
  const role = isRoleSlug(raw) ? raw : null;
  const since = parseSince(request.nextUrl.searchParams.get("since"));

  try {
    const status = await getRunStatus(role, { since });
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { configured: true, state: "idle", role, message: "Could not reach GitHub." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
