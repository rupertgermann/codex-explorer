"use client";

import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Database,
  FileText,
  Loader2,
  MessageSquareText,
  Search,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { searchDatabaseCatalog, type SearchableDatabase } from "@/lib/global-search";
import { formatBytes, formatDate, formatNumber } from "@/lib/utils";

type MemorySearchResult = {
  path: string;
  title: string;
  matches: { line: number; excerpt: string }[];
  matchCount: number;
};

type SessionSearchResult = {
  id: string;
  path: string;
  startedAt: number;
  size: number;
  project: string;
  provenance: "user" | "codex" | "automation" | "unknown";
  matches: { line: number; kind: "user" | "assistant" | "tool" | "metadata" | "raw"; excerpt: string }[];
};

type SearchResponse<T> = { results: T[]; error?: string };

async function searchRequest<T>(url: string, signal: AbortSignal) {
  const response = await fetch(url, { cache: "no-store", signal });
  const data = await response.json() as SearchResponse<T>;
  if (!response.ok) throw new Error(data.error ?? "Search failed.");
  return data.results;
}

function ScopeCard({ icon: Icon, title, description }: { icon: typeof Search; title: string; description: string }) {
  return (
    <div className="rounded-xl border bg-white p-4">
      <span className="mb-3 grid size-9 place-items-center rounded-lg bg-indigo-50 text-indigo-600"><Icon className="size-4" /></span>
      <p className="text-sm font-semibold">{title}</p>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </div>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark className="rounded bg-amber-200/80 px-0.5 text-inherit">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

const matchLabels = { user: "User", assistant: "Assistant", tool: "Tool", metadata: "Session", raw: "Raw event" } as const;

export function UnifiedSearch({
  databases,
  active,
  onOpenMemory,
  onOpenSession,
  onOpenDatabase,
}: {
  databases: SearchableDatabase[];
  active: boolean;
  onOpenMemory: (path: string) => void;
  onOpenSession: (path: string, query: string) => void;
  onOpenDatabase: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [memoryResults, setMemoryResults] = useState<MemorySearchResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const activeSearch = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const databaseResults = useMemo(
    () => searchDatabaseCatalog(databases, submittedQuery),
    [databases, submittedQuery],
  );
  const totalResults = memoryResults.length + sessionResults.length + databaseResults.length;

  useEffect(() => () => activeSearch.current?.abort(), []);
  useEffect(() => { if (active) input.current?.focus(); }, [active]);

  async function searchAll(event: FormEvent) {
    event.preventDefault();
    const needle = query.trim();
    if (needle.length < 3) {
      setErrors(["Enter at least 3 characters to search the complete session archive."]);
      return;
    }

    activeSearch.current?.abort();
    const controller = new AbortController();
    activeSearch.current = controller;
    setSubmittedQuery(needle);
    setSearching(true);
    setErrors([]);
    setMemoryResults([]);
    setSessionResults([]);

    const encoded = encodeURIComponent(needle);
    const [memory, sessions] = await Promise.allSettled([
      searchRequest<MemorySearchResult>(`/api/memory/search?q=${encoded}`, controller.signal),
      searchRequest<SessionSearchResult>(`/api/sessions/search?q=${encoded}`, controller.signal),
    ]);

    if (controller.signal.aborted) return;
    setMemoryResults(memory.status === "fulfilled" ? memory.value : []);
    setSessionResults(sessions.status === "fulfilled" ? sessions.value : []);
    setErrors([
      ...(memory.status === "rejected" ? [`Memory: ${memory.reason instanceof Error ? memory.reason.message : "Search failed."}`] : []),
      ...(sessions.status === "rejected" ? [`Sessions: ${sessions.reason instanceof Error ? sessions.reason.message : "Search failed."}`] : []),
    ]);
    setSearching(false);
    activeSearch.current = null;
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <div className="mb-2 flex items-center gap-2"><Badge className="border-indigo-200 bg-indigo-50 text-indigo-700"><Sparkles className="size-3" />All local Codex data</Badge><span className="text-xs text-muted-foreground">⌘K or Ctrl-K from anywhere</span></div>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Search everything</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Find a remembered decision, an old conversation, or a SQLite schema without first knowing where Codex stored it.</p>
      </div>

      <Card className="overflow-hidden border-indigo-200 shadow-[0_12px_40px_rgba(79,70,229,.08)]">
        <form role="search" onSubmit={searchAll}>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:p-5">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-indigo-500" />
              <Input
                ref={input}
                type="search"
                minLength={3}
                maxLength={200}
                aria-label="Search all Codex data"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search decisions, prompts, projects, tables…"
                className="h-12 border-indigo-200 bg-white pl-12 pr-4 text-base shadow-none"
              />
            </div>
            <Button type="submit" className="h-12 px-5" disabled={searching}>
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              {searching ? "Searching archive…" : "Search everything"}
            </Button>
          </div>
          <p className="border-t bg-indigo-50/50 px-5 py-2.5 text-[11px] leading-5 text-indigo-900/65">Memory and schema results are fast. Session search scans the complete local JSONL archive and can take up to 20 seconds.</p>
        </form>
      </Card>

      {errors.length > 0 && <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"><p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />Some sources could not be searched</p>{errors.map((error) => <p key={error} className="mt-1 text-xs">{error}</p>)}</div>}

      {!submittedQuery ? <>
        <div className="grid gap-3 md:grid-cols-3">
          <ScopeCard icon={Brain} title="Memory" description="Search every Markdown Memory file and see matching lines in context." />
          <ScopeCard icon={MessageSquareText} title="Sessions" description="Find any phrase across the complete local conversation archive." />
          <ScopeCard icon={Database} title="Database schema" description="Locate stores, tables, columns, and indexes by name or type." />
        </div>
        <p className="text-center text-xs text-muted-foreground">Try an error message, project name, API concept, decision, table, or column.</p>
      </> : <div className="space-y-5" aria-live="polite" aria-busy={searching}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold">{searching ? "Searching all sources…" : `${formatNumber(totalResults)} results for “${submittedQuery}”`}</p>
          <div className="flex gap-2 text-[10px] text-muted-foreground"><span>{memoryResults.length} Memory {memoryResults.length === 1 ? "file" : "files"}</span><span>·</span><span>{sessionResults.length} {sessionResults.length === 1 ? "session" : "sessions"}</span><span>·</span><span>{databaseResults.length} {databaseResults.length === 1 ? "database" : "databases"}</span></div>
        </div>

        {!searching && totalResults === 0 && errors.length === 0 && <Card><CardContent className="flex min-h-40 flex-col items-center justify-center text-center"><Search className="mb-3 size-8 text-muted-foreground/50" /><p className="font-medium">No local matches</p><p className="mt-1 text-sm text-muted-foreground">Try a shorter phrase, a project name, or a distinctive word.</p></CardContent></Card>}

        {memoryResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-cyan-50/40"><CardTitle className="flex items-center gap-2 text-sm"><Brain className="size-4 text-cyan-700" />Memory <Badge variant="secondary">{memoryResults.length}</Badge></CardTitle><CardDescription>Matching Markdown files with line-level context</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{memoryResults.map((result) => <button key={result.path} type="button" onClick={() => onOpenMemory(result.path)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-cyan-50/50"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-cyan-50 text-cyan-700"><FileText className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold">{result.title}</span><span className="shrink-0 text-[10px] text-muted-foreground">{result.matchCount} {result.matchCount === 1 ? "match" : "matches"}</span></span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{result.path}</span>{result.matches.slice(0, 2).map((match, index) => <span key={`${match.line}-${index}`} className="mt-2 block border-l-2 border-cyan-200 pl-2 text-xs leading-5 text-slate-600"><b className="mr-1 text-cyan-700">L{match.line}</b>{match.excerpt}</span>)}</span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-cyan-700" /></button>)}</CardContent>
        </Card>}

        {sessionResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-violet-50/40"><CardTitle className="flex items-center gap-2 text-sm"><MessageSquareText className="size-4 text-violet-700" />Sessions <Badge variant="secondary">{sessionResults.length}</Badge></CardTitle><CardDescription>Matching conversations with the exact message or event context</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{sessionResults.map((result) => <button key={result.path} type="button" onClick={() => onOpenSession(result.path, submittedQuery)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-violet-50/50"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-700"><MessageSquareText className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{result.project}</span><Badge variant="outline" className="px-1.5 py-0 text-[9px]">{result.provenance}</Badge></span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{result.id} · {formatDate(result.startedAt)} · {formatBytes(result.size)}</span>{result.matches.slice(0, 2).map((match) => <span key={`${match.line}-${match.kind}`} className="mt-2 block border-l-2 border-violet-200 pl-2 text-xs leading-5 text-slate-600"><b className="mr-1 text-violet-700">{matchLabels[match.kind]} · L{match.line}</b><HighlightedText text={match.excerpt} query={submittedQuery} /></span>)}</span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-violet-700" /></button>)}</CardContent>
          {sessionResults.length === 100 && <p className="border-t bg-violet-50/30 px-4 py-2 text-[10px] text-muted-foreground">Showing the first 100 matching sessions. Use a more specific phrase to narrow the result set.</p>}
        </Card>}

        {databaseResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-slate-50"><CardTitle className="flex items-center gap-2 text-sm"><Database className="size-4 text-slate-700" />Database schema <Badge variant="secondary">{databaseResults.length}</Badge></CardTitle><CardDescription>Matching stores, tables, columns, and indexes</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{databaseResults.map((result) => <button key={result.databaseId} type="button" onClick={() => onOpenDatabase(result.databaseId)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-slate-50"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-700"><Database className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{result.name}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{result.relativePath}</span><span className="mt-2 flex flex-wrap gap-1.5">{result.matches.map((match) => <Badge key={match} variant="outline" className="font-mono text-[9px] font-medium">{match}</Badge>)}</span></span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-slate-900" /></button>)}</CardContent>
        </Card>}
      </div>}
    </div>
  );
}
