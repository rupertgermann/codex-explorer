"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Brain,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock3,
  Code2,
  Copy,
  Database,
  Download,
  FileCode2,
  HardDrive,
  Layers3,
  Loader2,
  Menu,
  MessageSquareText,
  Play,
  RefreshCw,
  Search,
  Table2,
  X,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { MemoryWorkspace } from "@/components/memory-workspace";
import { UsageWorkspace } from "@/components/usage-workspace";
import { SessionWorkspace } from "@/components/session-workspace";
import { cn, formatBytes, formatDate, formatNumber } from "@/lib/utils";
import { type Workspace, WORKSPACE_COOKIE_NAME } from "@/lib/workspace";

type JsonValue = string | number | boolean | null;
type Column = { cid: number; name: string; type: string; notnull: number; dflt_value: JsonValue; pk: number };
type ForeignKey = { id: number; seq: number; table: string; from: string; to: string; on_update: string; on_delete: string };
type Table = { name: string; sql: string; columns: Column[]; foreignKeys: ForeignKey[]; indexes: string[]; rowEstimate: number | null; allocatedBytes: number | null };
type DatabaseInfo = { id: string; name: string; filename: string; path: string; relativePath: string; group: string; size: number; modifiedAt: number; journalMode: string; tables: Table[] };
type ChartPoint = { name: string; value: number };
type Analysis = { metrics: { size: number; tables: number; rows: number; modifiedAt: number }; activity: ChartPoint[]; breakdown: ChartPoint[]; insight: string };
type Row = Record<string, JsonValue>;
type Tab = "overview" | "browser" | "query" | "schema";

const PIE_COLORS = ["#6264ef", "#7e80f5", "#9ca0fb", "#b9bcff", "#4fc3a1", "#f4b860", "#ed7b84", "#8ba4bd"];

function databaseAccent(name: string) {
  if (name.includes("log")) return "bg-violet-100 text-violet-700";
  if (name.includes("memor")) return "bg-cyan-100 text-cyan-700";
  if (name.includes("state")) return "bg-amber-100 text-amber-700";
  if (name.includes("goal")) return "bg-emerald-100 text-emerald-700";
  if (name.includes("queue")) return "bg-rose-100 text-rose-700";
  return "bg-slate-100 text-slate-700";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed.");
  return body as T;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-muted/25 px-6 text-center">
      <Database className="mb-3 size-8 text-muted-foreground/60" />
      <p className="font-medium">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function LoadingState({ label = "Reading database" }: { label?: string }) {
  return <div className="flex min-h-64 items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{label}</div>;
}

function MetricCard({ label, value, detail, icon: Icon }: { label: string; value: string; detail: string; icon: typeof Database }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
            <p className="mt-2 text-2xl font-semibold tracking-[-0.03em]">{value}</p>
            <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
          </div>
          <span className="rounded-lg bg-accent p-2 text-accent-foreground"><Icon className="size-4" /></span>
        </div>
      </CardContent>
    </Card>
  );
}

