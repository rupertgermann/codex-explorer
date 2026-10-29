import { statSync } from "node:fs";
import { sep } from "node:path";

export function sessionFileRevision(path: string) {
  const file = statSync(path, { bigint: true });
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(":");
}

/** Process-local LRU, bounded by serialized evidence bytes plus per-record overhead. */
export class SessionFileCache<T> {
  private entries = new Map<string, { revision: string; value: T; bytes: number }>();
  private bytes = 0;
  readonly budget: number;
  constructor(budget: number) { this.budget = budget; }

  get(path: string, revision: string): T | undefined {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.delete(path);
    if (entry.revision !== revision) return;
    this.entries.set(path, entry);
    this.bytes += entry.bytes;
    return entry.value;
  }

  set(path: string, revision: string, value: T, bytes: number) {
    this.delete(path);
    if (bytes > this.budget) return;
    while (this.bytes + bytes > this.budget && this.entries.size) this.delete(this.entries.keys().next().value!);
    this.entries.set(path, { revision, value, bytes });
    this.bytes += bytes;
  }

  prune(root: string, paths: Set<string>) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    for (const path of this.entries.keys()) if (path.startsWith(prefix) && !paths.has(path)) this.delete(path);
  }

  private delete(path: string) {
    const entry = this.entries.get(path);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(path);
  }
}
