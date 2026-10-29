import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUsageData as readTelemetry } from "../lib/usage-repository.ts";
import { analyzeQuota, buildUsageReport, csvText, dimensionKey, emptyTokens, fitRange, quotaAt, usageBuckets, zoomRange } from "../lib/usage-report.ts";

// Every accounting fixture also exercises date changes and warm evidence replay.
async function readUsageData(since, until, options) {
  const first = await readTelemetry(since, until, options);
  await readTelemetry(since - 100, until + 100, options);
  const warm = await readTelemetry(since, until, options);
  assert.deepEqual({ ...warm, generatedAt: 0 }, { ...first, generatedAt: 0 });
  return first;
}

const epoch = Date.parse("2026-09-04T00:00:00Z") / 1000;
const at = seconds => new Date((epoch + seconds) * 1000).toISOString();
const record = (t, type, payload) => ({ timestamp: at(t), type, payload });
const event = (t, type, rest = {}) => record(t, "event_msg", { type, ...rest });
const count = (t, total, cached = 0) => event(t, "token_count", { info: { total_token_usage: { input_tokens: total - 10, output_tokens: 10, cached_input_tokens: cached, total_tokens: total } } });
const context = (t, turn, model, effort) => record(t, "turn_context", { turn_id: turn, model, effort });
const settings = (t, id, tier, extra = {}) => event(t, "thread_settings_applied", { thread_id: id, thread_settings: { service_tier: tier, ...extra } });