function Sidebar({ databases, selectedId, onSelect, filter, setFilter, workspace, onWorkspaceChange }: { databases: DatabaseInfo[]; selectedId: string; onSelect: (id: string) => void; filter: string; setFilter: (value: string) => void; workspace: Workspace; onWorkspaceChange: (workspace: Workspace) => void }) {
  const groups = useMemo(() => {
    const map = new Map<string, DatabaseInfo[]>();
    databases.filter((database) => `${database.name} ${database.relativePath}`.toLowerCase().includes(filter.toLowerCase())).forEach((database) => {
      map.set(database.group, [...(map.get(database.group) ?? []), database]);
    });
    return [...map.entries()];
  }, [databases, filter]);

  return (
    <aside className="desktop-sidebar fixed inset-y-0 left-0 z-30 flex w-[272px] flex-col border-r border-white/10 bg-[#17202d] text-white">
      <div className="flex h-16 items-center gap-3 border-b border-white/10 px-5">
        <div className="grid size-9 place-items-center rounded-xl bg-[#6567f1] shadow-lg shadow-indigo-950/30"><Layers3 className="size-5" /></div>
        <div><p className="font-semibold tracking-tight">Codex Explorer</p><p className="text-[11px] text-slate-400">Local data intelligence</p></div>
      </div>
      <div className="space-y-1 border-b border-white/10 p-3">
        <button onClick={() => onWorkspaceChange("memory")} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition", workspace === "memory" ? "bg-cyan-400/10 text-cyan-200" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}><Brain className="size-4" />Markdown memory</button>
        <button onClick={() => onWorkspaceChange("sessions")} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition", workspace === "sessions" ? "bg-violet-400/10 text-violet-200" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}><MessageSquareText className="size-4" />Session archive</button>
        <button onClick={() => onWorkspaceChange("usage")} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition", workspace === "usage" ? "bg-emerald-400/10 text-emerald-200" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}><BarChart3 className="size-4" />Usage report</button>
        <button onClick={() => onWorkspaceChange("databases")} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-xs font-medium transition", workspace === "databases" ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}><Database className="size-4" />SQLite databases</button>
      </div>
      {workspace === "databases" && <div className="px-4 py-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Find a store…" className="sidebar-form-border h-9 w-full rounded-lg border bg-white/[0.06] pl-9 pr-3 text-xs text-white outline-none placeholder:text-slate-500" />
        </div>
      </div>}
      {workspace === "databases" ? <div className="scrollbar-thin flex-1 overflow-y-auto px-3 pb-5">
        {groups.map(([group, items]) => (
          <div key={group} className="mb-5">
            <p className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-500">{group}</p>
            <div className="space-y-1">
              {items.map((database) => (
                <button key={database.id} onClick={() => onSelect(database.id)} className={cn("group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition", selectedId === database.id ? "bg-white/10 text-white" : "text-slate-400 hover:bg-white/[0.06] hover:text-slate-200")}>
                  <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", selectedId === database.id ? "bg-indigo-500 text-white" : "bg-white/[0.06]")}><Database className="size-3.5" /></span>
                  <span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{database.name}</span><span className="block truncate text-[10px] text-slate-500">{formatBytes(database.size)} · {database.tables.length} tables</span></span>
                  {selectedId === database.id && <span className="size-1.5 rounded-full bg-emerald-400" />}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div> : <div className="flex-1" />}
    </aside>
  );
}

function Overview({ database }: { database: DatabaseInfo }) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [error, setError] = useState("");
  const [renderedAt] = useState(() => Date.now());
  useEffect(() => {
    fetchJson<Analysis>(`/api/analysis?database=${encodeURIComponent(database.id)}`).then(setAnalysis).catch((reason) => setError(reason.message));
  }, [database.id]);
  if (error) return <EmptyState title="Analysis unavailable" description={error} />;
  if (!analysis) return <LoadingState label="Calculating overview" />;
  const largest = [...database.tables].sort((a, b) => (b.allocatedBytes ?? 0) - (a.allocatedBytes ?? 0))[0];

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Database size" value={formatBytes(analysis.metrics.size)} detail={`${database.journalMode.toUpperCase()} journal mode`} icon={HardDrive} />
        <MetricCard label="Tables" value={formatNumber(analysis.metrics.tables)} detail={`${database.tables.reduce((sum, table) => sum + table.indexes.length, 0)} indexes discovered`} icon={Table2} />
        <MetricCard label="Estimated rows" value={formatNumber(analysis.metrics.rows)} detail="Exact for small stores, estimated for large" icon={BarChart3} />
        <MetricCard label="Last changed" value={new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(Math.round((analysis.metrics.modifiedAt - renderedAt) / 3_600_000), "hour")} detail={formatDate(analysis.metrics.modifiedAt)} icon={Clock3} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.65fr_1fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div><CardTitle>Activity signal</CardTitle><CardDescription className="mt-1">A useful time window selected for this store</CardDescription></div>
            <Badge variant="secondary"><Activity className="size-3" />live data</Badge>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={analysis.activity} margin={{ left: -16, right: 12, top: 12, bottom: 0 }}>
                  <defs><linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#6366f1" stopOpacity={0.28} /><stop offset="100%" stopColor="#6366f1" stopOpacity={0.015} /></linearGradient></defs>
                  <CartesianGrid stroke="#edf0f4" vertical={false} />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: "#7a8290", fontSize: 11 }} minTickGap={22} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: "#7a8290", fontSize: 11 }} allowDecimals={false} />
                  <Tooltip contentStyle={{ borderRadius: 10, borderColor: "#e2e5ea", boxShadow: "0 10px 28px rgba(20,30,50,.10)", fontSize: 12 }} />
                  <Area type="monotone" dataKey="value" stroke="#6366f1" strokeWidth={2} fill="url(#areaFill)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Composition</CardTitle><CardDescription>Dominant record groups</CardDescription></CardHeader>
          <CardContent>
            <div className="grid grid-cols-[150px_1fr] items-center gap-2">
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={analysis.breakdown} dataKey="value" nameKey="name" innerRadius={43} outerRadius={66} paddingAngle={2} stroke="none">{analysis.breakdown.map((entry, index) => <Cell key={`${entry.name}-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />)}</Pie><Tooltip contentStyle={{ borderRadius: 10, borderColor: "#e2e5ea", fontSize: 12 }} /></PieChart></ResponsiveContainer>
              </div>
              <div className="space-y-2">{analysis.breakdown.slice(0, 6).map((entry, index) => <div key={entry.name} className="flex items-center justify-between gap-3 text-xs"><span className="flex min-w-0 items-center gap-2"><i className="size-2 shrink-0 rounded-full" style={{ background: PIE_COLORS[index % PIE_COLORS.length] }} /><span className="truncate text-muted-foreground">{entry.name || "unknown"}</span></span><span className="font-semibold tabular-nums">{formatNumber(entry.value)}</span></div>)}</div>
            </div>
            <p className="mt-4 rounded-lg bg-muted/70 p-3 text-xs leading-5 text-muted-foreground">{analysis.insight}</p>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between"><div><CardTitle>Table inventory</CardTitle><CardDescription className="mt-1">Schema shape, records, and allocated pages</CardDescription></div>{largest && <Badge variant="outline">Largest: {largest.name}</Badge>}</CardHeader>
        <CardContent className="px-0 pb-0">
          <div className="overflow-x-auto"><table className="data-grid text-xs"><thead><tr className="text-muted-foreground"><th>Table</th><th>Columns</th><th>Indexes</th><th>Rows</th><th>Allocated</th><th className="w-[26%]">Share</th></tr></thead><tbody>{database.tables.map((table) => <tr key={table.name}><td className="font-mono font-medium text-foreground">{table.name}</td><td>{table.columns.length}</td><td>{table.indexes.length}</td><td className="tabular-nums">{formatNumber(table.rowEstimate)}</td><td>{table.allocatedBytes == null ? "—" : formatBytes(table.allocatedBytes)}</td><td><div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-indigo-500" style={{ width: `${Math.max(2, ((table.allocatedBytes ?? 0) / Math.max(1, database.size)) * 100)}%` }} /></div></td></tr>)}</tbody></table></div>
        </CardContent>
      </Card>
    </div>
  );
}

function displayCell(value: JsonValue, column: string) {
  if (value == null) return <span className="italic text-muted-foreground/60">null</span>;
  if (typeof value === "number" && /(^ts$|_at$|_at_ms$|_time$|created|updated|generated|finished|started)/i.test(column) && !/nanos|bytes|count|used/i.test(column)) return <span title={String(value)}>{formatDate(value)}</span>;
  if (typeof value === "boolean") return value ? "true" : "false";
  const text = String(value);
  return <span title={text.length > 80 ? text : undefined}>{text.length > 100 ? `${text.slice(0, 100)}…` : text}</span>;
}

function prettyValue(value: JsonValue) {
  if (typeof value !== "string") return String(value);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

function TableBrowser({ database }: { database: DatabaseInfo }) {
  const [tableName, setTableName] = useState(database.tables.find((table) => !table.name.startsWith("_"))?.name ?? database.tables[0]?.name ?? "");
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<Column[]>([]);
  const [search, setSearch] = useState("");
  const [settledSearch, setSettledSearch] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState<number | null>(null);
  const [sort, setSort] = useState("");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");
  const [selectedRow, setSelectedRow] = useState<Row | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const pageSize = 50;

  useEffect(() => { const timer = setTimeout(() => { setSettledSearch(search); setPage(1); }, 350); return () => clearTimeout(timer); }, [search]);

  const load = useCallback(() => {
    if (!tableName) return;
    setLoading(true); setError("");
    const params = new URLSearchParams({ database: database.id, table: tableName, page: String(page), pageSize: String(pageSize), search: settledSearch, direction });
    if (sort) params.set("sort", sort);
    fetchJson<{ rows: Row[]; columns: Column[]; total: number | null; sort: string; direction: "asc" | "desc" }>(`/api/table?${params}`)
      .then((data) => { setRows(data.rows); setColumns(data.columns); setTotal(data.total); if (!sort) setSort(data.sort); })
      .catch((reason) => setError(reason.message)).finally(() => setLoading(false));
  }, [database.id, direction, page, settledSearch, sort, tableName]);
  useEffect(() => {
    if (!tableName) return;
    const params = new URLSearchParams({ database: database.id, table: tableName, page: String(page), pageSize: String(pageSize), search: settledSearch, direction });
    if (sort) params.set("sort", sort);
    fetchJson<{ rows: Row[]; columns: Column[]; total: number | null; sort: string; direction: "asc" | "desc" }>(`/api/table?${params}`)
      .then((data) => { setRows(data.rows); setColumns(data.columns); setTotal(data.total); if (!sort) setSort(data.sort); setError(""); })
      .catch((reason) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [database.id, direction, page, settledSearch, sort, tableName]);

  function changeSort(column: string) {
    if (sort === column) setDirection((value) => value === "desc" ? "asc" : "desc");
    else { setSort(column); setDirection("asc"); }
    setPage(1);
  }

  const pages = total == null ? null : Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4 lg:flex-row lg:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1 lg:pb-0">
            {database.tables.map((table) => <Button key={table.name} size="sm" variant={tableName === table.name ? "default" : "ghost"} onClick={() => { setTableName(table.name); setPage(1); setSort(""); }} className="shrink-0 font-mono">{table.name}<span className={cn("text-[10px]", tableName === table.name ? "text-white/70" : "text-muted-foreground")}>{formatNumber(table.rowEstimate)}</span></Button>)}
          </div>
          <div className="relative w-full lg:w-72"><Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input value={search} onChange={(event) => setSearch(event.target.value)} className="pl-9 pr-9" placeholder="Search every column…" />{search && <button onClick={() => setSearch("")} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="size-3.5" /></button>}</div>
        </CardContent>
      </Card>
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b px-4 py-3"><div className="flex items-center gap-2"><Table2 className="size-4 text-indigo-500" /><span className="font-mono text-sm font-semibold">{tableName}</span><Badge variant="secondary">{formatNumber(total)} rows</Badge></div><Button variant="ghost" size="icon" onClick={load} aria-label="Refresh table"><RefreshCw className={cn("size-4", loading && "animate-spin")} /></Button></div>
        {error ? <EmptyState title="Could not read table" description={error} /> : loading ? <LoadingState /> : rows.length === 0 ? <EmptyState title="No matching rows" description={settledSearch ? "Try a broader search term." : "This table is empty."} /> : (
          <div className="scrollbar-thin max-h-[590px] overflow-auto"><table className="data-grid text-xs"><thead><tr>{columns.map((column) => <th key={column.name}><button onClick={() => changeSort(column.name)} className="flex items-center gap-1.5 whitespace-nowrap font-medium text-muted-foreground hover:text-foreground">{column.name}{column.pk > 0 && <span className="rounded bg-amber-100 px-1 text-[8px] font-bold text-amber-700">PK</span>}{sort === column.name && (direction === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}</button></th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex} onClick={() => setSelectedRow(row)} className="cursor-pointer">{columns.map((column) => <td key={column.name} className={cn("max-w-[360px] overflow-hidden text-ellipsis whitespace-nowrap", /id|path|json|body|summary|message|sql/i.test(column.name) && "font-mono text-[11px]")}>{displayCell(row[column.name], column.name)}</td>)}</tr>)}</tbody></table></div>
        )}
        <div className="flex items-center justify-between border-t px-4 py-3 text-xs text-muted-foreground"><span>{total == null ? `${rows.length} rows loaded` : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${formatNumber(total)}`}</span><div className="flex items-center gap-2"><Button variant="outline" size="icon" disabled={page === 1} onClick={() => setPage((value) => value - 1)}><ChevronLeft className="size-4" /></Button><span className="min-w-16 text-center">Page {page}{pages ? ` / ${pages}` : ""}</span><Button variant="outline" size="icon" disabled={rows.length < pageSize || (pages != null && page >= pages)} onClick={() => setPage((value) => value + 1)}><ChevronRight className="size-4" /></Button></div></div>
      </Card>
      <Dialog open={selectedRow !== null} onOpenChange={(open) => !open && setSelectedRow(null)}><DialogContent><DialogHeader><DialogTitle>Row details</DialogTitle><DialogDescription>{tableName} · all values from the selected record</DialogDescription></DialogHeader>{selectedRow && <div className="space-y-3">{Object.entries(selectedRow).map(([key, value]) => <div key={key} className="grid gap-1 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[150px_1fr]"><span className="font-mono text-xs font-semibold text-muted-foreground">{key}</span><pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{prettyValue(value)}</pre></div>)}</div>}</DialogContent></Dialog>
    </div>
  );
}

function queryPresets(database: DatabaseInfo) {
  const names = new Set(database.tables.map((table) => table.name));
  if (names.has("logs")) return [
    { label: "Recent errors", sql: "SELECT datetime(ts, 'unixepoch', 'localtime') AS time, level, target, feedback_log_body, thread_id\nFROM logs\nWHERE level IN ('ERROR', 'WARN')\nORDER BY ts DESC, ts_nanos DESC\nLIMIT 100" },
    { label: "Top targets · 24h", sql: "SELECT target, COUNT(*) AS events\nFROM logs\nWHERE ts >= unixepoch('now', '-24 hours')\nGROUP BY target\nORDER BY events DESC\nLIMIT 25" },
  ];
  if (names.has("threads")) return [
    { label: "Recent threads", sql: "SELECT title, cwd, model, reasoning_effort, tokens_used, datetime(COALESCE(updated_at_ms, updated_at * 1000) / 1000, 'unixepoch', 'localtime') AS updated\nFROM threads\nORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC\nLIMIT 100" },
    { label: "Tokens by project", sql: "SELECT cwd, COUNT(*) AS threads, SUM(tokens_used) AS tokens\nFROM threads\nGROUP BY cwd\nORDER BY tokens DESC\nLIMIT 25" },
  ];
  if (names.has("stage1_outputs")) return [{ label: "Used memories", sql: "SELECT thread_id, rollout_slug, usage_count, datetime(last_usage, 'unixepoch', 'localtime') AS last_used, selected_for_phase2\nFROM stage1_outputs\nWHERE COALESCE(usage_count, 0) > 0\nORDER BY usage_count DESC, last_usage DESC\nLIMIT 100" }];
  const table = database.tables.find((entry) => !entry.name.startsWith("_")) ?? database.tables[0];
  return table ? [{ label: `Preview ${table.name}`, sql: `SELECT * FROM "${table.name.replaceAll('"', '""')}" LIMIT 100` }] : [];
}

function QueryLab({ database }: { database: DatabaseInfo }) {
  const presets = useMemo(() => queryPresets(database), [database]);
  const [sql, setSql] = useState(presets[0]?.sql ?? "SELECT 1 AS ready");
  const [rows, setRows] = useState<Row[]>([]);
  const [columns, setColumns] = useState<string[]>([]);
  const [duration, setDuration] = useState<number | null>(null);
  const [limited, setLimited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  async function runQuery() {
    setLoading(true); setError("");
    try {
      const result = await fetchJson<{ rows: Row[]; columns: string[]; durationMs: number; limited: boolean }>("/api/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ databaseId: database.id, sql }) });
      setRows(result.rows); setColumns(result.columns); setDuration(result.durationMs); setLimited(result.limited);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Query failed."); setRows([]); setColumns([]); }
    finally { setLoading(false); }
  }

  function exportCsv() {
    const escape = (value: JsonValue) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.map(escape).join(","), ...rows.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
    const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); link.download = `${database.name}-query.csv`; link.click(); URL.revokeObjectURL(link.href);
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b bg-[#1d2532] px-4 py-3 text-white"><div className="flex items-center gap-2 text-sm font-medium"><Code2 className="size-4 text-indigo-300" />SQL editor</div><Badge className="border-white/10 bg-white/10 text-slate-300">read only</Badge></div>
        <div className="border-b bg-[#171e2a] p-3"><div className="flex flex-wrap gap-2">{presets.map((preset) => <button key={preset.label} onClick={() => setSql(preset.sql)} className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-slate-400 hover:border-indigo-400/40 hover:text-white">{preset.label}</button>)}</div></div>
        <textarea value={sql} onChange={(event) => setSql(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") runQuery(); }} spellCheck={false} className="code-field min-h-[390px] w-full resize-y bg-[#151c27] p-5 font-mono text-[13px] leading-6 text-slate-200 outline-none placeholder:text-slate-600" />
        <div className="flex items-center justify-between border-t border-white/10 bg-[#1d2532] p-3"><span className="text-[11px] text-slate-500">⌘ Enter to run · up to 500 rows</span><div className="flex gap-2"><Button variant="ghost" size="sm" className="text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => { navigator.clipboard.writeText(sql); setCopied(true); setTimeout(() => setCopied(false), 1200); }}>{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copied ? "Copied" : "Copy"}</Button><Button size="sm" onClick={runQuery} disabled={loading}>{loading ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />}Run query</Button></div></div>
      </Card>
      <Card className="min-w-0 overflow-hidden">
        <div className="flex h-[53px] items-center justify-between border-b px-4"><div className="flex items-center gap-2"><Braces className="size-4 text-indigo-500" /><span className="text-sm font-semibold">Results</span>{duration != null && <Badge variant="secondary">{duration.toFixed(1)} ms</Badge>}{limited && <Badge variant="warning">limited</Badge>}</div>{rows.length > 0 && <Button variant="outline" size="sm" onClick={exportCsv}><Download className="size-3.5" />CSV</Button>}</div>
        {error ? <div className="m-4 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"><p className="font-semibold">SQLite rejected the query</p><p className="mt-1 font-mono text-xs leading-5">{error}</p></div> : columns.length === 0 ? <EmptyState title="Ready for a query" description="Choose a template or write a SELECT statement, then press Run query." /> : rows.length === 0 ? <EmptyState title="No rows returned" description="The query completed successfully but the result set is empty." /> : <div className="scrollbar-thin max-h-[600px] overflow-auto"><table className="data-grid text-xs"><thead><tr>{columns.map((column) => <th key={column} className="whitespace-nowrap font-mono font-medium text-muted-foreground">{column}</th>)}</tr></thead><tbody>{rows.map((row, index) => <tr key={index}>{columns.map((column) => <td key={column} className="max-w-[300px] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px]">{displayCell(row[column], column)}</td>)}</tr>)}</tbody></table></div>}
      </Card>
    </div>
  );
}

function SchemaView({ database }: { database: DatabaseInfo }) {
  const edges = database.tables.flatMap((table) => table.foreignKeys.map((fk) => ({ from: table.name, column: fk.from, to: fk.table, target: fk.to })));
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
      <div className="space-y-4">{database.tables.map((table) => <Card key={table.name} className="overflow-hidden"><details open={database.tables.length <= 5}><summary className="flex cursor-pointer list-none items-center justify-between p-4 hover:bg-muted/30"><span className="flex items-center gap-3"><span className={cn("grid size-9 place-items-center rounded-lg", databaseAccent(database.name))}><Table2 className="size-4" /></span><span><span className="block font-mono text-sm font-semibold">{table.name}</span><span className="text-xs text-muted-foreground">{table.columns.length} columns · {table.indexes.length} indexes · {formatNumber(table.rowEstimate)} rows</span></span></span><ChevronRight className="size-4 text-muted-foreground" /></summary><div className="border-t"><div className="overflow-x-auto"><table className="data-grid text-xs"><thead><tr><th>Column</th><th>Type</th><th>Constraints</th><th>Default</th></tr></thead><tbody>{table.columns.map((column) => <tr key={column.name}><td className="font-mono font-medium">{column.name}</td><td><Badge variant="secondary">{column.type || "ANY"}</Badge></td><td><div className="flex gap-1">{column.pk > 0 && <Badge variant="warning">primary key</Badge>}{column.notnull > 0 && <Badge variant="outline">not null</Badge>}{table.foreignKeys.some((fk) => fk.from === column.name) && <Badge variant="success">foreign key</Badge>}</div></td><td className="font-mono text-muted-foreground">{column.dflt_value ?? "—"}</td></tr>)}</tbody></table></div>{table.sql && <pre className="overflow-x-auto border-t bg-[#17202d] p-4 font-mono text-[11px] leading-5 text-slate-300">{table.sql}</pre>}</div></details></Card>)}</div>
      <div className="space-y-5">
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><CircleDot className="size-4 text-indigo-500" />Relationships</CardTitle><CardDescription>Declared foreign-key edges</CardDescription></CardHeader><CardContent>{edges.length ? <div className="space-y-3">{edges.map((edge, index) => <div key={`${edge.from}-${edge.column}-${index}`} className="rounded-lg border bg-muted/20 p-3 font-mono text-[11px]"><p className="font-semibold text-indigo-600">{edge.from}.{edge.column}</p><p className="my-1 text-muted-foreground">↓ references</p><p className="font-semibold">{edge.to}.{edge.target}</p></div>)}</div> : <p className="text-sm leading-6 text-muted-foreground">No explicit foreign keys are declared. Relationships may still exist by naming convention.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Database details</CardTitle></CardHeader><CardContent className="space-y-3 text-xs"><div><p className="text-muted-foreground">Absolute path</p><p className="mt-1 break-all font-mono leading-5">{database.path}</p></div><div className="grid grid-cols-2 gap-3"><div><p className="text-muted-foreground">Journal</p><p className="mt-1 font-semibold uppercase">{database.journalMode}</p></div><div><p className="text-muted-foreground">Modified</p><p className="mt-1 font-semibold">{formatDate(database.modifiedAt)}</p></div></div></CardContent></Card>
      </div>
    </div>
  );
}

export function CodexExplorer({ initialWorkspace }: { initialWorkspace: Workspace }) {
  const [workspace, setWorkspace] = useState(initialWorkspace);
  const [databases, setDatabases] = useState<DatabaseInfo[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [tab, setTab] = useState<Tab>("overview");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshKey, setRefreshKey] = useState(0);
  const [mobileMenu, setMobileMenu] = useState(false);

  const selectWorkspace = useCallback((next: Workspace) => {
    setWorkspace(next);
    document.cookie = `${WORKSPACE_COOKIE_NAME}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
    setMobileMenu(false);
  }, []);

  const loadCatalog = useCallback(async () => {
    setLoading(true); setError("");
    try {
      const data = await fetchJson<{ databases: DatabaseInfo[] }>("/api/catalog");
      setDatabases(data.databases);
      setSelectedId((current) => data.databases.some((database) => database.id === current) ? current : data.databases[0]?.id ?? "");
      setRefreshKey((value) => value + 1);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not scan Codex databases."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => {
    fetchJson<{ databases: DatabaseInfo[] }>("/api/catalog")
      .then((data) => {
        setDatabases(data.databases);
        setSelectedId(data.databases[0]?.id ?? "");
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : "Could not scan Codex databases."))
      .finally(() => setLoading(false));
  }, []);
  const database = databases.find((candidate) => candidate.id === selectedId);
  const tabs: { id: Tab; label: string; icon: typeof Database }[] = [
    { id: "overview", label: "Overview", icon: BarChart3 },
    { id: "browser", label: "Table browser", icon: Table2 },
    { id: "query", label: "Query lab", icon: Code2 },
    { id: "schema", label: "Schema", icon: FileCode2 },
  ];

  return (
    <div className="min-h-screen">
      <Sidebar databases={databases} selectedId={selectedId} onSelect={(id) => { setSelectedId(id); setTab("overview"); }} filter={filter} setFilter={setFilter} workspace={workspace} onWorkspaceChange={selectWorkspace} />
      <main className="min-h-screen lg:ml-[272px]">
        <div className="px-4 pt-4 sm:px-6 lg:hidden"><Button variant="outline" size="sm" aria-label="Choose workspace" onClick={() => setMobileMenu((value) => !value)}><Menu className="size-4" />Modules</Button></div>
        {mobileMenu && <div className="space-y-2 border-b bg-white p-3 lg:hidden"><div className="grid grid-cols-4 gap-2"><Button variant={workspace === "memory" ? "default" : "outline"} size="sm" onClick={() => selectWorkspace("memory")}><Brain className="size-3.5" /><span className="hidden sm:inline">Memory</span></Button><Button variant={workspace === "sessions" ? "default" : "outline"} size="sm" onClick={() => selectWorkspace("sessions")}><MessageSquareText className="size-3.5" /><span className="hidden sm:inline">Sessions</span></Button><Button aria-label="Usage report" variant={workspace === "usage" ? "default" : "outline"} size="sm" onClick={() => selectWorkspace("usage")}><BarChart3 className="size-3.5" /><span className="hidden sm:inline">Usage</span></Button><Button variant={workspace === "databases" ? "default" : "outline"} size="sm" onClick={() => selectWorkspace("databases")}><Database className="size-3.5" /><span className="hidden sm:inline">Databases</span></Button></div>{workspace === "databases" && <select value={selectedId} onChange={(event) => { setSelectedId(event.target.value); setMobileMenu(false); }} className="h-10 w-full rounded-lg border bg-white px-3 text-sm">{databases.map((item) => <option key={item.id} value={item.id}>{item.group} / {item.name}</option>)}</select>}</div>}
        <div className="px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {workspace === "memory" ? <MemoryWorkspace /> : workspace === "sessions" ? <SessionWorkspace /> : workspace === "usage" ? <UsageWorkspace /> : error ? <EmptyState title="Could not open Codex data" description={error} /> : !database ? <LoadingState label="Discovering SQLite stores" /> : <>
            <div className="mb-6 space-y-4"><div className="flex items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2"><Badge variant="secondary">{database.group}</Badge><span className="text-xs text-muted-foreground">Updated {formatDate(database.modifiedAt)}</span></div><h1 className="text-2xl font-semibold tracking-[-0.035em] sm:text-3xl">{database.name}</h1><p className="mt-1 max-w-2xl text-sm text-muted-foreground">Explore records, inspect schema, and analyze this local Codex store without changing it.</p></div><Button variant="outline" size="sm" className="shrink-0" onClick={loadCatalog} disabled={loading} aria-label="Refresh database catalog"><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />Refresh</Button></div><div className="flex w-fit max-w-full flex-wrap gap-1 rounded-xl border bg-white p-1 shadow-sm">{tabs.map((item) => <button key={item.id} onClick={() => setTab(item.id)} className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-3 text-xs font-medium transition", tab === item.id ? "bg-[#17202d] text-white shadow-sm" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><item.icon className="size-3.5" />{item.label}</button>)}</div></div>
            {tab === "overview" && <Overview key={`${database.id}-${refreshKey}`} database={database} />}
            {tab === "browser" && <TableBrowser key={database.id} database={database} />}
            {tab === "query" && <QueryLab key={database.id} database={database} />}
            {tab === "schema" && <SchemaView database={database} />}
          </>}
        </div>
      </main>
    </div>
  );
}
