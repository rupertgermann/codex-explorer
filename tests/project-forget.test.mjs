import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "node:test";
import { forgetRequest } from "./fixtures/forget-api.mjs";
import { projectBytes, seedProjectMemory } from "./fixtures/project-memory.mjs";
import { memoryHash } from "../lib/memory.ts";

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
  assert.match((await apply.json()).error, /exact project directory/);
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

test("Project Apply requires exact confirmation and rejects stale file and row revisions without writes", async () => {
  for (const change of ["file", "row"]) {
    const source = fixture();
    const plan = await preview(source);
    const beforeConfirmation = projectBytes(source.home);
    for (const confirmedDirectory of [undefined, "/work/application", "/work/app/"]) {
      const response = await forgetRequest(source, { action: "apply", plan, confirmedDirectory });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /exact project directory/);
    }
    assert.deepEqual(projectBytes(source.home), beforeConfirmation);
    if (change === "file") {
      writeFileSync(join(source.root, "raw_memories.md"), readFileSync(join(source.root, "raw_memories.md"), "utf8") + "\nConcurrent editor change.\n");
    } else {
      const db = new DatabaseSync(plan.database.path);
      db.exec("UPDATE stage1_outputs SET selected_for_phase2 = 0 WHERE thread_id = 'app'");
      db.close();
    }
    const before = projectBytes(source.home);
    const response = await forgetRequest(source, { action: "apply", plan, confirmedDirectory: "/work/app" });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /changed.*Refresh/);
    assert.deepEqual(projectBytes(source.home), before);
  }
});

test("Project Apply reconciles both stores, preserves shared content and references, and records a verified backup", async () => {
  const source = fixture();
  const referencePath = "extensions/ad_hoc/notes/reference.md";
  writeFileSync(join(source.root, referencePath), "# Retained reference\n\nSee [source](../../../rollout_summaries/app-ui.md).\n");
  const plan = await preview(source);
  assert.equal(plan.actionable, true, plan.reason);
  const before = projectBytes(source.home);
  const untouched = (files) => files.filter(([path]) => /^(sessions|archived_sessions|sqlite)\//.test(path));
  const response = await forgetRequest(source, { action: "apply", plan, confirmedDirectory: plan.directory });
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const result = await response.json();
  assert.equal(result.verification, "suppressed");
  assert.equal(result.removedDatabaseRows, 2);
  assert.equal(result.rolledBack, false);
  assert.deepEqual(untouched(projectBytes(source.home)), untouched(before));
  for (const path of ["memory_summary.md", "MEMORY.md", "raw_memories.md"]) assert.ok(existsSync(join(source.root, path)));
  assert.equal(existsSync(join(source.root, "rollout_summaries/app.md")), false);
  assert.equal(readFileSync(join(source.root, "rollout_summaries/app-ui.md"), "utf8"), "");
  assert.match(readFileSync(join(source.root, referencePath), "utf8"), /app-ui\.md/);
  for (const path of ["memory_summary.md", "MEMORY.md"]) {
    const content = readFileSync(join(source.root, path), "utf8");
    assert.doesNotMatch(content, /Keep project routing|Reuse native controls/);
    assert.match(content, /Preserve accessible keyboard navigation/);
    assert.match(content, /Separate billing credentials/);
  }
  assert.doesNotMatch(readFileSync(join(source.root, "raw_memories.md"), "utf8"), /Thread `app(?:-ui)?`/);
  const note = readFileSync(join(source.root, "extensions/ad_hoc/notes/routing.md"), "utf8");
  assert.doesNotMatch(note, /Keep project routing/);
  assert.match(note, /Separate billing credentials/);
  const db = new DatabaseSync(plan.database.path, { readOnly: true });
  try {
    assert.deepEqual(db.prepare("SELECT thread_id FROM stage1_outputs ORDER BY thread_id").all().map(({ thread_id }) => thread_id), ["neighbor"]);
    assert.deepEqual(db.prepare("SELECT * FROM jobs").all().map((row) => ({ ...row })), [{ kind: "memory", job_key: "app", status: "done" }]);
  } finally { db.close(); }
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.status, "committed");
  assert.equal(manifest.directory, "/work/app");
  assert.deepEqual(manifest.database, plan.database);
  assert.deepEqual(manifest.paths, result.changedPaths);
  for (const { path, expectedHash } of manifest.files) {
    const backup = readFileSync(join(result.manifestPath, "..", "files", path), "utf8");
    assert.equal(memoryHash(backup), expectedHash);
    assert.equal(memoryHash(backup), plan.sourceRevisions.find((revision) => revision.path === path).expectedHash);
  }
  const tombstones = projectBytes(source.root).filter(([, content]) => content.includes("codex-explorer-forget:"));
  assert.equal(tombstones.length, 1);
  assert.match(tombstones[0][1].toString(), /action: delete/);
  assert.match(tombstones[0][1].toString(), /Memories assigned to \/work\/app/);
  const after = projectBytes(source.home);
  assert.equal((await forgetRequest(source, { action: "apply", plan, confirmedDirectory: plan.directory })).status, 409);
  assert.deepEqual(projectBytes(source.home), after);
});

