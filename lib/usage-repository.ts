import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicMemoryWrite } from "./memory.ts";
import { SessionRepository, scanJsonl } from "./sessions.ts";
import { TOKEN_FIELDS, dimensionKey, emptyTokens, type ActivityInterval, type Dimensions, type Tokens, type UsageData, type UsageEvent } from "./usage-report.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" ? value : "";
const stamp = (value: unknown) => typeof value === "number" ? value : Date.parse(string(value)) / 1000;
const unknown: Dimensions = { model: "unknown", effort: "unknown", speed: "unknown" };

// Historical speed comes from settings at the time, never today's thread settings.
function dimensions(payload: Record<string, unknown>, previous: Dimensions): Dimensions {
  const settings = object(object(payload.collaboration_mode).settings);
  const tier = Object.hasOwn(payload, "service_tier") ? payload.service_tier : payload.speed;
  return { model: string(payload.model) || string(settings.model) || previous.model,
    effort: string(payload.effort) || string(payload.reasoning_effort) || string(settings.reasoning_effort) || previous.effort,
    speed: tier === undefined ? previous.speed : tier === "priority" || tier === "fast" ? "fast" : tier === "default" || tier === "normal" ? "normal" : "unknown" };
}

function tokens(value: unknown): Tokens | null {
  const row = object(value);
  if (!Object.keys(row).length) return null;
  const result = emptyTokens();
  for (const key of TOKEN_FIELDS) {
    const n = row[key] ?? 0;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return null;
    result[key] = n;
  }
  return result;
}

type Turn = { start?: number; end?: number; last: number; firstEvent?: number; contexts: (Dimensions & { t: number })[] };

type UsageOptions = { home?: string; roots?: string[]; signal?: AbortSignal };

