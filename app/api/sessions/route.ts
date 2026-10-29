import { type NextRequest, NextResponse } from "next/server";
import { SessionRepository } from "@/lib/sessions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(await new SessionRepository().catalog({ refresh: request.nextUrl.searchParams.get("refresh") === "1" }), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not inspect Codex sessions." },
      { status: 500 },
    );
  }
}
