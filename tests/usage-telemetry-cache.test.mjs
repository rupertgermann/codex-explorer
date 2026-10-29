import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { zstdCompressSync } from "node:zlib";
import { readUsageData } from "../lib/usage-repository.ts";
import { pruneUsageTelemetry, scanUsageTelemetry } from "../lib/usage-telemetry.ts";
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

test("scan-resistant admission preserves reused residents, promotes a reused candidate, and accounts for variable sizes", () => {
  const cache = new SessionFileCache(10, "scan-resistant");
  cache.set("/root/a", "one", "a", 4);
  cache.set("/root/b", "one", "b", 4);
  cache.set("/root/c", "one", "c", 4);
  assert.equal(cache.get("/root/a", "one"), "a");
  assert.equal(cache.get("/root/b", "one"), undefined);
  cache.set("/root/d", "one", "d", 6);
  assert.equal(cache.get("/root/c", "one"), undefined);
  assert.equal(cache.get("/root/d", "one"), "d"); // A real hit promotes the candidate.
  cache.set("/root/e", "one", "e", 7); // Bypass an admission that would evict every resident.
  assert.equal(cache.get("/root/a", "one"), undefined);
  assert.equal(cache.get("/root/d", "one"), "d");
  cache.set("/root/huge", "one", "huge", 11);
  assert.equal(cache.get("/root/e", "one"), undefined);
  assert.equal(cache.get("/root/d", "one"), "d");
  cache.set("/root/f", "one", "f", 3);
  cache.prune("/root", new Set(["/root/e"]));
  cache.set("/root/g", "one", "g", 3);
  assert.equal(cache.get("/root/g", "changed"), undefined);
  assert.equal(cache.get("/root/e", "one"), undefined);
});

test("scan resistance retains partial hits when only one large source fits", () => {
  const cache = new SessionFileCache(64, "scan-resistant");
  const sweep = () => {
    const hits = [];
    for (const path of ["/root/a", "/root/b"]) {
      if (cache.get(path, "one")) hits.push(path);
      else cache.set(path, "one", path, 40);
    }
    return hits;
  };
  assert.deepEqual(sweep(), []);
  for (let generation = 0; generation < 5; generation++) assert.deepEqual(sweep(), ["/root/a"]);
  cache.retain(new Set(["/root/b"]));
  cache.set("/root/b", "one", "/root/b", 40);
  assert.equal(cache.get("/root/b", "one"), "/root/b");
  assert.equal(cache.get("/root/a", "one"), undefined);
});

