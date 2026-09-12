import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readUsageData } from "../lib/usage-repository.ts";
import { analyzeQuota, buildUsageReport, csvText, dimensionKey, emptyTokens, fitRange, quotaAt, zoomRange } from "../lib/usage-report.ts";

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
