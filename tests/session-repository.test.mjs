import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { SessionRepository } from "../lib/sessions.ts";

const roots = [];

function sessionRoot() {
  const root = mkdtempSync(join(tmpdir(), "codex-sessions-test-"));
  roots.push(root);
  return root;
}

function writeSession(root, relativePath, records) {
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

afterEach(() => {
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

test("catalogs JSONL sessions from metadata without treating other files as sessions", () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/24/rollout-one.jsonl", [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "session-one", cwd: "/work/alpha", source: "vscode", originator: "codex" } },
    { timestamp: "2026-08-24T10:01:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Build alpha" } },
  ]);
  writeSession(root, "2026/08/23/rollout-two.jsonl", [
    { timestamp: "2026-08-23T09:00:00.000Z", type: "session_meta", payload: { id: "session-two", cwd: "/work/beta", source: "cli" } },
  ]);
  writeFileSync(join(root, "ignored.txt"), "not a session");

  const catalog = new SessionRepository(root).catalog();

  assert.equal(catalog.totals.sessions, 2);
  assert.equal(catalog.totals.projects, 2);
  assert.equal(catalog.totals.activeDays, 2);
  assert.deepEqual(catalog.sessions.map((session) => session.id), ["session-one", "session-two"]);
  assert.deepEqual(catalog.topProjects.map((project) => project.project), ["alpha", "beta"]);
  assert.deepEqual(catalog.months, [{ month: "2026-08", sessions: 2, bytes: catalog.totals.bytes }]);
});

test("reuses the session catalog until an explicit refresh", () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/first.jsonl", [
    { type: "session_meta", payload: { id: "first", cwd: "/work/alpha" } },
  ]);
  const repository = new SessionRepository(root);

  const first = repository.catalog();
  writeSession(root, "2026/08/second.jsonl", [
    { type: "session_meta", payload: { id: "second", cwd: "/work/beta" } },
  ]);
  const cached = new SessionRepository(root).catalog();
  const refreshed = repository.catalog({ refresh: true });

  assert.strictEqual(cached, first);
  assert.deepEqual(cached.sessions.map((session) => session.id), ["first"]);
  assert.deepEqual(refreshed.sessions.map((session) => session.id).sort(), ["first", "second"]);
  assert.ok(refreshed.indexedAt >= first.indexedAt);
});

test("classifies user, Codex, automation, and legacy session provenance", () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/user.jsonl", [
    { type: "session_meta", payload: { id: "user", thread_source: "user", source: "vscode" } },
  ]);
  writeSession(root, "2026/08/codex.jsonl", [
    { type: "session_meta", payload: { id: "codex", thread_source: "subagent", parent_thread_id: "user", source: { subagent: { thread_spawn: {} } } } },
  ]);
  writeSession(root, "2026/08/automation.jsonl", [
    { type: "session_meta", payload: { id: "automation", thread_source: "pull_request_fix_automation", source: "vscode" } },
  ]);
  writeSession(root, "2026/08/legacy-codex.jsonl", [
    { type: "session_meta", payload: { id: "legacy-codex", parent_thread_id: "user", source: { subagent: { thread_spawn: {} } } } },
  ]);
  writeSession(root, "2026/08/unknown.jsonl", [
    { type: "session_meta", payload: { id: "unknown", source: "vscode" } },
  ]);

  const sessions = new SessionRepository(root).catalog().sessions;
  const provenance = Object.fromEntries(sessions.map((session) => [session.id, [session.provenance, session.parentThreadId]]));

  assert.deepEqual(provenance, {
    user: ["user", ""],
    codex: ["codex", "user"],
    automation: ["automation", ""],
    "legacy-codex": ["codex", "user"],
    unknown: ["unknown", ""],
  });
});