test("timestamp evidence compacts finite runs but keeps invalid times and semantic line boundaries", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-time-runs-")), path = join(home, "run.jsonl");
  const records = [metadata(0, "runs"),
    row(1, "response_item", { text: "private" }), row(9, "response_item", {}), row(3, "event_msg", { type: "agent_message" }),
    JSON.stringify({ timestamp: epoch + 9, type: "response_item" }),
    row(10, "turn_context", { turn_id: "turn", model: "test" }),
    row(15, "response_item", {}), row(12, "response_item", {}),
    JSON.stringify({ type: "response_item" }), JSON.stringify({ timestamp: "invalid", type: "response_item" }),
    row(17, "response_item", {}), row(19, "event_msg", { type: "thread_settings_applied", thread_settings: { service_tier: "priority" } }),
    row(22, "response_item", {}), count(25, 100), "malformed JSON"];
  fs.writeFileSync(path, records.join("\n") + "\n");
  const scan = async () => { const rows = []; const result = await scanUsageTelemetry(path, (record, line) => rows.push({ record, line })); return { rows, skipped: result.skippedLines }; };
  try {
    const cold = await scan(), warm = await scan();
    assert.equal(cold.rows.length, 14);
    assert.equal(warm.rows.length, 10);
    assert.equal(cold.skipped, 1); assert.equal(warm.skipped, 1);
    assert.deepEqual(warm.rows.filter(r => r.record.type).map(r => [r.record.type, r.line]), [["session_meta", 1], ["turn_context", 6], ["event_msg", 12], ["event_msg", 14]]);
    assert.deepEqual(warm.rows.filter(r => !r.record.type).map(r => r.record.timestamp), [epoch + 9, epoch + 15, false, "invalid", epoch + 17, epoch + 22]);
    assert.ok(!JSON.stringify(warm).includes("private"));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("activity accounting stays period-independent across compacted runs, settings and incomplete turns", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-time-ranges-")), path = join(home, "range.jsonl");
  const records = [metadata(-1, "range"), row(0, "event_msg", { type: "task_started", turn_id: "turn" }),
    row(1, "turn_context", { turn_id: "turn", model: "test", effort: "high" }), count(2, 100),
    row(40, "response_item", {}), row(10, "response_item", {}), JSON.stringify({ timestamp: epoch + 30, type: "response_item" }),
    JSON.stringify({ type: "response_item" }), row(45, "event_msg", { type: "thread_settings_applied", thread_id: "range", thread_settings: { service_tier: "priority" } }),
    row(70, "response_item", {}), row(50, "response_item", {}), count(60, 130)];
  fs.writeFileSync(path, records.join("\n") + "\n");
  const options = { home, roots: [home] };
  try {
    for (const end of [20, 55, 100, 5, 100]) {
      // Invalidate for a cold parse of exactly the same bytes, then compare warm replay.
      fs.writeFileSync(path, records.join("\n") + "\n");
      const cold = await readUsageData(epoch, epoch + end, options), warm = await readUsageData(epoch, epoch + end, options);
      assert.deepEqual({ ...warm, generatedAt: 0 }, { ...cold, generatedAt: 0 });
      assert.equal(warm.coverage.missingTime, 1);
      assert.equal(total(warm), end > 60 ? 130 : 100);
      assert.equal(warm.intervals.reduce((end, interval) => Math.max(end, interval.end), 0), epoch + Math.min(end, 70));
      assert.ok(warm.intervals.every(i => i.partial));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("compaction does not carry inherited activity across fork ownership boundaries", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-fork-runs-")), path = join(home, "fork.jsonl");
  const records = [row(20, "session_meta", { id: "child", forked_from_id: "parent", parent_thread_id: "parent" }),
    row(-40, "event_msg", { type: "task_started", turn_id: "inherited", started_at: epoch - 40 }), row(-39, "turn_context", { model: "parent", turn_id: "inherited" }), count(-20, 100),
    row(1000, "response_item", {}), row(-10, "response_item", {}),
    row(30, "event_msg", { type: "task_started", turn_id: "own", started_at: epoch + 30 }), row(31, "turn_context", { model: "child", turn_id: "own" }), count(40, 130, 30),
    row(45, "response_item", {}), row(60, "response_item", {}), row(50, "response_item", {})];
  try {
    for (const end of [50, 100, 50]) {
      fs.writeFileSync(path, records.join("\n") + "\n");
      const cold = await readUsageData(epoch, epoch + end, { home, roots: [home] }), warm = await readUsageData(epoch, epoch + end, { home, roots: [home] });
      assert.deepEqual({ ...warm, generatedAt: 0 }, { ...cold, generatedAt: 0 });
      assert.equal(total(warm), 30);
      assert.equal(warm.intervals.length, 1);
      assert.equal(warm.intervals[0].start, epoch + 30);
      assert.equal(warm.intervals[0].end, epoch + Math.min(end, 60));
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("over-budget semantic evidence keeps partial hits for five sweeps and prunes back to a fully cached set", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-over-capacity-"));
  const paths = Array.from({ length: 4 }, (_, i) => join(home, `${i}.jsonl`));
  const contexts = (row(2, "turn_context", { turn_id: "turn", model: "fixture", effort: "high" }) + "\n").repeat(60000);
  for (const [i, path] of paths.entries()) fs.writeFileSync(path, metadata(0, String(i)) + "\n" + row(1, "event_msg", { type: "task_started", turn_id: "turn" }) + "\n" + contexts + count(10, 100) + "\n");
  const create = fs.createReadStream, opened = [];
  fs.createReadStream = (...args) => { opened.push(String(args[0])); return create(...args); }; syncBuiltinESMExports();
  const sweep = async selected => {
    const result = [];
    for (const path of selected) {
      let records = 0, lines = 0, estimatedBytes = 128;
      const scan = await scanUsageTelemetry(path, (record, line) => { records++; lines += line; estimatedBytes += Buffer.byteLength(JSON.stringify(record)) + 128; });
      result.push({ records, lines, estimatedBytes, skipped: scan.skippedLines });
    }
    return result;
  };
  try {
    const cold = await sweep(paths);
    assert.ok(cold.every(file => file.estimatedBytes < 64 * 1024 * 1024));
    assert.ok(cold.reduce((n, file) => n + file.estimatedBytes, 0) > 64 * 1024 * 1024);
    for (let i = 0; i < 5; i++) {
      opened.length = 0;
      assert.deepEqual(await sweep(paths), cold);
      assert.ok(opened.length > 0 && opened.length < paths.length, `partial reuse on sweep ${i}: ${opened.length} reads`);
    }
    fs.appendFileSync(paths[0], count(20, 120) + "\n");
    opened.length = 0;
    const updated = await sweep(paths);
    assert.ok(opened.includes(paths[0]));
    assert.equal(updated[0].records, cold[0].records + 1);
    fs.rmSync(paths[3]);
    const remaining = paths.slice(0, 3);
    pruneUsageTelemetry(new Set(remaining));
    await sweep(remaining);
    opened.length = 0;
    await sweep(remaining);
    assert.deepEqual(opened, []);
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});

test("generation releases evidence outside its period and selected sources while retaining header reuse", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-working-set-")), active = join(home, "sessions"), archived = join(home, "archived");
  fs.mkdirSync(active); fs.mkdirSync(archived);
  const old = join(active, "old.jsonl"), future = join(active, "future.jsonl"), copy = join(archived, "old.jsonl");
  fs.writeFileSync(old, metadata(0, "old") + "\n" + count(10, 100) + "\n");
  fs.writeFileSync(future, metadata(100, "future") + "\n" + count(110, 100) + "\n");
  fs.copyFileSync(old, copy);
  const create = fs.createReadStream, opened = [];
  fs.createReadStream = (...args) => { opened.push(String(args[0])); return create(...args); }; syncBuiltinESMExports();
  const read = (end, roots = [active, archived]) => readUsageData(epoch, epoch + end, { home, roots });
  try {
    assert.equal(total(await read(200)), 200);
    opened.length = 0;
    await read(200); assert.deepEqual(opened, []);
    await read(50); assert.deepEqual(opened, []);
    await read(200); assert.deepEqual(opened, [future]);
    opened.length = 0;
    assert.equal(total(await read(50, [archived])), 100);
    assert.deepEqual(opened, [copy]); // The shadowed archive's evidence was not retained.
    opened.length = 0;
    assert.equal(total(await read(50)), 100);
    assert.deepEqual(opened, [old]); // Other roots did not pin old residents; headers stayed reusable.
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});
