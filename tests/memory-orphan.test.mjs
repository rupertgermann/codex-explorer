import assert from "node:assert/strict";
import { existsSync, linkSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { MemoryConflictError } from "../lib/memory.ts";
import { MemoryOrphanService } from "../lib/memory-orphan.ts";

const roots = [];

function fixture() {
  const base = mkdtempSync(join(tmpdir(), "codex-orphan-test-"));
  roots.push(base);
  const memoryRoot = join(base, "memories");
  const activeSessionsRoot = join(base, "sessions");
  const archivedSessionsRoot = join(base, "archived_sessions");
  const backupRoot = join(base, "backups");
  mkdirSync(join(memoryRoot, "rollout_summaries"), { recursive: true });
  mkdirSync(activeSessionsRoot, { recursive: true });
  mkdirSync(archivedSessionsRoot, { recursive: true });
  writeFileSync(join(memoryRoot, "memory_summary.md"), "# Summary\n");
  writeFileSync(join(memoryRoot, "MEMORY.md"), "# Memory\n");
  writeFileSync(join(memoryRoot, "raw_memories.md"), "# Raw Memories\n");
  writeFileSync(join(memoryRoot, "rollout_summaries", "candidate.md"), "# Candidate\n\nNo durable Memory remains here.\n");
  const service = new MemoryOrphanService(memoryRoot, { activeSessionsRoot, archivedSessionsRoot, backupRoot });
  return { base, memoryRoot, activeSessionsRoot, archivedSessionsRoot, backupRoot, service };
}

function writeSession(root, path, id) {
  const absolutePath = join(root, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: "/work/project" } })}\n`);
  return absolutePath;
}

function treeBytes(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    return entry.isDirectory()
      ? treeBytes(path).map(([name, content]) => [join(entry.name, name), content])
      : [[entry.name, readFileSync(path)]];
  });
}

function confirmation(plan) {
  return { path: plan.path, expectedHash: plan.expectedHash };
}

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

test("inspection reports every incoming Memory reference and rejects aggregate files", async () => {
  const { memoryRoot, service } = fixture();
  writeFileSync(join(memoryRoot, "MEMORY.md"), [
    "# Memory",
    "",
    "- rollout_summaries/candidate.md",
    "- See rollout_summaries/candidate.md again.",
    "",
  ].join("\n"));

  const plan = await service.inspect("rollout_summaries/candidate.md");

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.incomingReferences.map(({ path, line }) => [path, line]), [["MEMORY.md", 3], ["MEMORY.md", 4]]);
  assert.match(plan.reason, /incoming Memory reference/i);
  linkSync(join(memoryRoot, "MEMORY.md"), join(memoryRoot, "memory-alias.md"));
  for (const corePath of ["memory_summary.md", "MEMORY.md", "raw_memories.md", "./MEMORY.md", "rollout_summaries/../MEMORY.md", "memory-alias.md"]) {
    await assert.rejects(async () => await service.inspect(corePath), /aggregate Memory file/i);
  }
});

test("inspection resolves relative Markdown links to the candidate", async () => {
  const { memoryRoot, service } = fixture();
  writeFileSync(join(memoryRoot, "rollout_summaries", "other.md"), "# Other\n\nSee [the candidate](candidate.md).\n");

  const plan = await service.inspect("rollout_summaries/candidate.md");

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.incomingReferences.map(({ path, line }) => [path, line]), [["rollout_summaries/other.md", 3]]);
});

test("inspection works when an aggregate file is absent", async () => {
  const { memoryRoot, service } = fixture();
  rmSync(join(memoryRoot, "raw_memories.md"));

  assert.equal((await service.inspect("rollout_summaries/candidate.md")).eligible, true);
});

test("inspection reports linked active and archived session provenance without changing JSONL files", async () => {
  const { memoryRoot, activeSessionsRoot, archivedSessionsRoot, service } = fixture();
  writeFileSync(join(memoryRoot, "rollout_summaries", "candidate.md"), [
    "# Candidate",
    "",
    "thread_id: active-session",
    "session_id: archived-session",
    "",
  ].join("\n"));
  const activePath = writeSession(activeSessionsRoot, "2026/08/active.jsonl", "active-session");
  const archivedPath = writeSession(archivedSessionsRoot, "2025/12/archived.jsonl", "archived-session");
  const activeBefore = readFileSync(activePath);
  const archivedBefore = readFileSync(archivedPath);

  const plan = await service.inspect("rollout_summaries/candidate.md");

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.sessionLinks.map(({ id, location }) => [id, location]), [
    ["active-session", "active"],
    ["archived-session", "archived"],
  ]);
  assert.match(plan.reason, /session/i);
  assert.deepEqual(readFileSync(activePath), activeBefore);
  assert.deepEqual(readFileSync(archivedPath), archivedBefore);
});

test("inspection blocks a file containing a positive Memory and directs the user to Forget", async () => {
  const { memoryRoot, service } = fixture();
  writeFileSync(join(memoryRoot, "rollout_summaries", "candidate.md"), "# Candidate\n\n- Keep changes simple.\n");

  const plan = await service.inspect("rollout_summaries/candidate.md");

  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.positiveMemories.map(({ line, content }) => [line, content.trim()]), [[3, "- Keep changes simple."]]);
  assert.match(plan.reason, /Forget/);
});

test("apply backs up and deletes only an eligible confirmed orphan", async () => {
  const { memoryRoot, activeSessionsRoot, service } = fixture();
  const candidatePath = join(memoryRoot, "rollout_summaries", "candidate.md");
  const candidateBefore = readFileSync(candidatePath);
  const sessionPath = writeSession(activeSessionsRoot, "2026/08/unlinked.jsonl", "unlinked-session");
  const sessionBefore = readFileSync(sessionPath);
  const corpusBefore = treeBytes(memoryRoot).filter(([path]) => path !== "rollout_summaries/candidate.md");
  const plan = await service.inspect("rollout_summaries/candidate.md");

  await assert.rejects(async () => await service.apply(plan, { path: plan.path, expectedHash: "wrong" }), /confirmation/i);
  const result = await service.apply(plan, confirmation(plan));

  assert.equal(plan.eligible, true);
  assert.equal(existsSync(candidatePath), false);
  assert.deepEqual(treeBytes(memoryRoot), corpusBefore);
  assert.deepEqual(readFileSync(sessionPath), sessionBefore);
  const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  assert.equal(manifest.status, "verified");
  assert.equal(manifest.path, "rollout_summaries/candidate.md");
  assert.equal(manifest.revision, plan.expectedHash);
  assert.deepEqual(readFileSync(manifest.backupPath), candidateBefore);
});

test("a stale plan leaves the Memory corpus byte-identical", async () => {
  const { memoryRoot, service } = fixture();
  const plan = await service.inspect("rollout_summaries/candidate.md");
  writeFileSync(join(memoryRoot, "rollout_summaries", "candidate.md"), "# Changed concurrently\n");
  const before = treeBytes(memoryRoot);

  await assert.rejects(async () => await service.apply(plan, confirmation(plan)), { name: MemoryConflictError.name });
  assert.deepEqual(treeBytes(memoryRoot), before);
});

test("a backup failure leaves the Memory corpus byte-identical", async () => {
  const { memoryRoot, backupRoot, service } = fixture();
  writeFileSync(backupRoot, "not a directory");
  const plan = await service.inspect("rollout_summaries/candidate.md");
  const before = treeBytes(memoryRoot);

  await assert.rejects(async () => await service.apply(plan, confirmation(plan)));
  assert.deepEqual(treeBytes(memoryRoot), before);
});


test("orphan inspection resolves old plain rollout references to compressed active and archived sessions", async () => {
  const { memoryRoot, activeSessionsRoot, archivedSessionsRoot, service } = fixture();
  for (const [root, name] of [[activeSessionsRoot, "active"], [archivedSessionsRoot, "archived"]]) {
    const path = writeSession(root, `${name}.jsonl`, name);
    writeFileSync(`${path}.zst`, zstdCompressSync(readFileSync(path)));
    rmSync(path);
  }
  writeFileSync(join(memoryRoot, "rollout_summaries/candidate.md"), "# Candidate\nSources: active.jsonl and archived.jsonl\n");
  const plan = await service.inspect("rollout_summaries/candidate.md");
  assert.equal(plan.eligible, false);
  assert.deepEqual(plan.sessionLinks.map(s => s.path), ["active.jsonl.zst", "archived.jsonl.zst"]);
});
