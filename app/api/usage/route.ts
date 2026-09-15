import { type NextRequest, NextResponse } from "next/server";
import { generateUsageData, readCachedUsageData } from "@/lib/usage-repository";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json(readCachedUsageData(), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load the saved usage report." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}

export async function POST(request: NextRequest) {
  const since = Date.parse(request.nextUrl.searchParams.get("since") ?? "") / 1000;
  const until = Date.parse(request.nextUrl.searchParams.get("until") ?? "") / 1000;
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) return NextResponse.json({ error: "Choose a valid start and a later end." }, { status: 400 });
  try {
    return NextResponse.json(await generateUsageData(since, until, { signal: request.signal }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not read usage telemetry." }, { status: 500 });
  }
}
