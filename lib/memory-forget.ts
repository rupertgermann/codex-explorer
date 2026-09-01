import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

export type ForgetResult = {
  changedPaths: string[];
  manifestPath: string;
  rolledBack: boolean;
  tombstonePath: string;
  verification: "suppressed";
};

export type ProjectForgetDatabaseRow = {
  threadId: string;
  rolloutSlug: string;
  selectedForPhase2: boolean;
};

export type ProjectForgetPlan = {
  directory: string;
  knownDirectories: string[];
  actionable: boolean;
  reason: string | null;
  scopes: string[];
  sections: ForgetSection[];
  sharedSections: ForgetSection[];
  databaseRows: ProjectForgetDatabaseRow[];
  sessionCount: number;
};

type ProjectForgetSources = {
  activeSessionsRoot?: string;
  archivedSessionsRoot?: string;
  databasePath?: string;
};

type ScopedTaskGroup = { directory: string; section: ForgetSection };

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

function absoluteDirectory(input: string) {
  const value = input.trim();
  return isAbsolute(value) ? normalize(value) : null;
}

function isWithin(directory: string, candidate: string) {
  const path = relative(directory, candidate);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function scopedTaskGroups(content: string): ScopedTaskGroup[] {
  const starts = [...content.matchAll(/^# Task Group:.*$/gm)];
  return starts.flatMap((start, index) => {
    const startOffset = start.index ?? 0;
    const endOffset = starts[index + 1]?.index ?? content.length;
    const sectionContent = content.slice(startOffset, endOffset);
    const directory = absoluteDirectory(sectionContent.match(/^applies_to:\s*cwd=([^;\r\n]+)/m)?.[1] ?? "");
    if (!directory) return [];
    return [{
      directory,
      section: rangeSection("MEMORY.md", "durable", content, startOffset, endOffset, "exact", [`project scope ${directory}`]),
    }];
  });
}

function memoryBullets(content: string) {
  const headings = [...content.matchAll(/^#{2,6}\s+(.+)$/gm)];
  return bulletSections("MEMORY.md", "durable", content).filter((section) => {
    const heading = headings.findLast((candidate) => (candidate.index ?? 0) < section.startOffset)?.[1].trim().toLocaleLowerCase();
    return heading !== "rollout_summary_files" && heading !== "keywords";
  });
}

function projectSummarySections(content: string, directory: string) {
  const headings = [...content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const ranges = headings.flatMap((heading, index) => {
    const project = absoluteDirectory(heading[2].trim().replace(/^`|`$/g, ""));
    if (!project || !isWithin(directory, project)) return [];
    const level = heading[1].length;
    const endOffset = headings.slice(index + 1).find((candidate) => candidate[1].length <= level)?.index ?? content.length;
    return [{ startOffset: heading.index ?? 0, endOffset }];
  });
  return bulletSections("memory_summary.md", "summary", content)
    .filter((section) => ranges.some((range) => section.startOffset >= range.startOffset && section.endOffset <= range.endOffset));
}

function rawThreadSections(content: string, threadIds: Set<string>) {
  const threads = [...content.matchAll(/^## Thread `([^`]+)`/gm)];
  return threads.flatMap((thread, index) => threadIds.has(thread[1])
    ? [rangeSection("raw_memories.md", "raw", content, thread.index ?? 0, threads[index + 1]?.index ?? content.length, "exact", [`thread id ${thread[1]}`])]
    : []);
}

function provenance(content: string) {
  return {
    rolloutPaths: new Set([...content.matchAll(/rollout_summaries\/[^\s)]+\.md/g)].map((match) => match[0])),
    threadIds: new Set([
      ...[...content.matchAll(/(?:thread|session|rollout)_id\s*[:=]\s*([a-z0-9_-]+)/gi)].map((match) => match[1]),
      ...[...content.matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi)].map((match) => match[0]),
    ]),
  };
}

function uniqueSections(sections: ForgetSection[]) {
  const kindOrder: ForgetSectionKind[] = ["summary", "durable", "raw", "rollout", "ad-hoc"];
  const unique = sections.filter((section, index, all) => all.findIndex(({ id }) => id === section.id) === index);
  return unique
    .filter((section, index) => !unique.some((candidate, candidateIndex) => candidateIndex !== index
      && candidate.path === section.path
      && candidate.startOffset <= section.startOffset
      && candidate.endOffset >= section.endOffset
      && (candidate.startOffset < section.startOffset || candidate.endOffset > section.endOffset)))
    .sort((left, right) => kindOrder.indexOf(left.kind) - kindOrder.indexOf(right.kind) || left.path.localeCompare(right.path) || left.startOffset - right.startOffset);
}

function stage1Rows(path: string) {
  if (!existsSync(path)) return { rows: [] as ProjectForgetDatabaseRow[], error: null as string | null };
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const rows = database.prepare("SELECT thread_id, rollout_slug, selected_for_phase2 FROM stage1_outputs ORDER BY thread_id").all() as Array<{
      thread_id: string;
      rollout_slug: string | null;
      selected_for_phase2: number | bigint;
    }>;
    return {
      rows: rows.map((row) => ({
        threadId: row.thread_id,
        rolloutSlug: row.rollout_slug ?? "",
        selectedForPhase2: Number(row.selected_for_phase2) !== 0,
      })),
      error: null,
    };
  } catch {
    return { rows: [] as ProjectForgetDatabaseRow[], error: "The active Memory database does not expose the expected stage1_outputs schema." };
  } finally {
    database?.close();
  }
}

export class MemoryForgetService {
  readonly root: string;
  readonly backupRoot: string;
  readonly projectSources: Required<ProjectForgetSources>;

  constructor(root: string, backupRoot = join(dirname(resolve(root)), "memory-forget-backups"), projectSources: ProjectForgetSources = {}) {
    this.root = resolve(root);
    this.backupRoot = resolve(backupRoot);
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    this.projectSources = {
      activeSessionsRoot: projectSources.activeSessionsRoot ?? codexSessionsRoot(),
      archivedSessionsRoot: projectSources.archivedSessionsRoot ?? process.env.CODEX_ARCHIVED_SESSIONS_DIRECTORY ?? join(codexHome, "archived_sessions"),
      databasePath: projectSources.databasePath ?? join(codexHome, "memories_1.sqlite"),
    };
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

  previewProject(input: string): ProjectForgetPlan {
    const repository = new MemoryRepository(this.root);
    const durable = repository.read("MEMORY.md");
    const groups = scopedTaskGroups(durable.content);
    const sessions = [
      ...new SessionRepository(this.projectSources.activeSessionsRoot).catalog({ refresh: true }).sessions,
      ...new SessionRepository(this.projectSources.archivedSessionsRoot).catalog({ refresh: true }).sessions,
    ];
    const knownDirectories = [...new Set([
      ...groups.map(({ directory }) => directory),
      ...sessions.map(({ cwd }) => absoluteDirectory(cwd)).filter((directory): directory is string => directory !== null),
    ])].sort();
    const directory = absoluteDirectory(input);
    const empty = (reason: string): ProjectForgetPlan => ({
      directory: directory ?? input.trim(),
      knownDirectories,
      actionable: false,
      reason,
      scopes: [],
      sections: [],
      sharedSections: [],
      databaseRows: [],
      sessionCount: 0,
    });
    if (!directory) return empty("Enter an absolute project directory.");

    const matchedGroups = groups.filter((group) => isWithin(directory, group.directory));
    const unmatchedGroups = groups.filter((group) => !isWithin(directory, group.directory));
    const matchingSessions = sessions.filter((session) => absoluteDirectory(session.cwd) && isWithin(directory, normalize(session.cwd)));
    const matchedSource = matchedGroups.map(({ section }) => section.content).join("\n");
    const unmatchedSource = unmatchedGroups.map(({ section }) => section.content).join("\n");
    const matchedProvenance = provenance(matchedSource);
    const unmatchedProvenance = provenance(unmatchedSource);
    const sharedThreadIds = new Set([...matchedProvenance.threadIds].filter((id) => unmatchedProvenance.threadIds.has(id)));
    const targetThreadIds = new Set([
      ...matchingSessions.map(({ id }) => id),
      ...[...matchedProvenance.threadIds].filter((id) => !sharedThreadIds.has(id)),
    ]);
    const database = stage1Rows(this.projectSources.databasePath);
    const databaseRows = database.rows.filter(({ threadId }) => targetThreadIds.has(threadId));
    const reasons = [
      database.error,
      sharedThreadIds.size ? "Some thread provenance is shared with another project." : null,
      groups.length > 0 && matchedGroups.length === groups.length ? "Project Forget cannot target every project-scoped Task Group." : null,
    ].filter((reason): reason is string => reason !== null);

    const allDurableMemories = memoryBullets(durable.content);
    const matchedMemories = allDurableMemories.filter((memory) => matchedGroups.some(({ section }) => memory.startOffset >= section.startOffset && memory.endOffset <= section.endOffset));
    const unmatchedTargets = new Set(allDurableMemories
      .filter((memory) => unmatchedGroups.some(({ section }) => memory.startOffset >= section.startOffset && memory.endOffset <= section.endOffset))
      .map(({ content }) => canonical(content)));
    const sharedTargets = new Set(matchedMemories.map(({ content }) => canonical(content)).filter((target) => unmatchedTargets.has(target)));
    const exclusiveTargets = new Set(matchedMemories.map(({ content }) => canonical(content)).filter((target) => !sharedTargets.has(target)));
    const sharedSections: ForgetSection[] = matchedMemories.filter(({ content }) => sharedTargets.has(canonical(content)));
    const sections: ForgetSection[] = matchedMemories.filter(({ content }) => exclusiveTargets.has(canonical(content)));

    const files = new Set(repository.catalog().files.map(({ path }) => path));
    const missingRollout = [...matchedProvenance.rolloutPaths].find((path) => !files.has(path));
    if (missingRollout) reasons.push(`Referenced Memory source is missing: ${missingRollout}.`);
    const rolloutReferenceLines = matchedGroups.flatMap(({ section }) => section.content.split(/\r?\n/));
    const unresolvedRollout = [...matchedProvenance.rolloutPaths]
      .filter((path) => files.has(path))
      .find((path) => provenance(`${rolloutReferenceLines.find((line) => line.includes(path)) ?? ""}\n${repository.read(path).content}`).threadIds.size === 0);
    if (unresolvedRollout) reasons.push(`Project rollout provenance has no matching thread: ${unresolvedRollout}.`);
    if (files.has("memory_summary.md")) {
      const summary = repository.read("memory_summary.md").content;
      const scopedSummaryIds = new Set(projectSummarySections(summary, directory).map(({ id }) => id));
      for (const memory of bulletSections("memory_summary.md", "summary", summary)) {
        const target = canonical(memory.content);
        if (sharedTargets.has(target)) sharedSections.push(memory);
        else if (exclusiveTargets.has(target) || scopedSummaryIds.has(memory.id)) sections.push(memory);
      }
    }
    if (files.has("raw_memories.md")) {
      sections.push(...rawThreadSections(repository.read("raw_memories.md").content, targetThreadIds));
    }

    for (const path of files) {
      const kind = kindFor(path);
      if (kind === "rollout") {
        const content = repository.read(path).content;
        const threadId = provenance(content).threadIds.values().next().value as string | undefined;
        const referenced = matchedProvenance.rolloutPaths.has(path) || Boolean(threadId && targetThreadIds.has(threadId));
        if (!referenced) continue;
        const section = rangeSection(path, "rollout", content, 0, content.length, "exact", [threadId ? `thread id ${threadId}` : "project rollout reference"]);
        if (unmatchedProvenance.rolloutPaths.has(path) || Boolean(threadId && sharedThreadIds.has(threadId))) sharedSections.push(section);
        else sections.push(section);
      }
      if (kind === "ad-hoc") {
        for (const memory of bulletSections(path, "ad-hoc", repository.read(path).content)) {
          const target = canonical(memory.content);
          if (exclusiveTargets.has(target)) sections.push(memory);
          else if (sharedTargets.has(target)) sharedSections.push(memory);
        }
      }
    }

    const affectedSections = uniqueSections(sections);
    if (affectedSections.length === 0 && databaseRows.length === 0) reasons.push("No project-scoped Memory was found.");
    return {
      directory,
      knownDirectories,
      actionable: reasons.length === 0,
      reason: reasons.join(" ") || null,
      scopes: [...new Set(matchedGroups.map(({ directory: scope }) => scope))].sort(),
      sections: affectedSections,
      sharedSections: uniqueSections(sharedSections),
      databaseRows,
      sessionCount: matchingSessions.length,
    };
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
