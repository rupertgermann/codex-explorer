"use client";

import { FormEvent, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Braces,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  FileJson2,
  Folder,
  GitBranch,
  HardDrive,
  Loader2,
  List,
  MessageSquareText,
  RefreshCw,
  ScanText,
  Search,
  Terminal,
  User,
  Wrench,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { buildSessionForest, matchingSessionPaths, sessionArchiveNavigation, type SessionTreeNode } from "@/lib/session-tree";
import type { SessionProvenance } from "@/lib/sessions";
import { cn, formatBytes, formatDate, formatNumber } from "@/lib/utils";

type SessionSummary = {
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

type SessionCatalog = {
  root: string;
  indexedAt: number;
  sessions: SessionSummary[];
  totals: { sessions: number; bytes: number; projects: number; activeDays: number };
  months: { month: string; sessions: number; bytes: number }[];
  topProjects: { project: string; sessions: number; bytes: number }[];
};

type SessionEntry = {
  id: string;
  timestamp: number;
  kind: "user" | "assistant" | "tool";
  phase?: string;
  text?: string;
  name?: string;
  detail?: string;
  truncated?: boolean;
};

type SessionDetail = SessionSummary & {
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

type RawSessionPage = {
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

type TranscriptUpdate =
  | { type: "entry"; entry: SessionEntry }
  | { type: "progress"; scannedBytes: number; totalBytes: number }
  | { type: "complete"; session: Omit<SessionDetail, "entries"> }
  | { type: "error"; error: string };

async function sessionRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Session request failed.");
  return data as T;
}

function duration(value: number) {
  if (value < 1_000) return `${value} ms`;
  if (value < 60_000) return `${Math.round(value / 1_000)} sec`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} min`;
  return `${(value / 3_600_000).toFixed(1)} hr`;
}

function monthLabel(value: string) {
  const date = new Date(`${value}-01T00:00:00Z`);
  return new Intl.DateTimeFormat("en", { month: "short", year: "numeric", timeZone: "UTC" }).format(date);
}

const provenanceLabels: Record<SessionProvenance, string> = {
  user: "User",
  codex: "Codex subtask",
  automation: "Automation",
  unknown: "Unknown/legacy",
};

function ProvenanceBadge({ provenance }: { provenance: SessionProvenance }) {
  return <Badge variant="outline" className={cn(
    "shrink-0 px-1.5 py-0 text-[9px]",
    provenance === "user" && "border-emerald-200 bg-emerald-50 text-emerald-700",
    provenance === "codex" && "border-violet-200 bg-violet-50 text-violet-700",
    provenance === "automation" && "border-amber-200 bg-amber-50 text-amber-700",
    provenance === "unknown" && "border-slate-200 bg-slate-50 text-slate-600",
  )}>{provenanceLabels[provenance]}</Badge>;
}

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof HardDrive }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-4">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</p><p className="mt-1.5 text-xl font-semibold tracking-[-0.03em]">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>
        <span className="rounded-lg bg-violet-50 p-2 text-violet-700"><Icon className="size-4" /></span>
      </CardContent>
    </Card>
  );
}

function transcriptEntryText(entry: SessionEntry) {
  return entry.kind === "tool" ? `${entry.name ?? ""} ${entry.detail ?? ""}` : entry.text ?? "";
}

function TranscriptEntry({ entry, matched }: { entry: SessionEntry; matched: boolean }) {
  if (entry.kind === "tool") {
    return (
      <div id={`session-entry-${entry.id}`} className={cn("ml-8 rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 scroll-mt-4", matched && "border-amber-300 bg-amber-50/70 ring-2 ring-amber-200/70")}>
        <div className="flex items-center justify-between gap-3"><span className="flex min-w-0 items-center gap-2 text-xs font-medium"><Wrench className="size-3.5 shrink-0 text-slate-500" /><span className="truncate font-mono">{entry.name}</span>{matched && <Badge className="border-amber-200 bg-amber-100 px-1.5 py-0 text-[9px] text-amber-800">match</Badge>}</span><time className="shrink-0 text-[10px] text-muted-foreground">{formatDate(entry.timestamp)}</time></div>
        {entry.detail && <details className="mt-2"><summary className="cursor-pointer text-[10px] font-medium text-muted-foreground">Show call input{entry.truncated ? " (truncated)" : ""}</summary><pre className="scrollbar-thin mt-2 max-h-48 overflow-auto rounded-lg bg-[#17202d] p-3 font-mono text-[10px] leading-5 text-slate-300">{entry.detail}</pre></details>}
      </div>
    );
  }

  const assistant = entry.kind === "assistant";
  return (
    <div id={`session-entry-${entry.id}`} className={cn("flex scroll-mt-4 gap-3", !assistant && "flex-row-reverse")}>
      <span className={cn("mt-1 grid size-8 shrink-0 place-items-center rounded-lg", assistant ? "bg-violet-100 text-violet-700" : "bg-indigo-600 text-white")}>{assistant ? <Bot className="size-4" /> : <User className="size-4" />}</span>
      <div className={cn("min-w-0 max-w-[88%] rounded-2xl border px-4 py-3", assistant ? "border-slate-200 bg-white" : "border-indigo-600 bg-indigo-50", matched && "border-amber-300 bg-amber-50/70 ring-2 ring-amber-200/70")}>
        <div className="mb-2 flex items-center justify-between gap-4"><span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{assistant ? entry.phase === "final_answer" ? "Assistant · final" : "Assistant" : "User"}{matched && <Badge className="border-amber-200 bg-amber-100 px-1.5 py-0 text-[9px] normal-case tracking-normal text-amber-800">match</Badge>}</span><time className="text-[10px] text-muted-foreground">{formatDate(entry.timestamp)}</time></div>
        <div className="memory-markdown text-xs leading-6 text-slate-700"><ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.text}</ReactMarkdown></div>
        {entry.truncated && <p className="mt-2 text-[10px] font-medium text-amber-700">Long message truncated for display.</p>}
      </div>
    </div>
  );
}

function ThreadTreeItem({
  node,
  depth = 0,
  expanded,
  selectedPath,
  onToggle,
  onSelect,
}: {
  node: SessionTreeNode<SessionSummary>;
  depth?: number;
  expanded: ReadonlySet<string>;
  selectedPath?: string;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const expansionKey = node.contextOnly ? `context:${node.session.path}` : node.session.path;
  const open = node.contextOnly ? !expanded.has(expansionKey) : expanded.has(expansionKey);
  const hasChildren = node.children.length > 0;
  return <div>
    <div className={cn("flex items-stretch rounded-lg transition hover:bg-muted lg:hover:bg-white/[0.06] lg:[&_.text-muted-foreground]:text-slate-400", node.contextOnly && "opacity-55", selectedPath === node.session.path && "bg-violet-50 text-violet-950 opacity-100 lg:bg-violet-400/10 lg:text-violet-100")} style={{ paddingLeft: `${Math.min(depth, 8) * 14 + 4}px` }}>
      <button type="button" disabled={!hasChildren} onClick={() => onToggle(expansionKey)} aria-expanded={hasChildren ? open : undefined} aria-label={`${open ? "Collapse" : "Expand"} ${node.session.id}`} className="grid w-7 shrink-0 place-items-center text-muted-foreground disabled:opacity-20">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
      </button>
      <button type="button" onClick={() => onSelect(node.session.path)} className="min-w-0 flex-1 px-1.5 py-2 text-left">
        <span className="flex items-center justify-between gap-1.5"><span className="min-w-0 truncate text-xs font-semibold">{node.session.project}</span><ProvenanceBadge provenance={node.session.provenance} /></span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5"><span className="truncate font-mono text-[9px] text-muted-foreground">{node.session.id}</span>{node.contextOnly && <span className="shrink-0 text-[9px] font-medium text-slate-500">context</span>}{node.orphan && <span className="shrink-0 text-[9px] font-medium text-amber-700">missing parent</span>}{node.cycle && <span className="shrink-0 text-[9px] font-medium text-red-700">cycle</span>}</span>
        <span className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground"><span>{formatDate(node.session.startedAt)}</span><span>{formatBytes(node.session.size)}</span></span>
      </button>
    </div>
    {open && node.children.map((child) => <ThreadTreeItem key={child.session.path} node={child} depth={depth + 1} expanded={expanded} selectedPath={selectedPath} onToggle={onToggle} onSelect={onSelect} />)}
  </div>;
}

export function SessionWorkspace({ initialPath, initialQuery }: { initialPath?: string; initialQuery?: string }) {
  const [catalog, setCatalog] = useState<SessionCatalog | null>(null);
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [project, setProject] = useState("All");
  const [month, setMonth] = useState("All");
  const [provenance, setProvenance] = useState<"All" | SessionProvenance>("All");
  const [archiveNavigation, dispatchArchiveNavigation] = useReducer(sessionArchiveNavigation, {
    view: "tree",
    selectedPath: "",
    expandedThreads: new Set<string>(),
  });
  const [treePagination, setTreePagination] = useState({ key: "", limit: 500 });
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SessionSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [sessionLoading, setSessionLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [viewer, setViewer] = useState<"transcript" | "raw">("transcript");
  const [fullScanning, setFullScanning] = useState(false);
  const [fullProgress, setFullProgress] = useState(0);
  const [fullScanComplete, setFullScanComplete] = useState(false);
  const [rawPage, setRawPage] = useState<RawSessionPage | null>(null);
  const [rawLoading, setRawLoading] = useState(false);
  const [transcriptQuery, setTranscriptQuery] = useState(initialQuery ?? "");
  const [activeTranscriptMatch, setActiveTranscriptMatch] = useState(0);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);
  const fullScanAbort = useRef<AbortController | null>(null);
  const rawPageAbort = useRef<AbortController | null>(null);

  const loadSession = useCallback(async (path: string) => {
    fullScanAbort.current?.abort();
    rawPageAbort.current?.abort();
    rawPageAbort.current = null;
    setSessionLoading(true); setMessage(null);
    setViewer("transcript"); setFullScanning(false); setFullProgress(0); setFullScanComplete(false); setRawPage(null); setRawLoading(false);
    try {
      const detail = await sessionRequest<SessionDetail>(`/api/sessions/document?path=${encodeURIComponent(path)}`);
      setSession(detail);
      dispatchArchiveNavigation({ type: "select", path: detail.path });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not open session." });
    } finally { setSessionLoading(false); }
  }, []);

  const refreshCatalog = useCallback(async () => {
    setLoading(true); setMessage(null);
    try {
      const next = await sessionRequest<SessionCatalog>("/api/sessions?refresh=1");
      setCatalog(next);
      const selected = next.sessions.find((candidate) => candidate.path === session?.path) ?? next.sessions[0];
      if (selected) await loadSession(selected.path); else setSession(null);
      setMessage({ kind: "success", text: `Indexed ${formatNumber(next.totals.sessions)} session files.` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not load Codex sessions." });
    } finally { setLoading(false); }
  }, [loadSession, session?.path]);

  useEffect(() => {
    sessionRequest<SessionCatalog>("/api/sessions")
      .then(async (next) => {
        setCatalog(next);
        const initial = initialPath ? next.sessions.find((candidate) => candidate.path === initialPath) : next.sessions[0];
        if (initial) await loadSession(initial.path);
        else if (initialPath) setMessage({ kind: "error", text: `${initialPath} no longer exists. Refresh search and try again.` });
      })
      .catch((error) => setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not load Codex sessions." }))
      .finally(() => setLoading(false));
  }, [initialPath, loadSession]);

  useEffect(() => () => {
    fullScanAbort.current?.abort();
    rawPageAbort.current?.abort();
  }, []);

  async function scanCompleteTranscript() {
    if (!session || fullScanning) return;
    const path = session.path;
    const controller = new AbortController();
    fullScanAbort.current?.abort();
    fullScanAbort.current = controller;
    setFullScanning(true); setFullProgress(0); setFullScanComplete(false); setMessage(null);
    const entries: SessionEntry[] = [];
    try {
      const response = await fetch(`/api/sessions/transcript?path=${encodeURIComponent(path)}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error ?? "Complete transcript scan failed.");
      }
      if (!response.body) throw new Error("The browser did not provide a streaming response body.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const accept = (update: TranscriptUpdate) => {
        if (update.type === "entry") entries.push(update.entry);
        if (update.type === "progress") {
          setFullProgress(update.totalBytes ? update.scannedBytes / update.totalBytes : 1);
          setSession((current) => current?.path === path
            ? { ...current, entries: [...entries], metrics: { ...current.metrics, scannedBytes: update.scannedBytes } }
            : current);
        }
        if (update.type === "complete") {
          setSession((current) => current?.path === path ? { ...update.session, entries: [...entries] } : current);
          setFullProgress(1);
          setFullScanComplete(true);
        }
        if (update.type === "error") throw new Error(update.error);
      };

      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = done ? "" : lines.pop() ?? "";
        for (const line of lines) if (line) accept(JSON.parse(line) as TranscriptUpdate);
        if (done) {
          if (buffer.trim()) accept(JSON.parse(buffer) as TranscriptUpdate);
          break;
        }
      }
      setMessage({ kind: "success", text: `Scanned the complete transcript (${formatNumber(entries.length)} visible entries).` });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessage({ kind: "error", text: error instanceof Error ? error.message : "Complete transcript scan failed." });
      }
    } finally {
      if (fullScanAbort.current === controller) fullScanAbort.current = null;
      setFullScanning(false);
    }
  }

  async function loadRawPage(offset = 0) {
    if (!session) return;
    const controller = new AbortController();
    rawPageAbort.current?.abort();
    rawPageAbort.current = controller;
    setRawLoading(true); setMessage(null);
    try {
      const page = await sessionRequest<RawSessionPage>(`/api/sessions/raw?path=${encodeURIComponent(session.path)}&offset=${offset}`, { signal: controller.signal });
      if (rawPageAbort.current === controller) setRawPage(page);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not read raw session content." });
      }
    } finally {
      if (rawPageAbort.current === controller) {
        rawPageAbort.current = null;
        setRawLoading(false);
      }
    }
  }

  function selectViewer(next: "transcript" | "raw") {
    setViewer(next);
    if (next === "raw" && !rawPage) void loadRawPage(0);
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim();
    if (!needle) { setSearchResults(null); return; }
    if (needle.length < 3) { setMessage({ kind: "error", text: "Enter at least 3 characters." }); return; }
    setSearching(true); setMessage(null);
    try {
      const data = await sessionRequest<{ results: SessionSummary[] }>(`/api/sessions/search?q=${encodeURIComponent(needle)}`);
      setSearchResults(data.results);
      setMessage({ kind: "success", text: data.results.length === 100 ? "Showing up to 100 matching sessions." : `${formatNumber(data.results.length)} matching sessions found.` });
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Session search failed." });
    } finally { setSearching(false); }
  }

  function clearSearch() {
    setQuery(""); setSearchResults(null); setMessage(null);
  }

  const projects = useMemo(() => catalog ? [...new Set(catalog.sessions.map((item) => item.project))].sort() : [], [catalog]);
  const contentPaths = useMemo(() => searchResults ? new Set(searchResults.map((item) => item.path)) : undefined, [searchResults]);
  const matchingPaths = useMemo(() => matchingSessionPaths(catalog?.sessions ?? [], {
    project: project === "All" ? undefined : project,
    month: month === "All" ? undefined : month,
    provenance: provenance === "All" ? undefined : provenance,
    contentPaths,
  }), [catalog, contentPaths, month, project, provenance]);
  const hasActiveFilters = project !== "All" || month !== "All" || provenance !== "All" || searchResults !== null;
  const visibleSessions = useMemo(() => (catalog?.sessions ?? []).filter((item) => matchingPaths.has(item.path)), [catalog, matchingPaths]);
  const listedSessions = visibleSessions.slice(0, 1_000);
  const fullSessionForest = useMemo(() => buildSessionForest(catalog?.sessions ?? [], hasActiveFilters ? matchingPaths : undefined), [catalog, hasActiveFilters, matchingPaths]);
  const treeFilterKey = `${project}\n${month}\n${provenance}\n${searchResults?.map((item) => item.path).join("\n") ?? ""}`;
  const treeRootLimit = treePagination.key === treeFilterKey ? treePagination.limit : 500;
  const sessionForest = fullSessionForest.slice(0, treeRootLimit);
  const maxProject = catalog?.topProjects[0]?.sessions ?? 1;
  const maxEvent = session?.eventTypes[0]?.count ?? 1;
  const canScanCompleteTranscript = Boolean(session && !fullScanComplete && (session.truncation.scanLimitReached || session.truncation.entryLimitReached));
  const transcriptMatchIds = useMemo(() => {
    const needle = transcriptQuery.trim().toLocaleLowerCase();
    if (!needle || !session) return [];
    return session.entries.filter((entry) => transcriptEntryText(entry).toLocaleLowerCase().includes(needle)).map((entry) => entry.id);
  }, [session, transcriptQuery]);
  const firstTranscriptMatch = transcriptMatchIds[0];
  const displayedTranscriptMatch = Math.min(activeTranscriptMatch, Math.max(0, transcriptMatchIds.length - 1));

  const focusTranscriptMatch = useCallback((index: number) => {
    if (transcriptMatchIds.length === 0) return;
    const next = (index + transcriptMatchIds.length) % transcriptMatchIds.length;
    setActiveTranscriptMatch(next);
    document.getElementById(`session-entry-${transcriptMatchIds[next]}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [transcriptMatchIds]);

  useEffect(() => {
    if (firstTranscriptMatch) requestAnimationFrame(() => document.getElementById(`session-entry-${firstTranscriptMatch}`)?.scrollIntoView({ block: "center" }));
  }, [firstTranscriptMatch, session?.path, transcriptQuery]);

  const archiveView = archiveNavigation.view;
  const expandedThreads = archiveNavigation.expandedThreads;
  const setArchiveView = (view: "list" | "tree") => dispatchArchiveNavigation({ type: "view", view });
  const toggleThread = (key: string) => dispatchArchiveNavigation({ type: "toggle", key });

  if (loading && !catalog) return <div className="flex min-h-[65vh] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Indexing session metadata…</div>;
  if (!catalog) return <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{message?.text ?? "Codex sessions are unavailable."}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0"><div className="mb-2 flex items-center gap-2"><Badge className="border-violet-200 bg-violet-50 text-violet-700"><MessageSquareText className="size-3" />JSONL corpus</Badge><span className="truncate text-xs text-muted-foreground">{catalog.root}</span></div><h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Codex Sessions</h1><p className="mt-1 max-w-3xl text-sm text-muted-foreground">Browse conversations, inspect tool activity, analyze projects and dates, or run an explicit full-text search across the local session archive.</p></div>
        <div className="flex shrink-0 items-center gap-3 self-start"><span className="whitespace-nowrap text-xs text-muted-foreground">Last indexed {formatDate(catalog.indexedAt)}</span><Button variant="outline" size="sm" onClick={refreshCatalog} disabled={loading}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />Refresh index</Button></div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Sessions" value={formatNumber(catalog.totals.sessions)} detail="Recursive JSONL files" icon={FileJson2} />
        <Metric label="Archive size" value={formatBytes(catalog.totals.bytes)} detail="Cached metadata index" icon={HardDrive} />
        <Metric label="Projects" value={formatNumber(catalog.totals.projects)} detail="Derived from working directories" icon={Folder} />
        <Metric label="Active days" value={formatNumber(catalog.totals.activeDays)} detail={`${catalog.months.length} calendar months`} icon={CalendarDays} />
      </div>

      {message && <div className={cn("flex items-center justify-between rounded-lg border px-4 py-3 text-sm", message.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}><span className="flex items-center gap-2">{message.kind === "success" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}{message.text}</span><button onClick={() => setMessage(null)} aria-label="Dismiss message"><X className="size-4" /></button></div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="min-w-0 overflow-hidden lg:fixed lg:bottom-0 lg:left-0 lg:top-[245px] lg:z-40 lg:flex lg:w-[272px] lg:flex-col lg:rounded-none lg:border-x-0 lg:border-b-0 lg:border-white/10 lg:bg-[#17202d] lg:text-white lg:[&_.text-muted-foreground]:text-slate-400">
          <CardHeader className="border-b p-4 lg:border-white/10"><div className="flex items-start justify-between gap-2"><div><CardTitle className="text-sm">Session archive</CardTitle><CardDescription>{searchResults ? `${visibleSessions.length} search results` : `${visibleSessions.length} indexed sessions`}</CardDescription></div><div className="sidebar-form-border flex rounded-lg border bg-muted/50 p-0.5 lg:bg-white/[0.06]"><button type="button" aria-pressed={archiveView === "list"} onClick={() => setArchiveView("list")} className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium lg:text-slate-400", archiveView === "list" && "bg-white shadow-sm lg:bg-white/10 lg:text-white")}><List className="size-3" />List</button><button type="button" aria-pressed={archiveView === "tree"} onClick={() => setArchiveView("tree")} className={cn("flex items-center gap-1 rounded-md px-2 py-1 text-[10px] font-medium lg:text-slate-400", archiveView === "tree" && "bg-white shadow-sm lg:bg-white/10 lg:text-white")}><GitBranch className="size-3" />Tree</button></div></div><form onSubmit={search} className="flex gap-2 pt-2"><div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search session contents…" className="sidebar-form-border pl-9 pr-8 lg:bg-white/[0.06] lg:text-white lg:placeholder:text-slate-500" />{query && <button type="button" onClick={clearSearch} aria-label="Clear session search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="size-3.5" /></button>}</div><Button type="submit" size="icon" variant="outline" disabled={searching} aria-label="Search sessions" className="sidebar-form-border lg:bg-white/[0.06] lg:text-slate-300 lg:hover:bg-white/10 lg:hover:text-white">{searching ? <Loader2 className="size-3.5 animate-spin" /> : <Search className="size-3.5" />}</Button></form><p className="text-[10px] leading-4 text-muted-foreground">Search runs only when submitted and may scan the complete archive for up to 20 seconds.</p><div className="grid gap-2 pt-1"><select value={project} onChange={(event) => setProject(event.target.value)} aria-label="Filter sessions by project" className="sidebar-form-border h-8 min-w-0 rounded-lg border bg-white px-2 text-xs lg:bg-white/[0.06] lg:text-slate-200 lg:[&>option]:bg-white lg:[&>option]:text-slate-900"><option value="All">All projects</option>{projects.map((item) => <option key={item} value={item}>{item}</option>)}</select><select value={month} onChange={(event) => setMonth(event.target.value)} aria-label="Filter sessions by month" className="sidebar-form-border h-8 min-w-0 rounded-lg border bg-white px-2 text-xs lg:bg-white/[0.06] lg:text-slate-200 lg:[&>option]:bg-white lg:[&>option]:text-slate-900"><option value="All">All months</option>{catalog.months.map((item) => <option key={item.month} value={item.month}>{monthLabel(item.month)}</option>)}</select><select value={provenance} onChange={(event) => setProvenance(event.target.value as "All" | SessionProvenance)} aria-label="Filter sessions by provenance" className="sidebar-form-border h-8 min-w-0 rounded-lg border bg-white px-2 text-xs lg:bg-white/[0.06] lg:text-slate-200 lg:[&>option]:bg-white lg:[&>option]:text-slate-900"><option value="All">All origins</option>{Object.entries(provenanceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div></CardHeader>
          <CardContent
            className="scrollbar-thin max-h-[760px] overflow-y-auto p-2 lg:min-h-0 lg:max-h-none lg:flex-1"
            onScroll={(event) => {
              const viewport = event.currentTarget;
              if (archiveView === "tree" && viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 120 && sessionForest.length < fullSessionForest.length) {
                setTreePagination({ key: treeFilterKey, limit: treeRootLimit + 500 });
              }
            }}
          >
            {archiveView === "list" ? <>{listedSessions.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No sessions match the current filters.</p> : <div className="space-y-1">{listedSessions.map((item) => <button key={item.path} onClick={() => loadSession(item.path)} className={cn("w-full rounded-lg px-2.5 py-2.5 text-left transition hover:bg-muted lg:hover:bg-white/[0.06]", session?.path === item.path && "bg-violet-50 text-violet-950 lg:bg-violet-400/10 lg:text-violet-100")}><span className="flex items-start gap-2.5"><span className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg", session?.path === item.path ? "bg-violet-100 text-violet-700 lg:bg-violet-400/10 lg:text-violet-300" : "bg-muted text-muted-foreground lg:bg-white/[0.06]")}><MessageSquareText className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-1.5"><span className="min-w-0 truncate text-xs font-semibold">{item.project}</span><ProvenanceBadge provenance={item.provenance} /></span><span className="mt-0.5 block truncate font-mono text-[9px] text-muted-foreground">{item.id}</span><span className="mt-1 flex items-center justify-between gap-2 text-[9px] text-muted-foreground"><span>{formatDate(item.startedAt)}</span><span>{formatBytes(item.size)}</span></span></span></span></button>)}</div>}{visibleSessions.length > listedSessions.length && <p className="p-3 text-center text-[10px] text-muted-foreground">Showing the first {listedSessions.length} sessions. Narrow the filters to see more.</p>}</> : sessionForest.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">No threads match the current filters.</p> : <div className="space-y-1">{sessionForest.map((node) => <ThreadTreeItem key={node.session.path} node={node} expanded={expandedThreads} selectedPath={session?.path} onToggle={toggleThread} onSelect={loadSession} />)}</div>}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          {session ? <>
            <div className="border-b px-4 py-3">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="line-clamp-2 text-sm font-semibold leading-5">{session.title}</p>
                    {(session.truncation.scanLimitReached || session.truncation.entryLimitReached) && <Badge variant="warning">partial transcript</Badge>}
                    {!session.truncation.scanLimitReached && !session.truncation.entryLimitReached && (session.truncation.oversizedRecords > 0 || session.truncation.invalidRecords > 0) && <Badge variant="warning">raw records omitted</Badge>}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{session.path}</p>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1.5"><ProvenanceBadge provenance={session.provenance} /><Badge variant="secondary">{session.model}</Badge><Badge variant="outline">{session.effort}</Badge></div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-muted-foreground sm:grid-cols-4">
                <span>{formatNumber(session.metrics.userMessages + session.metrics.assistantMessages)} messages</span>
                <span>{formatNumber(session.metrics.toolCalls)} tools</span>
                <span>{duration(session.metrics.durationMs)}</span>
                <span>{formatBytes(session.metrics.scannedBytes)} scanned</span>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex rounded-lg border bg-muted/50 p-0.5">
                  <button aria-pressed={viewer === "transcript"} onClick={() => selectViewer("transcript")} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium", viewer === "transcript" && "bg-white shadow-sm")}><MessageSquareText className="size-3" />Transcript</button>
                  <button aria-pressed={viewer === "raw"} onClick={() => selectViewer("raw")} className={cn("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium", viewer === "raw" && "bg-white shadow-sm")}><Braces className="size-3" />Raw JSONL</button>
                </div>
                {viewer === "transcript" && canScanCompleteTranscript && !fullScanning && <Button size="sm" variant="outline" onClick={scanCompleteTranscript}><ScanText className="size-3.5" />Scan complete transcript</Button>}
                {viewer === "transcript" && fullScanning && <Button size="sm" variant="outline" onClick={() => fullScanAbort.current?.abort()}><X className="size-3.5" />Cancel scan</Button>}
              </div>
              {fullScanning && <div className="mt-3"><div className="mb-1 flex justify-between text-[10px] text-muted-foreground"><span>Scanning complete file…</span><span>{Math.round(fullProgress * 100)}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full bg-violet-500 transition-[width]" style={{ width: `${fullProgress * 100}%` }} /></div></div>}
            </div>

            {viewer === "transcript" && <div className="flex flex-col gap-2 border-b bg-white px-4 py-3 sm:flex-row sm:items-center">
              <div className="relative min-w-0 flex-1"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Find in selected transcript" value={transcriptQuery} onChange={(event) => { setTranscriptQuery(event.target.value); setActiveTranscriptMatch(0); }} placeholder="Find in this transcript…" className="h-8 pl-9 pr-8 text-xs" />{transcriptQuery && <button type="button" onClick={() => { setTranscriptQuery(""); setActiveTranscriptMatch(0); }} aria-label="Clear transcript search" className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="size-3.5" /></button>}</div>
              <div className="flex shrink-0 items-center justify-between gap-2 sm:justify-end">
                <span className={cn("text-[10px]", transcriptQuery && transcriptMatchIds.length === 0 ? "text-amber-700" : "text-muted-foreground")}>{transcriptQuery ? transcriptMatchIds.length > 0 ? `${displayedTranscriptMatch + 1} of ${transcriptMatchIds.length} visible matches` : "No visible transcript match" : "Search loaded messages and tools"}</span>
                <span className="flex"><Button type="button" size="icon" variant="ghost" className="size-7" disabled={transcriptMatchIds.length === 0} onClick={() => focusTranscriptMatch(displayedTranscriptMatch - 1)} aria-label="Previous transcript match"><ChevronLeft className="size-3.5" /></Button><Button type="button" size="icon" variant="ghost" className="size-7" disabled={transcriptMatchIds.length === 0} onClick={() => focusTranscriptMatch(displayedTranscriptMatch + 1)} aria-label="Next transcript match"><ChevronRight className="size-3.5" /></Button></span>
              </div>
              {transcriptQuery && transcriptMatchIds.length === 0 && <p className="text-[10px] leading-4 text-amber-700 sm:max-w-48">The source match may be in metadata, raw JSONL, or beyond this preview.</p>}
            </div>}

            {viewer === "transcript" && session.truncated && <div className="flex items-start justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-800">
              <span className="flex min-w-0 items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span>
                {session.truncation.scanLimitReached && <>Preview stopped after {formatBytes(session.metrics.scannedBytes)} of {formatBytes(session.size)}. Scan the complete transcript to continue.</>}
                {session.truncation.entryLimitReached && <> The transcript reached its {formatNumber(fullScanComplete ? 20_000 : 1_500)}-entry display limit.</>}
                {session.truncation.oversizedRecords > 0 && <> {formatNumber(session.truncation.oversizedRecords)} oversized JSONL {session.truncation.oversizedRecords === 1 ? "record was" : "records were"} omitted from the transcript; every byte remains available in Raw JSONL.</>}
                {session.truncation.invalidRecords > 0 && <> {formatNumber(session.truncation.invalidRecords)} invalid JSONL {session.truncation.invalidRecords === 1 ? "record could" : "records could"} not be parsed; the raw bytes remain available.</>}
              </span></span>
              <button onClick={() => selectViewer("raw")} className="shrink-0 font-semibold underline underline-offset-2">View raw</button>
            </div>}

            {viewer === "transcript" ? <div className="scrollbar-thin max-h-[760px] min-h-[620px] space-y-4 overflow-y-auto bg-slate-50/60 p-4 sm:p-5">
              {sessionLoading ? <div className="flex min-h-[580px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Reading session…</div>
                : session.entries.length ? session.entries.map((entry) => <TranscriptEntry key={entry.id} entry={entry} matched={transcriptMatchIds.includes(entry.id)} />)
                  : <div className="flex min-h-[580px] items-center justify-center text-sm text-muted-foreground">No human messages or tool calls were found in the scanned portion.</div>}
            </div> : <div className="min-h-[620px] bg-[#111827] text-slate-200">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-700 px-4 py-2 text-[10px] text-slate-400">
                <span>{rawPage ? `Bytes ${(rawPage.offset + (rawPage.bytes ? 1 : 0)).toLocaleString("en-US")}–${(rawPage.offset + rawPage.bytes).toLocaleString("en-US")} of ${rawPage.fileSize.toLocaleString("en-US")}` : "Loading raw JSONL…"}</span>
                <span className="flex items-center gap-1.5">
                  {rawPage?.startsMidLine && <Badge variant="outline" className="border-amber-500/60 text-amber-300">starts inside record</Badge>}
                  {rawPage?.endsMidLine && <Badge variant="outline" className="border-amber-500/60 text-amber-300">record continues</Badge>}
                </span>
                <span className="flex items-center gap-1">
                  <Button size="icon" variant="ghost" className="size-7 text-slate-300 hover:bg-slate-700 hover:text-white" disabled={rawLoading || !rawPage || rawPage.offset === 0} onClick={() => void loadRawPage(0)} aria-label="First raw page"><ChevronsLeft className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="size-7 text-slate-300 hover:bg-slate-700 hover:text-white" disabled={rawLoading || rawPage?.previousOffset === null} onClick={() => rawPage && void loadRawPage(rawPage.previousOffset ?? 0)} aria-label="Previous raw page"><ChevronLeft className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="size-7 text-slate-300 hover:bg-slate-700 hover:text-white" disabled={rawLoading || !rawPage || rawPage.nextOffset === null} onClick={() => { const offset = rawPage?.nextOffset; if (offset !== null && offset !== undefined) void loadRawPage(offset); }} aria-label="Next raw page"><ChevronRight className="size-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="size-7 text-slate-300 hover:bg-slate-700 hover:text-white" disabled={rawLoading || !rawPage || rawPage.nextOffset === null} onClick={() => rawPage && void loadRawPage(Math.max(0, rawPage.fileSize - rawPage.byteLimit))} aria-label="Last raw page"><ChevronsRight className="size-3.5" /></Button>
                </span>
              </div>
              {rawLoading ? <div className="flex min-h-[580px] items-center justify-center gap-2 text-sm text-slate-400"><Loader2 className="size-4 animate-spin" />Reading raw bytes…</div>
                : <pre className="scrollbar-thin max-h-[720px] min-h-[580px] overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-[10px] leading-5">{rawPage?.text}</pre>}
            </div>}

            <div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[10px] text-muted-foreground"><span>{session.project} · {session.source} · {session.originator}</span><span>Started {formatDate(session.startedAt)} · {formatBytes(session.size)} · read-only</span></div>
          </> : <div className="flex min-h-[720px] items-center justify-center text-sm text-muted-foreground">Select a session.</div>}
        </Card>

        <div className="space-y-5 xl:grid xl:grid-cols-3 xl:gap-5 xl:space-y-0 2xl:block 2xl:space-y-5">
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Folder className="size-4 text-violet-600" />Top projects</CardTitle><CardDescription>Sessions by working directory</CardDescription></CardHeader><CardContent className="space-y-2.5">{catalog.topProjects.slice(0, 10).map((item) => <button key={item.project} onClick={() => setProject(item.project)} className="block w-full text-left"><div className="mb-1 flex items-center justify-between gap-3 text-[11px]"><span className="truncate">{item.project}</span><span className="shrink-0 tabular-nums text-muted-foreground">{formatNumber(item.sessions)}</span></div><div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-violet-500" style={{ width: `${Math.max(4, item.sessions / maxProject * 100)}%` }} /></div></button>)}</CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><CalendarDays className="size-4 text-indigo-500" />Monthly activity</CardTitle><CardDescription>Recent archive volume</CardDescription></CardHeader><CardContent className="space-y-2">{catalog.months.slice(0, 10).map((item) => <button key={item.month} onClick={() => setMonth(item.month)} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-muted"><span>{monthLabel(item.month)}</span><span className="text-right"><b className="font-semibold">{formatNumber(item.sessions)}</b><small className="ml-2 text-[9px] text-muted-foreground">{formatBytes(item.bytes)}</small></span></button>)}</CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Terminal className="size-4 text-cyan-600" />Selected activity</CardTitle><CardDescription>Most frequent JSONL event types</CardDescription></CardHeader><CardContent className="space-y-2.5">{session?.eventTypes.slice(0, 10).map((item) => <div key={item.type}><div className="mb-1 flex items-center justify-between gap-3 text-[10px]"><span className="truncate font-mono">{item.type}</span><span className="tabular-nums text-muted-foreground">{formatNumber(item.count)}</span></div><div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.max(4, item.count / maxEvent * 100)}%` }} /></div></div>) ?? <p className="text-xs text-muted-foreground">Select a session to inspect its event composition.</p>}</CardContent></Card>
        </div>
      </div>
    </div>
  );
}
