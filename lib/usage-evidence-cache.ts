import { createHash, randomUUID } from "node:crypto";
import { closeSync, fstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setImmediate } from "node:timers/promises";
import { deserialize, serialize } from "node:v8";
import { sessionFileRevision } from "./session-file-cache.ts";
import type { JsonRecord } from "./sessions.ts";

export type Evidence = { records: { record: JsonRecord; line: number }[]; skippedLines: number };
export const EVIDENCE_BUDGET = 64 * 1024 * 1024;
// Bump when telemetry normalization or timestamp compaction changes.
const VERSION = 1;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();
const cachePath = (directory: string, source: string) => join(directory, createHash("sha256").update(resolve(source)).digest("hex") + ".bin");

export function readUsageEvidence(directory: string, source: string, revision: string): { evidence: Evidence; bytes: number } | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(cachePath(directory, source), "r");
    const size = fstatSync(fd).size;
    if (size <= 32 || size > EVIDENCE_BUDGET) return;
    const contents = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const read = readSync(fd, contents, offset, size - offset, offset);
      if (!read) return;
      offset += read;
    }
    const payload = contents.subarray(32);
    if (!digest(payload).equals(contents.subarray(0, 32))) return;
    const entry = deserialize(payload);
    if (entry?.version !== VERSION || entry.source !== resolve(source) || entry.revision !== revision
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > EVIDENCE_BUDGET
      || !Number.isSafeInteger(entry.evidence?.skippedLines) || entry.evidence.skippedLines < 0
      || !Array.isArray(entry.evidence.records)) return;
    let previousLine = 0;
    for (const item of entry.evidence.records) {
      if (!Number.isSafeInteger(item?.line) || item.line <= previousLine || item.record === null
        || typeof item.record !== "object" || Array.isArray(item.record)) return;
      previousLine = item.line;
    }
    return { evidence: entry.evidence, bytes: entry.bytes };
  } catch { return; } finally { if (fd !== undefined) closeSync(fd); }
}

export async function writeUsageEvidence(directory: string, source: string, revision: string, evidence: Evidence, bytes: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (bytes > EVIDENCE_BUDGET) return false;
  const target = cachePath(directory, source), temporary = `${target}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const payload = serialize({ version: VERSION, source: resolve(source), revision, evidence, bytes });
    if (payload.length + 32 > EVIDENCE_BUDGET) return false;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(temporary, Buffer.concat([digest(payload), payload]), { flag: "wx", mode: 0o600 });
    await setImmediate();
    signal?.throwIfAborted();
    if (sessionFileRevision(source) === revision) { renameSync(temporary, target); published = true; }
  } catch { /* A disposable cache must not prevent a report. */ }
  finally { try { unlinkSync(temporary); } catch { /* Published or never created. */ } }
  signal?.throwIfAborted();
  return published;
}
