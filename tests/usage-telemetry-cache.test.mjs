import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { readUsageData } from "../lib/usage-repository.ts";
import { scanUsageTelemetry } from "../lib/usage-telemetry.ts";
import { SessionFileCache } from "../lib/session-file-cache.ts";

const epoch = Date.parse("2026-09-01T00:00:00Z") / 1000;
const row = (t, type, payload) => JSON.stringify({ timestamp: new Date((epoch + t) * 1000).toISOString(), type, payload });
const count = (t, n, last) => row(t, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: n }, last_token_usage: last === undefined ? null : { input_tokens: last } } });
const metadata = (t, id) => row(t, "session_meta", { id, cwd: "/fixture" });
const total = data => data.events.reduce((n, e) => n + e.usage.total_tokens, 0);

test("regeneration reuses resident headers/evidence, invalidates revised files, and reconciles newly added historical copies", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-evidence-")), root = join(home, "sessions"), archived = join(home, "archived");
  fs.mkdirSync(root); fs.mkdirSync(archived);
  const path = join(root, "resumed.jsonl"), old = join(archived, "old.jsonl");
  const original = [metadata(0, "same"), row(1, "turn_context", { model: "test", turn_id: "t" }), count(20, 150, 50), row(25, "response_item", { text: "private sentinel" })].join("\n") + "\n";
  fs.writeFileSync(path, original);
  const opens = [], create = fs.createReadStream;
  fs.createReadStream = (...args) => { opens.push(String(args[0])); return create(...args); };
  syncBuiltinESMExports();
  const read = () => readUsageData(epoch, epoch + 100, { home, roots: [root, archived] });
  try {
    const first = await read();
    assert.equal(total(first), 150);
    first.events[0].usage.input_tokens = 999999;
    first.events[0].usage.total_tokens = 999999;
    assert.equal(opens.length, 2);
    opens.length = 0;
    assert.equal(total(await read()), 150);
    assert.deepEqual(opens, []);
    // Adding old evidence must change the resumed baseline even though its own events are outside the period.
    fs.writeFileSync(old, [metadata(-200, "same"), count(-100, 100)].join("\n") + "\n");
    assert.equal(total(await read()), 50);
    assert.deepEqual(opens, [old, old]);
    opens.length = 0;
    fs.appendFileSync(path, count(30, 175) + "\n");
    assert.equal(total(await read()), 75);
    assert.deepEqual(opens, [path, path]);
    opens.length = 0;
    fs.writeFileSync(path, original.replace('"input_tokens":150', '"input_tokens":160')); // same-size rewrite
    assert.equal(total(await read()), 160); // 160 - 50 no longer matches the old baseline.
    assert.deepEqual(opens, [path, path]);
    fs.writeFileSync(path, metadata(0, "replacement") + "\n"); // truncation
    assert.equal(total(await read()), 0);
    fs.renameSync(path, path + ".previous");
    fs.writeFileSync(path, original); // replacement inode
    assert.equal(total(await read()), 50);
    fs.writeFileSync(path + ".zst", zstdCompressSync(Buffer.from(original)));
    opens.length = 0;
    assert.equal(total(await read()), 50);
    assert.deepEqual(opens, []); // plain has precedence
    fs.rmSync(path);
    assert.equal(total(await read()), 50); // compressed takes over
    assert.ok(opens.includes(path + ".zst"));
    fs.rmSync(old);
    assert.equal(total(await read()), 150); // deleted baseline cannot linger
    const captured = [];
    await scanUsageTelemetry(path + ".zst", record => captured.push(record));
    assert.ok(!JSON.stringify(captured).includes("private sentinel"));
    assert.equal(fs.readFileSync(path + ".previous", "utf8"), metadata(0, "replacement") + "\n");
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); }
});

test("warm replay observes cancellation and concurrent appends cannot publish stale evidence", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-replay-")), path = join(home, "usage.jsonl");
  fs.writeFileSync(path, metadata(0, "replay") + "\n" + Array.from({ length: 2000 }, (_, i) => count(i, i)).join("\n") + "\n");
  try {
    await scanUsageTelemetry(path, () => {});
    const controller = new AbortController(); let visited = 0;
    await assert.rejects(scanUsageTelemetry(path, () => { if (++visited === 1) setImmediate(() => controller.abort()); }, controller.signal), { name: "AbortError" });
    assert.ok(visited > 0 && visited < 2000);
    let appended = false;
    // Invalidates the cache, then changes the source while the cold scan is visiting it.
    fs.appendFileSync(path, count(2001, 2001) + "\n");
    await scanUsageTelemetry(path, () => { if (!appended) { appended = true; fs.appendFileSync(path, count(2002, 2002) + "\n"); } });
    let sourceOpens = 0; const create = fs.createReadStream;
    fs.createReadStream = (...args) => { sourceOpens++; return create(...args); }; syncBuiltinESMExports();
    try { await scanUsageTelemetry(path, () => {}); assert.equal(sourceOpens, 1); }
    finally { fs.createReadStream = create; syncBuiltinESMExports(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("file evidence cache keeps only current revisions, evicts within its budget, and prunes vanished paths", () => {
  const cache = new SessionFileCache(10);
  cache.set("/root/a", "one", "a", 6);
  cache.set("/root/b", "one", "b", 6);
  assert.equal(cache.get("/root/a", "one"), undefined);
  assert.equal(cache.get("/root/b", "one"), "b");
  cache.set("/root/b", "two", "new", 6);
  assert.equal(cache.get("/root/b", "one"), undefined);
  cache.set("/root/large", "one", "large", 11);
  assert.equal(cache.get("/root/large", "one"), undefined);
  cache.set("/root/b", "two", "new", 6);
  cache.prune("/root", new Set());
  assert.equal(cache.get("/root/b", "two"), undefined);
});