test("reads the human conversation and tool activity from a session", async () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/24/session.jsonl", [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "session-one", cwd: "/work/alpha" } },
    { timestamp: "2026-08-24T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-test", effort: "high" } },
    { timestamp: "2026-08-24T10:00:02.000Z", type: "event_msg", payload: { type: "user_message", message: "Build a session explorer" } },
    { timestamp: "2026-08-24T10:00:03.000Z", type: "event_msg", payload: { type: "agent_message", phase: "commentary", message: "Inspecting the files." } },
    { timestamp: "2026-08-24T10:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" } },
    { timestamp: "2026-08-24T10:00:05.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "Done." } },
    { timestamp: "2026-08-24T10:00:06.000Z", type: "event_msg", payload: { type: "task_complete" } },
  ]);

  const detail = await new SessionRepository(root).read("2026/08/24/session.jsonl");

  assert.equal(detail.id, "session-one");
  assert.equal(detail.title, "Build a session explorer");
  assert.equal(detail.model, "gpt-test");
  assert.equal(detail.effort, "high");
  assert.equal(detail.metrics.userMessages, 1);
  assert.equal(detail.metrics.assistantMessages, 2);
  assert.equal(detail.metrics.toolCalls, 1);
  assert.equal(detail.metrics.events, 7);
  assert.equal(detail.truncated, false);
  assert.deepEqual(detail.entries.map((entry) => [entry.kind, entry.text ?? entry.name]), [
    ["user", "Build a session explorer"],
    ["assistant", "Inspecting the files."],
    ["tool", "exec_command"],
    ["assistant", "Done."],
  ]);
});

test("searches session contents and rejects paths outside the session root", async () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/match.jsonl", [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "match", cwd: "/work/alpha" } },
    { timestamp: "2026-08-24T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Needle phrase" } },
    { timestamp: "2026-08-24T10:00:02.000Z", type: "event_msg", payload: { type: "agent_message", message: "The needle phrase appears in an answer." } },
    { timestamp: "2026-08-24T10:00:03.000Z", type: "response_item", payload: { type: "function_call", name: "lookup", arguments: "{\"query\":\"needle phrase\"}" } },
  ]);
  writeSession(root, "2026/08/miss.jsonl", [
    { timestamp: "2026-08-23T10:00:00.000Z", type: "session_meta", payload: { id: "miss", cwd: "/work/beta" } },
  ]);
  const repository = new SessionRepository(root);

  const results = await repository.search("needle phrase");

  assert.deepEqual(results.map((session) => session.id), ["match"]);
  assert.deepEqual(results[0].matches, [
    { line: 2, kind: "user", excerpt: "Needle phrase" },
    { line: 3, kind: "assistant", excerpt: "The needle phrase appears in an answer." },
    { line: 4, kind: "tool", excerpt: "lookup {\"query\":\"needle phrase\"}" },
  ]);
  await assert.rejects(() => repository.read("../outside.jsonl"), { name: "SessionPathError" });
  await assert.rejects(() => repository.read("not-json.txt"), { name: "SessionPathError" });
});

test("treats punctuation in session search as literal text", async () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/literal.jsonl", [
    { type: "session_meta", payload: { id: "literal", cwd: "/work/literal" } },
    { type: "event_msg", payload: { type: "user_message", message: "Keep [needle]+ literal." } },
  ]);

  const results = await new SessionRepository(root).search("[needle]+");

  assert.deepEqual(results.map((session) => session.id), ["literal"]);
  assert.equal(results[0].matches[0].excerpt, "Keep [needle]+ literal.");
});

test("caps broad session searches at the newest 100 files", async () => {
  const root = sessionRoot();
  for (let index = 0; index <= 100; index += 1) {
    writeSession(root, `2026/08/${String(index).padStart(3, "0")}.jsonl`, [
      { timestamp: new Date(Date.UTC(2026, 7, 1, 0, index)).toISOString(), type: "session_meta", payload: { id: `session-${index}`, cwd: "/work/broad" } },
      { type: "event_msg", payload: { type: "user_message", message: "Broad needle" } },
    ]);
  }

  const results = await new SessionRepository(root).search("broad needle");

  assert.equal(results.length, 100);
  assert.equal(results[0].id, "session-100");
  assert.equal(results.at(-1).id, "session-1");
});

