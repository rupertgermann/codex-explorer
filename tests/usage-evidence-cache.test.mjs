import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deserialize, serialize } from "node:v8";
import { zstdCompressSync } from "node:zlib";
import { pruneUsageTelemetry, scanUsageTelemetry } from "../lib/usage-telemetry.ts";
import { EVIDENCE_BUDGET, readUsageEvidence, writeUsageEvidence } from "../lib/usage-evidence-cache.ts";
import { sessionFileRevision } from "../lib/session-file-cache.ts";

const epoch = 1_788_220_800;
const row = (t, type, payload) => JSON.stringify({ timestamp: new Date((epoch + t) * 1000).toISOString(), type, payload });
const source = n => [row(0, "session_meta", { id: "session" }),
  row(1, "turn_context", { model: "test", turn_id: "turn" }),
  row(2, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: n } } }),
  row(3, "response_item", { text: "private transcript sentinel" })].join("\n") + "\n";
const repositoryUrl = new URL("../lib/usage-repository.ts", import.meta.url).href;
const telemetryUrl = new URL("../lib/usage-telemetry.ts", import.meta.url).href;
const fresh = (home, roots, cache, end = 100) => deserialize(execFileSync(process.execPath, ["--input-type=module", "-e", `
  import fs from "node:fs";
  import { syncBuiltinESMExports } from "node:module";
  import { serialize } from "node:v8";
  const opened = [], create = fs.createReadStream;
  fs.createReadStream = (...args) => { opened.push(String(args[0])); return create(...args); };
  syncBuiltinESMExports();
  const { readUsageData } = await import(${JSON.stringify(repositoryUrl)});
  const data = await readUsageData(${epoch}, ${epoch + end}, ${JSON.stringify({ home, roots, evidenceCacheDirectory: cache })});
  data.generatedAt = 0;
  process.stdout.write(serialize({ data, opened }));
`], { maxBuffer: 16 * 1024 * 1024 }));

