import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { SessionRepository } from "../lib/sessions.ts";
import { buildSessionForest } from "../lib/session-tree.ts";

function writeSession(root, payload, compressed) {
  const content = Buffer.from(`${JSON.stringify({ type: "session_meta", payload })}\n`);
  writeFileSync(join(root, `${payload.id}.jsonl${compressed ? ".zst" : ""}`), compressed ? zstdCompressSync(content) : content);
}

for (const compressed of [false, true]) {
  for (const topLevel of [undefined, ""]) {
    test(`catalog nests thread-spawn child with ${topLevel === undefined ? "missing" : "empty"} top-level parent (${compressed ? "compressed" : "plain"})`, async (t) => {
      const root = mkdtempSync(join(tmpdir(), "codex-parent-metadata-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      writeSession(root, { id: "parent", thread_source: "user" }, compressed);
      writeSession(root, {
        id: "child",
        parent_thread_id: topLevel,
        source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
      }, compressed);

      const catalog = await new SessionRepository(root).catalog();
      const forest = buildSessionForest(catalog.sessions);

      assert.equal(forest.length, 1);
      assert.equal(forest[0].session.id, "parent");
      assert.deepEqual(forest[0].children.map((node) => [node.session.id, node.session.provenance, node.orphan]), [["child", "codex", false]]);
    });
  }
}

for (const compressed of [false, true]) {
  test(`catalog preserves explicit parents, legacy links, roots, and orphans (${compressed ? "compressed" : "plain"})`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "codex-parent-compatibility-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    for (const payload of [
      { id: "parent", thread_source: "user" },
      { id: "other-root", source: "cli" },
      { id: "explicit", parent_thread_id: "parent", source: { subagent: { thread_spawn: { parent_thread_id: "other-root" } } } },
      { id: "legacy", parent_thread_id: "parent" },
      { id: "no-parent", source: { subagent: { thread_spawn: {} } } },
      { id: "orphan", source: { subagent: { thread_spawn: { parent_thread_id: "deleted-parent" } } } },
    ]) writeSession(root, payload, compressed);

    const catalog = await new SessionRepository(root).catalog();
    const forest = buildSessionForest(catalog.sessions);

    assert.deepEqual(forest.map((node) => node.session.id).sort(), ["no-parent", "orphan", "other-root", "parent"]);
    assert.deepEqual(forest.find((node) => node.session.id === "parent").children.map((node) => node.session.id).sort(), ["explicit", "legacy"]);
    assert.equal(forest.find((node) => node.session.id === "other-root").children.length, 0);
    assert.equal(forest.find((node) => node.session.id === "orphan").orphan, true);
    assert.equal(forest.find((node) => node.session.id === "no-parent").orphan, false);
  });
}
