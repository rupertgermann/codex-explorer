import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, posix, resolve, sep } from "node:path";
import { memoryHash, MemoryConflictError, MemoryRepository, resolveMemoryMarkdownPath } from "./memory.ts";
import { AGGREGATE_MEMORY_PATHS, isAggregateMemoryPath } from "./memory-policy.ts";
import { codexSessionsRoot, SessionRepository, type SessionSummary } from "./sessions.ts";

export type OrphanIncomingReference = {
  path: string;
  line: number;
  excerpt: string;
};

export type OrphanSessionLink = Pick<SessionSummary, "id" | "path" | "filename" | "startedAt" | "project"> & {
  location: "active" | "archived";
};

export type OrphanPositiveMemory = {
  line: number;
  endLine: number;
  content: string;
};

export type OrphanPlan = {
  path: string;
  expectedHash: string;
  eligible: boolean;
  reason: string | null;
  incomingReferences: OrphanIncomingReference[];
  sessionLinks: OrphanSessionLink[];
  positiveMemories: OrphanPositiveMemory[];
};

export type OrphanResult = {
  deletedPath: string;
  revision: string;
  manifestPath: string;
};

export type OrphanConfirmation = Pick<OrphanPlan, "path" | "expectedHash">;

type OrphanServiceOptions = {
  activeSessionsRoot: string;
  archivedSessionsRoot: string;
  backupRoot: string;
};

const DELETE_MARKER = "codex-explorer-forget:";

export function isAggregateMemoryFile(root: string, path: string) {
  if (isAggregateMemoryPath(path)) return true;
  const candidate = statSync(resolveMemoryMarkdownPath(root, path));
  return AGGREGATE_MEMORY_PATHS.some((aggregatePath) => {
    if (!existsSync(join(root, aggregatePath))) return false;
    const aggregate = statSync(resolveMemoryMarkdownPath(root, aggregatePath));
    return aggregate.dev === candidate.dev && aggregate.ino === candidate.ino;
  });
}

