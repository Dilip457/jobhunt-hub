import { NextRequest } from "next/server";
import { getRunStatus } from "@/lib/github";
import { isRoleSlug } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("role") ?? "";
  const role = isRoleSlug(raw) ? raw : null;

  try {
    const status = await getRunStatus(role);
    return Response.json(status, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json(
      { configured: true, state: "idle", role, message: "Could not reach GitHub." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
