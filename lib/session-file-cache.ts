import { statSync } from "node:fs";
import { sep } from "node:path";

export function sessionFileRevision(path: string) {
  const file = statSync(path, { bigint: true });
  return [file.dev, file.ino, file.size, file.mtimeNs, file.ctimeNs].join(":");
}

/** Bounded process-local cache; scan resistance protects reused entries from one-pass admissions. */
export class SessionFileCache<T> {
  private entries = new Map<string, { revision: string; value: T; bytes: number }>();
  private bytes = 0;
  private probationaryPath: string | undefined;
  private readonly policy: "lru" | "scan-resistant";
  readonly budget: number;
  constructor(budget: number, policy: "lru" | "scan-resistant" = "lru") { this.budget = budget; this.policy = policy; }

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
    if (this.bytes + bytes > this.budget && this.probationaryPath !== undefined) this.delete(this.probationaryPath);
    while (this.bytes + bytes > this.budget && this.entries.size) this.delete(this.entries.keys().next().value!);
    this.entries.set(path, { revision, value, bytes });
    this.bytes += bytes;
    if (this.policy === "scan-resistant") this.probationaryPath = path;
  }

  prune(root: string, paths: Set<string>) {
    const prefix = root.endsWith(sep) ? root : root + sep;
    for (const path of this.entries.keys()) if (path.startsWith(prefix) && !paths.has(path)) this.delete(path);
  }

  retain(paths: Set<string>) {
    for (const path of this.entries.keys()) if (!paths.has(path)) this.delete(path);
  }

  private delete(path: string) {
    if (this.probationaryPath === path) this.probationaryPath = undefined;
    const entry = this.entries.get(path);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(path);
  }
}