test("report scans live and archived files, preserves turn attribution and filters actual speed/effort usage", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-"));
  const write = (dir, name, rows) => { mkdirSync(join(home, dir), { recursive: true }); writeFileSync(join(home, dir, name), rows.map(r => JSON.stringify(r)).join("\n") + "\n"); };
  try {
    writeFileSync(join(home, "session_index.jsonl"), JSON.stringify({ id: "main", thread_name: "Known title" }) + "\n");
    const main = [record(-100, "session_meta", { id: "main", cwd: "/work/project" }),
      settings(-90, "main", "default"), event(-80, "task_started", { turn_id: "turn" }), context(-79, "turn", "gpt-6-astra", "medium"),
      count(-20, 100, 50), count(10, 150, 70), count(11, 150, 70),
      // Announcing the next effort cannot relabel a response from the existing context.
      settings(20, "main", "priority", { model: "gpt-next", reasoning_effort: "max" }), count(22, 200, 90),
      context(25, "turn", "gpt-6-astra", "max"), count(30, 250, 110), event(40, "task_complete", { turn_id: "turn" }),
      event(3600, "task_started", { turn_id: "next" }), context(3601, "next", "future-model", "ultra"), count(3610, 300, 130), event(3700, "turn_aborted", { turn_id: "next" }),
      record(3701, "response_item", { text: "A private prompt must not enter the report" })];
    write("sessions", "main.jsonl", main);
    write("archived_sessions", "copy.jsonl", main); // Duplicate archive copy contributes neither tokens nor activity twice.
    write("archived_sessions", "old.jsonl", [record(0, "session_meta", { id: "old", cwd: "/work/legacy" }),
      event(50, "task_started", { turn_id: "old-turn" }), context(51, "old-turn", "legacy-model", "none"), count(100, 40), count(7200, 80)]);
    write("sessions", "restored.jsonl", [record(200, "session_meta", { id: "restored" }),
      event(200, "task_started", { turn_id: "restored-turn", started_at: epoch + 300 }), context(200, "restored-turn", "historic-model", "high"), count(200, 1000000),
      event(200, "task_complete", { turn_id: "restored-turn", started_at: epoch + 300, completed_at: epoch + 600 })]);
    const data = await readUsageData(epoch, epoch + 7200, { home, roots: [join(home, "sessions"), join(home, "archived_sessions")] });
    const report = buildUsageReport(data);
    assert.equal(report.summary.total_tokens, 240);
    assert.equal(report.sessions.length, 2);
    assert.equal(report.sessions.find(s => s.id === "main").title, "Known title");
    assert.equal(report.sessions.find(s => s.id === "main").activeSeconds, 140);
    assert.equal(report.sessions.find(s => s.id === "old").partial, true);
    assert.equal(buildUsageReport(data, { speed: "fast" }).summary.total_tokens, 150);
    assert.equal(buildUsageReport(data, { speed: "normal" }).summary.total_tokens, 50);
    assert.equal(buildUsageReport(data, { speed: "unknown" }).summary.total_tokens, 40);
    assert.equal(buildUsageReport(data, { effort: "medium" }).summary.total_tokens, 100);
    assert.equal(buildUsageReport(data, { model: "future-model", effort: "ultra", speed: "fast" }).summary.total_tokens, 50);
    for (const buckets of [report.hourly, report.sixHourly, report.daily]) {
      assert.equal(buckets.reduce((n, b) => n + b.total_tokens, 0), 240);
      for (const b of buckets) assert.equal(Object.values(b.series).reduce((n, value) => n + value, 0), b.total_tokens);
    }
    assert.equal(data.coverage.duplicateEvents, 4);
    assert.equal(data.coverage.undatedUsage, 1);
    assert.ok(data.intervals.some(i => i.sessionId === "restored" && i.partial));
    assert.ok(!JSON.stringify(data).includes("private prompt"));
    assert.ok(data.events.every(e => e.line > 1));
    const cancelled = AbortSignal.abort();
    await assert.rejects(readUsageData(epoch, epoch + 7200, { home, roots: [join(home, "sessions")], signal: cancelled }), { name: "AbortError" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("forked sessions baseline inherited counters, ignore embedded identity and count resets once", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-fork-"));
  try {
    const rows = [record(200, "session_meta", { id: "child", forked_from_id: "parent", source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } }),
      event(0, "task_started", { turn_id: "inherited", started_at: epoch }), context(1, "inherited", "parent-model", "high"), count(10, 100),
      record(200, "session_meta", { id: "parent" }), settings(250, "parent", "priority"),
      event(300, "task_started", { turn_id: "own", started_at: epoch + 300 }), context(301, "own", "child-model", "minimal"), count(310, 130), count(311, 130), count(320, 25),
      event(330, "task_completed", { turn_id: "own" })];
    writeFileSync(join(home, "child.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 1000, { home, roots: [home] });
    const report = buildUsageReport(data);
    assert.equal(report.summary.total_tokens, 55);
    assert.equal(report.summary.rootTokens, 0);
    assert.equal(report.summary.subagentTokens, 55);
    assert.equal(report.summary.activeSeconds, 30);
    assert.equal(report.sessions[0].id, "child");
    assert.equal(report.sessions[0].parent, "parent");
    assert.equal(report.models[0].speed, "unknown");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("quota keeps buckets, gaps, resets and stale readings separate and excludes concurrency from attribution", () => {
  const dims = { model: "any-model", effort: "ultra", speed: "fast" };
  const point = (t, usedPercent, resetsAt = 10000, extra = {}) => ({ ...dims, t, usedPercent, resetsAt, sessionId: "a", limitId: "codex", windowMinutes: 10080, source: "source", line: t + 1, reliable: true, ...extra });
  const own = { ...dims, sessionId: "a", start: 0, end: 2000, partial: false };
  const data = { intervals: [own], snapshots: [point(0, 10), point(200, 11, 10001), point(400, 10), point(600, 11), point(800, 12), point(900, 0, 20000), point(1500, 1, 20000), point(1600, 99, 20000, { limitId: "spark" }), point(1700, 90, 20000, { reliable: false })] };
  const report = analyzeQuota(data, "codex/10080");
  assert.equal(report.observedPp, 3);
  assert.equal(report.windows.reduce((n, w) => n + w.observedPp, 0), 3);
  assert.deepEqual(report.series.map(s => s.points), [[[0, 90], [200, 89]], [[600, 89], [800, 88]], [[900, 100]], [[1500, 99]]]);
  assert.equal(quotaAt(report.series, 300), null);
  assert.equal(quotaAt(report.series, 850), null);
  assert.equal(quotaAt(report.series, 1501), null);
  assert.equal(quotaAt(report.series, 100).remaining, 90);
  const isolated = { intervals: [own], snapshots: [0, 200, 400, 600].map(t => point(t, 10)) };
  const comparison = analyzeQuota(isolated, "codex/10080").comparison[0];
  assert.equal(comparison.speed, "fast");
  assert.equal(comparison.ppPerHour, 0);
  assert.equal(analyzeQuota(isolated, "codex/10080", 15).comparison.length, 0);
  assert.equal(analyzeQuota({ ...isolated, intervals: [own, { ...own, sessionId: "other", model: "other-model", start: 100, end: 500 }] }, "codex/10080").comparison.length, 0);
  assert.equal(analyzeQuota({ ...isolated, intervals: [{ ...own, partial: true }] }, "codex/10080").comparison.length, 0);
});

test("time selection, DST days, empty reports and CSV preserve observable values", () => {
  assert.deepEqual(zoomRange([0, 86400], .5, 0, 86400), [21600, 64800]);
  assert.deepEqual(fitRange(-100, 3500, 0, 7200), [0, 3600]);
  assert.throws(() => fitRange(100, 99, 0, 7200));
  const data = { since: 0, until: 7200, events: [], intervals: [], sessions: [], snapshots: [] };
  assert.equal(buildUsageReport(data).summary.total_tokens, 0);
  assert.equal(analyzeQuota(data, "codex/10080").series.length, 0);
  const csv = csvText([{ title: '=HYPERLINK("bad")', tokens: 42, speed: "unknown", note: "line\nnext" }]);
  assert.ok(csv.startsWith("\uFEFF"));
  assert.ok(csv.includes('"\'=HYPERLINK(""bad"")";"42";"unknown";"line\nnext"'));
  const savedTZ = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    const since = Date.parse("2026-10-25T00:00:00+02:00") / 1000, until = Date.parse("2026-10-26T00:00:00+01:00") / 1000;
    const dims = { model: "test", effort: "none", speed: "normal" };
    const usage = { ...emptyTokens(), input_tokens: 9, output_tokens: 1, total_tokens: 10 };
    const report = buildUsageReport({ ...data, since, until, sessions: [{ id: "a" }], events: [{ ...dims, sessionId: "a", t: until - 1, usage }] });
    assert.equal(report.daily.length, 1);
    assert.equal(report.daily[0].end - report.daily[0].start, 25 * 3600);
    assert.equal(report.hourly.length, 25);
    assert.equal(report.daily[0].series[dimensionKey(dims)], 10);
  } finally { if (savedTZ === undefined) delete process.env.TZ; else process.env.TZ = savedTZ; }
});


test("usage counts compressed live and archived sessions once, preferring plain and then active copies", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-zstd-"));
  const write = (root, path, id, total) => {
    mkdirSync(join(home, root), { recursive: true });
    const content = Buffer.from([record(0, "session_meta", { id }), context(1, "turn", "model", "high"), count(10, total), count(11, total)].map(r => JSON.stringify(r)).join("\n"));
    writeFileSync(join(home, root, path), path.endsWith(".zst") ? zstdCompressSync(content) : content);
  };
  try {
    write("sessions", "copy.jsonl", "main", 100);
    write("sessions", "copy.jsonl.zst", "main", 9999);
    write("archived_sessions", "copy.jsonl.zst", "main", 9999);
    write("sessions", "compressed.jsonl.zst", "child", 50);
    write("archived_sessions", "archived.jsonl.zst", "archived", 40);
    const data = await readUsageData(epoch, epoch + 100, { home });
    assert.equal(buildUsageReport(data).summary.total_tokens, 190);
    assert.equal(data.events.length, 3);
    assert.equal(data.sessions.length, 3);
    assert.equal(data.coverage.invalidUsage, 0);
    await assert.rejects(readUsageData(epoch, epoch + 100, { home, signal: AbortSignal.abort() }), { name: "AbortError" });
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("the first snapshot of a compressed fork counts its last request rather than inherited lifetime usage", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-inherited-"));
  try {
    const first = count(10, 1000);
    first.payload.info.last_token_usage = { input_tokens: 90, output_tokens: 10, total_tokens: 100 };
    const parent = count(5, 900);
    parent.payload.info.last_token_usage = { input_tokens: 90, output_tokens: 10, total_tokens: 100 };
    writeFileSync(join(home, "parent.jsonl"), [record(0, "session_meta", { id: "parent" }), parent].map(r => JSON.stringify(r)).join("\n"));
    const rows = [record(0, "session_meta", { id: "child", forked_from_id: "parent" }),
      event(1, "task_started", { turn_id: "own" }), context(2, "own", "model", "high"), first, { ...first, timestamp: at(11) }, count(20, 1050)];
    writeFileSync(join(home, "child.jsonl.zst"), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n"))));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.deepEqual(data.events.filter(e => e.sessionId === "child").map(e => e.usage.total_tokens), [100, 50]);
    assert.equal(buildUsageReport(data).summary.total_tokens, 1050);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("quota activity stays correct across nonchronological cycles, touching boundaries and equal timestamps", () => {
  const dims = { model: "model", effort: "high", speed: "normal" };
  const interval = (sessionId, start, end) => ({ ...dims, sessionId, start, end, partial: false });
  const snapshot = (sessionId, t, usedPercent, resetsAt) => ({ ...dims, sessionId, t, usedPercent, resetsAt,
    limitId: "codex", windowMinutes: 10080, source: sessionId, line: t, reliable: true });
  const data = { events: [], intervals: [interval("b", 1000, 1500), interval("a", 100, 250),
    interval("touch-left", 0, 100), interval("touch-right", 200, 300)], snapshots: [
    snapshot("b", 1000, 10, 10000), snapshot("b", 1100, 11, 10000), snapshot("b", 1200, 12, 10000),
    snapshot("a", 100, 20, 20000), snapshot("a", 100, 20, 20000), snapshot("a", 150, 21, 20000), snapshot("a", 200, 22, 20000),
  ] };
  const before = [...data.intervals];
  const result = analyzeQuota(data, "codex/10080", 0);
  assert.deepEqual(result.selected.map(w => [w.sessionId, w.start, w.end, w.observedPp]), [["b", 1000, 1200, 2], ["a", 100, 200, 2]]);
  assert.ok(result.windows.some(w => w.category === "same_timestamp"));
  assert.deepEqual(data.intervals, before);
});

const usageRecord = (t, responseId, usage, extra = {}) => record(t, "token_usage_record", { response_id: responseId, usage, ...extra });
const compacted = (responseId, t) => t === undefined ? { type: "compacted", payload: { compaction_response_id: responseId } } : record(t, "compacted", { compaction_response_id: responseId });

test("compaction requests use their own timestamp and model, count once, and do not change cumulative baselines", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-compact-"));
  try {
    const rows = [record(0, "session_meta", { id: "main" }), context(1, "turn", "normal-model", "high"), count(2, 100),
      usageRecord(3, "remote", { input_tokens: 300, output_tokens: 30, cached_input_tokens: 200 }, { model: "compact-model" }),
      compacted("remote", 4), compacted("remote", 5), usageRecord(6, "remote", { input_tokens: 999, output_tokens: 1 }),
      usageRecord(7, "unrelated", { input_tokens: 999, output_tokens: 1 }), count(8, 150),
      compacted("reverse"), usageRecord(9, "reverse", { input_tokens: 200, output_tokens: 20 }),
      usageRecord(99, "across-end", { input_tokens: 10, output_tokens: 2 }), compacted("across-end", 101),
      usageRecord(100, "outside", { input_tokens: 999, output_tokens: 1 }), compacted("outside", 101)];
    writeFileSync(join(home, "main.jsonl.zst"), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n"))));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    const report = buildUsageReport(data);
    assert.equal(report.summary.total_tokens, 712);
    assert.equal(report.summary.cached_input_tokens, 200);
    assert.equal(buildUsageReport(data, { model: "compact-model" }).summary.total_tokens, 330);
    assert.equal(buildUsageReport(data, { model: "normal-model" }).summary.total_tokens, 382);
    assert.deepEqual(data.events.filter(e => e.responseId).map(e => [e.responseId, e.t - epoch]), [["remote", 3], ["reverse", 9], ["across-end", 99]]);
    assert.ok(data.events.every(e => e.source.endsWith(".zst") && e.line > 1));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("compaction usage already covered by counters is not added, including a first snapshot with thread totals", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-compact-counted-"));
  try {
    const u = (input_tokens, output_tokens) => ({ input_tokens, output_tokens, total_tokens: input_tokens + output_tokens });
    const token = (t, usage) => event(t, "token_count", { info: { total_token_usage: usage } });
    const rows = [record(0, "session_meta", { id: "main" }), token(1, u(100, 20)),
      usageRecord(2, "local", u(300, 30)), token(3, u(400, 50)), compacted("local", 4), token(5, u(450, 60))];
    writeFileSync(join(home, "main.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const first = [record(0, "session_meta", { id: "first" }), usageRecord(1, "thread-total", u(300, 30), { thread_token_usage: u(400, 50) }), token(2, u(400, 50)), compacted("thread-total")];
    writeFileSync(join(home, "first.jsonl"), first.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 960);
    assert.equal(data.events.filter(e => e.responseId).length, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("compaction response IDs deduplicate timestamp-rewritten copies and retain the original reporting period", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-compact-copy-"));
  try {
    const write = (path, id, t) => writeFileSync(join(home, path), [record(0, "session_meta", { id }),
      usageRecord(t, "same-response", { input_tokens: 90, output_tokens: 10 }), compacted("same-response")].map(r => JSON.stringify(r)).join("\n"));
    write("a-copy.jsonl", "copy", 110); write("z-original.jsonl", "original", 10);
    const whole = await readUsageData(epoch, epoch + 200, { home, roots: [home] });
    assert.equal(buildUsageReport(whole).summary.total_tokens, 100);
    assert.equal(whole.events[0].sessionId, "original");
    const later = await readUsageData(epoch + 100, epoch + 200, { home, roots: [home] });
    assert.equal(buildUsageReport(later).summary.total_tokens, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("compaction markers above the transcript record cap are included structurally and can precede covered counters", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-big-compact-"));
  try {
    const marker = compacted("remote", 4);
    marker.payload.replacement_history = "x".repeat(3 * 1024 * 1024);
    const rows = [record(0, "session_meta", { id: "main" }), count(1, 100),
      usageRecord(2, "covered", { input_tokens: 50, output_tokens: 0 }), compacted("covered", 3), count(4, 150),
      usageRecord(5, "remote", { input_tokens: 30, output_tokens: 0 }), marker,
      record(7, "response_item", { type: "tool_output", nested: compacted("fake"), text: "x".repeat(3 * 1024 * 1024) }),
      usageRecord(8, "fake", { input_tokens: 999, output_tokens: 0 })];
    writeFileSync(join(home, "main.jsonl.zst"), zstdCompressSync(Buffer.from(rows.map(r => JSON.stringify(r)).join("\n"))));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 180);
    assert.deepEqual(data.events.filter(e => e.responseId).map(e => e.responseId), ["remote"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a foreign thread's exact carried counter is a baseline, including its inherited last request", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-guardian-"));
  try {
    const total = { input_tokens: 890, output_tokens: 10, total_tokens: 900 };
    const seed = count(1, 900); seed.payload.info.last_token_usage = { input_tokens: 90, output_tokens: 10, total_tokens: 100 };
    const rows = [record(0, "session_meta", { id: "guardian", parent_thread_id: "parent" }),
      record(0, "compacted", { latest_token_usage_record: { thread_id: "parent", thread_token_usage: total } }),
      seed, event(2, "task_started", { turn_id: "own" }), count(3, 950)];
    writeFileSync(join(home, "guardian.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.deepEqual(data.events.map(e => e.usage.total_tokens), [50]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("resumed segments subtract only a full-vector baseline proven by an earlier source of the same session", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-resumed-"));
  try {
    const parent = count(10, 100); parent.payload.info.last_token_usage = { input_tokens: 40, output_tokens: 0, total_tokens: 40 };
    writeFileSync(join(home, "first.jsonl"), [record(0, "session_meta", { id: "same" }), parent].map(r => JSON.stringify(r)).join("\n"));
    const first = count(20, 150); first.payload.info.last_token_usage = { input_tokens: 50, output_tokens: 0, total_tokens: 50 };
    writeFileSync(join(home, "resumed.jsonl"), [record(15, "session_meta", { id: "same" }), first, count(30, 170)].map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 170);
    assert.equal(data.events.find(e => e.source.endsWith("first.jsonl")).usage.total_tokens, 100);
    assert.equal(data.events.find(e => e.source.endsWith("resumed.jsonl")).usage.total_tokens, 50);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("delayed task-start logging does not discard requests inside explicit actual task boundaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-delayed-"));
  try {
    const rows = [record(0, "session_meta", { id: "delayed" }), event(4, "task_started", { turn_id: "own", started_at: epoch + 1 }),
      count(10, 100), usageRecord(20, "compact", { input_tokens: 50, output_tokens: 0 }, { turn_id: "own" }), compacted("compact"),
      event(30, "task_complete", { turn_id: "own", started_at: epoch + 1, completed_at: epoch + 30 })];
    writeFileSync(join(home, "delayed.jsonl"), rows.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 150);
    assert.equal(data.coverage.undatedUsage, 0);
    assert.ok(data.intervals.every(i => i.partial));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a compaction covered in one source is not added from a copied source without its counter", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-compact-covered-copy-"));
  try {
    const request = usageRecord(2, "shared", { input_tokens: 330, output_tokens: 0 });
    const copy = [record(0, "session_meta", { id: "copy" }), request, compacted("shared", 4)];
    const original = [record(0, "session_meta", { id: "original" }), count(1, 100), request, count(3, 430), compacted("shared", 4)];
    writeFileSync(join(home, "a-copy.jsonl"), copy.map(r => JSON.stringify(r)).join("\n"));
    writeFileSync(join(home, "z-original.jsonl"), original.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 430);
    assert.equal(data.events.filter(e => e.responseId).length, 0);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("overlapping copied and resumed streams deduplicate after inherited counters are normalized", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-resumed-overlap-"));
  try {
    const write = (path, start, rows) => writeFileSync(join(home, path), [record(start, "session_meta", { id: "same" }), ...rows].map(r => JSON.stringify(r)).join("\n"));
    write("b-full-copy.jsonl", 0, [count(10, 100), count(20, 150), count(30, 170)]);
    const first = count(20, 150); first.payload.info.last_token_usage = { input_tokens: 50, output_tokens: 0, total_tokens: 50 };
    write("c-resumed.jsonl", 15, [first, count(30, 170)]);
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 170);
    assert.equal(data.events.length, 3);
    assert.equal(data.coverage.duplicateEvents, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test("an old plain source outside the period still establishes a resumed baseline", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-old-baseline-"));
  try {
    const write = (path, start, rows, modified) => {
      writeFileSync(join(home, path), [record(start, "session_meta", { id: "same" }), ...rows].map(r => JSON.stringify(r)).join("\n"));
      utimesSync(join(home, path), epoch + modified, epoch + modified);
    };
    write("first.jsonl", 0, [count(10, 100)], 10);
    const first = count(20, 150); first.payload.info.last_token_usage = { input_tokens: 50, output_tokens: 0, total_tokens: 50 };
    write("resume.jsonl", 15, [first], 20);
    const data = await readUsageData(epoch + 15, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 50);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an excluded restored counter cannot suppress a valid original compaction", async () => {
  const home = mkdtempSync(join(tmpdir(), "codex-usage-undated-counter-"));
  try {
    const usage = { input_tokens: 50, output_tokens: 0, total_tokens: 50 };
    const original = [record(0, "session_meta", { id: "original" }), usageRecord(10, "compact", usage), compacted("compact", 11)];
    const copy = [record(50, "session_meta", { id: "copy" }), event(50, "task_started", { turn_id: "copy", started_at: epoch }),
      usageRecord(50, "compact", usage), event(50, "token_count", { info: { total_token_usage: usage } }), compacted("compact", 50),
      event(50, "task_complete", { turn_id: "copy", started_at: epoch, completed_at: epoch + 20 })];
    writeFileSync(join(home, "original.jsonl"), original.map(r => JSON.stringify(r)).join("\n"));
    writeFileSync(join(home, "copy.jsonl"), copy.map(r => JSON.stringify(r)).join("\n"));
    const data = await readUsageData(epoch, epoch + 100, { home, roots: [home] });
    assert.equal(buildUsageReport(data).summary.total_tokens, 50);
    assert.equal(data.events[0].sessionId, "original");
    assert.equal(data.coverage.undatedUsage, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("hourly activity bucketing matches clipped overlap at every boundary", () => {
  const dims = { model: "fixture", effort: "high", speed: "normal", sessionId: "one", partial: false };
  const intervals = [[-7200, -1], [-100, 1], [0, 3600], [3600, 7200], [3700, 3700], [7200, 10000], [10001, 11000], [-50, 11000]]
    .map(([start, end]) => ({ ...dims, start, end }));
  for (const hours of [1, 6]) {
    const buckets = usageBuckets([], intervals, [], 0, 10000, hours);
    for (const bucket of buckets) assert.equal(bucket.activeSeconds, intervals.reduce((sum, interval) => sum + Math.max(0, Math.min(interval.end, bucket.end) - Math.max(interval.start, bucket.start)), 0));
  }
  assert.deepEqual(usageBuckets([], [], [], 0, 0, 1), []);
});

test("daily activity preserves local midnight across spring and autumn DST", () => {
  const previous = process.env.TZ;
  process.env.TZ = "Europe/Berlin";
  try {
    for (const [date, expectedHours] of [["2026-03-28T00:00:00", [24, 23, 24]], ["2026-10-24T00:00:00", [24, 25, 24]]]) {
      const start = new Date(date), end = new Date(date); end.setDate(end.getDate() + 3);
      const since = start.getTime() / 1000, until = end.getTime() / 1000;
      const intervals = [{ model: "fixture", effort: "high", speed: "normal", sessionId: "one", start: since - 1, end: until + 1, partial: false }];
      const buckets = usageBuckets([], intervals, [], since, until, 24);
      assert.deepEqual(buckets.map(b => (b.end - b.start) / 3600), expectedHours);
      assert.deepEqual(buckets.map(b => b.activeSeconds / 3600), expectedHours);
      assert.ok(buckets.every(b => new Date(b.start * 1000).getHours() === 0));
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test("large event-only, interval-heavy and mixed sessions keep exact bounds without argument spreading", () => {
  const dims = { model: "large", effort: "high", speed: "normal", sessionId: "large", turn: "turn" };
  const event = index => ({ ...dims, t: epoch + index, usage: { ...emptyTokens(), input_tokens: 1, total_tokens: 1 }, source: "fixture", line: index + 1 });
  const interval = (index, count) => ({ ...dims, effort: index % 2 ? "medium" : "high", start: epoch + index * 2 - count, end: epoch + index * 2 - count + 1, partial: false });
  for (const [eventCount, intervalCount] of [[150000, 0], [1, 150000], [80000, 80000]]) {
    const data = { since: epoch - 200000, until: epoch + 200000, generatedAt: epoch, sessions: [{ id: "large", title: "large", parent: "", project: "fixture", sources: [] }],
      events: Array.from({ length: eventCount }, (_, i) => event(i)), intervals: Array.from({ length: intervalCount }, (_, i) => interval(i, intervalCount)), snapshots: [], coverage: {} };
    const report = buildUsageReport(data);
    assert.equal(report.summary.total_tokens, eventCount);
    assert.equal(report.sessions[0].models[0].requests, eventCount);
    assert.equal(report.sessions[0].start, epoch - intervalCount);
    assert.equal(report.sessions[0].end, epoch + Math.max(eventCount - 1, intervalCount - 1));
    assert.deepEqual(buildUsageReport(data, { model: "no-match" }).sessions, []);
    assert.equal(buildUsageReport(data, { model: "large", effort: "high", speed: "normal", sessionId: "large" }).summary.total_tokens, eventCount);
  }
});

test("quota ownership compares each identity field and preserves exclusion precedence", () => {
  const dims = { model: "model", effort: "high", speed: "normal" };
  const interval = { ...dims, sessionId: "one", start: 0, end: 1200, partial: false };
  const snapshots = Array.from({ length: 7 }, (_, i) => ({ ...dims, sessionId: "one", t: i * 200, usedPercent: i, resetsAt: 10000, limitId: "codex", windowMinutes: 10080, source: "fixture", line: i + 1, reliable: true }));
  const analyze = (intervals, points = snapshots) => analyzeQuota({ intervals, snapshots: points }, "codex/10080");
  const equal = analyze([{ ...interval }, { ...interval }]);
  assert.equal(equal.windows.length, 1);
  assert.equal(equal.windows[0].category, "isolated");
  assert.equal(equal.selected[0].observedPp, 6);
  for (const [field, value] of [["sessionId", "two"], ["model", "other"], ["effort", "medium"], ["speed", "fast"]]) {
    assert.equal(analyze([interval, { ...interval, [field]: value }]).windows[0].category, "parallel_or_switch");
    assert.equal(analyze([interval], snapshots.map((s, i) => i ? { ...s, [field]: value } : s)).windows[0].category, "snapshot_owner_changed");
  }
  assert.equal(analyze([interval, { ...interval, sessionId: "two", partial: true }]).windows[0].category, "uncertain_activity");
  assert.equal(analyze([{ ...interval, end: 50 }, { ...interval, start: 100 }]).windows[0].category, "activity_gap");
  assert.equal(analyze([{ ...interval, partial: true }], snapshots.map((s, i) => ({ ...s, usedPercent: i ? 9 : 10 }))).windows[0].category, "stale_counter");
  assert.equal(analyze([{ ...interval, partial: true }], snapshots.map(s => ({ ...s, usedPercent: 100 }))).windows[0].category, "quota_at_100");
  const unknown = { model: "unknown", effort: "unknown", speed: "unknown" };
  assert.equal(analyze([{ ...interval, ...unknown }, { ...interval, ...unknown }], snapshots.map(s => ({ ...s, ...unknown }))).windows[0].category, "isolated");
});
