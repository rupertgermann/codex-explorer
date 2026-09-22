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
  X,
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

function HighlightedText({ text, query }: { text: string; query: string }) {
  const index = text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return text;
  return <>{text.slice(0, index)}<mark className="rounded bg-[var(--highlight)] px-0.5 text-foreground">{text.slice(index, index + query.length)}</mark>{text.slice(index + query.length)}</>;
}

const matchLabels = { user: "User", assistant: "Assistant", tool: "Tool", metadata: "Session", raw: "Raw event" } as const;

export function UnifiedSearch({
  databases,
  active,
  catalogError,
  onOpenMemory,
  onOpenSession,
  onOpenDatabase,
}: {
  databases: SearchableDatabase[];
  active: boolean;
  catalogError?: string;
  onOpenMemory: (path: string) => void;
  onOpenSession: (path: string, query: string) => void;
  onOpenDatabase: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [memoryResults, setMemoryResults] = useState<MemorySearchResult[]>([]);
  const [sessionResults, setSessionResults] = useState<SessionSearchResult[]>([]);
  const [pending, setPending] = useState<string[]>([]);
  const [cancelled, setCancelled] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const activeSearch = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const databaseResults = useMemo(
    () => searchDatabaseCatalog(databases, submittedQuery),
    [databases, submittedQuery],
  );
  const searching = pending.length > 0;
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
    setPending(["Memory", "Sessions"]);
    setCancelled(false);
    setErrors([]);
    setMemoryResults([]);
    setSessionResults([]);

    const encoded = encodeURIComponent(needle);
    async function source<T>(name: string, url: string, accept: (results: T[]) => void) {
      try {
        const results = await searchRequest<T>(url, controller.signal);
        if (!controller.signal.aborted) accept(results);
      } catch (reason) {
        if (!controller.signal.aborted) setErrors(current => [...current, `${name}: ${reason instanceof Error ? reason.message : "Search failed."}`]);
      } finally {
        if (!controller.signal.aborted) setPending(current => current.filter(source => source !== name));
      }
    }
    await Promise.all([
      source("Memory", `/api/memory/search?q=${encoded}`, setMemoryResults),
      source("Sessions", `/api/sessions/search?q=${encoded}`, setSessionResults),
    ]);
    if (activeSearch.current === controller) activeSearch.current = null;
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div>
        <div className="mb-3 flex flex-wrap items-center gap-2"><Badge variant="secondary"><Sparkles className="size-3" />All local Codex data</Badge><span className="hidden text-xs text-muted-foreground sm:inline">⌘K or Ctrl-K to search</span></div>
        <h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">Search everything</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Find a decision, a conversation, or a database schema. One search across your local Codex data.</p>
      </div>

      <Card className="overflow-hidden border-ring/30 shadow-[0_8px_32px_#5948ef0a]">
        <form role="search" onSubmit={searchAll}>
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:p-5">
            <div className="relative min-w-0 flex-1">
              <Search className="absolute left-4 top-1/2 size-5 -translate-y-1/2 text-accent-foreground" />
              <Input
                id="global-search"
                ref={input}
                type="search"
                minLength={3}
                required
                maxLength={200}
                aria-label="Search all Codex data"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search local data…"
                className="h-12 bg-background pl-12 pr-4 text-base shadow-none"
              />
            </div>
            <Button type="submit" aria-label="Search everything" className="h-12 px-6" disabled={query.trim().length < 3}>
              {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              Search
            </Button>
            {searching && <Button type="button" variant="outline" className="h-12" onClick={() => { activeSearch.current?.abort(); setPending([]); setCancelled(true); }}><X className="size-4" />Cancel search</Button>}
          </div>
          <p className="px-5 pb-4 text-xs leading-5 text-muted-foreground">At least 3 characters. Results appear as each source finishes; sessions may take up to 20 seconds.</p>
        </form>
      </Card>

      {(errors.length > 0 || catalogError) && <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-800 dark:text-amber-200"><p className="flex items-center gap-2 font-semibold"><AlertTriangle className="size-4" />Some sources could not be searched</p>{[...errors, ...(catalogError ? [`Database schema: ${catalogError}`] : [])].map((error) => <p key={error} className="mt-1 text-xs">{error}</p>)}</div>}

      {!submittedQuery ? <>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2"><Brain className="size-4 text-accent-foreground" />Memory files</span>
          <span className="flex items-center gap-2"><MessageSquareText className="size-4 text-accent-foreground" />Session archive</span>
          <span className="flex items-center gap-2"><Database className="size-4 text-accent-foreground" />Database schemas</span>
        </div>
        <p className="text-center text-xs text-muted-foreground">Try an error message, project name, API concept, decision, table, or column.</p>
      </> : <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p role="status" className="text-sm font-semibold">{`${formatNumber(totalResults)} results for “${submittedQuery}”`}{searching && <span className="ml-2 font-normal text-muted-foreground">Searching {pending.join(" and ")}…</span>}{cancelled && <span className="ml-2 font-normal text-muted-foreground">Search stopped · partial results</span>}</p>
          <div className="flex gap-2 text-[10px] text-muted-foreground"><span>{memoryResults.length} Memory {memoryResults.length === 1 ? "file" : "files"}</span><span>·</span><span>{sessionResults.length} {sessionResults.length === 1 ? "session" : "sessions"}</span><span>·</span><span>{databaseResults.length} {databaseResults.length === 1 ? "database" : "databases"}</span></div>
        </div>

        {!searching && !cancelled && !catalogError && totalResults === 0 && errors.length === 0 && <Card><CardContent className="flex min-h-40 flex-col items-center justify-center text-center"><Search className="mb-3 size-8 text-muted-foreground/50" /><p className="font-medium">No local matches</p><p className="mt-1 text-sm text-muted-foreground">Try a shorter phrase, a project name, or a distinctive word.</p></CardContent></Card>}

        {memoryResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-muted/40"><CardTitle className="flex items-center gap-2 text-sm"><Brain className="size-4 text-accent-foreground" />Memory <Badge variant="secondary">{memoryResults.length}</Badge></CardTitle><CardDescription>Matching Markdown files with line-level context</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{memoryResults.map((result) => <button key={result.path} type="button" onClick={() => onOpenMemory(result.path)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-accent/40"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><FileText className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex items-center justify-between gap-3"><span className="truncate text-sm font-semibold">{result.title}</span><span className="shrink-0 text-[10px] text-muted-foreground">{result.matchCount} {result.matchCount === 1 ? "match" : "matches"}</span></span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{result.path}</span>{result.matches.slice(0, 2).map((match, index) => <span key={`${match.line}-${index}`} className="mt-2 block break-words border-l-2 border-ring/40 pl-2 text-xs leading-5 text-secondary-foreground"><b className="mr-1 text-accent-foreground">L{match.line}</b><HighlightedText text={match.excerpt} query={submittedQuery} /></span>)}</span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-accent-foreground" /></button>)}</CardContent>
        </Card>}

        {sessionResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-muted/40"><CardTitle className="flex items-center gap-2 text-sm"><MessageSquareText className="size-4 text-accent-foreground" />Sessions <Badge variant="secondary">{sessionResults.length}</Badge></CardTitle><CardDescription>Matching conversations with the exact message or event context</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{sessionResults.map((result) => <button key={result.path} type="button" onClick={() => onOpenSession(result.path, submittedQuery)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-accent/40"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><MessageSquareText className="size-4" /></span><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2"><span className="text-sm font-semibold">{result.project}</span><Badge variant="outline" className="px-1.5 py-0 text-[9px]">{result.provenance}</Badge></span><span className="mt-1 block truncate font-mono text-[10px] text-muted-foreground">{result.id} · {formatDate(result.startedAt)} · {formatBytes(result.size)}</span>{result.matches.slice(0, 2).map((match) => <span key={`${match.line}-${match.kind}`} className="mt-2 block break-words border-l-2 border-ring/40 pl-2 text-xs leading-5 text-secondary-foreground"><b className="mr-1 text-accent-foreground">{matchLabels[match.kind]} · L{match.line}</b><HighlightedText text={match.excerpt} query={submittedQuery} /></span>)}</span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-accent-foreground" /></button>)}</CardContent>
          {sessionResults.length === 100 && <p className="border-t bg-muted/30 px-4 py-2 text-[10px] text-muted-foreground">Showing the first 100 matching sessions. Use a more specific phrase to narrow the result set.</p>}
        </Card>}

        {databaseResults.length > 0 && <Card className="overflow-hidden">
          <CardHeader className="border-b bg-muted/40"><CardTitle className="flex items-center gap-2 text-sm"><Database className="size-4 text-accent-foreground" />Database schema <Badge variant="secondary">{databaseResults.length}</Badge></CardTitle><CardDescription>Matching stores, tables, columns, and indexes</CardDescription></CardHeader>
          <CardContent className="divide-y p-0">{databaseResults.map((result) => <button key={result.databaseId} type="button" onClick={() => onOpenDatabase(result.databaseId)} className="group flex w-full items-start gap-3 p-4 text-left transition hover:bg-muted/40"><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent text-accent-foreground"><Database className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-semibold">{result.name}</span><span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground">{result.relativePath}</span><span className="mt-2 flex flex-wrap gap-1.5">{result.matches.map((match) => <Badge key={match} variant="outline" className="font-mono text-[9px] font-medium">{match}</Badge>)}</span></span><ArrowRight className="mt-2 size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-accent-foreground" /></button>)}</CardContent>
        </Card>}
      </div>}
    </div>
  );
}
