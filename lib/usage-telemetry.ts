import { setImmediate } from "node:timers/promises";
import { SessionFileCache, sessionFileRevision } from "./session-file-cache.ts";
import { scanJsonl, type JsonRecord } from "./sessions.ts";
import { TOKEN_FIELDS } from "./usage-report.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const scalar = (value: unknown) => value === null || ["string", "number", "boolean"].includes(typeof value) ? value : false;
const fields = (value: unknown, keys: readonly string[]) => {
  const row = object(value);
  return Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, scalar(row[key])]));
};
const counters = (value: unknown) => Object.keys(object(value)).length ? { _present: true, ...fields(value, TOKEN_FIELDS) } : {};
const settings = (value: unknown) => {
  const row = object(value);
  return { ...fields(row, ["model", "effort", "reasoning_effort", "service_tier", "speed"]),
    collaboration_mode: { settings: fields(object(row.collaboration_mode).settings, ["model", "reasoning_effort"]) } };
};

/** Retain accounting evidence only; ordinary content contributes just its timestamp. */
function telemetry(record: JsonRecord): JsonRecord {
  const p = object(record.payload);
  const base = { timestamp: scalar(record.timestamp) };
  switch (record.type) {
    case "session_meta": {
      const spawn = fields(object(object(p.source).subagent).thread_spawn, ["parent_thread_id", "agent_path", "agent_nickname"]);
      return { ...base, type: record.type, payload: { ...fields(p, ["id", "session_id", "parent_thread_id", "timestamp"]),
        forked_from_id: Boolean(p.forked_from_id), source: { subagent: { thread_spawn: spawn } } } };
    }
    case "compacted":
      return { ...base, type: record.type, payload: { ...fields(p, ["compaction_response_id"]), latest_token_usage_record: {
        ...fields(p.latest_token_usage_record, ["thread_id"]), thread_token_usage: counters(object(p.latest_token_usage_record).thread_token_usage) } } };
    case "token_usage_record":
      return { ...base, type: record.type, payload: { ...fields(p, ["response_id", "turn_id", "model"]),
        usage: counters(p.usage), thread_token_usage: counters(p.thread_token_usage) } };
    case "turn_context":
      return { ...base, type: record.type, payload: { ...settings(p), ...fields(p, ["turn_id"]) } };
    case "event_msg": {
      switch (p.type) {
        case "thread_settings_applied":
          return { ...base, type: record.type, payload: { ...fields(p, ["type", "thread_id"]), thread_settings: settings(p.thread_settings) } };
        case "task_started": case "task_complete": case "task_completed": case "turn_aborted":
          return { ...base, type: record.type, payload: fields(p, ["type", "turn_id", "started_at", "completed_at"]) };
        case "token_count": {
          const limits = object(p.rate_limits), info = object(p.info);
          return { ...base, type: record.type, payload: { type: p.type,
            info: { total_token_usage: counters(info.total_token_usage), last_token_usage: counters(info.last_token_usage) },
            rate_limits: { ...fields(limits, ["limit_id"]), primary: fields(limits.primary, ["used_percent", "resets_at", "window_minutes"]),
              secondary: fields(limits.secondary, ["used_percent", "resets_at", "window_minutes"]) } } };
        }
      }
    }
  }
  return base;
}

type Evidence = { records: { record: JsonRecord; line: number }[]; skippedLines: number };
// No raw content or date-clipped results. Oversized files stream without being retained.
const evidenceCache = new SessionFileCache<Evidence>(64 * 1024 * 1024);
export const pruneUsageTelemetry = (root: string, paths: Set<string>) => evidenceCache.prune(root, paths);

export async function scanUsageTelemetry(path: string, visit: (record: JsonRecord, line: number) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const revision = sessionFileRevision(path);
  const cached = evidenceCache.get(path, revision);
  if (cached) {
    for (let i = 0; i < cached.records.length; i++) {
      if (i % 512 === 0) { await setImmediate(); signal?.throwIfAborted(); }
      const { record, line } = cached.records[i];
      visit(record, line);
    }
    signal?.throwIfAborted();
    return { skippedLines: cached.skippedLines };
  }
  let records: Evidence["records"] = [], bytes = 0, retain = true;
  const scan = await scanJsonl(path, Infinity, (raw, line) => {
    const record = telemetry(raw);
    visit(record, line);
    if (!retain) return;
    bytes += Buffer.byteLength(JSON.stringify(record)) + 128;
    if (bytes > evidenceCache.budget) { retain = false; records = []; }
    else records.push({ record, line });
  }, { signal, maxRecordBytes: 32 * 1024 * 1024 });
  signal?.throwIfAborted();
  if (retain && sessionFileRevision(path) === revision) evidenceCache.set(path, revision, { records, skippedLines: scan.skippedLines }, bytes + 128);
  return scan;
}
