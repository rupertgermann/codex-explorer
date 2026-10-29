import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { MemoryForgetService } from "../lib/memory-forget.ts";
import { MemoryRepository } from "../lib/memory.ts";

const roots = [];

function fixture({ ambiguous = false, adHoc = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), "codex-forget-test-"));
  roots.push(base);
  const root = join(base, "memories");
  mkdirSync(join(root, "rollout_summaries"), { recursive: true });
  mkdirSync(join(root, "sessions"), { recursive: true });
  if (adHoc) mkdirSync(join(root, "extensions", "ad_hoc", "notes"), { recursive: true });
  writeFileSync(join(root, "memory_summary.md"), "# Summary\n\n- Keep changes simple and never add speculative features. [ad-hoc note]\n- Preserve unrelated facts.\n");
  writeFileSync(join(root, "MEMORY.md"), [
    "# Memory\n",
    "## Task group\n",
    "rollout_summary_files:\n- rollout_summaries/one.md (thread_id: thread-one)\n",
    "- Keep changes simple and never add speculative features. [Task 1] [ad-hoc note]\n",
    ...(ambiguous ? ["- Keep changes simple and never add speculative features. [Task 2] [ad-hoc note]\n"] : []),
    "- Preserve unrelated facts. [Task 1]\n",
  ].join("\n"));
  writeFileSync(join(root, "raw_memories.md"), "# Raw\n\n## Task group\n\n### Task 1\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
  writeFileSync(join(root, "rollout_summaries", "one.md"), "# Rollout\n\n## Task 1\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
  if (adHoc) writeFileSync(join(root, "extensions", "ad_hoc", "notes", "simplicity.md"), "# Simplicity\n\n- Keep changes simple and never add speculative features.\n");
  writeFileSync(join(root, "sessions", "thread-one.jsonl"), '{"memory":"Keep changes simple"}\n');
  return { base, root };
}

function bytes(root) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? visit(path) : [[path.slice(root.length + 1), readFileSync(path)]];
  });
  return visit(root);
}

