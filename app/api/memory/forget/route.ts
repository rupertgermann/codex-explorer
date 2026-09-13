import { NextResponse } from "next/server";
import { codexMemoryRoot, MemoryConflictError } from "@/lib/memory";
import { MemoryForgetService, type ForgetPlan, type ForgetSection, type ForgetSelection, type ProjectForgetPlan } from "@/lib/memory-forget";

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

function isProjectPlan(value: Record<string, unknown>): value is ProjectForgetPlan {
  const strings = (items: unknown) => Array.isArray(items) && items.every((item) => typeof item === "string");
  return value.kind === "project"
    && typeof value.directory === "string" && typeof value.fingerprint === "string"
    && typeof value.actionable === "boolean"
    && (value.reason === null || typeof value.reason === "string")
    && isRecord(value.selection) && value.selection.kind === "project" && typeof value.selection.directory === "string"
    && strings(value.knownProjectScopes) && strings(value.blockers) && strings(value.matchedSessionIds)
    && typeof value.sessionRevision === "string"
    && typeof value.untouchedSessionCount === "number" && Number.isInteger(value.untouchedSessionCount)
    && Array.isArray(value.sections) && value.sections.every(isSection)
    && Array.isArray(value.retainedShared) && value.retainedShared.every(isSection)
    && Array.isArray(value.sourceRevisions) && value.sourceRevisions.every((revision) =>
      isRecord(revision) && typeof revision.path === "string" && typeof revision.expectedHash === "string")
    && isRecord(value.database)
    && (value.database.path === null || typeof value.database.path === "string")
    && (value.database.expectedHash === null || typeof value.database.expectedHash === "string")
    && Array.isArray(value.database.rows) && value.database.rows.every((row) =>
      isRecord(row) && typeof row.thread_id === "string"
      && Object.values(row).every((cell) => cell === null || typeof cell === "string" || typeof cell === "number" && Number.isFinite(cell)));
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
      if (isRecord(body.plan) && body.plan.kind === "project") {
        if (!isProjectPlan(body.plan)) throw new Error("A valid Project Forget plan is required.");
        if (typeof body.confirmedDirectory !== "string") throw new Error("Confirm the exact project directory before applying its Forget plan.");
        return NextResponse.json(service.apply(body.plan, body.confirmedDirectory), { headers: { "Cache-Control": "no-store" } });
      }
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
