import { type NextRequest, NextResponse } from "next/server";
import { SessionPathError, SessionRepository } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const path = request.nextUrl.searchParams.get("path") ?? "";
    const rawOffset = Number(request.nextUrl.searchParams.get("offset") ?? 0);
    if (!Number.isFinite(rawOffset) || rawOffset < 0) throw new Error("offset must be a non-negative number.");
    const page = await new SessionRepository().rawPage(path, { offset: rawOffset, signal: request.signal });
    return NextResponse.json(page, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not read raw session content." },
      { status: error instanceof SessionPathError ? 404 : 400 },
    );
  }
}
