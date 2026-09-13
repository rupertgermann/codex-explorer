"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Minus, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { dimensionLabel, fitRange, quotaAt, zoomRange, type Dimensions, type QuotaSegment, type UsageBucket } from "@/lib/usage-report";
import { formatNumber } from "@/lib/utils";

function seriesColor(key: string) {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 65% ${38 + (hash % 20)}%)`;
}
export const localInput = (t: number) => {
  const date = new Date(t * 1000);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const stamp = (t: number) => new Intl.DateTimeFormat("en-GB", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(t * 1000);
type Props = { since: number; until: number; hours: UsageBucket[]; models: (Dimensions & { key: string })[]; series: QuotaSegment[]; cycles: { id: number; start: number }[] };

// SVG geometry, stepwise quota, brush, pan and zoom adapted from usage-chart.js.
function Plot({ hours, models, series, cycles, range, changeRange, expanded }: Omit<Props, "since" | "until"> & { range: [number, number]; changeRange: (range: [number, number]) => void; expanded: boolean }) {
  const host = useRef<HTMLDivElement>(null), clip = useId();
  const [width, setWidth] = useState(900);
  const [height, setHeight] = useState(390);
  const [hover, setHover] = useState<number | null>(null);
  const [drag, setDrag] = useState<{ x: number; pan: boolean } | null>(null);
  const [cursor, setCursor] = useState(0);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => { setWidth(Math.max(280, entry.contentRect.width)); setHeight(entry.contentRect.height); });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, []);
  const visible = hours.filter(b => b.start < range[1] && b.end > range[0]);
  const left = width < 480 ? 46 : 65, right = width - 48, top = 30, bottom = height - 55;
  const maximum = Math.max(1, ...visible.map(b => b.total_tokens));
  const span = range[1] - range[0];
  const x = (t: number) => left + (t - range[0]) / span * (right - left);
  const y = (n: number) => bottom - n / maximum * (bottom - top);
  const qy = (n: number) => bottom - n / 100 * (bottom - top);
  const time = (px: number) => range[0] + (Math.min(right, Math.max(left, px)) - left) / (right - left) * span;
  const px = (event: React.PointerEvent<SVGSVGElement>) => (event.clientX - event.currentTarget.getBoundingClientRect().left) * width / event.currentTarget.getBoundingClientRect().width;
  const inspected = hover === null ? null : visible.find(b => b.start <= hover && (hover < b.end || hover === range[1] && b.end === range[1]));
  const quota = hover === null ? null : quotaAt(series, hover);
  const ticks = Math.max(2, Math.floor((right - left) / 140));
  return <div ref={host} className="relative min-w-0" style={{ height: expanded ? "max(390px, calc(100dvh - 320px))" : 390 }}>
    <svg role="img" aria-label="Tokens per hour by model, effort and speed, with remaining account quota" viewBox={`0 0 ${width} ${height}`} className="w-full touch-pan-y select-none" style={{ height }}
      onPointerDown={event => { if (event.button === 0 && px(event) >= left && px(event) <= right) { setDrag({ x: px(event), pan: event.shiftKey }); setCursor(px(event)); event.currentTarget.setPointerCapture(event.pointerId); } }}
      onPointerMove={event => { const at = px(event); setCursor(at); setHover(at >= left && at <= right ? time(at) : null); }}
      onPointerLeave={() => { if (!drag) setHover(null); }}
      onPointerCancel={() => setDrag(null)}
      onPointerUp={event => {
        if (!drag) return;
        const end = px(event); event.currentTarget.releasePointerCapture(event.pointerId); setDrag(null);
        if (Math.abs(end - drag.x) < 8) return;
        const a = time(drag.x), b = time(end);
        changeRange(drag.pan ? [range[0] + a - b, range[1] + a - b] : [Math.min(a, b), Math.max(a, b)]);
        setHover(null);
      }}>
      <title>Tokens per hour and remaining account quota</title>
      <desc>Stacked hourly totals, split by model, effort and speed. The right axis shows remaining quota. Gaps and counter cycles are never connected. Equivalent values are available in the report tables and CSV exports.</desc>
      <defs><clipPath id={clip}><rect x={left} y={top} width={right - left} height={bottom - top} /></clipPath></defs>
      {[0, .25, .5, .75, 1].map(fraction => <g key={fraction} className="text-[10px] fill-slate-500">
        <line x1={left} x2={right} y1={y(fraction * maximum)} y2={y(fraction * maximum)} stroke="#e2e8f0" />
        <text x={left - 6} y={y(fraction * maximum) + 4} textAnchor="end">{formatNumber(fraction * maximum)}</text>
        <text x={right + 6} y={qy(fraction * 100) + 4}>{fraction * 100}%</text>
      </g>)}
      {Array.from({ length: ticks }, (_, i) => range[0] + i * span / (ticks - 1)).map((t, i) => <text key={t} x={x(t)} y={bottom + 24} textAnchor={i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"} className="fill-slate-500 text-[10px]">{stamp(t)}</text>)}
      <text x={left} y={15} className="fill-slate-500 text-[11px]">Tokens / hour</text><text x={right} y={15} textAnchor="end" className="fill-slate-500 text-[11px]">Remaining %</text>
      <g clipPath={`url(#${clip})`}>
        {visible.map(bucket => {
          let base = 0;
          return models.map(model => {
            const n = bucket.series[model.key] ?? 0, before = base; base += n;
            return n > 0 && <rect key={`${bucket.start}-${model.key}`} fill={seriesColor(model.key)} x={x(bucket.start) + .5} y={y(base)} width={Math.max(.4, x(bucket.end) - x(bucket.start) - 1)} height={y(before) - y(base)}><title>{stamp(bucket.start)} · {dimensionLabel(model)}: {n.toLocaleString("en-GB")}</title></rect>;
          });
        })}
        {series.filter(s => s.points[0][0] <= range[1] && s.points.at(-1)![0] >= range[0]).map((segment, i) => <g key={i} stroke="#0f172a" fill="none">
          <path strokeWidth="2" d={segment.points.map((p, n) => n ? `H${x(p[0])}V${qy(p[1])}` : `M${x(p[0])},${qy(p[1])}`).join("")} />
          {[segment.points[0], segment.points.at(-1)!].map((p, n) => <circle key={n} cx={x(p[0])} cy={qy(p[1])} r="2" fill="#0f172a" />)}
        </g>)}
        {cycles.slice(1).filter(c => c.start >= range[0] && c.start <= range[1]).map(c => <g key={c.id}><line x1={x(c.start)} x2={x(c.start)} y1={top} y2={bottom} stroke="#be123c" strokeDasharray="4 4" /><text x={x(c.start) + 4} y={top + 12} className="fill-rose-700 text-[10px]">Cycle {c.id}</text></g>)}
        {drag && <rect x={Math.min(drag.x, cursor)} y={top} width={Math.abs(cursor - drag.x)} height={bottom - top} fill="#6366f130" />}
        {hover !== null && !drag && <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="#64748b" strokeDasharray="3 3" />}
      </g>
    </svg>
    {hover !== null && !drag && <div role="status" className="pointer-events-none absolute top-9 z-10 max-h-72 max-w-[85%] overflow-hidden rounded-lg border bg-white/95 p-3 text-xs shadow-lg" style={x(hover) > width / 2 ? { right: Math.max(8, width - x(hover) + 12) } : { left: Math.max(8, x(hover) + 12) }}>
      <p className="mb-2 font-semibold">{stamp(hover)}</p>
      {inspected && <><p className="mb-1 text-muted-foreground">Whole bucket: {stamp(inspected.start)} – {stamp(inspected.end)}</p>{models.filter(m => inspected.series[m.key]).map(m => <p key={m.key}>{dimensionLabel(m)}: <strong>{inspected.series[m.key].toLocaleString("en-GB")}</strong></p>)}<p className="mt-1 font-semibold">Total: {inspected.total_tokens.toLocaleString("en-GB")}</p></>}
      <p className="mt-2">{quota ? `Remaining: ${quota.remaining}% · cycle ${quota.cycle}` : "Remaining: no reliable reading in this gap"}</p>
    </div>}
  </div>;
}

