"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Brain,
  CheckCircle2,
  Eye,
  FileText,
  Folder,
  Hash,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Text,
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

function Metric({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Brain }) {
  return (
    <Card>
      <CardContent className="flex items-start justify-between p-4">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</p><p className="mt-1.5 text-xl font-semibold tracking-[-0.03em]">{value}</p><p className="mt-1 text-[11px] text-muted-foreground">{detail}</p></div>
        <span className="rounded-lg bg-cyan-50 p-2 text-cyan-700"><Icon className="size-4" /></span>
      </CardContent>
    </Card>
  );
}

function MarkdownPreview({ content, onForgetLine }: { content: string; onForgetLine?: (line: number) => void }) {
  const lines = content.split(/\r?\n/);
  return (
    <article className="memory-markdown mx-auto max-w-3xl p-6 text-sm leading-7 text-slate-700 sm:p-8">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          li: ({ node, children, ...props }) => {
            const line = node?.position?.start.line;
            const forgettable = line !== undefined && lines[line - 1]?.startsWith("- ");
            return <li {...props}>{children}{forgettable && onForgetLine && <button type="button" onClick={() => onForgetLine(line)} className="ml-2 inline-flex rounded border border-red-200 px-1.5 py-0.5 text-[10px] font-medium leading-4 text-red-700 hover:bg-red-50">Forget…</button>}</li>;
          },
        }}
      >{content}</ReactMarkdown>
    </article>
  );
}

