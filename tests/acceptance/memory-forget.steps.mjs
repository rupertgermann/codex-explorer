import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { After, Given, Then, When, setWorldConstructor } from "@cucumber/cucumber";
import { MemoryForgetService } from "../../lib/memory-forget.ts";
import { MemoryRepository } from "../../lib/memory.ts";

class ForgetWorld {
  base = "";
  root = "";
  before = [];
  sessionBefore = Buffer.alloc(0);
  plan = null;
  result = null;
  activeSessionsRoot = "";
  archivedSessionsRoot = "";
  databasePath = "";
  databaseBefore = Buffer.alloc(0);
  sessionsBefore = [];
}

setWorldConstructor(ForgetWorld);

function corpusBytes(root) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? visit(path) : [[path.slice(root.length + 1), readFileSync(path)]];
  });
  return visit(root);
}

function seed(world, repeated) {
  world.base = mkdtempSync(join(tmpdir(), "codex-forget-acceptance-"));
  world.root = join(world.base, "memories");
  mkdirSync(join(world.root, "rollout_summaries"), { recursive: true });
  mkdirSync(join(world.root, "extensions", "ad_hoc", "notes"), { recursive: true });
  mkdirSync(join(world.root, "sessions"), { recursive: true });
  writeFileSync(join(world.root, "memory_summary.md"), "# Summary\n\n- Keep changes simple and never add speculative features. [ad-hoc note]\n- Preserve unrelated facts.\n");
  writeFileSync(join(world.root, "MEMORY.md"), `# Memory\n\n- Keep changes simple and never add speculative features. [Task 1] [ad-hoc note]\n${repeated ? "- Keep changes simple and never add speculative features. [Task 2] [ad-hoc note]\n" : ""}- Preserve unrelated facts. [Task 1]\n`);
  writeFileSync(join(world.root, "raw_memories.md"), "# Raw\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
  writeFileSync(join(world.root, "rollout_summaries", "one.md"), "# Rollout\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
  writeFileSync(join(world.root, "extensions", "ad_hoc", "notes", "simplicity.md"), "# Simplicity\n\n- Keep changes simple and never add speculative features.\n");
  writeFileSync(join(world.root, "sessions", "thread.jsonl"), '{"memory":"Keep changes simple"}\n');
  world.before = corpusBytes(world.root);
  world.sessionBefore = readFileSync(join(world.root, "sessions", "thread.jsonl"));
}

Given("a disposable Memory corpus with one exact durable source", function () { seed(this, false); });
Given("a disposable Memory corpus with repeated durable sources", function () { seed(this, true); });

Given("a disposable Memory corpus with project-scoped sources", function () {
  this.base = mkdtempSync(join(tmpdir(), "codex-project-forget-acceptance-"));
  this.root = join(this.base, "memories");
  this.activeSessionsRoot = join(this.base, "sessions");
  this.archivedSessionsRoot = join(this.base, "archived_sessions");
  this.databasePath = join(this.base, "memories_1.sqlite");
  mkdirSync(join(this.root, "rollout_summaries"), { recursive: true });
  mkdirSync(join(this.root, "extensions", "ad_hoc", "notes"), { recursive: true });
  mkdirSync(this.activeSessionsRoot, { recursive: true });
  mkdirSync(this.archivedSessionsRoot, { recursive: true });
  writeFileSync(join(this.root, "memory_summary.md"), [
    "# Summary",
    "",
    "### /work/alpha",
    "- Alpha uses a narrow release workflow.",
    "- Shared release checks.",
    "",
    "### /work/alpha-tools",
    "- Beta keeps separate release notes.",
    "",
  ].join("\n"));
  writeFileSync(join(this.root, "MEMORY.md"), [
    "# Task Group: Alpha",
    "scope: Alpha delivery knowledge.",
    "applies_to: cwd=/work/alpha; reuse_rule=alpha only.",
    "",
    "## Task 1: Alpha delivery",
    "### rollout_summary_files",
    "- rollout_summaries/alpha.md (thread_id=thread-alpha)",
    "",
    "## Reusable knowledge",
    "- Alpha uses a narrow release workflow. [Task 1] [ad-hoc note]",
    "- Shared release checks. [Task 1]",
    "",
    "# Task Group: Beta",
    "scope: Beta delivery knowledge.",
    "applies_to: cwd=/work/alpha-tools; reuse_rule=beta only.",
    "",
    "## Task 1: Beta delivery",
    "### rollout_summary_files",
    "- rollout_summaries/beta.md (thread_id=thread-beta)",
    "",
    "## Reusable knowledge",
    "- Shared release checks. [Task 1]",
    "",
  ].join("\n"));
  writeFileSync(join(this.root, "raw_memories.md"), [
    "# Raw",
    "",
    "## Thread `thread-alpha`",
    "- Alpha uses a narrow release workflow.",
    "",
    "## Thread `thread-beta`",
    "- Shared release checks.",
    "",
  ].join("\n"));
  writeFileSync(join(this.root, "rollout_summaries", "alpha.md"), "thread_id: thread-alpha\n\n- Alpha uses a narrow release workflow.\n");
  writeFileSync(join(this.root, "rollout_summaries", "beta.md"), "thread_id: thread-beta\n\n- Shared release checks.\n");
  writeFileSync(join(this.root, "extensions", "ad_hoc", "notes", "alpha.md"), "# Alpha\n\n- Alpha uses a narrow release workflow.\n");
  writeFileSync(join(this.activeSessionsRoot, "alpha.jsonl"), `${JSON.stringify({ timestamp: "2026-08-24T10:00:00Z", type: "session_meta", payload: { id: "thread-alpha", cwd: "/work/alpha" } })}\n`);
  writeFileSync(join(this.activeSessionsRoot, "beta.jsonl"), `${JSON.stringify({ timestamp: "2026-08-24T11:00:00Z", type: "session_meta", payload: { id: "thread-beta", cwd: "/work/alpha-tools" } })}\n`);
  const database = new DatabaseSync(this.databasePath);
  database.exec("CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, rollout_slug TEXT, selected_for_phase2 INTEGER NOT NULL DEFAULT 0)");
  database.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?)").run("thread-alpha", "alpha", 1);
  database.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?)").run("thread-beta", "beta", 1);
  database.close();
  this.before = corpusBytes(this.root);
  this.databaseBefore = readFileSync(this.databasePath);
  this.sessionsBefore = corpusBytes(this.activeSessionsRoot);
});

