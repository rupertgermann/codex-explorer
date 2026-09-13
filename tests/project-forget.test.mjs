import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { forgetRequest } from "./fixtures/forget-api.mjs";
import { projectBytes, seedProjectMemory } from "./fixtures/project-memory.mjs";

const roots = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "codex-project-preview-"));
  roots.push(home);
  return seedProjectMemory(home);
}
async function preview(fixture, directory = "/work/app") {
  const response = await forgetRequest(fixture, { action: "preview", selection: { kind: "project", directory } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("Forget API previews and refreshes exact project sections and database rows without any file writes", async () => {
  const source = fixture();
  const before = projectBytes(source.home);
  const plan = await preview(source, "/work/app/packages/../");
  assert.equal(plan.directory, "/work/app");
  assert.equal(plan.actionable, true, plan.reason);
  assert.deepEqual(plan.knownProjectScopes, ["/work/app", "/work/app/packages/ui", "/work/application"]);
  assert.deepEqual(plan.matchedSessionIds, ["app", "app-ui"]);
  assert.equal(plan.untouchedSessionCount, 2);
  assert.deepEqual(plan.sections.map(({ kind }) => kind).sort(), ["ad-hoc", "durable", "durable", "raw", "raw", "rollout", "rollout", "summary", "summary"]);
  assert.deepEqual(plan.database.rows, [
    { thread_id: "app", raw_memory: "Raw payload app", rollout_summary: "Rollout payload app", rollout_slug: "app", generated_at: 123, selected_for_phase2: 1 },
    { thread_id: "app-ui", raw_memory: "Raw payload app-ui", rollout_summary: "Rollout payload app-ui", rollout_slug: "app-ui", generated_at: 123, selected_for_phase2: 1 },
  ]);
  assert.equal(plan.database.path, join(source.home, "memories_1.sqlite"));
  assert.match(plan.database.expectedHash, /^[a-f0-9]{64}$/);
  assert.equal(plan.sections.some(({ content }) => content.includes("Separate billing credentials")), false);
  assert.deepEqual(plan.retainedShared.map(({ content }) => content.trim()), ["- Preserve accessible keyboard navigation."]);
  for (const section of plan.sections) assert.equal(readFileSync(join(source.root, section.path), "utf8").slice(section.startOffset, section.endOffset), section.content);
  assert.deepEqual(await preview(source), plan);
  const apply = await forgetRequest(source, { action: "apply", plan });
  assert.equal(apply.status, 400);
  assert.match((await apply.json()).error, /valid confirmed Forget plan/);
  assert.deepEqual(projectBytes(source.home), before);
});

test("invalid, absent, similarly named and corpus-wide project targets are explicit and read-only", async () => {
  const source = fixture();
  const before = projectBytes(source.home);
  for (const directory of ["", "work/app", "/work/app\n", "/work/app\0"]) {
    const plan = await preview(source, directory);
    assert.equal(plan.actionable, false);
    assert.match(plan.reason, /absolute project directory/);
  }
  for (const directory of ["/work/no-match", "/untrusted/free-text", "/untrusted/event"]) {
    const plan = await preview(source, directory);
    assert.equal(plan.actionable, false);
    assert.match(plan.reason, /No project Memories/);
  }
  const all = await preview(source, "/work");
  assert.equal(all.actionable, false);
  assert.match(all.reason, /every project-scoped Task Group/);
  const neighbor = await preview(source, "/work/application");
  assert.equal(neighbor.actionable, true, neighbor.reason);
  assert.deepEqual(neighbor.database.rows.map(({ thread_id }) => thread_id), ["neighbor"]);
  assert.equal(neighbor.sections.some(({ content }) => content.includes("routing deterministic")), false);
  assert.deepEqual(projectBytes(source.home), before);
});

test("missing or conflicting relevant provenance blocks the API preview", async () => {
  const source = fixture();
  const path = join(source.root, "MEMORY.md");
  const original = readFileSync(path, "utf8");
  writeFileSync(path, original.replace("cwd=/work/app;", "cwd=relative/app;"));
  let plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /no valid applies_to/);
  writeFileSync(path, original);
  writeFileSync(join(source.home, "archived_sessions", "conflict.jsonl"), JSON.stringify({ type: "session_meta", payload: { id: "app", cwd: "/elsewhere" } }) + "\n");
  plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /conflicting|unambiguous session/);
  rmSync(join(source.home, "archived_sessions", "conflict.jsonl"));
  rmSync(join(source.root, "rollout_summaries", "app.md"));
  plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /referenced source rollout_summaries\/app.md is missing/);
});

test("unknown database thread provenance and multiple active stores block instead of guessing", async () => {
  const source = fixture();
  const db = new DatabaseSync(join(source.home, "memories_1.sqlite"));
  db.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?, ?)").run("unknown", "payload", "summary", null, 123, 0);
  db.close();
  const before = projectBytes(source.home);
  const plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /stage1_outputs thread unknown/);
  assert.deepEqual(projectBytes(source.home), before);
  copyFileSync(join(source.home, "memories_1.sqlite"), join(source.home, "memories_2.sqlite"));
  const ambiguous = await preview(source);
  assert.equal(ambiguous.actionable, false);
  assert.match(ambiguous.reason, /multiple memories databases/);
});

test("related Summary text and raw Memories without resolved project provenance are non-actionable", async () => {
  const source = fixture();
  const summaryPath = join(source.root, "memory_summary.md");
  const summary = readFileSync(summaryPath, "utf8");
  writeFileSync(summaryPath, summary.replace("Keep project routing deterministic.", "Keep project routing deterministic across nested URL paths."));
  let plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /only has a related text match/);
  writeFileSync(summaryPath, summary);
  const rawPath = join(source.root, "raw_memories.md");
  writeFileSync(rawPath, readFileSync(rawPath, "utf8") + "\n## Thread `unknown`\n\n- Keep project routing deterministic.\n");
  const before = projectBytes(source.home);
  plan = await preview(source);
  assert.equal(plan.actionable, false);
  assert.match(plan.reason, /raw thread unknown/);
  assert.deepEqual(projectBytes(source.home), before);
});

test("preview leaves a live WAL database, its sidecars and scheduler jobs unchanged", async () => {
  const source = fixture();
  const db = new DatabaseSync(join(source.home, "memories_1.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL; UPDATE stage1_outputs SET raw_memory='Current WAL payload' WHERE thread_id='app'");
    const before = projectBytes(source.home);
    const plan = await preview(source);
    assert.equal(plan.actionable, true, plan.reason);
    assert.equal(plan.database.rows[0].raw_memory, "Current WAL payload");
    assert.deepEqual(projectBytes(source.home), before);
  } finally { db.close(); }
});