test("report generation enables persistence while direct reads do not write it", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-report-persistence-")), root = join(home, "sessions");
  fs.mkdirSync(root); fs.writeFileSync(join(root, "usage.jsonl"), source(100));
  try {
    const readonly = fresh(home, [root]);
    assert.deepEqual(fs.readdirSync(home), ["sessions"]);
    execFileSync(process.execPath, ["--input-type=module", "-e", `
      const { generateUsageData } = await import(${JSON.stringify(repositoryUrl)});
      process.chdir(${JSON.stringify(home)});
      await generateUsageData(${epoch}, ${epoch + 100}, ${JSON.stringify({ home, roots: [root] })});
    `]);
    const cache = join(home, ".cache", "usage-evidence");
    assert.equal(fs.readdirSync(cache).length, 1);
    const persisted = fresh(home, [root], cache);
    assert.deepEqual(persisted.data, readonly.data);
    assert.equal(persisted.opened.length, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("disk evidence survives fresh processes, source revisions, compressed replacement, changed roots and periods", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-durable-")), active = join(home, "active"), archive = join(home, "archive"), cache = join(home, "cache");
  fs.mkdirSync(active); fs.mkdirSync(archive);
  const path = join(active, "usage.jsonl");
  fs.writeFileSync(path, source(100));
  try {
    const readonly = fresh(home, [active, archive]);
    assert.equal(fs.existsSync(cache), false);
    const cold = fresh(home, [active, archive], cache), warm = fresh(home, [active, archive], cache);
    assert.deepEqual(cold.data, readonly.data);
    assert.deepEqual(warm.data, cold.data);
    assert.equal(cold.opened.filter(p => p === path).length, 2);
    assert.equal(warm.opened.filter(p => p === path).length, 1);
    const entry = join(cache, fs.readdirSync(cache)[0]);
    assert.equal(fs.statSync(entry).mode & 0o777, 0o600);
    assert.equal(fs.statSync(cache).mode & 0o777, 0o700);
    assert.ok(!fs.readFileSync(entry).includes(Buffer.from("private transcript sentinel")));
    assert.deepEqual(fresh(home, [active], cache, 2).data, fresh(home, [active], undefined, 2).data);
    fs.writeFileSync(path, source(150));
    const rewrite = fresh(home, [active], cache);
    assert.equal(rewrite.data.events[0].usage.total_tokens, 150);
    assert.equal(rewrite.opened.length, 2);
    fs.appendFileSync(path, row(5, "event_msg", { type: "token_count", info: { total_token_usage: { input_tokens: 200 } } }) + "\n");
    assert.deepEqual(fresh(home, [active], cache).data, fresh(home, [active]).data);
    fs.renameSync(path, path + ".old");
    fs.writeFileSync(path, source(250));
    assert.equal(fresh(home, [active], cache).data.events[0].usage.total_tokens, 250);
    fs.writeFileSync(path + ".zst", zstdCompressSync(Buffer.from(source(300))));
    fs.rmSync(path);
    const compressed = fresh(home, [active], cache);
    assert.equal(compressed.data.events[0].usage.total_tokens, 300);
    assert.deepEqual(fresh(home, [active], cache).data, compressed.data);
    fs.writeFileSync(join(archive, "usage.jsonl"), source(400));
    assert.equal(fresh(home, [archive], cache).data.events[0].usage.total_tokens, 400);
    fs.rmSync(path + ".zst");
    assert.equal(fresh(home, [active], cache).data.events.length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("corrupt and invalid entries fall back completely, and unwritable cache does not fail valid scans", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-corrupt-")), path = join(home, "usage.jsonl"), cache = join(home, "cache");
  fs.writeFileSync(path, source(100));
  const scan = async () => {
    pruneUsageTelemetry(new Set());
    const records = [];
    const result = await scanUsageTelemetry(path, (record, line) => records.push({ record, line }), undefined, cache);
    return { records, ...result };
  };
  try {
    const cold = await scan(), entry = join(cache, fs.readdirSync(cache)[0]);
    const valid = fs.readFileSync(entry);
    for (const invalid of [Buffer.from("invalid cache"), Buffer.from(valid.subarray(0, valid.length - 1)), Buffer.from(valid)]) {
      invalid[invalid.length - 1] ^= 1;
      fs.writeFileSync(entry, invalid);
      assert.deepEqual(await scan(), cold);
    }
    const envelope = deserialize(valid.subarray(32));
    envelope.evidence.records.push({ record: {}, line: "invalid" });
    const payload = serialize(envelope);
    fs.writeFileSync(entry, Buffer.concat([createHash("sha256").update(payload).digest(), payload]));
    assert.deepEqual(await scan(), cold);
    fs.rmSync(cache, { recursive: true }); fs.writeFileSync(cache, "not a directory");
    assert.deepEqual(await scan(), cold);
  } finally { fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});

test("resident evidence populates requested disk tiers once without rereading the source", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-resident-disk-")), path = join(home, "usage.jsonl"), first = join(home, "first"), second = join(home, "second");
  fs.writeFileSync(path, source(100));
  const create = fs.createReadStream;
  try {
    await scanUsageTelemetry(path, () => {});
    fs.createReadStream = () => { throw new Error("Resident evidence must not rescan"); }; syncBuiltinESMExports();
    for (const cache of [first, second]) await scanUsageTelemetry(path, () => {}, undefined, cache);
    const entries = [first, second].map(cache => join(cache, fs.readdirSync(cache)[0]));
    const revisions = entries.map(sessionFileRevision);
    for (const cache of [second, first, second]) await scanUsageTelemetry(path, () => {}, undefined, cache);
    assert.deepEqual(entries.map(sessionFileRevision), revisions);
    assert.deepEqual(readUsageEvidence(first, path, sessionFileRevision(path)), readUsageEvidence(second, path, sessionFileRevision(path)));
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});

test("lossless disk evidence preserves nonfinite numbers and invalid counter coverage after restart", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-nonfinite-")), path = join(home, "usage.jsonl"), cache = join(home, "cache");
  fs.writeFileSync(path, source(100).replace('"input_tokens":100', '"input_tokens":1e999'));
  const scan = () => deserialize(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { serialize } from "node:v8";
    const { scanUsageTelemetry } = await import(${JSON.stringify(telemetryUrl)});
    const records = [];
    await scanUsageTelemetry(${JSON.stringify(path)}, record => records.push(record), undefined, ${JSON.stringify(cache)});
    process.stdout.write(serialize(records));
  `]));
  try {
    const cold = scan(), warm = scan();
    assert.equal(cold[2].payload.info.total_token_usage.input_tokens, Infinity);
    assert.deepEqual(warm, cold);
    assert.deepEqual(fresh(home, [home], cache).data, fresh(home, [home]).data);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("cancellation, concurrent changes and writers never publish partial evidence", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-publication-")), path = join(home, "usage.jsonl"), cache = join(home, "cache");
  fs.writeFileSync(path, source(100));
  try {
    const abort = new AbortController();
    await assert.rejects(scanUsageTelemetry(path, () => abort.abort(), abort.signal, cache), { name: "AbortError" });
    assert.equal(fs.existsSync(cache), false);
    let changed = false;
    await scanUsageTelemetry(path, () => { if (!changed) { changed = true; fs.appendFileSync(path, row(9, "response_item", {}) + "\n"); } }, undefined, cache);
    assert.equal(fs.existsSync(cache), false);
    const revision = sessionFileRevision(path), evidence = { records: [{ record: { timestamp: Infinity }, line: 1 }], skippedLines: 0 };
    const controller = new AbortController();
    const pending = writeUsageEvidence(cache, path, revision, evidence, 256, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    assert.deepEqual(fs.readdirSync(cache), []);
    await Promise.all([writeUsageEvidence(cache, path, revision, evidence, 256), writeUsageEvidence(cache, path, revision, evidence, 256)]);
    assert.deepEqual(readUsageEvidence(cache, path, revision)?.evidence, evidence);
    assert.equal(fs.readdirSync(cache).length, 1);
    const stale = writeUsageEvidence(cache, path, revision, evidence, 256);
    fs.appendFileSync(path, "\n");
    await stale;
    assert.equal(readUsageEvidence(cache, path, sessionFileRevision(path)), undefined);
  } finally { fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});

test("oversized serialized entries are ignored without allocating their advertised size", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-cache-bound-")), path = join(home, "usage.jsonl"), cache = join(home, "cache");
  fs.writeFileSync(path, source(100));
  try {
    await scanUsageTelemetry(path, () => {}, undefined, cache);
    const entry = join(cache, fs.readdirSync(cache)[0]);
    fs.truncateSync(entry, EVIDENCE_BUDGET + 1);
    assert.equal(readUsageEvidence(cache, path, sessionFileRevision(path)), undefined);
    pruneUsageTelemetry(new Set());
    let opens = 0; const create = fs.createReadStream;
    fs.createReadStream = (...args) => { opens++; return create(...args); }; syncBuiltinESMExports();
    try { await scanUsageTelemetry(path, () => {}, undefined, cache); assert.equal(opens, 1); }
    finally { fs.createReadStream = create; syncBuiltinESMExports(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});

test("fresh process reuses all evidence when the archive exceeds the resident memory budget", () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-disk-capacity-")), cache = join(home, "cache");
  const paths = Array.from({ length: 4 }, (_, i) => join(home, `${i}.jsonl`));
  const contexts = (row(1, "turn_context", { turn_id: "turn", model: "test", effort: "high" }) + "\n").repeat(60000);
  for (const path of paths) fs.writeFileSync(path, source(100) + contexts);
  const sweep = () => deserialize(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    import { serialize } from "node:v8";
    const opened = [], create = fs.createReadStream;
    fs.createReadStream = (...args) => { opened.push(String(args[0])); return create(...args); };
    syncBuiltinESMExports();
    const { scanUsageTelemetry } = await import(${JSON.stringify(telemetryUrl)});
    const results = [];
    for (const path of ${JSON.stringify(paths)}) {
      let records = 0, lines = 0, bytes = 128;
      await scanUsageTelemetry(path, (record, line) => { records++; lines += line; bytes += Buffer.byteLength(JSON.stringify(record)) + 128; }, undefined, ${JSON.stringify(cache)});
      results.push({ records, lines, bytes });
    }
    process.stdout.write(serialize({ opened, results }));
  `]));
  try {
    const cold = sweep(), warm = sweep();
    assert.ok(cold.results.reduce((n, file) => n + file.bytes, 0) > EVIDENCE_BUDGET);
    assert.deepEqual(cold.opened, paths);
    assert.deepEqual(warm.opened, []);
    assert.deepEqual(warm.results, cold.results);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test("a source above the per-file evidence budget streams completely on every scan", async () => {
  const home = fs.mkdtempSync(join(tmpdir(), "usage-large-source-")), path = join(home, "usage.jsonl"), cache = join(home, "cache");
  fs.writeFileSync(path, source(100) + (row(1, "turn_context", { turn_id: "turn", model: "test", effort: "high" }) + "\n").repeat(260000));
  const create = fs.createReadStream; let opened = 0;
  fs.createReadStream = (...args) => { opened++; return create(...args); }; syncBuiltinESMExports();
  try {
    for (let pass = 0; pass < 2; pass++) {
      let records = 0, bytes = 128;
      await scanUsageTelemetry(path, record => { records++; bytes += Buffer.byteLength(JSON.stringify(record)) + 128; }, undefined, cache);
      assert.equal(records, 260004);
      assert.ok(bytes > EVIDENCE_BUDGET);
    }
    assert.equal(opened, 2);
    assert.equal(fs.existsSync(cache), false);
  } finally { fs.createReadStream = create; syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true }); pruneUsageTelemetry(new Set()); }
});
