import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { SessionRepository } from "../lib/sessions.ts";
import { readUsageData } from "../lib/usage-repository.ts";

test("pre-abort avoids index reads and catalog streams; mid-catalog cancellation closes streams without replacing the catalog", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-cancel-"));
  const root = join(home, "sessions");
  fs.mkdirSync(root);
  const repository = new SessionRepository(root);
  const before = await repository.catalog();
  const metadata = JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: "test", cwd: "/fixture" } });
  for (let i = 0; i < 101; i++) fs.writeFileSync(join(root, `${i}.jsonl.zst`), zstdCompressSync(Buffer.from(metadata + "\n" + "x".repeat(200000))));
  // An accidental index read fails with EISDIR, making the pre-abort assertion meaningful.
  fs.mkdirSync(join(home, "session_index.jsonl"));
  const original = fs.createReadStream;
  const streams = [];
  const controller = new AbortController();
  fs.createReadStream = (...args) => {
    const stream = original(...args);
    streams.push(stream);
    if (streams.length === 3) setImmediate(() => controller.abort());
    return stream;
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(readUsageData(1, 2, { home, roots: [root], signal: AbortSignal.abort() }), { name: "AbortError" });
    assert.equal(streams.length, 0);
    await assert.rejects(repository.catalog({ refresh: true, signal: controller.signal }), { name: "AbortError" });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(streams.length >= 3 && streams.length < 101);
    assert.ok(streams.every(stream => stream.destroyed));
    assert.strictEqual(await repository.catalog(), before);
  } finally {
    fs.createReadStream = original;
    syncBuiltinESMExports();
  }
  try { assert.equal((await repository.catalog({ refresh: true })).sessions.length, 101); }
  finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a warm flat catalog yields so request cancellation can interrupt cached headers", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "catalog-warm-cancel-"));
  for (let i = 0; i < 300; i++) fs.writeFileSync(join(root, `${i}.jsonl`), JSON.stringify({ timestamp: "2026-09-01T00:00:00Z", type: "session_meta", payload: { id: String(i) } }) + "\n");
  const repository = new SessionRepository(root);
  const before = await repository.catalog();
  const controller = new AbortController(), original = fs.statSync;
  let stats = 0;
  fs.statSync = (...args) => {
    if (String(args[0]).endsWith(".jsonl") && ++stats === 1) setImmediate(() => controller.abort());
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(repository.catalog({ refresh: true, signal: controller.signal }), { name: "AbortError" });
    assert.ok(stats > 0 && stats < 300);
    assert.strictEqual(await repository.catalog(), before);
  } finally { fs.statSync = original; syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); }
});
