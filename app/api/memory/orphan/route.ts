import { NextResponse } from "next/server";
import { codexMemoryRoot, MemoryConflictError } from "@/lib/memory";
import { MemoryOrphanService, type OrphanConfirmation, type OrphanPlan } from "@/lib/memory-orphan";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlan(value: unknown): value is OrphanPlan {
  if (!isRecord(value)) return false;
  return typeof value.path === "string"
    && typeof value.expectedHash === "string"
    && typeof value.eligible === "boolean"
    && (value.reason === null || typeof value.reason === "string")
    && Array.isArray(value.incomingReferences)
    && Array.isArray(value.sessionLinks)
    && Array.isArray(value.positiveMemories);
}

function isConfirmation(value: unknown): value is OrphanConfirmation {
  return isRecord(value) && typeof value.path === "string" && typeof value.expectedHash === "string";
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("An orphan cleanup request object is required.");
    const service = new MemoryOrphanService(codexMemoryRoot());
    if (body.action === "inspect") {
      if (typeof body.path !== "string") throw new Error("A candidate Memory Markdown path is required.");
      return NextResponse.json(await service.inspect(body.path), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "apply") {
      if (!isPlan(body.plan) || !isConfirmation(body.confirmation)) throw new Error("A valid confirmed orphan deletion plan is required.");
      return NextResponse.json(await service.apply(body.plan, body.confirmation), { headers: { "Cache-Control": "no-store" } });
    }
    throw new Error("action must be inspect or apply.");
  } catch (error) {
    const status = error instanceof MemoryConflictError ? 409 : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process the orphan cleanup request." },
      { status },
    );
  }
}