function selection(root) {
  return { summaryLine: 3, expectedSummaryHash: new MemoryRepository(root).read("memory_summary.md").hash };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("preview finds exact sections and never writes", async () => {
  const { base, root } = fixture();
  const before = bytes(root);
  const preview = new MemoryForgetService(root, join(base, "backups")).preview(selection(root));

  assert.equal(preview.actionable, true);
  assert.deepEqual(preview.sections.map(({ kind }) => kind), ["summary", "durable", "raw", "rollout", "ad-hoc"]);
  assert.ok(preview.sections.every((section) => section.content.includes("Keep changes simple")));
  assert.deepEqual(bytes(root), before);
});

test("preview blocks ambiguous durable matches until exact sections are confirmed", async () => {
  const { base, root } = fixture({ ambiguous: true });
  const service = new MemoryForgetService(root, join(base, "backups"));
  const first = service.preview(selection(root));

  assert.equal(first.actionable, false);
  assert.equal(first.durableCandidates.length, 2);

  const confirmed = service.preview({ ...selection(root), confirmedDurableIds: [first.durableCandidates[0].id] });
  assert.equal(confirmed.actionable, true);
  assert.equal(confirmed.sections.filter(({ kind }) => kind === "durable").length, 1);
});

test("preview offers a normalized-term match but requires explicit confirmation", async () => {
  const { base, root } = fixture();
  writeFileSync(join(root, "MEMORY.md"), "# Memory\n\n- Never add speculative features; keep every change simple. [Task 12] [ad-hoc note]\n");
  const service = new MemoryForgetService(root, join(base, "backups"));

  const first = service.preview(selection(root));
  assert.equal(first.actionable, false);
  assert.equal(first.durableCandidates.length, 1);
  assert.equal(first.durableCandidates[0].match, "related");
  assert.ok(first.durableCandidates[0].signals.includes("normalized terms"));

  const confirmed = service.preview({ ...selection(root), confirmedDurableIds: [first.durableCandidates[0].id] });
  assert.equal(confirmed.actionable, true);
  assert.equal(confirmed.sections.filter(({ kind }) => kind === "durable").length, 1);
});

test("preview follows durable Task, thread, rollout, and ad-hoc provenance", async () => {
  const { base, root } = fixture();
  writeFileSync(join(root, "MEMORY.md"), [
    "# Task Group: Simplicity\n",
    "## Task 7: Delivery\n",
    "### rollout_summary_files\n",
    "- rollout_summaries/one.md (thread_id=thread-one)\n",
    "## User preferences\n",
    "- Never add speculative features; keep every change simple. [ad-hoc note][Task 7]\n",
  ].join("\n"));
  writeFileSync(join(root, "raw_memories.md"), "# Raw\n\n## Thread `thread-one`\n\n### Task 7: Delivery\n\n- Prefer simple changes and avoid all speculative features.\n");
  writeFileSync(join(root, "rollout_summaries", "one.md"), "# Rollout\n\n## Task 7\n\n- Keep changes simple; never add speculative features.\n");
  writeFileSync(join(root, "extensions", "ad_hoc", "notes", "simplicity.md"), "# Simplicity\n\n- Avoid speculative features and always keep changes simple.\n");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const first = service.preview(selection(root));

  const plan = service.preview({ ...selection(root), confirmedDurableIds: [first.durableCandidates[0].id] });

  assert.deepEqual(plan.sections.map(({ kind }) => kind), ["summary", "durable", "raw", "rollout", "ad-hoc"]);
  assert.ok(plan.sections.find(({ kind }) => kind === "raw").signals.includes("thread id thread-one"));
  assert.ok(plan.sections.find(({ kind }) => kind === "rollout").signals.includes("rollout reference"));
  assert.ok(plan.sections.find(({ kind }) => kind === "ad-hoc").signals.includes("ad-hoc marker"));
});

test("apply follows enclosing task provenance without matching unrelated paths", async () => {
  const { base, root } = fixture({ adHoc: false });
  writeFileSync(join(root, "memory_summary.md"), [
    "# Summary\n",
    "- HUM PR #1390 re-review: private/environment/solr, query.type, queryFields, AuthUserFile\n",
    "  - desc: Pinned read-only merge-blocker review; findings are head-SHA/time-specific; cwd=/Users/rupertgermann/Sites/hum-corporate-typo3.\n",
  ].join("\n"));
  writeFileSync(join(root, "MEMORY.md"), [
    "# Task Group: HUM TYPO3 PR #1390 re-review\n",
    "scope: Pinned read-only review of copied Solr release files and configuration/spec blockers.\n",
    "## Task 1: Re-review merge blockers, success\n",
    "### rollout_summary_files\n",
    "- rollout_summaries/one.md (thread_id=thread-one)\n",
    "### keywords\n",
    "- PR #1390, private/environment/solr, query.type, queryFields, Solr isolation, AuthUserFile\n",
    "## Reusable knowledge\n",
    "- Review against immutable head/base; current head had four P1 spec blockers. [Task 1]\n",
    "# Task Group: Unrelated\n",
    "- Preserve unrelated facts. [Task 1]\n",
  ].join("\n"));
  writeFileSync(join(root, "raw_memories.md"), [
    "# Raw\n",
    "## Thread `thread-one`\n",
    "### Task 1: Re-review PR #1390\n",
    "- The user requested another read-only review excluding copied Solr release files.\n",
    "- Four P1 blockers remain, including queryFields and AuthUserFile problems.\n",
    "## Thread `thread-unrelated`\n",
    "- Primary checkout: `/Users/rupertgermann/Sites/gbk-corporate-typo3/gbk-corporate-app`.\n",
  ].join("\n"));
  writeFileSync(join(root, "rollout_summaries", "one.md"), [
    "thread_id: thread-one\n",
    "# Re-review of PR #1390 remained blocked\n",
    "## Task 1: Re-review PR #1390\n",
    "- Semantic mode still overrides queryFields.\n",
  ].join("\n"));
  writeFileSync(join(root, "rollout_summaries", "unrelated.md"), "# Unrelated\n\n- Working directory: `/Users/rupertgermann/Sites/gbk-corporate-typo3`\n");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const first = service.preview(selection(root));

  const plan = service.preview({ ...selection(root), confirmedDurableIds: [first.durableCandidates[0].id] });

  assert.deepEqual(plan.sections.map(({ kind }) => kind), ["summary", "durable", "raw", "rollout"]);
  assert.match(plan.sections.find(({ kind }) => kind === "durable").content, /# Task Group: HUM TYPO3 PR #1390/);
  assert.match(plan.sections.find(({ kind }) => kind === "raw").content, /## Thread `thread-one`/);
  assert.equal(plan.sections.find(({ kind }) => kind === "rollout").path, "rollout_summaries/one.md");
  assert.equal(plan.sections.some(({ path }) => path === "rollout_summaries/unrelated.md"), false);

  const result = await service.apply(plan);

  assert.equal(result.verification, "suppressed");
  assert.doesNotMatch(readFileSync(join(root, "MEMORY.md"), "utf8"), /PR #1390/);
  assert.doesNotMatch(readFileSync(join(root, "raw_memories.md"), "utf8"), /thread-one/);
  assert.match(readFileSync(join(root, "raw_memories.md"), "utf8"), /thread-unrelated/);
  assert.equal(existsSync(join(root, "rollout_summaries", "one.md")), false);
  assert.equal(existsSync(join(root, "rollout_summaries", "unrelated.md")), true);
});

test("preview reports no match and rejects stale or invalid summary selections", async () => {
  const { base, root } = fixture();
  writeFileSync(join(root, "memory_summary.md"), "# Summary\n\n- Something with no durable source.\n");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const current = selection(root);

  assert.equal(service.preview(current).reason, "No durable Memory match was found.");
  assert.throws(() => service.preview({ ...current, expectedSummaryHash: "stale" }), { name: "MemoryConflictError" });
  assert.throws(() => service.preview({ ...current, summaryLine: 1 }), /top-level Memory Summary entry/);
});

test("apply removes only confirmed sections, creates a backup, and never touches sessions", async () => {
  const { base, root } = fixture();
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));
  const sessionBefore = readFileSync(join(root, "sessions", "thread-one.jsonl"));

  const result = await service.apply(plan);

  assert.equal(result.rolledBack, false);
  assert.equal(result.verification, "suppressed");
  assert.ok(existsSync(result.manifestPath));
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.status, "committed");
  assert.deepEqual(manifest.paths.sort(), result.changedPaths.sort());
  for (const section of plan.sections) {
    const backup = join(result.manifestPath, "..", "files", section.path);
    assert.ok(existsSync(backup));
    assert.equal(new MemoryRepository(root).read(section.path).hash === section.expectedHash, false);
  }
  assert.deepEqual(readFileSync(join(root, "sessions", "thread-one.jsonl")), sessionBefore);
  assert.doesNotMatch(readFileSync(join(root, "memory_summary.md"), "utf8"), /Keep changes simple/);
  assert.match(readFileSync(join(root, "memory_summary.md"), "utf8"), /Preserve unrelated/);
  assert.doesNotMatch(readFileSync(join(root, "MEMORY.md"), "utf8"), /Keep changes simple/);
  assert.match(readFileSync(join(root, "MEMORY.md"), "utf8"), /Preserve unrelated/);
  const note = readFileSync(join(root, "extensions", "ad_hoc", "notes", "simplicity.md"), "utf8");
  assert.match(note, /action: delete/);
  assert.equal(result.tombstonePath, "extensions/ad_hoc/notes/simplicity.md");
  assert.equal(service.recheck(plan).resurfaced.length, 0);
});

test("apply aborts before writing when any planned revision is stale", async () => {
  const { base, root } = fixture();
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));
  writeFileSync(join(root, "raw_memories.md"), readFileSync(join(root, "raw_memories.md"), "utf8") + "\nChanged concurrently.\n");
  const before = bytes(root);

  await assert.rejects(async () => await service.apply(plan), { name: "MemoryConflictError" });
  assert.deepEqual(bytes(root), before);
});

