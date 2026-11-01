import { NextRequest } from "next/server";
import { checkRefreshKey } from "@/lib/refreshAuth";
import { getRoleData } from "@/lib/service";
import { isRoleSlug, REFRESH_TOKEN_HEADER } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const role = request.nextUrl.searchParams.get("role") ?? "";
  if (!isRoleSlug(role)) {
    return Response.json({ error: "Unknown role" }, { status: 400 });
  }

  // `fresh` skips the server's cached GitHub read, so it is only honoured with
  // the refresh key (the admin's reload after a refresh). Without one it is
  // ignored, so anyone adding ?fresh=1 cannot drain the GitHub API quota.
  const freshAsked = request.nextUrl.searchParams.has("fresh");
  const fresh = freshAsked && checkRefreshKey(request.headers.get(REFRESH_TOKEN_HEADER)) === "ok";

  try {
    const data = await getRoleData(role, { fresh });
    return Response.json(data, {
      headers: {
        // Never let the CDN store a `fresh` URL: an unauthenticated request
        // could otherwise park the cached copy where the admin's reload reads.
        "Cache-Control": freshAsked
          ? "private, no-store"
          : "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch {
    return Response.json({ error: "Could not load jobs" }, { status: 502 });
  }
}
