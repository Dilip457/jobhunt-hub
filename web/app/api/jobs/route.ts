import { NextRequest } from "next/server";
import { getRoleData } from "@/lib/service";
import { isRoleSlug } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const role = request.nextUrl.searchParams.get("role") ?? "";
  if (!isRoleSlug(role)) {
    return Response.json({ error: "Unknown role" }, { status: 400 });
  }

  const fresh = request.nextUrl.searchParams.get("fresh") === "1";

  try {
    const data = await getRoleData(role, fresh);
    return Response.json(data, {
      headers: {
        "Cache-Control": fresh
          ? "no-store"
          : "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return Response.json({ error: "Could not load jobs" }, { status: 502 });
  }
}