test("an intermediate database failure restores changed files and deleted rows from the backed-up revision", async () => {
  const source = fixture();
  const db = new DatabaseSync(join(source.home, "memories_1.sqlite"));
  db.exec("CREATE TRIGGER fail_second_delete BEFORE DELETE ON stage1_outputs WHEN OLD.thread_id = 'app-ui' AND NOT EXISTS (SELECT 1 FROM stage1_outputs WHERE thread_id = 'app') BEGIN SELECT RAISE(FAIL, 'forced intermediate failure'); END");
  const rows = db.prepare("SELECT * FROM stage1_outputs ORDER BY thread_id").all();
  const jobs = db.prepare("SELECT * FROM jobs").all();
  db.close();
  const plan = await preview(source);
  const before = projectBytes(source.root).map(([path, content]) => [path, content]);
  const response = await forgetRequest(source, { action: "apply", plan, confirmedDirectory: plan.directory });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /rolled back: forced intermediate failure/);
  assert.deepEqual(projectBytes(source.root).map(([path, content]) => [path, content]), before);
  const restored = new DatabaseSync(plan.database.path, { readOnly: true });
  try {
    assert.deepEqual(restored.prepare("SELECT * FROM stage1_outputs ORDER BY thread_id").all(), rows);
    assert.deepEqual(restored.prepare("SELECT * FROM jobs").all(), jobs);
  } finally { restored.close(); }
  const backups = join(source.home, "memory-forget-backups");
  const manifest = JSON.parse(readFileSync(join(backups, readdirSync(backups)[0], "manifest.json"), "utf8"));
  assert.equal(manifest.status, "rolled-back");
  assert.ok(manifest.paths.length > 0);
  assert.deepEqual(manifest.database.rows, plan.database.rows);
  assert.deepEqual(manifest.rollbackFailures, []);
});

test("Project Apply includes committed WAL payloads and supports database-only Memory", async () => {
  for (const databaseOnly of [false, true]) {
    const source = fixture();
    if (databaseOnly) {
      for (const entry of readdirSync(source.root)) rmSync(join(source.root, entry), { recursive: true });
    }
    const live = new DatabaseSync(join(source.home, "memories_1.sqlite"));
    try {
      live.exec("PRAGMA journal_mode=WAL; UPDATE stage1_outputs SET raw_memory='Latest committed payload' WHERE thread_id='app'");
      const plan = await preview(source);
      assert.equal(plan.actionable, true, plan.reason);
      assert.equal(plan.database.rows[0].raw_memory, "Latest committed payload");
      if (databaseOnly) assert.equal(plan.sections.length, 0);
      const response = await forgetRequest(source, { action: "apply", plan, confirmedDirectory: plan.directory });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      const result = await response.json();
      assert.equal(result.removedDatabaseRows, 2);
      assert.equal(result.verification, "suppressed");
      assert.deepEqual(live.prepare("SELECT thread_id FROM stage1_outputs").all().map(({ thread_id }) => thread_id), ["neighbor"]);
      const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
      assert.equal(manifest.database.rows[0].raw_memory, "Latest committed payload");
      if (databaseOnly) assert.equal(existsSync(join(source.root, "MEMORY.md")), false);
    } finally { live.close(); }
  }
});