export function MemoryWorkspace({ initialPath, onDirtyChange }: { initialPath?: string; onDirtyChange?: (dirty: boolean) => void }) {
  const [catalog, setCatalog] = useState<MemoryCatalog | null>(null);
  const [document, setDocument] = useState<MemoryDocument | null>(null);
  const [editedContent, setEditedContent] = useState("");
  const [directory, setDirectory] = useState("Root");
  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [loading, setLoading] = useState(true);
  const [documentLoading, setDocumentLoading] = useState(false);
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

  const dirty = document !== null && editedContent !== document.content;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const loadDocument = useCallback(async (path: string, force = false) => {
    if (!force && dirty && !window.confirm("Discard the unsaved changes in this memory file?")) return;
    setDocumentLoading(true); setMessage(null);
    try {
      const next = await memoryRequest<MemoryDocument>(`/api/memory/document?path=${encodeURIComponent(path)}`);
      setDocument(next); setEditedContent(next.content); setView("preview");
    } catch (error) {
      setMessage({ kind: "error", text: error instanceof Error ? error.message : "Could not open memory file." });
    } finally { setDocumentLoading(false); }
  }, [dirty]);

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
    if (!needle) {
      const timer = setTimeout(() => setSearchResults(null), 0);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(() => {
      memoryRequest<{ results: SearchResult[] }>(`/api/memory/search?q=${encodeURIComponent(needle)}`)
        .then((data) => setSearchResults(data.results))
        .catch((error) => setMessage({ kind: "error", text: error instanceof Error ? error.message : "Search failed." }));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  async function save() {
    if (!document || !dirty) return;
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
    setForgetOpen(true); setForgetLoading(true); setForgetError(null); setForgetResult(null); setForgetRecheck(null);
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
    setForgetDirectory(directory); setForgetOpen(true); setForgetLoading(true); setForgetError(null); setForgetResult(null); setForgetRecheck(null);
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
  const maxTerm = catalog?.topTerms[0]?.count ?? 1;

  if (loading && !catalog) return <div className="flex min-h-[65vh] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Analyzing Markdown memory…</div>;
  if (!catalog) return <div className="rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">{message?.text ?? "Codex memory is unavailable."}</div>;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0"><div className="mb-2 flex items-center gap-2"><Badge className="border-cyan-200 bg-cyan-50 text-cyan-700"><Brain className="size-3" />Markdown corpus</Badge><span className="truncate text-xs text-muted-foreground">{catalog.root}</span></div><h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Codex Memory</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Search and analyze the complete Markdown corpus, then edit files with revision-checked atomic saves.</p></div>
        <div className="shrink-0 space-y-2"><div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => { setForgetPlan(null); void previewProjectForget(""); }} disabled={dirty || loading}><Trash2 className="size-3.5" />Forget project…</Button><Button variant="outline" size="sm" onClick={loadCatalog} disabled={loading}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />Refresh analysis</Button></div>{dirty && <p className="text-[10px] text-amber-700">Save or discard editor changes before Project Forget.</p>}</div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label="Files" value={formatNumber(catalog.totals.files)} detail={`${catalog.directories.length} directories`} icon={FileText} />
        <Metric label="Corpus size" value={formatBytes(catalog.totals.bytes)} detail="All Markdown files" icon={BookOpen} />
        <Metric label="Words" value={formatNumber(catalog.totals.words)} detail="Searchable tokens" icon={Text} />
        <Metric label="Headings" value={formatNumber(catalog.totals.headings)} detail="Document structure" icon={Hash} />
      </div>

      {message && <div className={cn("flex items-center justify-between rounded-lg border px-4 py-3 text-sm", message.kind === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-red-200 bg-red-50 text-red-700")}><span className="flex items-center gap-2">{message.kind === "success" ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}{message.text}</span><button onClick={() => setMessage(null)} aria-label="Dismiss message"><X className="size-4" /></button></div>}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)] 2xl:grid-cols-[minmax(0,1fr)_280px]">
        <Card className="min-w-0 overflow-hidden lg:fixed lg:bottom-0 lg:left-0 lg:top-[245px] lg:z-40 lg:flex lg:w-[272px] lg:flex-col lg:rounded-none lg:border-x-0 lg:border-b-0 lg:border-white/10 lg:bg-[#17202d] lg:text-white lg:[&_.text-muted-foreground]:text-slate-400">
          <CardHeader className="border-b p-4 lg:border-white/10"><CardTitle className="text-sm">Memory files</CardTitle><CardDescription>Every Markdown file under the memory root</CardDescription><div className="relative pt-2"><Search className="absolute left-3 top-[26px] size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search all contents…" className="sidebar-form-border pl-9 pr-8 lg:bg-white/[0.06] lg:text-white lg:placeholder:text-slate-500" />{query && <button onClick={() => setQuery("")} className="absolute right-3 top-[26px] -translate-y-1/2 text-muted-foreground"><X className="size-3.5" /></button>}</div>{!query && <select value={directory} onChange={(event) => setDirectory(event.target.value)} className="sidebar-form-border mt-2 h-8 w-full rounded-lg border bg-white px-2 text-xs lg:bg-white/[0.06] lg:text-slate-200 lg:[&>option]:bg-white lg:[&>option]:text-slate-900"><option value="All">All directories ({catalog.files.length})</option>{catalog.directories.map((item) => <option key={item} value={item}>{item} ({directoryCounts[item]})</option>)}</select>}</CardHeader>
          <CardContent className="scrollbar-thin max-h-[680px] overflow-y-auto p-2 lg:min-h-0 lg:max-h-none lg:flex-1">
            {searchResults !== null ? searchResults.length === 0 ? <p className="p-5 text-center text-xs text-muted-foreground">No matches for “{query}”.</p> : <div className="space-y-1">{searchResults.map((result) => <button key={result.path} onClick={() => loadDocument(result.path)} className={cn("w-full rounded-lg border p-3 text-left transition hover:border-indigo-200 hover:bg-indigo-50/40 lg:border-white/10 lg:hover:border-cyan-300/20 lg:hover:bg-white/[0.06]", document?.path === result.path && "border-indigo-300 bg-indigo-50 lg:border-cyan-300/20 lg:bg-cyan-400/10 lg:text-cyan-100")}><span className="flex items-start justify-between gap-2"><span className="min-w-0"><span className="block truncate text-xs font-semibold">{result.title}</span><span className="block truncate font-mono text-[9px] text-muted-foreground">{result.path}</span></span><Badge variant="secondary">{result.matchCount}</Badge></span>{result.matches.slice(0, 2).map((match, index) => <span key={`${match.line}-${index}`} className="mt-2 block border-l-2 border-indigo-200 pl-2 text-[10px] leading-4 text-muted-foreground lg:border-cyan-300/20"><b className="mr-1 text-indigo-500 lg:text-cyan-300">L{match.line}</b>{match.excerpt}</span>)}</button>)}</div> : <div className="space-y-1">{visibleFiles.map((file) => <button key={file.path} onClick={() => loadDocument(file.path)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-muted lg:hover:bg-white/[0.06]", document?.path === file.path && "bg-indigo-50 text-indigo-900 lg:bg-cyan-400/10 lg:text-cyan-100")}><span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", document?.path === file.path ? "bg-indigo-100 text-indigo-700 lg:bg-cyan-400/10 lg:text-cyan-300" : "bg-muted text-muted-foreground lg:bg-white/[0.06]")}><FileText className="size-3.5" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{file.title}</span><span className="block truncate font-mono text-[9px] text-muted-foreground">{file.path}</span></span><span className="text-[9px] tabular-nums text-muted-foreground">{formatBytes(file.size)}</span></button>)}</div>}
          </CardContent>
        </Card>

        <Card className="min-w-0 overflow-hidden">
          {document ? <Fragment><div className="flex flex-col gap-3 border-b px-4 py-3 sm:flex-row sm:items-center sm:justify-between"><div className="min-w-0"><div className="flex items-center gap-2"><p className="truncate text-sm font-semibold">{document.title}</p>{dirty && <Badge variant="warning">unsaved</Badge>}</div><p className="truncate font-mono text-[10px] text-muted-foreground">{document.path}</p></div><div className="flex items-center gap-2"><div className="flex rounded-lg border bg-muted/40 p-0.5"><button onClick={() => setView("edit")} className={cn("flex h-7 items-center gap-1 rounded-md px-2 text-[11px]", view === "edit" ? "bg-white font-medium shadow-sm" : "text-muted-foreground")}><Pencil className="size-3" />Edit</button><button onClick={() => setView("preview")} className={cn("flex h-7 items-center gap-1 rounded-md px-2 text-[11px]", view === "preview" ? "bg-white font-medium shadow-sm" : "text-muted-foreground")}><Eye className="size-3" />Preview</button></div><Button size="sm" onClick={save} disabled={!dirty || saving}>{saving ? <Loader2 className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}Save</Button></div></div>{documentLoading ? <div className="flex min-h-[600px] items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Opening file…</div> : view === "edit" ? <textarea value={editedContent} onChange={(event) => setEditedContent(event.target.value)} spellCheck={false} className="scrollbar-thin min-h-[680px] w-full resize-y bg-[#151c27] p-5 font-mono text-[12px] leading-6 text-slate-200 outline-none" /> : <div className="scrollbar-thin min-h-[680px] max-h-[760px] overflow-y-auto bg-white"><MarkdownPreview content={editedContent} onForgetLine={document.path === "memory_summary.md" && !dirty ? previewForget : undefined} /></div>}<div className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-2 text-[10px] text-muted-foreground"><span>{formatNumber(editedContent.length)} characters · {formatNumber(editedContent.match(/[\p{L}\p{N}][\p{L}\p{N}_'-]*/gu)?.length ?? 0)} words</span><span>Loaded {formatDate(document.modifiedAt)} · rev {document.hash.slice(0, 8)}</span></div></Fragment> : <div className="flex min-h-[680px] items-center justify-center text-sm text-muted-foreground">Select a memory file.</div>}
        </Card>

        <div className="space-y-5 xl:grid xl:grid-cols-2 xl:gap-5 xl:space-y-0 2xl:block 2xl:space-y-5">
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Brain className="size-4 text-cyan-600" />Frequent terms</CardTitle><CardDescription>Most frequent non-stopwords across the corpus</CardDescription></CardHeader><CardContent className="space-y-2.5">{catalog.topTerms.slice(0, 12).map((item) => <div key={item.term}><div className="mb-1 flex items-center justify-between text-[11px]"><span className="truncate">{item.term}</span><span className="tabular-nums text-muted-foreground">{formatNumber(item.count)}</span></div><div className="h-1 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-cyan-500" style={{ width: `${Math.max(4, item.count / maxTerm * 100)}%` }} /></div></div>)}</CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Folder className="size-4 text-indigo-500" />Corpus map</CardTitle><CardDescription>Markdown files by directory</CardDescription></CardHeader><CardContent className="space-y-2">{Object.entries(directoryCounts).sort(([, left], [, right]) => right - left).map(([name, count]) => <button key={name} onClick={() => { setQuery(""); setDirectory(name); }} className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-xs hover:bg-muted"><span className="truncate font-mono text-[10px]">{name}</span><Badge variant="secondary">{count}</Badge></button>)}</CardContent></Card>
          <Card><CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Trash2 className="size-4 text-red-500" />Advanced cleanup</CardTitle><CardDescription>Inspect dependencies before removing one whole non-core file</CardDescription></CardHeader><CardContent>{document && !isAggregateMemoryPath(document.path) ? <div className="space-y-2"><p className="font-mono text-[10px] text-muted-foreground">{document.path}</p><Button variant="outline" size="sm" onClick={() => { void inspectOrphan(); }} disabled={dirty}><Trash2 className="size-3.5" />Delete orphaned file…</Button>{dirty && <p className="text-[10px] text-amber-700">Save or discard editor changes before inspection.</p>}</div> : <p className="text-xs text-muted-foreground">Aggregate Memory files are never eligible. Use Forget for individual Memories.</p>}</CardContent></Card>
        </div>
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
