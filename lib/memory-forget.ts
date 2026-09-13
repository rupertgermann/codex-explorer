import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { openReadonly } from "./database.ts";
import { atomicMemoryWrite, memoryHash, MemoryConflictError, MemoryRepository, resolveMemoryMarkdownPath } from "./memory.ts";
import { codexSessionsRoot, SessionRepository } from "./sessions.ts";

export type ForgetSectionKind = "summary" | "durable" | "raw" | "rollout" | "ad-hoc";

export type ForgetSection = {
  id: string;
  kind: ForgetSectionKind;
  path: string;
  expectedHash: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  content: string;
  match?: "exact" | "related";
  signals?: string[];
};

export type ForgetSelection = {
  summaryLine: number;
  expectedSummaryHash: string;
  confirmedDurableIds?: string[];
};

export type ForgetPlan = {
  fingerprint: string;
  target: string;
  targets: string[];
  actionable: boolean;
  reason: string | null;
  selection: ForgetSelection;
  durableCandidates: ForgetSection[];
  sections: ForgetSection[];
};

export type ProjectForgetSelection = { kind: "project"; directory: string };

export type ProjectForgetPlan = {
  kind: "project";
  selection: ProjectForgetSelection;
  directory: string;
  knownProjectScopes: string[];
  fingerprint: string;
  actionable: boolean;
  reason: string | null;
  blockers: string[];
  sections: ForgetSection[];
  retainedShared: ForgetSection[];
  database: { path: string | null; expectedHash: string | null; rows: Record<string, string | number | null>[] };
  sourceRevisions: { path: string; expectedHash: string }[];
  sessionRevision: string;
  matchedSessionIds: string[];
  untouchedSessionCount: number;
};

export type ForgetResult = {
  changedPaths: string[];
  manifestPath: string;
  rolledBack: boolean;
  tombstonePath: string;
  verification: "suppressed";
};

const ALLOWED_ROOT_FILES = new Map<string, ForgetSectionKind>([
  ["memory_summary.md", "summary"],
  ["MEMORY.md", "durable"],
  ["raw_memories.md", "raw"],
] as const);
const TOMBSTONE_MARKER = "codex-explorer-forget:";

