"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Download, Loader2, Play, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UsageChart, localInput } from "@/components/usage-chart";
import { analyzeQuota, buildUsageReport, csvText, dimensionKey, dimensionLabel, matchesUsage, perHour, quotaKey, usageBuckets, type UsageData, type UsageFilter } from "@/lib/usage-report";
import { formatDate, formatNumber } from "@/lib/utils";

const number = (n: number | null) => n === null ? "—" : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const fieldClass = "mt-1 block h-9 max-w-full rounded-md border bg-white px-2 text-sm";
type Report = ReturnType<typeof buildUsageReport>;

function ModelTable({ rows }: { rows: Report["models"] }) {
  return <div className="overflow-x-auto" role="region" aria-label="Model, effort and speed totals" tabIndex={0}><table className="data-grid text-xs"><thead><tr>{["Model / effort / speed", "Sessions", "Tokens", "Cached input", "Output", "Reasoning", "Active hours", "Tokens / active h", "Uncached + output / h", "Requests / h", "Tokens / request", "Reasoning / request"].map(h => <th key={h} className="whitespace-nowrap">{h}</th>)}</tr></thead><tbody>{rows.map(m => <tr key={m.key}><td className="whitespace-nowrap font-medium">{dimensionLabel(m)}</td><td>{m.sessions}</td><td>{number(m.total_tokens)}</td><td>{number(m.cached_input_tokens)}</td><td>{number(m.output_tokens)}</td><td>{number(m.reasoning_output_tokens)}</td><td>{m.partial && "≈ "}{number(m.activeSeconds / 3600)}</td><td>{m.partial && "≈ "}{number(perHour(m.total_tokens, m.activeSeconds))}</td><td>{number(perHour(m.total_tokens - m.cached_input_tokens, m.activeSeconds))}</td><td>{number(perHour(m.requests, m.activeSeconds))}</td><td>{number(m.total_tokens / m.requests)}</td><td>{number(m.reasoning_output_tokens / m.requests)}</td></tr>)}</tbody></table></div>;
}