test("apply rolls all writes back after an intermediate filesystem failure", async () => {
  const { base, root } = fixture({ adHoc: false });
  writeFileSync(join(root, "extensions"), "blocks the tombstone directory");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));
  const before = bytes(root);

  let failure;
  await assert.rejects(async () => { try { await service.apply(plan); } catch (error) { failure = error; throw error; } }, /rolled back/i);
  assert.deepEqual(bytes(root), before);
  assert.ok(failure instanceof Error);
});

test("apply creates exactly one new tombstone and repeated apply cannot duplicate it", async () => {
  const { base, root } = fixture({ adHoc: false });
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));

  const result = await service.apply(plan);
  const notes = readdirSync(join(root, "extensions", "ad_hoc", "notes"));
  assert.equal(notes.length, 1);
  assert.match(readFileSync(join(root, result.tombstonePath), "utf8"), /action: delete/);
  await assert.rejects(async () => await service.apply(plan), { name: "MemoryConflictError" });
  assert.equal(readdirSync(join(root, "extensions", "ad_hoc", "notes")).length, 1);
});

test("apply converts one of multiple linked notes and removes the other positive copies", async () => {
  const { base, root } = fixture();
  writeFileSync(join(root, "extensions", "ad_hoc", "notes", "second.md"), "# Second source\n\n- Keep changes simple and never add speculative features.\n- Keep this unrelated note.\n");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));

  const result = await service.apply(plan);

  const notes = readdirSync(join(root, "extensions", "ad_hoc", "notes")).map((name) => readFileSync(join(root, "extensions", "ad_hoc", "notes", name), "utf8"));
  assert.equal(notes.filter((content) => content.includes("codex-explorer-forget:")).length, 1);
  assert.equal(notes.filter((content) => /^- Keep changes simple/m.test(content)).length, 0);
  assert.ok(notes.some((content) => content.includes("Keep this unrelated note.")));
  assert.equal(result.verification, "suppressed");
});

