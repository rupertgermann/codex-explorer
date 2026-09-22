"use client";

import { ModuleSidebar, ModuleSidebarTrigger } from "@/components/module-sidebar";

import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Eye,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { MemoryForgetDialog, type ForgetRecheck } from "@/components/memory-forget-dialog";
import { MemoryOrphanDialog } from "@/components/memory-orphan-dialog";
import { cn, formatBytes, formatDate, formatNumber } from "@/lib/utils";
import type { ForgetPlan, ForgetResult, ProjectForgetPlan } from "@/lib/memory-forget";
import type { OrphanPlan, OrphanResult } from "@/lib/memory-orphan";
import { isAggregateMemoryPath } from "@/lib/memory-policy";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MemoryFile = {
  path: string;
  name: string;
  directory: string;
  title: string;
  size: number;
  modifiedAt: number;
  words: number;
  headings: number;
  hash: string;
};

type MemoryDocument = MemoryFile & { content: string };
type MemoryCatalog = {
  root: string;
  files: MemoryFile[];
  directories: string[];
  totals: { files: number; bytes: number; words: number; headings: number };
  topTerms: { term: string; count: number }[];
};
type SearchResult = {
  path: string;
  title: string;
  matches: { line: number; excerpt: string }[];
  matchCount: number;
};
async function memoryRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Memory request failed.");
  return data as T;
}

async function memorySnapshot(includeInitialDocument: boolean, initialPath?: string) {
  const catalog = await memoryRequest<MemoryCatalog>("/api/memory");
  if (!includeInitialDocument) return { catalog, document: null, missingInitialPath: "" };
  const initial = initialPath
    ? catalog.files.find((file) => file.path === initialPath)
    : catalog.files.find((file) => file.path === "MEMORY.md") ?? catalog.files[0];
  const document = initial
    ? await memoryRequest<MemoryDocument>(`/api/memory/document?path=${encodeURIComponent(initial.path)}`)
    : null;
  return { catalog, document, missingInitialPath: initialPath && !initial ? initialPath : "" };
}

const MarkdownPreview = memo(function MarkdownPreview({ content, onForgetLine }: { content: string; onForgetLine?: (line: number) => void }) {
  const lines = content.split(/\r?\n/);
  return (
    <article className="memory-markdown mx-auto max-w-3xl p-6 text-sm leading-7 text-foreground sm:p-8">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          li: ({ node, children, ...props }) => {
            const line = node?.position?.start.line;
            const forgettable = line !== undefined && lines[line - 1]?.startsWith("- ");
            return <li {...props}>{children}{forgettable && onForgetLine && <button type="button" onClick={() => onForgetLine(line)} className="ml-2 inline-flex min-h-6 items-center rounded-md border border-destructive/25 px-2 py-0.5 text-[11px] font-medium leading-4 text-destructive hover:bg-destructive/10">Forget…</button>}</li>;
          },
        }}
      >{content}</ReactMarkdown>
    </article>
  );
});