function usageSource(options: UsageOptions) {
  const home = resolve(options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const roots = [...new Set((options.roots ?? [process.env.CODEX_SESSIONS_DIRECTORY ?? join(home, "sessions"), process.env.CODEX_ARCHIVED_SESSIONS_DIRECTORY ?? join(home, "archived_sessions")]).map(root => resolve(root)))];
  return { home, roots };
}

function usageCachePath(options: UsageOptions) {
  const key = createHash("sha256").update(JSON.stringify(usageSource(options))).digest("hex");
  return join(process.cwd(), ".cache", "usage-reports", `${key}.json`);
}

/** The last successful scan persists across module visits and app restarts. */
export function readCachedUsageData(options: UsageOptions = {}): UsageData | null {
  const path = usageCachePath(options);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as UsageData : null;
}

export async function generateUsageData(since: number, until: number, options: UsageOptions = {}): Promise<UsageData> {
  const data = await readUsageData(since, until, options);
  options.signal?.throwIfAborted();
  data.generatedAt = Date.now() / 1000;
  atomicMemoryWrite(usageCachePath(options), JSON.stringify(data));
  return data;
}

/** On-demand, read-only scan. Adapted from extract_usage.py and active_intervals(). */
export async function readUsageData(since: number, until: number, options: UsageOptions = {}): Promise<UsageData> {
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) throw new Error("Choose a valid start and a later end.");
  const { home, roots } = usageSource(options);
  const names = new Map<string, string>();
  const index = join(home, "session_index.jsonl");
  if (existsSync(index)) for (const line of readFileSync(index, "utf8").split("\n")) {
    try { const row = JSON.parse(line); if (typeof row.id === "string" && typeof row.thread_name === "string") names.set(row.id, row.thread_name); } catch { /* The last append can still be in progress. */ }
  }
  const data: UsageData = { since, until, generatedAt: Date.now() / 1000, sessions: [], events: [], intervals: [], snapshots: [],
    coverage: { files: 0, scanned: 0, skippedRecords: 0, invalidUsage: 0, missingTime: 0, duplicateEvents: 0, rewrittenSessions: 0, undatedUsage: 0 } };
  const sessionMap = new Map<string, UsageData["sessions"][number]>();
  const seenEvents = new Set<string>(), seenSnapshots = new Set<string>(), seenIntervals = new Set<string>();
  for (const root of new Set(roots)) {
    const repository = new SessionRepository(root);
    for (const file of repository.catalog({ refresh: true }).sessions) {
      options.signal?.throwIfAborted();
      data.coverage.files++;
      if (file.startedAt / 1000 >= until) continue;
      if (Math.max(file.startedAt, file.modifiedAt) / 1000 < since) {
        // Restored files may have old mtimes: inspect the tail before skipping them.
        const tail = repository.rawPage(file.path, { offset: Math.max(0, file.size - 128 * 1024), byteLimit: 128 * 1024 }).text;
        const times = [...tail.matchAll(/"timestamp"\s*:\s*"([^"]+)"/g)].map(m => stamp(m[1]));
        if (!times.some(t => t >= since)) continue;
      }
      data.coverage.scanned++;
      const source = join(root, file.path), turns = new Map<string, Turn>();
      const events: UsageEvent[] = [], snapshots: UsageData["snapshots"] = [];
      let sid = file.id, parent = file.parentThreadId, title = names.get(sid) || sid;
      let current = { ...unknown }, turnId = "unknown", previous: Tokens | null = null;
      let created = file.startedAt / 1000, forked = false, owned = true, rewritten = false;
      const getTurn = () => {
        if (!turns.has(turnId)) turns.set(turnId, { last: 0, contexts: [] });
        return turns.get(turnId)!;
      };
      const scan = await scanJsonl(source, file.size, (record, line) => {
        const p = object(record.payload), type = string(p.type), t = stamp(record.timestamp);
        if (record.type === "session_meta") {
          if (line !== 1) return; // Embedded parent metadata never changes the child identity.
          sid = string(p.id) || string(p.session_id) || sid;
          const spawn = object(object(object(p.source).subagent).thread_spawn);
          parent = string(p.parent_thread_id) || string(spawn.parent_thread_id) || parent;
          title = names.get(sid) || string(spawn.agent_path) || string(spawn.agent_nickname) || sid;
          created = stamp(p.timestamp ?? record.timestamp) || created;
          forked = Boolean(p.forked_from_id); owned = !forked;
          return;
        }
        if (!Number.isFinite(t)) { data.coverage.missingTime++; return; }
        if (record.type === "event_msg" && type === "thread_settings_applied") {
          if (string(p.thread_id) && p.thread_id !== sid) return;
          if (owned) getTurn().last = Math.max(getTurn().last, Math.min(t, until));
          // Model/effort settings can announce the next turn while the current
          // response is still arriving. Its turn_context remains authoritative.
          const speed = dimensions(object(p.thread_settings), current).speed;
          if (speed !== current.speed) {
            current = { ...current, speed };
            if (owned && getTurn().contexts.length) getTurn().contexts.push({ ...current, t });
          }
          return;
        }
        if (record.type === "event_msg" && type === "task_started") {
          turnId = string(p.turn_id) || `line-${line}`;
          const actual = stamp(p.started_at);
          owned = !forked || (Number.isFinite(actual) ? actual >= Math.floor(created) : t >= created);
          if (!owned) return;
          const turn = getTurn();
          if (Number.isFinite(actual) && Math.abs(actual - t) > 2) rewritten = true;
          const start = Number.isFinite(actual) && Math.abs(actual - t) > 2 ? actual : t;
          turn.start = Math.min(turn.start ?? start, start);
          turn.last = Math.max(turn.last, start);
          return;
        }
        if (record.type === "turn_context") {
          turnId = string(p.turn_id) || turnId;
          current = dimensions(p, { ...current, model: "unknown", effort: "unknown" });
          if (owned) getTurn().contexts.push({ ...current, t });
          return;
        }
        if (owned) getTurn().last = Math.max(getTurn().last, Math.min(t, until));
        if (record.type !== "event_msg") return;
        if (["task_complete", "task_completed", "turn_aborted"].includes(type)) {
          if (!owned) return;
          turnId = string(p.turn_id) || turnId;
          const actual = stamp(p.completed_at), start = stamp(p.started_at);
          if (Number.isFinite(actual) && Math.abs(actual - t) > 2) rewritten = true;
          const turn = getTurn(), end = Number.isFinite(actual) && Math.abs(actual - t) > 2 ? actual : t;
          if (Number.isFinite(start) && turn.start === undefined) turn.start = start;
          if (end >= (turn.start ?? 0)) turn.end = Math.min(turn.end ?? end, end);
          return;
        }
        if (type !== "token_count") return;
        if (owned && t >= since && t < until) {
          const limits = object(p.rate_limits);
          for (const slot of ["primary", "secondary"]) {
            const window = object(limits[slot]);
            const usedPercent = window.used_percent, resetsAt = window.resets_at, minutes = window.window_minutes;
            if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 || typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) continue;
            snapshots.push({ ...current, t, sessionId: sid, usedPercent, resetsAt, limitId: string(limits.limit_id) || "unknown", windowMinutes: minutes, source, line, reliable: true });
          }
        }
        const total = tokens(object(p.info).total_token_usage);
        if (!total) return;
        if (!owned) { previous = total; return; } // Baseline inherited counters without counting them.
        const delta = emptyTokens();
        for (const key of TOKEN_FIELDS) delta[key] = !previous || total.total_tokens < previous.total_tokens ? total[key] : total[key] - previous[key];
        previous = total;
        if (delta.total_tokens === 0) return;
        if (TOKEN_FIELDS.some(k => delta[k] < 0) || delta.total_tokens !== delta.input_tokens + delta.output_tokens || delta.cached_input_tokens > delta.input_tokens || delta.reasoning_output_tokens > delta.output_tokens) {
          if (t >= since && t < until) data.coverage.invalidUsage++;
          return;
        }
        const turn = getTurn();
        turn.firstEvent = Math.min(turn.firstEvent ?? t, t);
        if (t >= since && t < until) events.push({ ...current, t, sessionId: sid, turn: turnId, usage: delta, source, line });
      }, { signal: options.signal });
      data.coverage.skippedRecords += scan.skippedLines;
      if (rewritten) data.coverage.rewrittenSessions++;
      for (const [turnId, turn] of turns) {
        const start = turn.start ?? turn.firstEvent, end = Math.min(turn.end ?? turn.last, until);
        if (start === undefined || end <= Math.max(start, since)) continue;
        const contexts = turn.contexts.sort((a, b) => a.t - b.t);
        let dims = contexts[0] ?? unknown;
        const changes = [{ ...dims, t: start }];
        for (const context of contexts.slice(1)) if (dimensionKey(context) !== dimensionKey(dims) && context.t > start && context.t < end) {
          changes.push(context); dims = context;
        }
        for (let i = 0; i < changes.length; i++) {
          const c = changes[i];
          const interval: ActivityInterval = { model: c.model, effort: c.effort, speed: c.speed, sessionId: sid, turn: turnId,
            start: Math.max(since, c.t), end: Math.min(end, changes[i + 1]?.t ?? end),
            partial: rewritten || turn.start === undefined || turn.end === undefined || !contexts.length };
          const key = JSON.stringify(interval);
          if (interval.end > interval.start && !seenIntervals.has(key)) { data.intervals.push(interval); seenIntervals.add(key); }
        }
      }
      for (const event of events) {
        // Restored streams can stamp inherited lifetime counters at file creation.
        // Their usage cannot be dated; keep only their activity as quota exclusions.
        if (rewritten) { data.coverage.undatedUsage++; continue; }
        const key = JSON.stringify([sid, event.t, event.turn, event.usage]);
        if (seenEvents.has(key)) { data.coverage.duplicateEvents++; continue; }
        seenEvents.add(key); data.events.push(event);
      }
      for (const snapshot of snapshots) {
        snapshot.reliable = !rewritten;
        const key = JSON.stringify([sid, snapshot.t, snapshot.limitId, snapshot.windowMinutes, snapshot.resetsAt, snapshot.usedPercent]);
        if (!seenSnapshots.has(key)) { data.snapshots.push(snapshot); seenSnapshots.add(key); }
      }
      if (events.length || snapshots.length) {
        const old = sessionMap.get(sid);
        sessionMap.set(sid, { id: sid, title, parent, project: file.project, sources: [...(old?.sources ?? []), source] });
      }
    }
  }
  data.sessions = [...sessionMap.values()];
  // A resumed/archived copy can overlap an earlier file's activity span.
  const merged: ActivityInterval[] = [];
  for (const interval of data.intervals.sort((a, b) => a.sessionId.localeCompare(b.sessionId) || (a.turn ?? "").localeCompare(b.turn ?? "") || dimensionKey(a).localeCompare(dimensionKey(b)) || a.start - b.start)) {
    const last = merged.at(-1);
    if (last && last.sessionId === interval.sessionId && last.turn === interval.turn && dimensionKey(last) === dimensionKey(interval) && interval.start <= last.end) {
      last.end = Math.max(last.end, interval.end); last.partial ||= interval.partial;
    } else merged.push({ ...interval });
  }
  data.intervals = merged;
  data.events.sort((a, b) => a.t - b.t);
  return data;
}