function canonical(content: string) {
  return content
    .replace(/^\s*-\s*/, "")
    .replace(/\[(?:Task\s+\d+|ad-hoc note)\]/gi, "")
    .replace(/(?<![\p{L}\p{N}])(?:\/[\p{L}\p{N}.@+_-]+){2,}/gu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLocaleLowerCase();
}

function significantTerms(content: string) {
  return new Set(canonical(content).split(" ").filter((term) => term.length >= 4));
}

function matchCandidate(section: ForgetSection, target: string, selectedContent: string, threshold = 0.6): ForgetSection | null {
  const candidate = canonical(section.content);
  if (candidate === target) return { ...section, match: "exact", signals: ["exact normalized text"] };
  const targetTerms = significantTerms(target);
  const candidateTerms = significantTerms(candidate);
  const shared = [...targetTerms].filter((term) => candidateTerms.has(term)).length;
  if (shared / Math.max(1, Math.min(targetTerms.size, candidateTerms.size)) < threshold) return null;
  const signals = ["normalized terms"];
  if (/\[ad-hoc note\]/i.test(selectedContent) && /\[ad-hoc note\]/i.test(section.content)) signals.push("ad-hoc marker");
  return { ...section, match: "related", signals };
}

function matchAny(section: ForgetSection, targets: Set<string>, signals: string[] = [], threshold = 0.6) {
  for (const target of targets) {
    const match = matchCandidate(section, target, "", threshold);
    if (match) return { ...match, signals: [...new Set([...(match.signals ?? []), ...signals])] };
  }
  return null;
}

function taskAt(content: string, offset: number, headingLevel: 2 | 3) {
  const matches = [...content.matchAll(new RegExp(`^#{${headingLevel}} Task (\\d+)\\b`, "gm"))];
  return matches.findLast((match) => (match.index ?? 0) <= offset)?.[1] ?? null;
}

function durableProvenance(content: string, sections: ForgetSection[]) {
  const rolloutPaths = new Set<string>();
  const threadIds = new Set<string>();
  const taskNumbers = new Set<string>();
  const groupStarts = [...content.matchAll(/^# Task Group:/gm)].map((match) => match.index ?? 0);

  for (const section of sections) {
    const groupStart = groupStarts.findLast((start) => start <= section.startOffset) ?? 0;
    const groupEnd = groupStarts.find((start) => start > section.startOffset) ?? content.length;
    const group = content.slice(groupStart, groupEnd);
    const taggedTasks = new Set([...section.content.matchAll(/\[Task (\d+)\]/g)].map((match) => match[1]));
    const containingTask = taskAt(group, section.startOffset - groupStart, 2);
    if (containingTask) taggedTasks.add(containingTask);
    for (const taskNumber of taggedTasks) {
      taskNumbers.add(taskNumber);
      const taskStart = group.search(new RegExp(`^## Task ${taskNumber}\\b`, "m"));
      if (taskStart < 0) continue;
      const afterTask = group.slice(taskStart);
      const nextTask = afterTask.slice(1).search(/^## Task \d+\b/m);
      const task = nextTask < 0 ? afterTask : afterTask.slice(0, nextTask + 1);
      for (const match of task.matchAll(/rollout_summaries\/[^\s)]+\.md/g)) rolloutPaths.add(match[0]);
      for (const match of task.matchAll(/thread_id=([a-z0-9-]+)/gi)) threadIds.add(match[1]);
      for (const match of task.matchAll(/rollout-[^\s)]*?([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/gi)) threadIds.add(match[1]);
    }
  }
  return { rolloutPaths, threadIds, taskNumbers };
}

function kindFor(path: string): ForgetSectionKind | null {
  const rootKind = ALLOWED_ROOT_FILES.get(path);
  if (rootKind) return rootKind;
  if (/^rollout_summaries\/[^/]+\.md$/.test(path)) return "rollout";
  if (/^extensions\/ad_hoc\/notes\/[^/]+\.md$/.test(path)) return "ad-hoc";
  return null;
}

function sectionId(section: Omit<ForgetSection, "id">) {
  return memoryHash(`${section.path}:${section.expectedHash}:${section.startOffset}:${section.endOffset}`);
}

function bulletSections(path: string, kind: ForgetSectionKind, content: string): ForgetSection[] {
  const fileHash = memoryHash(content);
  const lines = content.match(/.*(?:\r?\n|$)/g)?.filter(Boolean) ?? [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
  }

  return lines.flatMap((line, index) => {
    if (!/^-\s+\S/.test(line)) return [];
    let endIndex = index + 1;
    while (endIndex < lines.length && !/^(?:-\s+\S|#{1,6}\s+\S)/.test(lines[endIndex])) endIndex += 1;
    const startOffset = offsets[index];
    const endOffset = endIndex < lines.length ? offsets[endIndex] : content.length;
    const base = {
      kind,
      path,
      expectedHash: fileHash,
      startOffset,
      endOffset,
      startLine: index + 1,
      endLine: endIndex,
      content: content.slice(startOffset, endOffset),
    };
    return [{ ...base, id: sectionId(base) }];
  });
}

function rangeSection(
  path: string,
  kind: ForgetSectionKind,
  content: string,
  startOffset: number,
  endOffset: number,
  match: "exact" | "related",
  signals: string[],
): ForgetSection {
  const before = content.slice(0, startOffset);
  const through = content.slice(0, endOffset);
  const base = {
    kind,
    path,
    expectedHash: memoryHash(content),
    startOffset,
    endOffset,
    startLine: (before.match(/\n/g)?.length ?? 0) + 1,
    endLine: Math.max(1, (through.match(/\n/g)?.length ?? 0) + (through.endsWith("\n") ? 0 : 1)),
    content: content.slice(startOffset, endOffset),
    match,
    signals,
  };
  return { ...base, id: sectionId(base) };
}

function durableTaskGroup(content: string, section: ForgetSection) {
  const groups = [...content.matchAll(/^# Task Group:/gm)];
  const groupIndex = groups.findLastIndex((match) => (match.index ?? 0) <= section.startOffset);
  if (groupIndex < 0) return section;
  const startOffset = groups[groupIndex].index ?? 0;
  const endOffset = groups[groupIndex + 1]?.index ?? content.length;
  return rangeSection(
    section.path,
    section.kind,
    content,
    startOffset,
    endOffset,
    section.match ?? "related",
    [...new Set([...(section.signals ?? []), "task group"])],
  );
}

function withoutRanges(content: string, sections: ForgetSection[]) {
  return [...sections]
    .sort((left, right) => right.startOffset - left.startOffset)
    .reduce((next, section) => next.slice(0, section.startOffset) + next.slice(section.endOffset), content);
}

function projectDirectory(value: string) {
  const directory = value.trim();
  return isAbsolute(directory) && !/[\0\r\n]/.test(value) ? resolve(directory) : null;
}

function insideProject(cwd: string, directory: string) {
  return cwd === directory || cwd.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`);
}

function projectGroups(content: string) {
  const starts = [...content.matchAll(/^# Task Group:/gm)];
  return starts.map((start, index) => {
    const section = rangeSection("MEMORY.md", "durable", content, start.index, starts[index + 1]?.index ?? content.length, "exact", ["Task Group applies_to"]);
    const header = section.content.split(/^##\s/m, 1)[0];
    const appliesTo = header.match(/^applies_to:[ \t]*(.+)$/m)?.[1] ?? "";
    const workingDirectories = [...appliesTo.matchAll(/\bcwd\s*=\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^;,\r\n]+))/g)]
      .map((match) => projectDirectory(match[1] ?? match[2] ?? match[3] ?? match[4]));
    const directories = workingDirectories
      .filter((directory): directory is string => directory !== null);
    const paths = [...section.content.matchAll(/(?:rollout_summaries|extensions\/ad_hoc\/notes)\/[^\s)\]`]+\.md/g)].map((match) => match[0]);
    const threadIds = [...section.content.matchAll(/thread_id\s*[:=]\s*([a-z0-9-]+)/gi)].map((match) => match[1]);
    return { section, directories, invalidDirectory: workingDirectories.includes(null), paths, threadIds };
  });
}

function projectDatabaseRows(path: string) {
  // SQLite readOnly still writes WAL reader marks. Only open a private copy, including uncheckpointed commits.
  const sources = [path, `${path}-wal`, `${path}-journal`];
  const revisions = () => sources.map((source) => {
    if (!existsSync(/* turbopackIgnore: true */ source)) return null;
    const { dev, ino, size, mtimeNs, ctimeNs } = statSync(/* turbopackIgnore: true */ source, { bigint: true });
    return `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
  });
  const before = revisions();
  const temporary = mkdtempSync(join(tmpdir(), "codex-project-preview-db-"));
  let db;
  try {
    for (const [index, source] of sources.entries()) {
      if (before[index] !== null) copyFileSync(source, join(temporary, basename(source)));
    }
    if (JSON.stringify(revisions()) !== JSON.stringify(before)) throw new MemoryConflictError("The Memory database changed while building its preview. Refresh the preview.");
    db = openReadonly(join(temporary, basename(path)));
    return db.prepare("SELECT * FROM stage1_outputs ORDER BY thread_id").all();
  } finally {
    db?.close();
    rmSync(temporary, { recursive: true, force: true });
  }
}

export class MemoryForgetService {
  readonly root: string;
  readonly backupRoot: string;

  constructor(root: string, backupRoot = join(dirname(resolve(root)), "memory-forget-backups")) {
    this.root = resolve(root);
    this.backupRoot = resolve(backupRoot);
    if (this.backupRoot === this.root || this.backupRoot.startsWith(`${this.root}${sep}`)) {
      throw new Error("Forget backups must be stored outside the Memory corpus.");
    }
  }

  preview(selection: ForgetSelection): ForgetPlan {
    const repository = new MemoryRepository(this.root);
    const summary = repository.read("memory_summary.md");
    if (summary.hash !== selection.expectedSummaryHash) throw new MemoryConflictError();
    const selected = bulletSections("memory_summary.md", "summary", summary.content)
      .find((section) => section.startLine === selection.summaryLine);
    if (!selected) throw new Error("Select a top-level Memory Summary entry.");

    const target = canonical(selected.content);
    const durableDocument = repository.read("MEMORY.md");
    const durableCandidates = bulletSections("MEMORY.md", "durable", durableDocument.content)
      .map((section) => matchCandidate(section, target, selected.content))
      .filter((section): section is ForgetSection => section !== null);
    const confirmed = selection.confirmedDurableIds?.length
      ? durableCandidates.filter((section) => selection.confirmedDurableIds?.includes(section.id))
      : durableCandidates.length === 1 && durableCandidates[0].match === "exact" ? durableCandidates : [];
    const actionable = confirmed.length > 0;
    const reason = durableCandidates.length === 0
      ? "No durable Memory match was found."
      : actionable ? null : "Confirm the exact durable Memory sections to forget.";

    const sourceTargets = new Set([target, ...confirmed.map((section) => canonical(section.content))]);
    const related = actionable ? this.relatedSections(sourceTargets, confirmed, selected.content, durableDocument.content) : [];
    const durableSections = confirmed.map((section) => durableTaskGroup(durableDocument.content, section));
    const kindOrder: ForgetSectionKind[] = ["summary", "durable", "raw", "rollout", "ad-hoc"];
    const sections = [selected, ...durableSections, ...related]
      .filter((section, index, all) => all.findIndex(({ id }) => id === section.id) === index)
      .sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) || left.path.localeCompare(right.path));

    return {
      fingerprint: memoryHash(target),
      target,
      targets: [...sourceTargets],
      actionable,
      reason,
      selection,
      durableCandidates,
      sections,
    };
  }

  previewProject(selection: ProjectForgetSelection): ProjectForgetPlan {
    const repository = new MemoryRepository(this.root);
    const documents = repository.catalog().files.map(({ path }) => repository.read(path));
    const contents = new Map(documents.map(({ path, content }) => [path, content]));
    const durable = contents.get("MEMORY.md") ?? "";
    const groups = projectGroups(durable);
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    const sessions = [
      ...new SessionRepository(codexSessionsRoot()).catalog({ refresh: true }).sessions,
      ...new SessionRepository(process.env.CODEX_ARCHIVED_SESSIONS_DIRECTORY || join(codexHome, "archived_sessions")).catalog({ refresh: true }).sessions,
    ];
    const directory = projectDirectory(selection.directory);
    const blockers: string[] = [];
    const plan: ProjectForgetPlan = {
      kind: "project",
      selection: { kind: "project", directory: directory ?? selection.directory },
      directory: directory ?? selection.directory,
      knownProjectScopes: [...new Set([...groups.flatMap((group) => group.directories), ...sessions.flatMap(({ cwd }) => projectDirectory(cwd) ?? [])])].sort(),
      fingerprint: memoryHash(`project:${directory ?? selection.directory}`),
      actionable: false,
      reason: null,
      blockers,
      sections: [],
      retainedShared: [],
      database: { path: null, expectedHash: null, rows: [] },
      sourceRevisions: documents.map(({ path, hash }) => ({ path, expectedHash: hash })),
      sessionRevision: memoryHash(JSON.stringify(sessions.map(({ id, cwd, path }) => ({ id, cwd, path })))),
      matchedSessionIds: [],
      untouchedSessionCount: 0,
    };
    if (!directory) {
      blockers.push("Enter one absolute project directory.");
      return { ...plan, reason: blockers[0] };
    }

    const selected = groups.filter((group) => group.directories.length > 0 && group.directories.every((cwd) => insideProject(cwd, directory)));
    const outside = groups.filter((group) => !selected.includes(group));
    const scoped = groups.filter((group) => group.directories.length > 0);
    if (selected.length > 0 && selected.length === scoped.length) blockers.push("This directory covers every project-scoped Task Group. Project Forget cannot erase the complete corpus.");
    for (const group of selected.filter((group) => group.invalidDirectory)) blockers.push(`Unresolved provenance: ${group.section.path}:${group.section.startLine} has an invalid applies_to working directory.`);
    for (const group of outside.filter((group) => group.directories.some((cwd) => insideProject(cwd, directory)))) {
      blockers.push(`Unresolved provenance: ${group.section.path}:${group.section.startLine} spans this directory and another project.`);
      plan.retainedShared.push(group.section);
    }
    plan.sections.push(...selected.map((group) => group.section));
    const sessionsById = Map.groupBy(sessions, ({ id }) => id);
    const sessionScope = (id: string) => {
      const matches = sessionsById.get(id) ?? [];
      const directories = matches.map(({ cwd }) => projectDirectory(cwd));
      if (!directories.length || directories.some((cwd) => cwd === null)) return "unknown";
      const inside = directories.filter((cwd) => cwd !== null && insideProject(cwd, directory));
      return inside.length === directories.length ? "inside" : inside.length > 0 ? "conflict" : "outside";
    };
    plan.matchedSessionIds = [...new Set(sessions.filter(({ cwd }) => {
      const normalized = projectDirectory(cwd);
      return normalized !== null && insideProject(normalized, directory);
    }).map(({ id }) => id))].sort();
    plan.untouchedSessionCount = plan.matchedSessionIds.length;
    const selectedThreads = new Set(selected.flatMap((group) => group.threadIds));
    const outsideThreads = new Set(outside.flatMap((group) => group.threadIds));
    const selectedPaths = new Set(selected.flatMap((group) => group.paths));
    const outsidePaths = new Set(outside.flatMap((group) => group.paths));
    const durableBullets = bulletSections("MEMORY.md", "durable", durable);
    const belongsTo = (section: ForgetSection, candidates: typeof groups) => candidates.some(({ section: group }) => section.startOffset >= group.startOffset && section.endOffset <= group.endOffset);
    const selectedBullets = durableBullets.filter((section) => belongsTo(section, selected));
    const outsideBullets = durableBullets.filter((section) => !belongsTo(section, selected));
    const targets = new Set(selectedBullets.map(({ content }) => canonical(content)));

    // Only exact positive copies inherit a Task Group's scope; fuzzy matches need provenance repair.
    const considerCopy = (section: ForgetSection) => {
      if (section.content.includes(TOMBSTONE_MARKER)) return;
      const target = canonical(section.content);
      if (!targets.has(target)) {
        if (selectedBullets.some((source) => matchCandidate(source, target, section.content))) {
          blockers.push(`Unresolved provenance: ${section.path}:${section.startLine} only has a related text match.`);
        }
        return;
      }
      const remainingSources = outsideBullets.filter((source) => canonical(source.content) === target);
      if (remainingSources.length) {
        plan.retainedShared.push({ ...section, signals: ["durable source remains outside this directory"] });
        if (remainingSources.some((source) => !belongsTo(source, scoped))) blockers.push(`Unresolved provenance: a durable source of ${section.path}:${section.startLine} has no project scope.`);
      } else {
        if (outsideBullets.some((source) => matchCandidate(source, target, section.content))) blockers.push(`Unresolved provenance: ${section.path}:${section.startLine} also has a related durable source outside this directory.`);
        plan.sections.push({ ...section, match: "exact", signals: ["exact positive copy of a selected durable Memory"] });
      }
    };
    for (const section of bulletSections("memory_summary.md", "summary", contents.get("memory_summary.md") ?? "")) considerCopy(section);

    for (const path of selectedPaths) {
      if (!contents.has(path)) blockers.push(`Unresolved provenance: referenced source ${path} is missing.`);
    }
    for (const document of documents.filter(({ path }) => kindFor(path) === "rollout")) {
      const { path, content } = document;
      const threadId = content.match(/^thread_id:\s*([a-z0-9-]+)/im)?.[1];
      if (threadId && selectedPaths.has(path)) selectedThreads.add(threadId);
      if (threadId && outsidePaths.has(path)) outsideThreads.add(threadId);
      const scope = threadId ? sessionScope(threadId) : "unknown";
      if (!selectedPaths.has(path) && scope !== "inside" && scope !== "conflict") {
        if (scope === "unknown" && !outsidePaths.has(path)) {
          for (const section of bulletSections(path, "rollout", content)) considerCopy(section);
        }
        continue;
      }
      const section = rangeSection(path, "rollout", content, 0, content.length, "exact", [selectedPaths.has(path) ? "Task Group rollout reference" : `session metadata ${threadId}`]);
      if (outsidePaths.has(path)) {
        plan.retainedShared.push(section);
      } else if (scope === "conflict" || selectedPaths.has(path) && scope === "outside") {
        blockers.push(`Unresolved provenance: ${path} has conflicting Task Group or session project evidence.`);
      } else {
        plan.sections.push(section);
      }
    }
    const raw = contents.get("raw_memories.md") ?? "";
    const threads = [...raw.matchAll(/^## Thread `([^`]+)`/gm)];
    for (const [index, thread] of threads.entries()) {
      const scope = sessionScope(thread[1]);
      if (!selectedThreads.has(thread[1]) && scope !== "inside" && scope !== "conflict") {
        if (scope === "unknown" && !outsideThreads.has(thread[1])) {
          const threadContent = raw.slice(thread.index, threads[index + 1]?.index ?? raw.length);
          if (bulletSections("raw_memories.md", "raw", threadContent).some((section) => matchAny(section, targets))) blockers.push(`Unresolved provenance: raw thread ${thread[1]} contains a matching Memory without a known project.`);
        }
        continue;
      }
      const section = rangeSection("raw_memories.md", "raw", raw, thread.index, threads[index + 1]?.index ?? raw.length, "exact", [`thread id ${thread[1]}`]);
      if (outsideThreads.has(thread[1])) plan.retainedShared.push(section);
      else if (scope === "conflict" || selectedThreads.has(thread[1]) && scope === "outside") blockers.push(`Unresolved provenance: raw thread ${thread[1]} has conflicting project evidence.`);
      else plan.sections.push(section);
    }
    for (const section of bulletSections("raw_memories.md", "raw", raw)) {
      if (!plan.sections.some((range) => range.path === section.path && range.startOffset <= section.startOffset && range.endOffset >= section.endOffset)
        && !threads.some((thread, index) => thread.index <= section.startOffset && (threads[index + 1]?.index ?? raw.length) >= section.endOffset)) considerCopy(section);
    }
    for (const document of documents.filter(({ path }) => kindFor(path) === "ad-hoc")) {
      if (selectedPaths.has(document.path) && !document.content.includes(TOMBSTONE_MARKER)) {
        const section = rangeSection(document.path, "ad-hoc", document.content, 0, document.content.length, "exact", ["Task Group source reference"]);
        if (outsidePaths.has(document.path)) plan.retainedShared.push(section);
        else plan.sections.push(section);
        continue;
      }
      for (const section of bulletSections(document.path, "ad-hoc", document.content)) considerCopy(section);
    }
    for (const group of outside.filter((group) => group.directories.length === 0)) {
      if (group.threadIds.some((id) => sessionScope(id) === "inside") || group.paths.some((path) => plan.sections.some((section) => section.path === path))) {
        blockers.push(`Unresolved provenance: ${group.section.path}:${group.section.startLine} has no valid applies_to working directory.`);
      }
    }

    const databasePaths = existsSync(/* turbopackIgnore: true */ codexHome) ? readdirSync(/* turbopackIgnore: true */ codexHome, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^memories_\d+\.sqlite$/.test(entry.name)).map(({ name }) => join(codexHome, name)) : [];
    if (databasePaths.length > 1) blockers.push("The active Memory database is ambiguous: multiple memories databases exist in the Codex home.");
    else if (databasePaths.length === 1) {
      plan.database.path = databasePaths[0];
      try {
        const rows = projectDatabaseRows(databasePaths[0]);
        for (const row of rows) {
          const id = String(row.thread_id ?? "");
          const scope = sessionScope(id);
          if (scope === "unknown" || scope === "conflict") {
            blockers.push(`Unresolved provenance: stage1_outputs thread ${id || "(missing id)"} has no unambiguous session working directory.`);
          } else if (scope === "inside") {
            if (Object.values(row).some((value) => value instanceof Uint8Array || typeof value === "bigint")) throw new Error("Unsupported Memory database payload type.");
            plan.database.rows.push(row as Record<string, string | number | null>);
          }
        }
        const { dev, ino } = statSync(databasePaths[0]);
        plan.database.expectedHash = memoryHash(JSON.stringify({ path: databasePaths[0], dev, ino, rows: plan.database.rows }));
      } catch (error) {
        blockers.push(`The active Memory database could not be fully inspected: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }
    if (!plan.sections.length && !plan.database.rows.length) blockers.push("No project Memories match this directory.");
    plan.sections.sort((left, right) => left.path.localeCompare(right.path) || left.startOffset - right.startOffset);
    plan.blockers = [...new Set(blockers)];
    plan.reason = plan.blockers.length ? plan.blockers.join(" ") : null;
    plan.actionable = plan.blockers.length === 0;
    return plan;
  }

  apply(plan: ForgetPlan): ForgetResult {
    if (!plan.actionable || !plan.sections.some(({ kind }) => kind === "durable")) throw new Error("The Forget plan is not confirmed.");
    const fresh = this.preview(plan.selection);
    if (fresh.fingerprint !== plan.fingerprint || fresh.sections.map(({ id }) => id).join() !== plan.sections.map(({ id }) => id).join()) {
      throw new MemoryConflictError("The Forget plan no longer matches the Memory corpus. Refresh its preview.");
    }
    plan = fresh;
    const byPath = Map.groupBy(plan.sections, (section) => section.path);
    const originals = new Map<string, string>();
    for (const [path, sections] of byPath) {
      const absolute = this.safePath(path);
      const content = readFileSync(absolute, "utf8");
      if (memoryHash(content) !== sections[0].expectedHash) throw new MemoryConflictError();
      for (const section of sections) {
        if (content.slice(section.startOffset, section.endOffset) !== section.content) throw new MemoryConflictError();
      }
      originals.set(path, content);
    }

    const linkedNote = plan.sections.find(({ kind }) => kind === "ad-hoc");
    const tombstonePath = linkedNote?.path ?? `extensions/ad_hoc/notes/${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-forget-${plan.fingerprint.slice(0, 10)}-${randomUUID().slice(0, 8)}.md`;
    this.rejectDuplicateTombstone(plan.fingerprint, tombstonePath);
    if (!linkedNote && existsSync(this.safeNewPath(tombstonePath))) throw new MemoryConflictError("The planned tombstone path already exists.");
    const transactionRoot = join(this.backupRoot, `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`);
    mkdirSync(transactionRoot, { recursive: true });
    for (const [path, content] of originals) {
      const backup = join(transactionRoot, "files", path);
      mkdirSync(dirname(backup), { recursive: true });
      writeFileSync(backup, content);
      if (memoryHash(readFileSync(backup, "utf8")) !== memoryHash(content)) throw new Error(`Could not verify backup for ${path}.`);
    }
    const manifestPath = join(transactionRoot, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ status: "prepared", fingerprint: plan.fingerprint, paths: [...originals.keys()], tombstonePath }, null, 2));

    const tombstone = `# Delete memory\n\n- action: delete\n  ${TOMBSTONE_MARKER} sha256:${plan.fingerprint}\n  memory: ${plan.target}\n`;
    const outputs = new Map<string, string | null>();
    for (const [path, sections] of byPath) {
      let next = withoutRanges(originals.get(path) ?? "", sections);
      if (path === linkedNote?.path) next = `${next.trimEnd()}\n\n${tombstone}`;
      outputs.set(path, kindFor(path) === "rollout" && next.trim() === "" ? null : next);
    }
    if (!linkedNote) outputs.set(tombstonePath, tombstone);

    const written: string[] = [];
    try {
      for (const [path, content] of outputs) {
        const expected = originals.has(path) ? memoryHash(originals.get(path) ?? "") : undefined;
        const absolute = this.safeNewPath(path);
        if (content === null) {
          if (expected === undefined || memoryHash(readFileSync(absolute, "utf8")) !== expected) throw new MemoryConflictError();
          unlinkSync(absolute);
        } else {
          atomicMemoryWrite(absolute, content, expected);
        }
        written.push(path);
      }
      const verification = this.recheck(plan);
      if (verification.status === "resurfaced") {
        throw new Error(`Post-apply verification found the Memory in ${verification.resurfaced.map(({ path }) => path).join(", ")}.`);
      }
      writeFileSync(manifestPath, JSON.stringify({ status: "committed", fingerprint: plan.fingerprint, paths: [...outputs.keys()], tombstonePath }, null, 2));
      return { changedPaths: [...outputs.keys()], manifestPath, rolledBack: false, tombstonePath, verification: "suppressed" };
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const path of [...written].reverse()) {
        try {
          const absolute = this.safeNewPath(path);
          const output = outputs.get(path);
          const outputMatches = output === null ? !existsSync(absolute) : existsSync(absolute) && memoryHash(readFileSync(absolute, "utf8")) === memoryHash(output ?? "");
          if (!outputMatches) {
            rollbackFailures.push(path);
            continue;
          }
          if (originals.has(path)) atomicMemoryWrite(absolute, originals.get(path) ?? "", output === null ? undefined : memoryHash(output ?? ""));
          else unlinkSync(absolute);
        } catch {
          rollbackFailures.push(path);
        }
      }
      writeFileSync(manifestPath, JSON.stringify({ status: rollbackFailures.length ? "rollback-conflict" : "rolled-back", fingerprint: plan.fingerprint, paths: written, tombstonePath, rollbackFailures }, null, 2));
      throw new Error(rollbackFailures.length
        ? `Forget failed; rollback conflicts: ${rollbackFailures.join(", ")}. Backup: ${manifestPath}`
        : `Forget failed and was rolled back: ${error instanceof Error ? error.message : "unknown error"} Backup: ${manifestPath}`);
    }
  }

  recheck(plan: Pick<ForgetPlan, "fingerprint" | "target"> & Partial<Pick<ForgetPlan, "targets">>) {
    const targets = new Set(plan.targets ?? [plan.target]);
    const resurfaced = this.allSections()
      .filter((section) => !section.content.includes(`${TOMBSTONE_MARKER} sha256:${plan.fingerprint}`))
      .map((section) => matchAny(section, targets))
      .filter((section) => section !== null);
    return { status: resurfaced.length ? "resurfaced" as const : "suppressed" as const, resurfaced };
  }

  private relatedSections(targets: Set<string>, durable: ForgetSection[], summaryContent: string, durableContent: string) {
    const provenance = durableProvenance(durableContent, durable);
    const exact = this.allSections()
      .filter((section) => section.kind !== "summary" && section.kind !== "durable")
      .map((section) => targets.has(canonical(section.content)) ? { ...section, match: "exact" as const, signals: ["exact normalized text"] } : null);
    const repository = new MemoryRepository(this.root);
    const files = new Set(repository.catalog().files.map(({ path }) => path));
    const linked: Array<ForgetSection | null> = [];

    for (const path of provenance.rolloutPaths) {
      if (!files.has(path)) continue;
      const content = repository.read(path).content;
      const threadId = content.match(/^thread_id:\s*([a-z0-9-]+)/im)?.[1]
        ?? content.match(/rollout-[^\s]*?([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl/i)?.[1];
      if (threadId) provenance.threadIds.add(threadId);
    }

    if (files.has("raw_memories.md") && provenance.threadIds.size > 0) {
      const content = repository.read("raw_memories.md").content;
      const threads = [...content.matchAll(/^## Thread `([^`]+)`/gm)];
      for (const [index, thread] of threads.entries()) {
        if (!provenance.threadIds.has(thread[1])) continue;
        linked.push(rangeSection(
          "raw_memories.md",
          "raw",
          content,
          thread.index ?? 0,
          threads[index + 1]?.index ?? content.length,
          "related",
          [`thread id ${thread[1]}`],
        ));
      }
    }

    for (const path of provenance.rolloutPaths) {
      if (!files.has(path)) continue;
      const content = repository.read(path).content;
      linked.push(rangeSection(path, "rollout", content, 0, content.length, "related", ["rollout reference"]));
    }

    const hasAdHocMarker = /\[ad-hoc note\]/i.test(summaryContent) || durable.some((section) => /\[ad-hoc note\]/i.test(section.content));
    if (hasAdHocMarker) {
      for (const section of this.allSections().filter(({ kind }) => kind === "ad-hoc")) {
        linked.push(matchAny(section, targets, ["ad-hoc marker"], 0.4));
      }
    }

    const sections = [...exact, ...linked]
      .filter((section): section is ForgetSection => section !== null)
      .filter((section, index, all) => all.findIndex(({ id }) => id === section.id) === index);
    return sections.filter((section, index) => !sections.some((candidate, candidateIndex) =>
      candidateIndex !== index
      && candidate.path === section.path
      && candidate.startOffset <= section.startOffset
      && candidate.endOffset >= section.endOffset
      && (candidate.startOffset < section.startOffset || candidate.endOffset > section.endOffset)));
  }

  private allSections() {
    const repository = new MemoryRepository(this.root);
    return repository.catalog().files.flatMap(({ path }) => {
      const kind = kindFor(path);
      return kind ? bulletSections(path, kind, repository.read(path).content) : [];
    });
  }

  private rejectDuplicateTombstone(fingerprint: string, selectedPath: string) {
    const marker = `${TOMBSTONE_MARKER} sha256:${fingerprint}`;
    const matches = this.allSections().filter((section) => section.content.includes(marker));
    if (matches.some(({ path }) => path !== selectedPath) || matches.length > 1) throw new Error("A delete tombstone already exists for this Memory.");
  }

  private safePath(path: string) {
    if (!kindFor(path)) throw new Error(`Forget cannot modify ${path}.`);
    return resolveMemoryMarkdownPath(this.root, path);
  }

  private safeNewPath(path: string) {
    if (!kindFor(path)) throw new Error(`Forget cannot modify ${path}.`);
    return resolveMemoryMarkdownPath(this.root, path, false);
  }
}
