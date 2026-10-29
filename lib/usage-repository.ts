import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { atomicMemoryWrite } from "./memory.ts";
import { SessionRepository, scanJsonl, sessionFileKey } from "./sessions.ts";
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
  if (row.total_tokens === undefined) result.total_tokens = result.input_tokens + result.output_tokens;
  return result;
}

const sameTokens = (a: Tokens, b: Tokens) => TOKEN_FIELDS.every(key => a[key] === b[key]);
const validTokens = (usage: Tokens) => usage.total_tokens === usage.input_tokens + usage.output_tokens && usage.cached_input_tokens <= usage.input_tokens && usage.reasoning_output_tokens <= usage.output_tokens;
type CompactionRequest = { event: UsageEvent; threadUsage: Tokens | null; owned: boolean; coveringCounter: Pick<UsageEvent, "t" | "turn"> | null; rewritten?: boolean };

type Turn = { start?: number; end?: number; actualStart?: number; actualEnd?: number; last: number; firstEvent?: number; contexts: (Dimensions & { t: number })[] };

type UsageOptions = { home?: string; roots?: string[]; signal?: AbortSignal };

function usageSource(options: UsageOptions) {
  const home = resolve(options.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex"));
  const roots = [...new Set((options.roots ?? [process.env.CODEX_SESSIONS_DIRECTORY ?? join(home, "sessions"), process.env.CODEX_ARCHIVED_SESSIONS_DIRECTORY ?? join(home, "archived_sessions")]).map(root => resolve(root)))];
  return { home, roots };
}

function usageCachePath(options: UsageOptions) {
  const key = createHash("sha256").update(JSON.stringify({ ...usageSource(options), format: 3 })).digest("hex");
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
  const seenFiles = new Set<string>();
  const compactions = new Map<string, CompactionRequest>();
  const accountedCompactions = new Set<string>();
  const initialSnapshots: { event: UsageEvent; total: Tokens; last: Tokens }[] = [];
  const counterSnapshots: { sessionId: string; source: string; t: number; total: Tokens }[] = [];
  const catalogs = await Promise.all(roots.map(async root => ({ root, sessions: (await new SessionRepository(root).catalog({ refresh: true })).sessions })));
  const sourcesBySession = Map.groupBy(catalogs.flatMap(catalog => catalog.sessions), session => session.id);
  const repeatedSessions = new Set([...sourcesBySession].filter(([, files]) => files.length > 1).map(([id]) => id));
  for (const { root, sessions } of catalogs) {
    for (const file of sessions) {
      const key = sessionFileKey(file.path);
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      options.signal?.throwIfAborted();
      data.coverage.files++;
      if (file.startedAt / 1000 >= until) continue;
      data.coverage.scanned++;
      const source = join(root, file.path), turns = new Map<string, Turn>();
      const requests = new Map<string, CompactionRequest>(), compacted = new Set<string>();
      let latestResponse = "";
      let inheritedCounter: Tokens | null = null;
      const events: UsageEvent[] = [], snapshots: UsageData["snapshots"] = [];
      let sid = file.id, parent = file.parentThreadId, title = names.get(sid) || sid;
      let current = { ...unknown }, turnId = "unknown", previous: Tokens | null = null;
      let created = file.startedAt / 1000, forked = false, owned = true, rewritten = false;
      const getTurn = () => {
        if (!turns.has(turnId)) turns.set(turnId, { last: 0, contexts: [] });
        return turns.get(turnId)!;
      };
      const datedUsage = (event: Pick<UsageEvent, "t" | "turn">) => {
        if (!rewritten) return true;
        const turn = turns.get(event.turn);
        return turn?.actualStart !== undefined && turn.actualEnd !== undefined && turn.actualStart >= Math.floor(created)
          && event.t >= turn.actualStart - 2 && event.t <= turn.actualEnd + 2;
      };
      const scan = await scanJsonl(source, Infinity, (record, line) => {
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
        if (record.type === "compacted") {
          const responseId = string(p.compaction_response_id).trim();
          if (responseId) compacted.add(responseId);
          const latest = object(p.latest_token_usage_record);
          if (!previous && parent && string(latest.thread_id) && latest.thread_id !== sid) inheritedCounter = tokens(latest.thread_token_usage);
          return;
        }
        if (!Number.isFinite(t)) { data.coverage.missingTime++; return; }
        if (record.type === "token_usage_record") {
          const responseId = string(p.response_id).trim(), usage = tokens(p.usage);
          if (!responseId || !usage || !validTokens(usage) || !usage.total_tokens || requests.has(responseId)) return;
          const requestTurn = string(p.turn_id) || turnId;
          const context = turns.get(requestTurn)?.contexts.at(-1) ?? current;
          requests.set(responseId, { event: { ...context, model: string(p.model) || context.model, t, sessionId: sid, turn: requestTurn, usage, source, line, responseId },
            threadUsage: tokens(p.thread_token_usage), owned, coveringCounter: null });
          latestResponse = responseId;
          return;
        }
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
          if (Number.isFinite(actual)) turn.actualStart = actual;
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
          if (Number.isFinite(start)) turn.actualStart ??= start;
          if (Number.isFinite(actual)) turn.actualEnd = actual;
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
        if (repeatedSessions.has(sid) && t < until && (!previous || !sameTokens(previous, total))) counterSnapshots.push({ sessionId: sid, source, t, total });
        if (!previous && inheritedCounter && sameTokens(inheritedCounter, total)) { previous = total; return; }
        if (!owned) { previous = total; return; } // Baseline inherited counters without counting them.
        const initial = previous === null;
        const delta = emptyTokens();
        // A fork can start with parent lifetime counters without replaying its history.
        const first = forked ? tokens(object(p.info).last_token_usage) : total;
        if (!previous && !first) {
          previous = total;
          if (t >= since && t < until) data.coverage.undatedUsage++;
          return;
        }
        for (const key of TOKEN_FIELDS) delta[key] = !previous ? (first ?? total)[key] : total.total_tokens < previous.total_tokens ? total[key] : total[key] - previous[key];
        previous = total;
        if (delta.total_tokens === 0) return;
        if (TOKEN_FIELDS.some(k => delta[k] < 0) || delta.total_tokens !== delta.input_tokens + delta.output_tokens || delta.cached_input_tokens > delta.input_tokens || delta.reasoning_output_tokens > delta.output_tokens) {
          if (t >= since && t < until) data.coverage.invalidUsage++;
          return;
        }
        const pending = requests.get(latestResponse);
        if (pending && (sameTokens(pending.event.usage, delta) || pending.threadUsage && sameTokens(pending.threadUsage, total))) pending.coveringCounter ??= { t, turn: turnId };
        const turn = getTurn();
        turn.firstEvent = Math.min(turn.firstEvent ?? t, t);
        if (t >= since && t < until) {
          const event: UsageEvent = { ...current, t, sessionId: sid, turn: turnId, usage: delta, source, line };
          events.push(event);
          const last = tokens(object(p.info).last_token_usage);
          if (initial && !forked && last && validTokens(last)) initialSnapshots.push({ event, total, last });
        }
      }, { signal: options.signal, maxRecordBytes: 32 * 1024 * 1024 });
      data.coverage.skippedRecords += scan.skippedLines;
      if (rewritten) data.coverage.rewrittenSessions++;
      for (const responseId of compacted) {
        const request = requests.get(responseId);
        if (!request) continue;
        request.rewritten = !datedUsage(request.event);
        if (request.coveringCounter && datedUsage(request.coveringCounter)) accountedCompactions.add(responseId);
        const previous = compactions.get(responseId);
        if (!previous || request.event.t < previous.event.t || request.event.t === previous.event.t && request.owned && !previous.owned) compactions.set(responseId, request);
      }
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
        if (!datedUsage(event)) { data.coverage.undatedUsage++; continue; }
        data.events.push(event);
      }
      for (const snapshot of snapshots) {
        snapshot.reliable = !rewritten;
        const key = JSON.stringify([sid, snapshot.t, snapshot.limitId, snapshot.windowMinutes, snapshot.resetsAt, snapshot.usedPercent]);
        if (!seenSnapshots.has(key)) { data.snapshots.push(snapshot); seenSnapshots.add(key); }
      }
      if (events.length || snapshots.length || compacted.size) {
        const old = sessionMap.get(sid);
        sessionMap.set(sid, { id: sid, title, parent, project: file.project, sources: [...(old?.sources ?? []), source] });
      }
    }
  }
  // Resumed segments can retain the same session ID and start at a prior file's lifetime total.
  const priorBySession = Map.groupBy(counterSnapshots, snapshot => snapshot.sessionId);
  for (const initial of initialSnapshots) {
    const baseline = emptyTokens();
    for (const key of TOKEN_FIELDS) baseline[key] = initial.total[key] - initial.last[key];
    if (TOKEN_FIELDS.some(key => baseline[key] < 0)) continue;
    const prior = priorBySession.get(initial.event.sessionId) ?? [];
    if (prior.some(snapshot => snapshot.source !== initial.event.source && snapshot.t < initial.event.t && sameTokens(snapshot.total, baseline))) initial.event.usage = initial.last;
  }
  for (const [responseId, request] of compactions) {
    const event = request.event;
    if (!request.owned || accountedCompactions.has(responseId) || event.t < since || event.t >= until) continue;
    if (request.rewritten) { data.coverage.undatedUsage++; continue; }
    data.events.push(event);
  }
  data.events = data.events.filter(event => {
    const key = JSON.stringify([event.sessionId, event.t, event.turn, event.responseId ?? null, event.usage]);
    if (seenEvents.has(key)) { data.coverage.duplicateEvents++; return false; }
    seenEvents.add(key);
    return true;
  });
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