test("reads raw JSONL content in bounded byte pages", () => {
  const root = sessionRoot();
  writeSession(root, "2026/08/raw.jsonl", [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "raw" } },
    { timestamp: "2026-08-24T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Raw page content" } },
  ]);
  const repository = new SessionRepository(root);

  const first = repository.rawPage("2026/08/raw.jsonl", { offset: 0, byteLimit: 80 });
  const second = repository.rawPage("2026/08/raw.jsonl", { offset: first.nextOffset, byteLimit: 80 });

  assert.equal(first.offset, 0);
  assert.equal(first.bytes, 80);
  assert.equal(first.previousOffset, null);
  assert.equal(first.nextOffset, 80);
  assert.match(first.text, /^\{"timestamp":"2026-08-24T10:00:00\.000Z"/);
  assert.equal(first.endsMidLine, true);
  assert.equal(second.offset, 80);
  assert.equal(second.previousOffset, 0);
  assert.ok(second.text.length > 0);
  assert.equal(Buffer.byteLength(first.text) + Buffer.byteLength(second.text) <= second.fileSize, true);
});

test("raw byte pages do not split UTF-8 characters", () => {
  const root = sessionRoot();
  const relativePath = "2026/08/unicode.jsonl";
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${"a".repeat(63)}😀${"b".repeat(80)}`);
  const repository = new SessionRepository(root);

  const first = repository.rawPage(relativePath, { byteLimit: 64 });
  const second = repository.rawPage(relativePath, { offset: first.nextOffset, byteLimit: 64 });

  assert.equal(first.bytes, 63);
  assert.equal(first.text, "a".repeat(63));
  assert.equal(second.offset, 63);
  assert.match(second.text, /^😀b+/);
  assert.equal(`${first.text}${second.text}`.includes("�"), false);
});

test("streams the complete transcript beyond the preview limit", async () => {
  const root = sessionRoot();
  const relativePath = "2026/08/large.jsonl";
  const path = join(root, relativePath);
  mkdirSync(join(path, ".."), { recursive: true });
  const records = [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "large", cwd: "/work/large" } },
    { timestamp: "2026-08-24T10:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: "Before the large record" } },
    { timestamp: "2026-08-24T10:00:02.000Z", type: "response_item", payload: { type: "custom_tool_call_output", output: "x".repeat(33 * 1024 * 1024) } },
    { timestamp: "2026-08-24T10:00:03.000Z", type: "event_msg", payload: { type: "agent_message", phase: "final_answer", message: "After the preview limit" } },
  ];
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  const repository = new SessionRepository(root);
  const updates = [];

  const preview = await repository.read(relativePath);
  const complete = await repository.scanFull(relativePath, (update) => updates.push(update));

  assert.equal(preview.entries.some((entry) => entry.text === "After the preview limit"), false);
  assert.equal(preview.truncation.scanLimitReached, true);
  assert.equal(complete.entries.some((entry) => entry.text === "After the preview limit"), true);
  assert.equal(complete.metrics.scannedBytes, complete.size);
  assert.equal(complete.truncation.scanLimitReached, false);
  assert.equal(complete.truncation.oversizedRecords, 1);
  assert.equal(complete.truncation.entryLimitReached, false);
  assert.ok(updates.some((update) => update.type === "progress"));
  assert.ok(updates.some((update) => update.type === "entry" && update.entry.text === "After the preview limit"));
});

test("full scans continue past the preview entry limit even for small files", async () => {
  const root = sessionRoot();
  const path = "2026/08/many-entries.jsonl";
  writeSession(root, path, [
    { timestamp: "2026-08-24T10:00:00.000Z", type: "session_meta", payload: { id: "many-entries", cwd: "/work/alpha" } },
    ...Array.from({ length: 1_502 }, (_, index) => ({
      timestamp: "2026-08-24T10:00:01.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: `Message ${index + 1}` },
    })),
  ]);
  const repository = new SessionRepository(root);

  const preview = await repository.read(path);
  assert.equal(preview.truncation.scanLimitReached, false);
  assert.equal(preview.truncation.entryLimitReached, true);
  assert.equal(preview.entries.length, 1_500);

  const complete = await repository.scanFull(path);
  assert.equal(complete.truncation.entryLimitReached, false);
  assert.equal(complete.entries.length, 1_502);
});