export function UsageWorkspace() {
  const [since] = useState(() => { const date = new Date(); date.setDate(date.getDate() - 7); date.setHours(0, 0, 0, 0); return localInput(date.getTime() / 1000); });
  const [until] = useState(() => localInput(Math.ceil(Date.now() / 60000) * 60));
  const [data, setData] = useState<UsageData | null>(null), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [filter, setFilter] = useState<UsageFilter>({}), [query, setQuery] = useState("");
  const [bucket, setBucket] = useState("codex/10080"), [minimumMinutes, setMinimumMinutes] = useState(10);
  const [sessionId, setSessionId] = useState(""), [hours, setHours] = useState(6), [hideZeros, setHideZeros] = useState(false);
  const [exportKind, setExportKind] = useState("sessions");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const report = useMemo(() => data ? buildUsageReport(data, filter) : null, [data, filter]);
  const quota = useMemo(() => data ? analyzeQuota(data, bucket, minimumMinutes) : null, [data, bucket, minimumMinutes]);
  const options = useMemo(() => data ? {
    model: [...new Set(data.events.map(e => e.model))].sort(), effort: [...new Set(data.events.map(e => e.effort))].sort(),
    speed: [...new Set(data.events.map(e => e.speed))].sort(), quotas: [...new Set(data.snapshots.map(quotaKey))].sort(),
  } : null, [data]);
  const selected = report?.sessions.find(s => s.id === sessionId);
  const windows = useMemo(() => {
    if (!data || !report) return [];
    if (!selected) return hours === 1 ? report.hourly : report.sixHourly;
    return usageBuckets(report.events.filter(e => e.sessionId === selected.id), report.intervals.filter(i => i.sessionId === selected.id), data.sessions, data.since, data.until, hours)
      .filter(b => b.start < selected.end && b.end > selected.start || b.total_tokens > 0)
      .map(b => ({ ...b, start: Math.max(b.start, selected.start), end: Math.min(b.end, selected.end) }));
  }, [data, report, selected, hours]);

  async function load(form: FormData) {
    const start = Date.parse(String(form.get("since"))), end = Date.parse(String(form.get("until")));
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) { setError("Choose a valid start and a later end."); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ since: new Date(start).toISOString(), until: new Date(end).toISOString() });
      const response = await fetch(`/api/usage?${params}`, { cache: "no-store", signal: controller.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Usage scan failed.");
      setData(body); setSessionId(""); setFilter({});
      const available = new Set((body as UsageData).snapshots.map(quotaKey));
      setBucket(available.has("codex/10080") ? "codex/10080" : available.values().next().value ?? "codex/10080");
    } catch (reason) { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load usage."); }
    finally { if (request.current === controller) setLoading(false); }
  }

  function download() {
    if (!data || !report || !quota) return;
    const iso = (t: number) => new Date(t * 1000).toISOString();
    const bucketRows = (rows: typeof windows) => rows.map(({ series, ...b }) => ({ ...b, start: iso(b.start), end: iso(b.end), tokensPerClockHour: perHour(b.total_tokens, b.end - b.start), series }));
    let rows: Record<string, unknown>[];
    switch (exportKind) {
      case "models": rows = report.models; break;
      case "session-models": rows = report.sessions.flatMap(s => s.models.map(m => ({ sessionId: s.id, title: s.title, ...m }))); break;
      case "hourly": rows = bucketRows(report.hourly); break;
      case "six-hourly": rows = bucketRows(report.sixHourly); break;
      case "session-hourly": case "session-six-hourly": rows = report.sessions.flatMap(s => bucketRows(usageBuckets(report.events.filter(e => e.sessionId === s.id), report.intervals.filter(i => i.sessionId === s.id), data.sessions, data.since, data.until, exportKind === "session-hourly" ? 1 : 6).filter(b => b.start < s.end && b.end > s.start || b.total_tokens > 0).map(b => ({ ...b, start: Math.max(b.start, s.start), end: Math.min(b.end, s.end) }))).map(b => ({ sessionId: s.id, ...b }))); break;
      case "token-events": rows = report.events.map(({ usage, t, ...e }) => ({ ...e, timestamp: iso(t), ...usage })); break;
      case "quota-snapshots": rows = data.snapshots.filter(s => quotaKey(s) === bucket).map(s => ({ ...s, t: iso(s.t), resetsAt: iso(s.resetsAt) })); break;
      case "quota-windows": rows = quota.windows.map(w => ({ ...w, start: iso(w.start), end: iso(w.end) })); break;
      case "quota-comparison": rows = quota.comparison.filter(r => matchesUsage(r, filter)); break;
      default: rows = report.sessions.map(({ models, sources, ...s }) => ({ ...s, start: iso(s.start), end: iso(s.end), tokensPerActiveHour: perHour(s.total_tokens, s.activeSeconds), tokensPerElapsedHour: perHour(s.total_tokens, s.end - s.start), models: models.map(dimensionLabel).join(" | "), sources: sources.join(" | ") }));
    }
    const url = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `usage-${exportKind}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const sessionRows = report?.sessions.filter(s => `${s.title} ${s.id} ${s.project}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <div className="space-y-5">
    <div><Badge variant="secondary">Read-only telemetry</Badge><h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Usage report</h1><p className="mt-1 text-sm text-muted-foreground">Token consumption, active time and measured account quota across local sessions and archived sessions.</p></div>
    <Card><CardContent className="p-5"><form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); void load(new FormData(e.currentTarget)); }}>
      <label className="text-xs font-medium">Report from<Input type="datetime-local" aria-label="Report from" className="mt-1 w-auto" name="since" defaultValue={since} required /></label>
      <label className="text-xs font-medium">Report to<Input type="datetime-local" aria-label="Report to" className="mt-1 w-auto" name="until" defaultValue={until} required /></label>
      <Button type="submit" disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}{loading ? "Reading telemetry…" : "Generate report"}</Button>
      {loading && <Button variant="outline" type="button" onClick={() => { request.current?.abort(); setLoading(false); }}>Cancel</Button>}
    </form><p className="mt-3 text-xs text-muted-foreground">The archive is scanned only when you generate a report. Dates use your local timezone; the end is exclusive.</p></CardContent></Card>
    {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {!data && !loading && <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">Choose a period and generate the report. All recorded models, efforts and speeds are included by default.</div>}
    {data && report && quota && options && <>
      <div className="flex flex-wrap items-end gap-3">{(["model", "effort", "speed"] as const).map(key => <label key={key} className="text-xs font-medium capitalize">{key}<select aria-label={key[0].toUpperCase() + key.slice(1)} value={filter[key] ?? ""} className={fieldClass} onChange={e => { setFilter({ ...filter, [key]: e.target.value }); setSessionId(""); }}><option value="">All {key === "speed" ? "speeds" : `${key}s`}</option>{options[key].map(value => <option key={value} value={value}>{value}</option>)}</select></label>)}
        <label className="text-xs font-medium">Quota bucket<select aria-label="Quota bucket" value={bucket} className={fieldClass} onChange={e => setBucket(e.target.value)}>{options.quotas.length ? options.quotas.map(value => <option key={value} value={value}>{value.replace("/10080", " · weekly").replace("/300", " · 5 hours")}</option>) : <option value={bucket}>No quota readings</option>}</select></label>
        <p className="pb-2 text-xs text-muted-foreground">{formatDate(data.since)} – {formatDate(data.until)} · scanned {formatDate(data.generatedAt)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
        ["Total tokens", formatNumber(report.summary.total_tokens), `${number(report.summary.total_tokens - report.summary.cached_input_tokens)} without cached input`],
        ["Sessions", number(report.sessions.length), `${report.sessions.filter(s => !s.parent).length} main · ${report.sessions.filter(s => s.parent).length} subagents`],
        ["Active session hours", `${report.summary.partial ? "≈ " : ""}${number(report.summary.activeSeconds / 3600)}`, `${number(report.summary.clockSeconds / 3600)} active clock hours (overlaps merged)`],
        ["Tokens / active hour", `${report.summary.partial ? "≈ " : ""}${formatNumber(perHour(report.summary.total_tokens, report.summary.activeSeconds))}`, `${formatNumber(perHour(report.summary.total_tokens, data.until - data.since))} per hour of the entire period`],
      ].map(([label, value, detail]) => <Card key={label}><CardContent className="p-5"><p className="text-xs font-medium text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold" data-testid={label === "Total tokens" ? "usage-total" : undefined}>{value}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></CardContent></Card>)}</div>
      {report.events.length === 0 && <p role="status" className="rounded-lg border p-4 text-sm">No token usage matches this period and these filters.</p>}
      <UsageChart key={`${data.since}-${data.until}-${data.generatedAt}`} since={data.since} until={data.until} hours={report.hourly} models={report.models} series={quota.series} cycles={quota.cycles} />
      <Card><CardHeader><CardTitle>Model, effort and speed</CardTitle><CardDescription>A session can appear in multiple rows. Filters select the actual usage events, including changes within a session.</CardDescription></CardHeader><ModelTable rows={report.models} /></Card>
      <Card><CardHeader><CardTitle>Daily token consumption</CardTitle><CardDescription>Main sessions and subagents count their own usage once.</CardDescription></CardHeader><CardContent><div className="h-56" role="img" aria-label="Daily tokens split into main sessions and subagents"><ResponsiveContainer width="100%" height="100%"><BarChart data={report.daily.map(b => ({ ...b, day: new Date(b.start * 1000).toLocaleDateString("en-GB", { month: "short", day: "numeric" }) }))}><CartesianGrid stroke="#edf0f4" vertical={false} /><XAxis dataKey="day" fontSize={11} /><YAxis tickFormatter={formatNumber} fontSize={11} /><Tooltip formatter={value => number(Number(value))} /><Bar dataKey="rootTokens" name="Main sessions" fill="#6366f1" stackId="tokens" /><Bar dataKey="subagentTokens" name="Subagents" fill="#16a34a" stackId="tokens" /></BarChart></ResponsiveContainer></div><p className="mt-2 text-xs text-muted-foreground">Indigo: main sessions · Green: subagents. Active time includes tools and waiting within a turn; pauses between turns are excluded. These rates are not model output speed.</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Sessions</CardTitle><CardDescription>Own tokens within the selected period and filters. Select a session to see its breakdown and time windows.</CardDescription><label className="relative mt-3 block max-w-md"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input aria-label="Search report sessions" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search title, project or session ID" className="pl-9" /></label></CardHeader>
        <div className="max-h-[480px] overflow-auto" role="region" aria-label="Session usage" tabIndex={0}><table className="data-grid text-xs"><thead><tr>{["Session", "Role", "Tokens", "Active hours", "Tokens / active h", "Tokens / elapsed h"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{sessionRows.map(s => <tr key={s.id}><td><button className="text-left font-medium text-indigo-700 hover:underline" onClick={() => setSessionId(s.id)}>{s.title}</button><p className="mt-1 text-[10px] text-muted-foreground">{s.project} · {s.id}</p></td><td>{s.parent ? "Subagent" : "Main"}</td><td>{number(s.total_tokens)}</td><td>{s.partial && "≈ "}{number(s.activeSeconds / 3600)}</td><td>{s.partial && "≈ "}{number(perHour(s.total_tokens, s.activeSeconds))}</td><td>{number(perHour(s.total_tokens, s.end - s.start))}</td></tr>)}</tbody></table></div>
      </Card>
      {selected && <Card><CardHeader><CardTitle>{selected.title}</CardTitle><CardDescription>{selected.id}{selected.parent && ` · Parent: ${selected.parent}`} · {formatDate(selected.start)} – {formatDate(selected.end)}{selected.partial && " · Incomplete activity boundaries; rates are approximate."}</CardDescription></CardHeader><ModelTable rows={selected.models} /><CardContent className="pt-3"><details className="text-xs"><summary className="cursor-pointer">Source files</summary>{selected.sources.map(source => <p key={source} className="mt-1 break-all font-mono">{source}</p>)}</details></CardContent></Card>}
      <Card><CardHeader><CardTitle>Hourly and six-hour windows</CardTitle><div className="mt-2 flex flex-wrap items-end gap-3"><label className="min-w-0 max-w-full text-xs">Scope<select aria-label="Time window scope" className={fieldClass} value={selected?.id ?? ""} onChange={e => setSessionId(e.target.value)}><option value="">All selected sessions</option>{report.sessions.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></label><label className="text-xs">Window<select aria-label="Window size" className={fieldClass} value={hours} onChange={e => setHours(Number(e.target.value))}><option value={1}>1 hour</option><option value={6}>6 hours</option></select></label><label className="flex items-center gap-2 pb-2 text-xs"><input type="checkbox" checked={hideZeros} onChange={e => setHideZeros(e.target.checked)} />Hide empty windows</label></div></CardHeader><div className="max-h-80 overflow-auto" role="region" aria-label="Usage time windows" tabIndex={0}><table className="data-grid text-xs"><thead><tr>{["Window", "Tokens", "Cached input", "Output", "Main", "Subagents", "Tokens / clock h"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{windows.filter(b => !hideZeros || b.total_tokens).map(b => <tr key={b.start}><td className="whitespace-nowrap">{formatDate(b.start)} – {formatDate(b.end)}</td><td>{number(b.total_tokens)}</td><td>{number(b.cached_input_tokens)}</td><td>{number(b.output_tokens)}</td><td>{number(b.rootTokens)}</td><td>{number(b.subagentTokens)}</td><td>{number(perHour(b.total_tokens, b.end - b.start))}</td></tr>)}</tbody></table></div></Card>
      <Card><CardHeader><CardTitle>Observed quota comparison</CardTitle><CardDescription>Only continuously isolated local activity with a constant model, effort and speed. Other devices and cloud activity remain unobserved.</CardDescription><label className="mt-3 block text-xs">Minimum window<select aria-label="Minimum quota window" className={fieldClass} value={minimumMinutes} onChange={e => setMinimumMinutes(Number(e.target.value))}>{[5, 10, 15, 30].map(n => <option key={n} value={n}>{n} minutes</option>)}</select></label></CardHeader><CardContent>
        {quota.comparison.filter(r => matchesUsage(r, filter)).length ? <div className="overflow-x-auto" role="region" aria-label="Isolated quota comparison" tabIndex={0}><table className="data-grid text-xs"><thead><tr>{["Model / effort / speed", "Windows / sessions", "Minutes", "Observed pp", "pp / hour", "Rounding sensitivity pp / h"].map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{quota.comparison.filter(r => matchesUsage(r, filter)).map(r => <tr key={dimensionKey(r)}><td className="whitespace-nowrap">{dimensionLabel(r)}</td><td>{r.windows} / {r.sessions}</td><td>{number(r.seconds / 60)}</td><td>{number(r.observedPp)}</td><td>{number(r.ppPerHour)}</td><td>{number(r.low)} – {number(r.high)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-muted-foreground">No qualifying isolated windows. Quota consumption for these settings is unknown.</p>}
        <p className="mt-3 text-xs leading-5 text-muted-foreground">pp = percentage points. Zero change in a rounded reading does not mean free usage. Sensitivity assumes ±1 pp per window; it is not a confidence interval. These are partial observations, not a session bill or proof that one setting is cheaper.</p>
        <details className="mt-4 text-xs"><summary className="cursor-pointer font-medium">Measured windows and sessions</summary><div className="max-h-64 overflow-auto"><table className="data-grid text-xs"><thead><tr><th>Session / settings</th><th>From / to</th><th>Used %</th><th>pp / hour</th></tr></thead><tbody>{quota.selected.filter(w => w.dimensions && matchesUsage(w.dimensions, filter)).map((w, i) => <tr key={i}><td>{data.sessions.find(s => s.id === w.sessionId)?.title ?? w.sessionId}<p>{dimensionLabel(w.dimensions!)}</p></td><td>{formatDate(w.start)} – {formatDate(w.end)}</td><td>{w.startPercent} → {w.endPercent}</td><td>{number(perHour(w.observedPp, w.end - w.start))}</td></tr>)}</tbody></table></div></details>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>Quota history</CardTitle><CardDescription>{number(quota.snapshots.length)} reliable readings · {quota.cycles.length} counter cycles · {number(quota.observedPp)} percentage points observed across cycles, account-wide.</CardDescription></CardHeader><CardContent><div className="overflow-x-auto" role="region" aria-label="Quota cycles" tabIndex={0}><table className="data-grid text-xs"><thead><tr><th>Cycle</th><th>First / last observation</th><th>Used %</th><th>Scheduled reset</th><th>Conflicting readings</th></tr></thead><tbody>{quota.cycles.map(c => <tr key={c.id}><td>{c.id}</td><td>{formatDate(c.start)} – {formatDate(c.end)}</td><td>{c.firstPercent} → {c.highPercent}</td><td>{formatDate(c.reset)}</td><td>{c.stale}</td></tr>)}</tbody></table></div><p className="mt-3 text-xs text-muted-foreground">Reset timestamps within 60 seconds form one cycle. Only new high-water marks count as increases. Cycle markers show the first observation of a new counter, not an inferred reset time.</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Counting and data quality</CardTitle></CardHeader><CardContent className="space-y-2 text-xs leading-5 text-muted-foreground"><p>Tokens = input + output. Cached input is part of input; reasoning is part of output. Token events are cumulative-counter deltas, with repeated snapshots ignored and counter resets starting a new segment. Model, effort and speed come from the historical turn context and thread settings; priority = fast, default = normal, missing = unknown.</p><p>Parallel sessions add separate active session hours. Active clock hours merge overlap. Missing task boundaries are approximate (≈); no measurable duration produces no rate. Token and quota timestamps indicate when telemetry was recorded.</p><p>{data.coverage.scanned} of {data.coverage.files} files scanned · {data.coverage.duplicateEvents} duplicated usage events ignored · {data.coverage.skippedRecords} invalid/oversized records skipped · {data.coverage.invalidUsage} inconsistent usage events excluded · {data.coverage.missingTime} records without usable timestamps · {data.coverage.rewrittenSessions} files with rewritten timestamps; {data.coverage.undatedUsage} undatable usage events excluded. Their quota readings are excluded and their activity blocks quota attribution.</p><p>{data.events.filter(e => e.speed === "unknown").length} usage events have no known speed. Local telemetry does not establish complete remote usage or convert token counts into quota percentages.</p></CardContent></Card>
      <Card><CardHeader><CardTitle>Export report data</CardTitle><CardDescription>Token CSVs follow the model, effort and speed filters. Quota snapshots and windows retain account-wide evidence. UTF-8, semicolon-separated; timestamps are UTC.</CardDescription></CardHeader><CardContent className="flex flex-wrap items-end gap-3"><label className="text-xs">Dataset<select aria-label="Export dataset" className={fieldClass} value={exportKind} onChange={e => setExportKind(e.target.value)}>{["sessions", "models", "session-models", "hourly", "six-hourly", "session-hourly", "session-six-hourly", "token-events", "quota-snapshots", "quota-windows", "quota-comparison"].map(value => <option key={value}>{value}</option>)}</select></label><Button variant="outline" onClick={download}><Download className="size-4" />Download CSV</Button></CardContent></Card>
    </>}
  </div>;
}
