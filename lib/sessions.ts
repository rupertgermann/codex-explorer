import { spawn } from "node:child_process";
import { createReadStream, existsSync, lstatSync, openSync, closeSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";

export type SessionProvenance = "user" | "codex" | "automation" | "unknown";

export type SessionSummary = {
  id: string;
  path: string;
  filename: string;
  startedAt: number;
  modifiedAt: number;
  size: number;
  cwd: string;
  project: string;
  source: string;
  originator: string;
  provenance: SessionProvenance;
  parentThreadId: string;
};

export type SessionSearchMatch = {
  line: number;
  kind: "user" | "assistant" | "tool" | "metadata" | "raw";
  excerpt: string;
};

export type SessionSearchResult = SessionSummary & {
  matches: SessionSearchMatch[];
};

export type SessionCatalog = {
  root: string;
  indexedAt: number;
  sessions: SessionSummary[];
  totals: { sessions: number; bytes: number; projects: number; activeDays: number };
  months: { month: string; sessions: number; bytes: number }[];
  topProjects: { project: string; sessions: number; bytes: number }[];
};

export type SessionEntry = {
  id: string;
  timestamp: number;
  kind: "user" | "assistant" | "tool";
  phase?: string;
  text?: string;
  name?: string;
  detail?: string;
  truncated?: boolean;
};

export type SessionDetail = SessionSummary & {
  title: string;
  model: string;
  effort: string;
  entries: SessionEntry[];
  metrics: {
    events: number;
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    durationMs: number;
    scannedBytes: number;
    skippedLines: number;
  };
  eventTypes: { type: string; count: number }[];
  truncation: {
    scanLimitReached: boolean;
    entryLimitReached: boolean;
    oversizedRecords: number;
    invalidRecords: number;
  };
  truncated: boolean;
};

export type SessionScanUpdate =
  | { type: "entry"; entry: SessionEntry }
  | { type: "progress"; scannedBytes: number; totalBytes: number };

export type RawSessionPage = {
  path: string;
  offset: number;
  bytes: number;
  byteLimit: number;
  fileSize: number;
  previousOffset: number | null;
  nextOffset: number | null;
  startsMidLine: boolean;
  endsMidLine: boolean;
  text: string;
};

type JsonRecord = {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
};

const DETAIL_SCAN_LIMIT = 32 * 1024 * 1024;
const LINE_SIZE_LIMIT = 2 * 1024 * 1024;
const ENTRY_LIMIT = 1_500;
const FULL_ENTRY_LIMIT = 20_000;
const ENTRY_TEXT_LIMIT = 100_000;
const SEARCH_TIMEOUT_MS = 20_000;
const PROGRESS_INTERVAL = 4 * 1024 * 1024;
const sessionCatalogCache = new Map<string, SessionCatalog>();

export class SessionPathError extends Error {
  constructor(message = "The requested JSONL file is outside the sessions directory.") {
    super(message);
    this.name = "SessionPathError";
  }
}

export class SessionSearchError extends Error {
  constructor(message = "The session search could not be completed.") {
    super(message);
    this.name = "SessionSearchError";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function string(value: unknown) {
  return typeof value === "string" ? value : "";
}

function timestamp(value: unknown, fallback: number) {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sessionPaths(root: string, directory = root): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sessionPaths(root, path);
    if (!entry.isFile() || extname(entry.name).toLowerCase() !== ".jsonl") return [];
    return [relative(root, path)];
  });
}

function firstRecord(path: string): JsonRecord | null {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(128 * 1024);
    const bytes = readSync(descriptor, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(10);
    const line = buffer.subarray(0, newline >= 0 ? newline : bytes).toString("utf8");
    return JSON.parse(line) as JsonRecord;
  } catch {
    return null;
  } finally {
    closeSync(descriptor);
  }
}

function projectName(cwd: string) {
  return cwd ? basename(cwd) || cwd : "Unknown";
}

function sessionProvenance(payload: Record<string, unknown>): SessionProvenance {
  const threadSource = string(payload.thread_source);
  if (threadSource === "user") return "user";
  if (threadSource === "subagent") return "codex";
  if (threadSource.includes("automation")) return "automation";
  const source = object(payload.source);
  if (string(payload.parent_thread_id) || Object.keys(object(source.subagent)).length > 0) return "codex";
  return "unknown";
}

function summary(root: string, path: string): SessionSummary {
  const absolutePath = join(root, path);
  const file = statSync(absolutePath);
  const record = firstRecord(absolutePath);
  const payload = record?.type === "session_meta" ? object(record.payload) : {};
  const cwd = string(payload.cwd);
  const parentThreadId = string(payload.parent_thread_id);
  return {
    id: string(payload.id) || basename(path, ".jsonl"),
    path,
    filename: basename(path),
    startedAt: timestamp(record?.timestamp ?? payload.timestamp, file.birthtimeMs || file.mtimeMs),
    modifiedAt: file.mtimeMs,
    size: file.size,
    cwd,
    project: projectName(cwd),
    source: string(payload.source) || "unknown",
    originator: string(payload.originator) || "unknown",
    provenance: sessionProvenance(payload),
    parentThreadId,
  };
}

function clipped(value: string, limit: number) {
  return value.length <= limit ? { value, truncated: false } : { value: `${value.slice(0, limit)}\n\n…`, truncated: true };
}

function completeUtf8PrefixLength(buffer: Buffer, bytes: number) {
  if (bytes === 0) return 0;
  let sequenceStart = bytes - 1;
  while (sequenceStart > 0 && (buffer[sequenceStart] & 0xc0) === 0x80) sequenceStart -= 1;
  const first = buffer[sequenceStart];
  const expected = first < 0x80 ? 1 : first >= 0xc2 && first <= 0xdf ? 2 : first <= 0xef ? 3 : first <= 0xf4 ? 4 : 1;
  return bytes - sequenceStart < expected ? sequenceStart : bytes;
}

export async function scanJsonl(
  path: string,
  byteLimit: number,
  visit: (record: JsonRecord, line: number) => void,
  options: { signal?: AbortSignal; onProgress?: (scannedBytes: number, totalBytes: number) => void } = {},
) {
  const fileSize = statSync(path).size;
  const stream = createReadStream(path, { highWaterMark: 64 * 1024 });
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  let oversized = false;
  let scannedBytes = 0;
  let oversizedRecords = 0;
  let invalidRecords = 0;
  let lastProgress = 0;
  let line = 0;

  const append = (fragment: Buffer) => {
    if (oversized || fragment.length === 0) return;
    if (lineBytes + fragment.length > LINE_SIZE_LIMIT) {
      fragments = [];
      lineBytes = 0;
      oversized = true;
      return;
    }
    fragments.push(fragment);
    lineBytes += fragment.length;
  };

  const finishLine = () => {
    line += 1;
    if (oversized) {
      oversizedRecords += 1;
    } else if (lineBytes > 0) {
      try {
        visit(JSON.parse(Buffer.concat(fragments, lineBytes).toString("utf8")) as JsonRecord, line);
      } catch {
        invalidRecords += 1;
      }
    }
    fragments = [];
    lineBytes = 0;
    oversized = false;
  };

  for await (const rawChunk of stream) {
    if (options.signal?.aborted) throw new DOMException("Session scan cancelled.", "AbortError");
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    const remaining = byteLimit - scannedBytes;
    if (remaining <= 0) break;
    const usable = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
    scannedBytes += usable.length;
    let start = 0;
    for (let index = 0; index < usable.length; index += 1) {
      if (usable[index] !== 10) continue;
      append(usable.subarray(start, index));
      finishLine();
      start = index + 1;
    }
    append(usable.subarray(start));
    if (scannedBytes - lastProgress >= PROGRESS_INTERVAL) {
      lastProgress = scannedBytes;
      options.onProgress?.(scannedBytes, fileSize);
    }
    if (usable.length < chunk.length || scannedBytes >= byteLimit) break;
  }

  const scanLimitReached = scannedBytes < fileSize;
  if (!scanLimitReached) {
    finishLine();
  }
  options.onProgress?.(scannedBytes, fileSize);
  return {
    scannedBytes,
    oversizedRecords,
    invalidRecords,
    skippedLines: oversizedRecords + invalidRecords,
    scanLimitReached,
  };
}

function searchExcerpt(value: string, query: string) {
  const text = value.replace(/\s+/g, " ").trim();
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text.slice(0, 280);
  const start = Math.max(0, index - 100);
  const end = Math.min(text.length, index + query.length + 160);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

function conversationMessage(record: JsonRecord): { kind: "user" | "assistant"; text: string; phase?: string } | null {
  const payload = object(record.payload);
  const phase = string(payload.phase) || undefined;
  if (record.type === "event_msg" && (payload.type === "user_message" || payload.type === "agent_message")) {
    const text = string(payload.message);
    return text ? { kind: payload.type === "user_message" ? "user" : "assistant", text, phase } : null;
  }
  if (record.type !== "response_item" || payload.type !== "message" || (payload.role !== "user" && payload.role !== "assistant") || !Array.isArray(payload.content)) return null;

  const kinds = object(payload.internal_chat_message_metadata_passthrough).content_item_kinds;
  const text = payload.content.flatMap((value, index) => {
    const part = object(value);
    const kind = Array.isArray(kinds) ? string(kinds[index]) : "";
    // User-role records also carry injected workspace context, tagged separately from user input.
    if (payload.role === "user" && kind && kind !== "unknown" && !kind.startsWith("user.")) return [];
    return part.type === "input_text" || part.type === "output_text" ? [string(part.text)].filter(Boolean) : [];
  }).join("\n\n");
  return text ? { kind: payload.role, text, phase } : null;
}

function sessionSearchMatch(rawLine: string, line: number, query: string): SessionSearchMatch {
  try {
    const record = JSON.parse(rawLine) as JsonRecord;
    const recordType = string(record.type);
    const payload = object(record.payload);
    const payloadType = string(payload.type);
    const message = conversationMessage(record);
    if (message && message.text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return { line, kind: message.kind, excerpt: searchExcerpt(message.text, query) };
    if (recordType === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType.endsWith("_call"))) {
      const detail = `${string(payload.name) || payloadType} ${string(payload.arguments) || string(payload.input)}`;
      return { line, kind: "tool", excerpt: searchExcerpt(detail, query) };
    }
    if (recordType === "session_meta") {
      const detail = [string(payload.id), string(payload.cwd), string(payload.source), string(payload.originator)].filter(Boolean).join(" · ");
      return { line, kind: "metadata", excerpt: searchExcerpt(detail, query) };
    }
  } catch {
    // A bounded ripgrep excerpt may contain only part of a very large JSONL record.
  }
  const readable = rawLine.replaceAll("\\n", " ").replaceAll('\\"', '"').replace(/[{}[\]]/g, " ");
  return { line, kind: "raw", excerpt: searchExcerpt(readable, query) };
}

function ripgrepMatches(root: string, query: string): Promise<Map<string, SessionSearchMatch[]>> {
  return new Promise((resolvePromise, reject) => {
    const escaped = query.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    const pattern = `.{0,120}${escaped}.{0,160}`;
    const process = spawn("rg", ["--json", "--ignore-case", "--only-matching", "--max-count", "3", "--sortr", "path", "--glob", "*.jsonl", "--", pattern, root], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const results = new Map<string, SessionSearchMatch[]>();
    let stdout = "";
    let stderr = "";
    let stoppedEarly = false;

    const accept = (line: string) => {
      if (!line) return;
      try {
        const message = JSON.parse(line) as {
          type?: string;
          data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
        };
        if (message.type !== "match") return;
        const path = message.data?.path?.text;
        const rawLine = message.data?.lines?.text;
        const lineNumber = message.data?.line_number;
        if (!path || !rawLine || !lineNumber) return;
        if (!results.has(path) && results.size >= 100) {
          stoppedEarly = true;
          process.kill("SIGTERM");
          return;
        }
        const matches = results.get(path) ?? [];
        if (matches.length < 3) matches.push(sessionSearchMatch(rawLine.trim(), lineNumber, query));
        results.set(path, matches);
      } catch {
        // Ignore malformed diagnostic lines; valid match records remain usable.
      }
    };

    const timeout = setTimeout(() => {
      process.kill("SIGTERM");
      reject(new SessionSearchError("Session search exceeded 20 seconds. Try a more specific phrase."));
    }, SEARCH_TIMEOUT_MS);
    process.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      lines.forEach(accept);
    });
    process.stderr.on("data", (chunk) => { if (stderr.length < 20_000) stderr += chunk.toString(); });
    process.on("error", (error) => {
      clearTimeout(timeout);
      const message = (error as NodeJS.ErrnoException).code === "ENOENT"
        ? "Session search requires ripgrep (`rg`) on PATH."
        : error.message;
      reject(new SessionSearchError(message));
    });
    process.on("close", (code) => {
      clearTimeout(timeout);
      accept(stdout);
      if (code === 0 || code === 1 || stoppedEarly) resolvePromise(results);
      else reject(new SessionSearchError(stderr.trim() || `Session search exited with code ${code}.`));
    });
  });
}

export function codexSessionsRoot() {
  return process.env.CODEX_SESSIONS_DIRECTORY || join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

export class SessionRepository {
  readonly root: string;

  constructor(root = codexSessionsRoot()) {
    this.root = resolve(root);
  }

  catalog(options: { refresh?: boolean } = {}): SessionCatalog {
    const cached = sessionCatalogCache.get(this.root);
    if (cached && !options.refresh) return cached;

    const sessions = sessionPaths(this.root)
      .map((path) => summary(this.root, path))
      .sort((left, right) => right.startedAt - left.startedAt || left.path.localeCompare(right.path));
    const projects = new Map<string, { sessions: number; bytes: number }>();
    const months = new Map<string, { sessions: number; bytes: number }>();
    sessions.forEach((session) => {
      const project = projects.get(session.project) ?? { sessions: 0, bytes: 0 };
      project.sessions += 1; project.bytes += session.size; projects.set(session.project, project);
      const monthName = new Date(session.startedAt).toISOString().slice(0, 7);
      const month = months.get(monthName) ?? { sessions: 0, bytes: 0 };
      month.sessions += 1; month.bytes += session.size; months.set(monthName, month);
    });
    const catalog = {
      root: this.root,
      indexedAt: Date.now(),
      sessions,
      totals: {
        sessions: sessions.length,
        bytes: sessions.reduce((total, session) => total + session.size, 0),
        projects: projects.size,
        activeDays: new Set(sessions.map((session) => new Date(session.startedAt).toISOString().slice(0, 10))).size,
      },
      months: [...months.entries()]
        .map(([month, values]) => ({ month, ...values }))
        .sort((left, right) => right.month.localeCompare(left.month)),
      topProjects: [...projects.entries()]
        .map(([project, values]) => ({ project, ...values }))
        .sort((left, right) => right.sessions - left.sessions || right.bytes - left.bytes || left.project.localeCompare(right.project))
        .slice(0, 20),
    };
    sessionCatalogCache.set(this.root, catalog);
    return catalog;
  }

  async search(query: string): Promise<SessionSearchResult[]> {
    const needle = query.trim();
    if (!needle) return [];
    const matches = await ripgrepMatches(this.root, needle);
    const priority: Record<SessionSearchMatch["kind"], number> = { user: 0, assistant: 1, tool: 2, metadata: 3, raw: 4 };
    return [...matches.entries()]
      .map(([absolutePath, context]) => ({
        ...summary(this.root, relative(this.root, absolutePath)),
        matches: context.sort((left, right) => priority[left.kind] - priority[right.kind] || left.line - right.line),
      }))
      .sort((left, right) => right.startedAt - left.startedAt || left.path.localeCompare(right.path))
      .slice(0, 100);
  }

  rawPage(path: string, options: { offset?: number; byteLimit?: number } = {}): RawSessionPage {
    const absolutePath = this.resolveSessionPath(path);
    const fileSize = statSync(absolutePath).size;
    const byteLimit = Math.min(512 * 1024, Math.max(64, Math.floor(options.byteLimit ?? 256 * 1024)));
    let offset = Math.min(fileSize, Math.max(0, Math.floor(options.offset ?? 0)));
    const descriptor = openSync(absolutePath, "r");
    let buffer = Buffer.alloc(0);
    let bytes = 0;
    let previousByte = 10;
    try {
      if (offset > 0 && offset < fileSize) {
        const probe = Buffer.alloc(Math.min(4, fileSize - offset));
        const probeBytes = readSync(descriptor, probe, 0, probe.length, offset);
        let skippedContinuationBytes = 0;
        while (skippedContinuationBytes < probeBytes && (probe[skippedContinuationBytes] & 0xc0) === 0x80) skippedContinuationBytes += 1;
        offset += skippedContinuationBytes;
      }
      buffer = Buffer.alloc(Math.min(byteLimit, fileSize - offset));
      bytes = buffer.length > 0 ? readSync(descriptor, buffer, 0, buffer.length, offset) : 0;
      bytes = completeUtf8PrefixLength(buffer, bytes);
      if (offset > 0) {
        const previous = Buffer.alloc(1);
        readSync(descriptor, previous, 0, 1, offset - 1);
        previousByte = previous[0];
      }
    } finally {
      closeSync(descriptor);
    }
    const nextOffset = offset + bytes < fileSize ? offset + bytes : null;
    return {
      path: relative(this.root, absolutePath),
      offset,
      bytes,
      byteLimit,
      fileSize,
      previousOffset: offset > 0 ? Math.max(0, offset - byteLimit) : null,
      nextOffset,
      startsMidLine: offset > 0 && previousByte !== 10,
      endsMidLine: nextOffset !== null && bytes > 0 && buffer[bytes - 1] !== 10,
      text: buffer.subarray(0, bytes).toString("utf8"),
    };
  }

  async read(path: string): Promise<SessionDetail> {
    return this.inspect(path, DETAIL_SCAN_LIMIT, ENTRY_LIMIT);
  }

  async scanFull(path: string, onUpdate?: (update: SessionScanUpdate) => void, signal?: AbortSignal): Promise<SessionDetail> {
    return this.inspect(path, Number.POSITIVE_INFINITY, FULL_ENTRY_LIMIT, onUpdate, signal);
  }

  private async inspect(
    path: string,
    byteLimit: number,
    entryLimit: number,
    onUpdate?: (update: SessionScanUpdate) => void,
    signal?: AbortSignal,
  ): Promise<SessionDetail> {
    const absolutePath = this.resolveSessionPath(path);
    const base = summary(this.root, relative(this.root, absolutePath));
    const fileSize = statSync(absolutePath).size;
    const entries: SessionEntry[] = [];
    const eventTypes = new Map<string, number>();
    let model = "unknown";
    let effort = "unknown";
    let events = 0;
    let userMessages = 0;
    let assistantMessages = 0;
    let toolCalls = 0;
    let firstTimestamp = base.startedAt;
    let lastTimestamp = base.startedAt;
    let entriesTruncated = false;
    let previousMessage: { source: string; kind: string; text: string; phase?: string; entry?: SessionEntry } | null = null;

    const flushMessage = () => {
      if (previousMessage?.entry) onUpdate?.({ type: "entry", entry: previousMessage.entry });
      previousMessage = null;
    };

    const addEntry = (entry: Omit<SessionEntry, "id">, emit = true) => {
      if (entries.length >= entryLimit) {
        entriesTruncated = true;
        return;
      }
      const identified = { ...entry, id: `${events}-${entries.length}` };
      entries.push(identified);
      if (emit) onUpdate?.({ type: "entry", entry: identified });
      return identified;
    };

    const scan = await scanJsonl(absolutePath, Math.min(fileSize, byteLimit), (record) => {
      events += 1;
      const recordType = string(record.type) || "unknown";
      const payload = object(record.payload);
      const payloadType = string(payload.type);
      const type = payloadType ? `${recordType}:${payloadType}` : recordType;
      eventTypes.set(type, (eventTypes.get(type) ?? 0) + 1);
      const at = timestamp(record.timestamp, base.startedAt);
      firstTimestamp = Math.min(firstTimestamp, at);
      lastTimestamp = Math.max(lastTimestamp, at);

      if (recordType === "turn_context") {
        model = string(payload.model) || model;
        effort = string(payload.effort) || effort;
      }
      if (recordType === "turn_context" || (recordType === "event_msg" && payloadType === "task_started")) flushMessage();
      const message = conversationMessage(record);
      if (message) {
        // Some archives mirror a message in both formats; repeated prompts remain separate.
        if (previousMessage && previousMessage.source !== recordType && previousMessage.kind === message.kind && previousMessage.text === message.text
          && (!previousMessage.phase || !message.phase || previousMessage.phase === message.phase)) {
          if (previousMessage.entry && message.phase) previousMessage.entry.phase = message.phase;
          flushMessage();
          return;
        }
        flushMessage();
        const text = clipped(message.text, ENTRY_TEXT_LIMIT);
        if (message.kind === "user") userMessages += 1; else assistantMessages += 1;
        // Hold one message so its mirrored record can supply phase before streaming it.
        const entry = addEntry({ timestamp: at, kind: message.kind, phase: message.phase, text: text.value, truncated: text.truncated || undefined }, false);
        previousMessage = { source: recordType, ...message, entry };
      }
      if (recordType === "response_item" && (payloadType === "function_call" || payloadType === "custom_tool_call" || payloadType.endsWith("_call"))) {
        flushMessage();
        toolCalls += 1;
        const rawDetail = string(payload.arguments) || string(payload.input);
        const detail = clipped(rawDetail, 1_200);
        addEntry({
          timestamp: at,
          kind: "tool",
          name: string(payload.name) || payloadType,
          detail: detail.value || undefined,
          truncated: detail.truncated || undefined,
        });
      }
    }, {
      signal,
      onProgress: (scannedBytes, totalBytes) => onUpdate?.({ type: "progress", scannedBytes, totalBytes }),
    });
    flushMessage();

    const firstUserMessage = entries.find((entry) => entry.kind === "user")?.text ?? "Untitled session";
    const title = firstUserMessage.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160) || "Untitled session";
    return {
      ...base,
      title,
      model,
      effort,
      entries,
      metrics: {
        events,
        userMessages,
        assistantMessages,
        toolCalls,
        durationMs: Math.max(0, lastTimestamp - firstTimestamp),
        scannedBytes: scan.scannedBytes,
        skippedLines: scan.skippedLines,
      },
      eventTypes: [...eventTypes.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((left, right) => right.count - left.count || left.type.localeCompare(right.type)),
      truncation: {
        scanLimitReached: scan.scanLimitReached,
        entryLimitReached: entriesTruncated,
        oversizedRecords: scan.oversizedRecords,
        invalidRecords: scan.invalidRecords,
      },
      truncated: scan.scanLimitReached || entriesTruncated || scan.skippedLines > 0,
    };
  }

  private resolveSessionPath(path: string) {
    const absolutePath = resolve(this.root, path);
    if (!absolutePath.startsWith(`${this.root}${sep}`) || extname(absolutePath).toLowerCase() !== ".jsonl") throw new SessionPathError();
    if (!existsSync(absolutePath) || !lstatSync(absolutePath).isFile()) throw new SessionPathError("The requested session file does not exist.");
    return absolutePath;
  }
}
