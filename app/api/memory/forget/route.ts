import { NextResponse } from "next/server";
import { codexMemoryRoot, MemoryConflictError } from "@/lib/memory";
import { MemoryForgetService, type ForgetPlan, type ForgetSection, type ForgetSelection } from "@/lib/memory-forget";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSelection(value: unknown): value is ForgetSelection {
  if (!isRecord(value)) return false;
  return typeof value.summaryLine === "number" && Number.isInteger(value.summaryLine)
    && typeof value.expectedSummaryHash === "string"
    && (value.confirmedDurableIds === undefined
      || Array.isArray(value.confirmedDurableIds) && value.confirmedDurableIds.every((id) => typeof id === "string"));
}

function isSection(value: unknown): value is ForgetSection {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["summary", "durable", "raw", "rollout", "ad-hoc"].includes(String(value.kind))
    && typeof value.path === "string"
    && typeof value.expectedHash === "string"
    && typeof value.startOffset === "number" && Number.isInteger(value.startOffset)
    && typeof value.endOffset === "number" && Number.isInteger(value.endOffset)
    && typeof value.startLine === "number" && Number.isInteger(value.startLine)
    && typeof value.endLine === "number" && Number.isInteger(value.endLine)
    && typeof value.content === "string";
}

function isPlan(value: unknown): value is ForgetPlan {
  if (!isRecord(value)) return false;
  return typeof value.fingerprint === "string"
    && typeof value.target === "string"
    && Array.isArray(value.targets) && value.targets.every((target) => typeof target === "string")
    && typeof value.actionable === "boolean"
    && (value.reason === null || typeof value.reason === "string")
    && isSelection(value.selection)
    && Array.isArray(value.durableCandidates) && value.durableCandidates.every(isSection)
    && Array.isArray(value.sections) && value.sections.every(isSection);
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (!isRecord(body)) throw new Error("A Forget request object is required.");
    const service = new MemoryForgetService(codexMemoryRoot());

    if (body.action === "preview") {
      if (isRecord(body.selection) && body.selection.kind === "project") {
        if (typeof body.selection.directory !== "string") throw new Error("A project directory is required.");
        return NextResponse.json(service.previewProject({ kind: "project", directory: body.selection.directory }), { headers: { "Cache-Control": "no-store" } });
      }
      if (!isSelection(body.selection)) throw new Error("A valid summary selection is required.");
      return NextResponse.json(service.preview(body.selection), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "apply") {
      if (!isPlan(body.plan)) throw new Error("A valid confirmed Forget plan is required.");
      return NextResponse.json(service.apply(body.plan), { headers: { "Cache-Control": "no-store" } });
    }
    if (body.action === "recheck") {
      if (!isPlan(body.plan)) throw new Error("A valid Forget plan is required.");
      return NextResponse.json(service.recheck(body.plan), { headers: { "Cache-Control": "no-store" } });
    }
    throw new Error("action must be preview, apply, or recheck.");
  } catch (error) {
    const status = error instanceof MemoryConflictError ? 409 : 400;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not process the Forget request." },
      { status },
    );
  }
}