function positiveMemories(content: string): OrphanPositiveMemory[] {
  const lines = content.split(/\r?\n/);
  return lines.flatMap((line, index) => {
    if (!/^-\s+\S/.test(line)) return [];
    let end = index + 1;
    while (end < lines.length && !/^(?:-\s+\S|#{1,6}\s+\S)/.test(lines[end])) end += 1;
    const section = lines.slice(index, end).join("\n");
    if (/^-\s+action:\s*delete\b/i.test(section) && section.includes(DELETE_MARKER)) return [];
    return [{ line: index + 1, endLine: end, content: section }];
  });
}

function linkedIds(content: string) {
  const ids = new Set<string>();
  for (const match of content.matchAll(/(?:thread|session|rollout)_id\s*[:=]\s*([a-z0-9][a-z0-9_-]*)/gi)) ids.add(match[1]);
  for (const match of content.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)) ids.add(match[0]);
  return ids;
}

function resolvesToCandidate(target: string, sourcePath: string, candidatePath: string) {
  try {
    const decoded = decodeURIComponent(target.split(/[?#]/, 1)[0]);
    if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return false;
    const relativeTarget = decoded.startsWith("/") ? decoded.slice(1) : posix.join(posix.dirname(sourcePath), decoded);
    return posix.normalize(relativeTarget) === candidatePath;
  } catch {
    return false;
  }
}

export function referencesCandidate(line: string, sourcePath: string, candidatePath: string) {
  if (line.includes(candidatePath)) return true;
  const destinations = [
    ...line.matchAll(/!?\[[^\]]*\]\(\s*<?([^\s)>]+\.md(?:[?#][^\s)>]*)?)>?/gi),
    ...line.matchAll(/^\s*\[[^\]]+\]:\s*<?([^\s>]+\.md(?:[?#][^\s>]*)?)>?/gi),
  ];
  return destinations.some((match) => resolvesToCandidate(match[1], sourcePath, candidatePath));
}

function linkedSessions(root: string, location: OrphanSessionLink["location"], ids: Set<string>, source: string) {
  return new SessionRepository(root).catalog({ refresh: true }).sessions.flatMap((session): OrphanSessionLink[] => {
    const linked = ids.has(session.id) || source.includes(session.path) || source.includes(session.filename);
    return linked ? [{
      id: session.id,
      path: session.path,
      filename: session.filename,
      startedAt: session.startedAt,
      project: session.project,
      location,
    }] : [];
  });
}

export class MemoryOrphanService {
  readonly root: string;
  readonly options: OrphanServiceOptions;

  constructor(root: string, options: Partial<OrphanServiceOptions> = {}) {
    this.root = resolve(root);
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    this.options = {
      activeSessionsRoot: resolve(/* turbopackIgnore: true */ options.activeSessionsRoot ?? codexSessionsRoot()),
      archivedSessionsRoot: resolve(/* turbopackIgnore: true */ options.archivedSessionsRoot ?? process.env.CODEX_ARCHIVED_SESSIONS_DIRECTORY ?? join(codexHome, "archived_sessions")),
      backupRoot: resolve(/* turbopackIgnore: true */ options.backupRoot ?? join(dirname(this.root), "memory-orphan-backups")),
    };
    if (this.options.backupRoot === this.root || this.options.backupRoot.startsWith(`${this.root}${sep}`)) {
      throw new Error("Orphan backups must be stored outside the Memory corpus.");
    }
  }

  inspect(path: string): OrphanPlan {
    const repository = new MemoryRepository(this.root);
    const candidate = repository.read(path);
    if (isAggregateMemoryFile(this.root, candidate.path)) throw new Error(`${candidate.path} is an aggregate Memory file and cannot be deleted.`);
    const incomingReferences = repository.catalog().files
      .filter((file) => file.path !== candidate.path)
      .flatMap((file) => repository.read(file.path).content.split(/\r?\n/).flatMap((line, index) =>
        referencesCandidate(line, file.path, candidate.path) ? [{ path: file.path, line: index + 1, excerpt: line.trim() }] : [],
      ));
    const provenanceSource = [candidate.content, ...incomingReferences.map(({ excerpt }) => excerpt)].join("\n");
    const ids = linkedIds(provenanceSource);
    const sessionLinks = [
      ...linkedSessions(this.options.activeSessionsRoot, "active", ids, provenanceSource),
      ...linkedSessions(this.options.archivedSessionsRoot, "archived", ids, provenanceSource),
    ];
    const entries = positiveMemories(candidate.content);
    const blockers = [
      incomingReferences.length ? `${incomingReferences.length} incoming Memory reference${incomingReferences.length === 1 ? " remains" : "s remain"}.` : "",
      sessionLinks.length ? `${sessionLinks.length} active or archived session link${sessionLinks.length === 1 ? " remains" : "s remain"}; session JSONL files are read-only.` : "",
      entries.length ? `${entries.length} positive Memory entr${entries.length === 1 ? "y remains" : "ies remain"}; use the regular Forget workflow first.` : "",
    ].filter(Boolean);

    return {
      path: candidate.path,
      expectedHash: candidate.hash,
      eligible: blockers.length === 0,
      reason: blockers.length ? blockers.join(" ") : null,
      incomingReferences,
      sessionLinks,
      positiveMemories: entries,
    };
  }

  apply(plan: OrphanPlan, confirmation: OrphanConfirmation): OrphanResult {
    if (confirmation.path !== plan.path || confirmation.expectedHash !== plan.expectedHash) {
      throw new Error("Explicit confirmation of the exact orphan path and revision is required.");
    }
    if (!plan.eligible) throw new Error("This orphan deletion plan is blocked.");
    const repository = new MemoryRepository(this.root);
    const candidate = repository.read(plan.path);
    if (candidate.hash !== plan.expectedHash) throw new MemoryConflictError("The orphan file changed after inspection. Inspect it again.");
    const fresh = this.inspect(plan.path);
    if (!fresh.eligible) throw new MemoryConflictError("The file is no longer an eligible orphan. Inspect it again.");

    const transactionRoot = join(this.options.backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
    const backupPath = join(transactionRoot, "files", fresh.path);
    mkdirSync(dirname(backupPath), { recursive: true });
    writeFileSync(backupPath, candidate.content);
    if (memoryHash(readFileSync(backupPath, "utf8")) !== fresh.expectedHash) throw new Error(`Could not verify backup for ${fresh.path}.`);

    const manifestPath = join(transactionRoot, "manifest.json");
    const manifest = { status: "verified", path: fresh.path, revision: fresh.expectedHash, backupPath };
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const verifiedManifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof manifest;
    if (verifiedManifest.status !== "verified"
      || verifiedManifest.path !== fresh.path
      || verifiedManifest.revision !== fresh.expectedHash
      || verifiedManifest.backupPath !== backupPath) {
      throw new Error(`Could not verify backup manifest for ${fresh.path}.`);
    }

    const finalInspection = this.inspect(plan.path);
    if (!finalInspection.eligible || finalInspection.expectedHash !== plan.expectedHash) {
      throw new MemoryConflictError("The orphan deletion plan became stale during backup. Inspect it again.");
    }
    const absolutePath = resolveMemoryMarkdownPath(this.root, finalInspection.path);
    const quarantinePath = join(dirname(absolutePath), `.${basename(absolutePath)}.${randomUUID()}.orphan-delete`);
    renameSync(absolutePath, quarantinePath);
    try {
      if (memoryHash(readFileSync(quarantinePath, "utf8")) !== plan.expectedHash) {
        throw new MemoryConflictError("The orphan file changed immediately before deletion. Inspect it again.");
      }
      unlinkSync(quarantinePath);
    } catch (error) {
      if (existsSync(quarantinePath) && !existsSync(absolutePath)) renameSync(quarantinePath, absolutePath);
      throw error;
    }
    return { deletedPath: finalInspection.path, revision: finalInspection.expectedHash, manifestPath };
  }
}