test("apply rejects unconfirmed, manipulated, duplicate-tombstone, and unsafe plans", async () => {
  const ambiguous = fixture({ ambiguous: true });
  const ambiguousService = new MemoryForgetService(ambiguous.root, join(ambiguous.base, "backups"));
  const unconfirmed = ambiguousService.preview(selection(ambiguous.root));
  await assert.rejects(async () => await ambiguousService.apply(unconfirmed), /not confirmed/);

  const exact = fixture({ adHoc: false });
  const service = new MemoryForgetService(exact.root, join(exact.base, "backups"));
  const plan = service.preview(selection(exact.root));
  await assert.rejects(async () => await service.apply({ ...plan, fingerprint: "0".repeat(64) }), { name: "MemoryConflictError" });
  assert.throws(() => new MemoryForgetService(exact.root, exact.root), /outside/);
  assert.throws(() => new MemoryForgetService(exact.root, join(exact.root, "backups")), /outside/);

  mkdirSync(join(exact.root, "extensions", "ad_hoc", "notes"), { recursive: true });
  writeFileSync(join(exact.root, "extensions", "ad_hoc", "notes", "existing.md"), `# Delete\n\n- codex-explorer-forget: sha256:${plan.fingerprint}\n`);
  await assert.rejects(async () => await service.apply(plan), /already exists/);
});

test("preview rejects a linked source that escapes through a symlink", async () => {
  const { base, root } = fixture();
  const outside = join(base, "outside.md");
  writeFileSync(outside, readFileSync(join(root, "MEMORY.md")));
  rmSync(join(root, "MEMORY.md"));
  symlinkSync(outside, join(root, "MEMORY.md"));
  const service = new MemoryForgetService(root, join(base, "backups"));

  assert.throws(() => service.preview(selection(root)), { name: "MemoryPathError" });
  assert.match(readFileSync(outside, "utf8"), /Keep changes simple/);
});

test("apply deletes an empty rollout source but preserves aggregate files", async () => {
  const { base, root } = fixture();
  writeFileSync(join(root, "rollout_summaries", "one.md"), "- Keep changes simple and never add speculative features.\n");
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));

  await service.apply(plan);

  assert.equal(existsSync(join(root, "rollout_summaries", "one.md")), false);
  assert.equal(existsSync(join(root, "memory_summary.md")), true);
  assert.equal(existsSync(join(root, "MEMORY.md")), true);
  assert.equal(existsSync(join(root, "raw_memories.md")), true);
});

test("manual recheck ignores the tombstone but detects a resurfaced positive memory", async () => {
  const { base, root } = fixture();
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));
  await service.apply(plan);

  writeFileSync(join(root, "rollout_summaries", "later.md"), "# Later\n\n- Keep changes simple and never add speculative features.\n");

  assert.deepEqual(service.recheck(plan).resurfaced.map(({ path }) => path), ["rollout_summaries/later.md"]);
});

test("manual recheck detects a normalized-term paraphrase", async () => {
  const { base, root } = fixture();
  const service = new MemoryForgetService(root, join(base, "backups"));
  const plan = service.preview(selection(root));
  await service.apply(plan);
  writeFileSync(join(root, "rollout_summaries", "later.md"), "# Later\n\n- Never add speculative features; keep every change simple.\n");

  const recheck = service.recheck(plan);
  assert.equal(recheck.status, "resurfaced");
  assert.equal(recheck.resurfaced[0].match, "related");
  assert.equal(recheck.resurfaced[0].path, "rollout_summaries/later.md");
});