Given("one referenced project source is missing", function () {
  rmSync(join(this.root, "rollout_summaries", "alpha.md"));
});

Given("one project rollout has no thread provenance", function () {
  writeFileSync(join(this.root, "MEMORY.md"), readFileSync(join(this.root, "MEMORY.md"), "utf8").replace(
    "- rollout_summaries/alpha.md (thread_id=thread-alpha)",
    "- rollout_summaries/alpha.md\n- rollout_summaries/alpha-resolved.md (thread_id=thread-alpha-resolved)",
  ));
  writeFileSync(join(this.root, "rollout_summaries", "alpha.md"), "# Alpha rollout\n\n- Alpha uses a narrow release workflow.\n");
  writeFileSync(join(this.root, "rollout_summaries", "alpha-resolved.md"), "thread_id: thread-alpha-resolved\n");
  rmSync(join(this.activeSessionsRoot, "alpha.jsonl"));
});

When("I preview the first summary Memory", function () {
  const hash = new MemoryRepository(this.root).read("memory_summary.md").hash;
  this.plan = new MemoryForgetService(this.root, join(this.base, "backups")).preview({ summaryLine: 3, expectedSummaryHash: hash });
});

When("I confirm one exact durable source", function () {
  this.plan = new MemoryForgetService(this.root, join(this.base, "backups")).preview({
    ...this.plan.selection,
    confirmedDurableIds: [this.plan.durableCandidates[0].id],
  });
});

When("I apply the Forget plan", function () {
  this.result = new MemoryForgetService(this.root, join(this.base, "backups")).apply(this.plan);
});