export function UsageChart(props: Props) {
  const [range, setRange] = useState<[number, number]>([props.since, props.until]);
  const [expanded, setExpanded] = useState(false), [error, setError] = useState("");
  const [from, setFrom] = useState(localInput(props.since)), [to, setTo] = useState(localInput(props.until));
  const days = useMemo(() => {
    const result: { value: string; start: number; end: number }[] = [];
    const day = new Date(props.since * 1000); day.setHours(0, 0, 0, 0);
    while (day.getTime() / 1000 < props.until) {
      const start = day.getTime() / 1000, value = localInput(start).slice(0, 10);
      day.setDate(day.getDate() + 1);
      result.push({ value, start: Math.max(start, props.since), end: Math.min(day.getTime() / 1000, props.until) });
    }
    return result;
  }, [props.since, props.until]);
  const changeRange = (next: [number, number]) => {
    try {
      const fitted = fitRange(...next, props.since, props.until);
      setRange(fitted); setFrom(localInput(fitted[0])); setTo(localInput(fitted[1])); setError("");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Invalid range."); }
  };
  const content = <>
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget); const a = Date.parse(String(form.get("from"))) / 1000, b = Date.parse(String(form.get("to"))) / 1000; if (b <= props.since || a >= props.until) setError("The range is outside this report."); else changeRange([Math.max(props.since, a), Math.min(props.until, b)]); }}>
      <label className="text-xs">Day<select aria-label="Chart day" className="mt-1 block h-9 rounded-md border bg-white px-2" value={days.find(d => d.start === range[0] && d.end === range[1])?.value ?? (range[0] === props.since && range[1] === props.until ? "all" : "custom")} onChange={e => { const d = days.find(d => d.value === e.target.value); changeRange(d ? [d.start, d.end] : [props.since, props.until]); }}><option value="all">Entire report</option><option value="custom" disabled>Custom range</option>{days.map(d => <option key={d.value}>{d.value}</option>)}</select></label>
      <label className="text-xs">From<Input aria-label="Chart from" name="from" type="datetime-local" className="mt-1 h-9 w-auto" value={from} onChange={e => setFrom(e.target.value)} required /></label>
      <label className="text-xs">To<Input aria-label="Chart to" name="to" type="datetime-local" className="mt-1 h-9 w-auto" value={to} onChange={e => setTo(e.target.value)} required /></label>
      <Button variant="outline" size="sm" type="submit">Apply range</Button>
      <div className="flex gap-1">
        <Button variant="outline" size="icon" type="button" aria-label="Previous range" disabled={range[0] <= props.since} onClick={() => changeRange([2 * range[0] - range[1], range[0]])}><ChevronLeft /></Button>
        <Button variant="outline" size="icon" type="button" aria-label="Zoom in" disabled={range[1] - range[0] <= 3600} onClick={() => changeRange(zoomRange(range, .5, props.since, props.until))}><Plus /></Button>
        <Button variant="outline" size="icon" type="button" aria-label="Zoom out" disabled={range[1] - range[0] >= props.until - props.since} onClick={() => changeRange(zoomRange(range, 2, props.since, props.until))}><Minus /></Button>
        <Button variant="outline" size="icon" type="button" aria-label="Next range" disabled={range[1] >= props.until} onClick={() => changeRange([range[1], 2 * range[1] - range[0]])}><ChevronRight /></Button>
      </div>
    </form>
    {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
    <p aria-live="polite" className="mt-3 text-xs text-muted-foreground">{stamp(range[0])} – {stamp(range[1])} · {Intl.DateTimeFormat().resolvedOptions().timeZone} · {((range[1] - range[0]) / 3600).toFixed(2)} hours</p>
    <Plot {...props} range={range} changeRange={changeRange} expanded={expanded} />
    <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-2 overflow-auto text-xs">{props.models.map(m => <span key={m.key}><i className="mr-1.5 inline-block size-2.5 rounded-sm" style={{ background: seriesColor(m.key) }} />{dimensionLabel(m)}</span>)}<span><i className="mr-1.5 inline-block h-0.5 w-4 bg-slate-900 align-middle" />Remaining account quota</span></div>
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Drag to select; Shift + drag to pan. Zoom clips whole hourly totals. Quota is account-wide and stays unchanged by model filters. Gaps over five minutes, conflicting readings and new cycles are not connected.</p>
  </>;
  return <Dialog open={expanded} onOpenChange={setExpanded}><Card><CardHeader className="flex-row items-start justify-between gap-3"><div><CardTitle>Tokens and remaining quota</CardTitle><CardDescription className="mt-1">Hourly stacks by model, reasoning effort and speed</CardDescription></div><DialogTrigger asChild><Button variant="outline" size="sm"><Maximize2 className="size-4" />Fullscreen</Button></DialogTrigger></CardHeader><CardContent>{!expanded && content}</CardContent>
    <DialogContent className="h-[100dvh] max-h-[100dvh] w-screen max-w-none overflow-y-auto rounded-none p-4 sm:max-w-none sm:p-6"><DialogTitle className="flex items-center justify-between pr-10">Tokens and remaining quota<Button variant="outline" size="sm" onClick={() => setExpanded(false)}><X className="size-4" />Close fullscreen</Button></DialogTitle><DialogDescription>Adjust the chart range. Press Escape to return to the report.</DialogDescription>{expanded && content}</DialogContent>
  </Card></Dialog>;
}