export function MemoryWorkspace({ initialPath, onDirtyChange, active = true }: { initialPath?: string; onDirtyChange?: (dirty: boolean) => void; active?: boolean }) {
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [directory, setDirectory] = useState("Root");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [loading, setLoading] = useState(true);
  const [documentLoading, setDocumentLoading] = useState(false);
  const [browserSelection, setBrowserSelection] = useState(0);
  const [saving, setSaving] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const [forgetPlan, setForgetPlan] = useState<ForgetPlan | ProjectForgetPlan | null>(null);
  const [forgetDirectory, setForgetDirectory] = useState<string | null>(null);
  const [forgetConfirmation, setForgetConfirmation] = useState("");
  const [forgetResult, setForgetResult] = useState<ForgetResult | null>(null);
  const [forgetRecheck, setForgetRecheck] = useState<ForgetRecheck | null>(null);
  const [forgetLoading, setForgetLoading] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const [confirmedDurableIds, setConfirmedDurableIds] = useState<string[]>([]);
  const [orphanOpen, setOrphanOpen] = useState(false);
  const [orphanPlan, setOrphanPlan] = useState<OrphanPlan | null>(null);
  const [orphanResult, setOrphanResult] = useState<OrphanResult | null>(null);
  const [orphanLoading, setOrphanLoading] = useState(false);
  const [orphanError, setOrphanError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const documentRequest = useRef<AbortController | null>(null);
  const [searching, setSearching] = useState(false);
  const dirty = document !== null && editedContent !== document.content;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const loadDocument = useCallback(async (path: string, force = false) => {
    if (saving) return;
    if (!force && dirty && !window.confirm("Discard the unsaved changes in this memory file?")) return;
    documentRequest.current?.abort();
    const controller = new AbortController();
    documentRequest.current = controller;
    setDocumentLoading(true); setMessage(null);
    try {
      const next = await memoryRequest<MemoryDocument>(`/api/memory/document?path=${encodeURIComponent(path)}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setDirectory(next.directory);
      setDocument(next); setEditedContent(next.content); setView("preview");
      setBrowserSelection(value => value + 1);
      if (window.innerWidth < 1024) requestAnimationFrame(() => {
        const reader = window.document.getElementById("memory-document");
        reader?.focus({ preventScroll: true });
        reader?.scrollIntoView({ block: "start" });
      });
    } catch (error) {
      if (!controller.signal.aborted) setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not open memory file." });
    } finally { if (!controller.signal.aborted) setDocumentLoading(false); }
  }, [dirty, saving]);

  useEffect(() => () => documentRequest.current?.abort(), []);

  const loadCatalog = useCallback(async () => {
    setLoading(true); setMessage(null);
    try {
      const next = await memorySnapshot(!document);
      setCatalog(next.catalog);
      if (next.document) {
        setDocument(next.document);
        setEditedContent(next.document.content);
      }
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not load Codex memory." });
    } finally { setLoading(false); }
  }, [document]);

  useEffect(() => {
    memorySnapshot(true, initialPath)
      .then((next) => {
        setCatalog(next.catalog);
        if (next.document) {
          setDocument(next.document);
          setDirectory(next.document.directory);
          setEditedContent(next.document.content);
        }
        if (next.missingInitialPath) setMessage({ kind: "error", text: `${next.missingInitialPath} no longer exists. Refresh search and try again.` });
      })
      .catch((error) => setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not load Codex memory." }))
      .finally(() => setLoading(false));
  }, [initialPath]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const needle = query.trim();
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (!needle) { setSearchResults(null); setSearching(false); return; }
      setSearching(true);
      memoryRequest<{ results: SearchResult[] }>(`/api/memory/search?q=${encodeURIComponent(needle)}`, { signal: controller.signal })
        .then(data => { if (!controller.signal.aborted) setSearchResults(data.results); })
        .catch(error => { if (!controller.signal.aborted) setMessage({ kind: "error", text: error instanceof Error ? error.message : "Search failed." }); })
        .finally(() => { if (!controller.signal.aborted) setSearching(false); });
    }, needle ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query]);

  async function save() {
    if (!document || !dirty || saving) return;
    setSaving(true); setMessage(null);
    try {
      const saved = await memoryRequest<MemoryDocument>("/api/memory/document", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: document.path, content: editedContent, expectedHash: document.hash }),
      });
      setDocument(saved); setEditedContent(saved.content);
      setMessage({ kind: "success", text: `Saved ${saved.path}` });
      const next = await memoryRequest<MemoryCatalog>("/api/memory");
      setCatalog(next);
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not save memory file." });
    } finally { setSaving(false); }
  }

  async function previewForget(summaryLine: number, durableIds: string[] = []) {
    if (!document || document.path !== "memory_summary.md" || dirty) return;
    setForgetDirectory(null);
    setForgetOpen(true); setForgetPlan(null); setForgetLoading(true); setForgetError(null); setForgetResult(null); setForgetRecheck(null);
    try {
      const plan = await memoryRequest<ForgetPlan>("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", selection: { summaryLine, expectedSummaryHash: document.hash, confirmedDurableIds: durableIds } }),
      });
      setForgetPlan(plan);
      setConfirmedDurableIds(durableIds.length ? durableIds : plan.durableCandidates.length === 1 ? [plan.durableCandidates[0].id] : []);
    } catch (error) {
      setForgetError(error instanceof Error ? error.message : "Could not preview this Forget plan.");
    } finally { setForgetLoading(false); }
  }

  async function previewProjectForget(directory: string) {
    if (dirty) return;
    setForgetConfirmation("");
    setForgetDirectory(directory); setForgetOpen(true); setForgetPlan(null); setForgetLoading(true); setForgetError(null); setForgetResult(null); setForgetRecheck(null);
    try {
      const plan = await memoryRequest<ProjectForgetPlan>("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "preview", selection: { kind: "project", directory } }),
      });
      setForgetPlan(plan); setForgetDirectory(plan.directory);
    } catch (error) {
      setForgetPlan(null);
      setForgetError(error instanceof Error ? error.message : "Could not preview this project.");
    } finally { setForgetLoading(false); }
  }

  async function applyForget() {
    if (!forgetPlan?.actionable || dirty) return;
    if ("kind" in forgetPlan && (forgetDirectory !== forgetPlan.directory || forgetConfirmation !== forgetPlan.directory)) return;
    setForgetLoading(true); setForgetError(null);
    let applied = false;
    try {
      const result = await memoryRequest<ForgetResult>("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", plan: forgetPlan, ...("kind" in forgetPlan ? { confirmedDirectory: forgetConfirmation } : {}) }),
      });
      applied = true;
      setForgetResult(result);
      const next = await memorySnapshot(false);
      setCatalog(next.catalog);
      const path = next.catalog.files.find(({ path }) => path === "memory_summary.md")?.path ?? next.catalog.files[0]?.path;
      const refreshed = await memoryRequest<MemoryDocument>(`/api/memory/document?path=${encodeURIComponent(path)}`);
      setDocument(refreshed); setEditedContent(refreshed.content);
    } catch (error) {
      if ("kind" in forgetPlan && !applied) { setForgetPlan(null); setForgetConfirmation(""); }
      setForgetError(error instanceof Error ? error.message : "Could not apply this Forget plan.");
    } finally { setForgetLoading(false); }
  }

  async function recheckForget() {
    if (!forgetPlan || "kind" in forgetPlan) return;
    setForgetLoading(true); setForgetError(null);
    try {
      setForgetRecheck(await memoryRequest<ForgetRecheck>("/api/memory/forget", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "recheck", plan: forgetPlan }),
      }));
    } catch (error) {
      setForgetError(error instanceof Error ? error.message : "Could not recheck this Memory.");
    } finally { setForgetLoading(false); }
  }

  async function inspectOrphan() {
    if (!document || isAggregateMemoryPath(document.path) || dirty) return;
    setOrphanOpen(true); setOrphanLoading(true); setOrphanError(null); setOrphanPlan(null); setOrphanResult(null);
    try {
      setOrphanPlan(await memoryRequest<OrphanPlan>("/api/memory/orphan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "inspect", path: document.path }),
      }));
    } catch (error) {
      setOrphanError(error instanceof Error ? error.message : "Could not inspect this orphan candidate.");
    } finally { setOrphanLoading(false); }
  }

  async function applyOrphan() {
    if (!orphanPlan?.eligible) return;
    setOrphanLoading(true); setOrphanError(null);
    try {
      const result = await memoryRequest<OrphanResult>("/api/memory/orphan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "apply", plan: orphanPlan, confirmation: { path: orphanPlan.path, expectedHash: orphanPlan.expectedHash } }),
      });
      setOrphanResult(result);
      const next = await memorySnapshot(false);
      setCatalog(next.catalog);
      const fallback = next.catalog.files.find(({ path }) => path === "MEMORY.md") ?? next.catalog.files[0];
      if (fallback) {
        const refreshed = await memoryRequest<MemoryDocument>(`/api/memory/document?path=${encodeURIComponent(fallback.path)}`);
        setDocument(refreshed); setEditedContent(refreshed.content); setView("edit");
      } else {
        setDocument(null); setEditedContent("");
      }
    } catch (error) {
      setOrphanError(error instanceof Error ? error.message : "Could not delete this orphan file.");
    } finally { setOrphanLoading(false); }
  }

  const visibleFiles = useMemo(() => catalog?.files.filter((file) => directory === "All" || file.directory === directory) ?? [], [catalog, directory]);
  const directoryCounts = useMemo(() => catalog?.files.reduce<Record<string, number>>((counts, file) => ({ ...counts, [file.directory]: (counts[file.directory] ?? 0) + 1 }), {}) ?? {}, [catalog]);

  if (loading && !catalog) return <div className="flex min-h-[65vh] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Analyzing Markdown memory…</div>;
  if (!catalog) return <div role="alert" className="rounded-xl border border-destructive/25 bg-destructive/8 p-5 text-sm text-destructive"><p>{message?.text ?? "Codex memory is unavailable."}</p><Button className="mt-3" variant="outline" onClick={loadCatalog}>Try again</Button></div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0"><div className="mb-2 flex items-center gap-2"><Badge variant="secondary"><Brain className="size-3" />Markdown corpus</Badge><span className="truncate text-xs text-muted-foreground">{catalog.root}</span></div><h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Markdown memory</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Find remembered decisions, read their context, and edit Markdown files.</p></div>
        <div className="shrink-0 space-y-2"><div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" onClick={() => { void previewProjectForget(""); }} disabled={dirty || loading}><Trash2 className="size-3.5" />Forget project…</Button><Button variant="outline" size="sm" onClick={loadCatalog} disabled={loading}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />Refresh analysis</Button></div>{dirty && <p className="text-[11px] text-amber-700 dark:text-amber-300">Save or discard editor changes before Project Forget.</p>}</div>
      </div>

      <p className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground"><span><b className="font-medium text-foreground">{formatNumber(catalog.totals.files)}</b> files</span><span>{formatBytes(catalog.totals.bytes)}</span><span>{formatNumber(catalog.totals.words)} words</span><span>{catalog.directories.length} directories</span></p>

      {message && <div role={message.kind === "error" ? "alert" : "status"} className={cn("flex items-start justify-between gap-3 rounded-xl border px-4 py-3 text-sm", message.kind === "success" ? "border-emerald-200 bg-emerald-50 dark:border-emerald-400/25 dark:bg-emerald-400/10 text-emerald-700 dark:text-emerald-300" : "border-destructive/25 bg-destructive/8 text-destructive")}><span className="flex min-w-0 items-start gap-2 break-words">{message.kind === "success" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}{message.text}</span><button onClick={() => setMessage(null)} aria-label="Dismiss message" className="grid size-6 shrink-0 place-items-center rounded-md hover:bg-background/50"><X className="size-4" /></button></div>}

      <div className="grid min-w-0 gap-5">
        <ModuleSidebar id="memory-browser" active={active} label="Browse memory files" selectionKey={browserSelection}><Card className="min-w-0 overflow-hidden lg:flex lg:h-full lg:min-h-0 lg:flex-col lg:rounded-none lg:border-0 lg:bg-transparent lg:shadow-none">
          <CardHeader className="border-b p-4"><CardTitle className="text-sm">Memory files</CardTitle><CardDescription>Every Markdown file under the memory root</CardDescription><div className="relative pt-2"><Search className="absolute left-3 top-[26px] size-3.5 -translate-y-1/2 text-muted-foreground" /><Input aria-label="Search Memory contents" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all contents…" className="sidebar-form-border pl-9 pr-8" />{query && <button aria-label="Clear Memory search" onClick={() => setQuery("")} className="absolute right-1 top-[26px] grid size-7 -translate-y-1/2 place-items-center rounded-md text-muted-foreground hover:bg-muted"><X className="size-3.5" /></button>}</div>{!query && <select aria-label="Memory directory" value={directory} onChange={(event) => setDirectory(event.target.value)} className="sidebar-form-border mt-2 h-8 w-full rounded-lg border bg-card px-2 text-xs text-foreground"><option value="All">All directories ({catalog.files.length})</option>{catalog.directories.map((item) => <option key={item} value={item}>{item} ({directoryCounts[item]})</option>)}</select>}</CardHeader>
          <CardContent className="scrollbar-thin max-h-72 overflow-y-auto p-2 lg:min-h-0 lg:max-h-none lg:flex-1">
            {searching && <p role="status" className="p-3 text-xs text-muted-foreground">Searching Memory…</p>}
            {searchResults !== null ? searchResults.length === 0 ? <p className="p-5 text-center text-xs text-muted-foreground">No matches for “{query}”.</p> : <div className="space-y-1">{searchResults.map((result) => <button key={result.path} disabled={saving} aria-current={document?.path === result.path ? "true" : undefined} onClick={() => loadDocument(result.path)} className={cn("w-full rounded-xl border p-3 text-left transition hover:border-primary/30 hover:bg-accent/50", document?.path === result.path && "border-primary/30 bg-accent text-accent-foreground")}><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-xs font-semibold">{result.title}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{result.path}</span></span><Badge variant="secondary">{result.matchCount}</Badge></span>{result.matches.slice(0, 2).map((match, index) => <span key={`${match.line}-${index}`} className="mt-2 block border-l-2 border-primary/25 pl-2 text-[11px] leading-4 text-muted-foreground"><b className="mr-1 text-accent-foreground">L{match.line}</b>{match.excerpt}</span>)}</button>)}</div> : <div className="space-y-1">{visibleFiles.map((file) => <button key={file.path} disabled={saving} aria-current={document?.path === file.path ? "true" : undefined} onClick={() => loadDocument(file.path)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted", document?.path === file.path && "bg-accent text-accent-foreground")}><span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", document?.path === file.path ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground")}><FileText className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{file.title}</span><span className="block truncate font-mono text-[10px] text-muted-foreground">{file.path}</span></span><span className="text-[10px] tabular-nums text-muted-foreground">{formatBytes(file.size)}</span></button>)}</div>}
          </CardContent>
        </Card></ModuleSidebar>

        <Card id="memory-document" tabIndex={-1} className="min-w-0 scroll-mt-20 overflow-hidden">
          {document ? <Fragment><div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{document.title}</p>{dirty && <Badge variant="warning">unsaved</Badge>}</div><p className="truncate font-mono text-[11px] text-muted-foreground">{document.path}</p></div><div className="flex shrink-0 flex-wrap items-center gap-2"><ModuleSidebarTrigger targetId="memory-browser" label="Browse files" /><div className="flex rounded-lg border bg-muted/40 p-0.5"><button aria-pressed={view === "edit"} onClick={() => setView("edit")} className={cn("flex h-7 items-center gap-1 rounded-md px-2 text-[11px]", view === "edit" ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground")}><Pencil className="size-3" />Edit</button><button aria-pressed={view === "preview"} onClick={() => setView("preview")} className={cn("flex h-7 items-center gap-1 rounded-md px-2 text-[11px]", view === "preview" ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground")}><Eye className="size-3" />Preview</button></div>{view === "edit" && <Button size="sm" onClick={save} title="Save (⌘ / Ctrl + S)" disabled={!dirty || saving || documentLoading}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}Save</Button>}{dirty && <Button variant="ghost" size="sm" disabled={saving} onClick={() => { if (window.confirm("Discard the unsaved changes in this memory file?")) { setEditedContent(document.content); setMessage(null); } }}>Discard</Button>}</div></div>{documentLoading ? <div className="flex min-h-[600px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Opening file…</div> : view === "edit" ? <textarea aria-label="Memory Markdown" readOnly={saving} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void save(); } }} value={editedContent} onChange={(event) => setEditedContent(event.target.value)} spellCheck={false} className="scrollbar-thin min-h-[420px] sm:min-h-[600px] w-full resize-y bg-muted/30 p-5 font-mono text-xs leading-6 text-foreground focus-visible:-outline-offset-2" /> : <div role="region" aria-label="Memory preview" tabIndex={0} className="scrollbar-thin min-h-[420px] sm:min-h-[600px] max-h-[760px] overflow-y-auto bg-card"><MarkdownPreview content={editedContent} onForgetLine={document.path === "memory_summary.md" && !dirty ? previewForget : undefined} /></div>}<div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[11px] text-muted-foreground"><span>{formatNumber(editedContent.length)} characters · {formatNumber(editedContent.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0)} words</span><span>Loaded {formatDate(document.modifiedAt)} · rev {document.hash.slice(0, 8)}</span></div></Fragment> : <div className="flex min-h-[420px] sm:min-h-[600px] items-center justify-center p-6 text-center text-sm text-muted-foreground">{catalog.files.length ? "Select a memory file." : "No Markdown files found in this Memory folder."}</div>}
        </Card>

        <details className="rounded-2xl border bg-card p-4">
          <summary className="cursor-pointer text-sm font-medium">Advanced cleanup</summary>
          <p className="mt-3 text-xs text-muted-foreground">Inspect dependencies before removing one whole non-core file.</p>
          {document && !isAggregateMemoryPath(document.path) ? <div className="mt-3 space-y-2"><p className="break-all font-mono text-[11px] text-muted-foreground">{document.path}</p><Button variant="outline" size="sm" onClick={() => { void inspectOrphan(); }} disabled={dirty}><Trash2 className="size-3.5" />Delete orphaned file…</Button>{dirty && <p className="text-xs text-amber-700 dark:text-amber-300">Save or discard editor changes before inspection.</p>}</div> : <p className="mt-2 text-xs text-muted-foreground">Aggregate Memory files are never eligible. Use Forget for individual Memories.</p>}
        </details>
      </div>

      <MemoryForgetDialog
        open={forgetOpen}
        loading={forgetLoading}
        error={forgetError}
        plan={forgetPlan}
        result={forgetResult}
        recheck={forgetRecheck}
        confirmedDurableIds={confirmedDurableIds}
        project={forgetDirectory === null ? undefined : {
          directory: forgetDirectory,
          confirmation: forgetConfirmation,
          onConfirmationChange: setForgetConfirmation,
          onDirectoryChange: (directory) => { setForgetDirectory(directory); setForgetConfirmation(""); },
          onPreview: () => { void previewProjectForget(forgetDirectory); },
        }}
        onOpenChange={setForgetOpen}
        onConfirm={(id, confirmed) => setConfirmedDurableIds((ids) => confirmed ? [...new Set([...ids, id])] : ids.filter((item) => item !== id))}
        onRefresh={() => { if (forgetPlan && !("kind" in forgetPlan)) void previewForget(forgetPlan.selection.summaryLine, confirmedDurableIds); }}
        onApply={() => { void applyForget(); }}
        onRecheck={() => { void recheckForget(); }}
      />
      <MemoryOrphanDialog
        key={orphanPlan?.expectedHash ?? "empty-orphan-plan"}
        open={orphanOpen}
        loading={orphanLoading}
        error={orphanError}
        plan={orphanPlan}
        result={orphanResult}
        onOpenChange={setOrphanOpen}
        onApply={() => { void applyOrphan(); }}
      />
    </div>
  );
}