When("I preview Memory for {string}", function (directory) {
  this.plan = new MemoryForgetService(this.root, join(this.base, "backups"), {
    activeSessionsRoot: this.activeSessionsRoot,
    archivedSessionsRoot: this.archivedSessionsRoot,
    databasePath: this.databasePath,
  }).previewProject(directory);
});

When("the positive Memory resurfaces in a later rollout", function () {
  writeFileSync(join(this.root, "rollout_summaries", "later.md"), "# Later\n\n- Never add speculative features; keep every change simple.\n");
});

Then("the Forget plan is actionable", function () { assert.equal(this.plan.actionable, true); });
Then("the preview has not changed any corpus byte", function () { assert.deepEqual(corpusBytes(this.root), this.before); });
Then("the Forget plan requires a durable source confirmation", function () {
  assert.equal(this.plan.actionable, false);
  assert.equal(this.plan.durableCandidates.length, 2);
});
Then("only the selected Memory is absent", function () {
  assert.doesNotMatch(readFileSync(join(this.root, "MEMORY.md"), "utf8"), /Keep changes simple/);
  assert.match(readFileSync(join(this.root, "MEMORY.md"), "utf8"), /Preserve unrelated/);
});
Then("an external backup manifest exists", function () { assert.ok(existsSync(this.result.manifestPath)); });
Then("the session archive is byte-identical", function () { assert.deepEqual(readFileSync(join(this.root, "sessions", "thread.jsonl")), this.sessionBefore); });
Then("exactly one delete tombstone exists", function () {
  const notes = readdirSync(join(this.root, "extensions", "ad_hoc", "notes"));
  assert.equal(notes.length, 1);
  assert.match(readFileSync(join(this.root, "extensions", "ad_hoc", "notes", notes[0]), "utf8"), /action: delete/);
});
Then("post-apply verification reports suppression", function () { assert.equal(this.result.verification, "suppressed"); });
Then("the manual recheck reports the later rollout", function () {
  const recheck = new MemoryForgetService(this.root, join(this.base, "backups")).recheck(this.plan);
  assert.equal(recheck.status, "resurfaced");
  assert.deepEqual(recheck.resurfaced.map(({ path }) => path), ["rollout_summaries/later.md"]);
});

Then("the Project Forget plan is actionable", function () { assert.equal(this.plan.actionable, true); });
Then("the Project Forget plan is blocked by {string}", function (reason) {
  assert.equal(this.plan.actionable, false);
  assert.match(this.plan.reason, new RegExp(reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

Then("the preview lists only the project sources and retains shared Memory", function () {
  assert.deepEqual(this.plan.scopes, ["/work/alpha"]);
  assert.deepEqual(this.plan.sections.map(({ kind }) => kind), ["summary", "durable", "raw", "rollout", "ad-hoc"]);
  assert.equal(this.plan.sections.find(({ kind }) => kind === "durable").content.trim(), "- Alpha uses a narrow release workflow. [Task 1] [ad-hoc note]");
  assert.deepEqual(this.plan.databaseRows.map(({ threadId }) => threadId), ["thread-alpha"]);
  assert.equal(this.plan.sessionCount, 1);
  assert.ok(this.plan.sharedSections.some(({ kind, content }) => kind === "summary" && content.includes("Shared release checks")));
  assert.ok(this.plan.sharedSections.some(({ kind, content }) => kind === "durable" && content.includes("Shared release checks")));
  assert.ok(this.plan.sections.filter(({ kind }) => kind === "summary").every(({ content }) => !content.includes("Shared release checks")));
});

Then("the project preview has not changed the corpus, Memory database, or sessions", function () {
  assert.deepEqual(corpusBytes(this.root), this.before);
  assert.deepEqual(readFileSync(this.databasePath), this.databaseBefore);
  assert.deepEqual(corpusBytes(this.activeSessionsRoot), this.sessionsBefore);
});

After(function () { if (this.base) rmSync(this.base, { recursive: true, force: true }); });
