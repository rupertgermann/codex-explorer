// Adapted from build_report.py, quota_analysis.py and usage-chart.js in
// codex-insights-2026-09-10-1013. All times are Unix seconds; cache/reasoning are subsets.
export const TOKEN_FIELDS = ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"] as const;
export type Tokens = Record<typeof TOKEN_FIELDS[number], number>;
export type Dimensions = { model: string; effort: string; speed: "fast" | "normal" | "unknown" };
export type UsageEvent = Dimensions & { t: number; sessionId: string; turn: string; usage: Tokens; source: string; line: number };
export type ActivityInterval = Dimensions & { sessionId: string; turn?: string; start: number; end: number; partial: boolean };
export type UsageSession = { id: string; title: string; project: string; parent: string; sources: string[] };
export type QuotaSnapshot = Dimensions & { t: number; sessionId: string; usedPercent: number; resetsAt: number; limitId: string; windowMinutes: number; source: string; line: number; reliable: boolean };
export type UsageData = {
  since: number; until: number; generatedAt: number;
  sessions: UsageSession[]; events: UsageEvent[]; intervals: ActivityInterval[]; snapshots: QuotaSnapshot[];
  coverage: { files: number; scanned: number; skippedRecords: number; invalidUsage: number; missingTime: number; duplicateEvents: number; rewrittenSessions: number; undatedUsage: number };
};
export type UsageFilter = { model?: string; effort?: string; speed?: string; sessionId?: string };
export type UsageBucket = Tokens & { start: number; end: number; activeSeconds: number; rootTokens: number; subagentTokens: number; series: Record<string, number> };
export type QuotaSegment = { cycle: number; points: [number, number][] };
export type QuotaWindow = { cycle: number; start: number; end: number; startPercent: number; endPercent: number; category: string; sessionId: string | null; dimensions: Dimensions | null; observedPp: number; firstSource: string; firstLine: number; lastSource: string; lastLine: number };

export const dimensionKey = (d: Dimensions) => JSON.stringify([d.model, d.effort, d.speed]);
export const dimensionLabel = (d: Dimensions) => `${d.model} · ${d.effort} · ${d.speed}`;
export const matchesUsage = (d: Dimensions & { sessionId?: string }, f: UsageFilter) =>
  (!f.model || d.model === f.model) && (!f.effort || d.effort === f.effort) && (!f.speed || d.speed === f.speed) && (!f.sessionId || d.sessionId === f.sessionId);
export const emptyTokens = (): Tokens => Object.fromEntries(TOKEN_FIELDS.map(key => [key, 0])) as Tokens;
export const perHour = (tokens: number, seconds: number) => seconds > 0 ? tokens * 3600 / seconds : null;

export function sumTokens(events: UsageEvent[]) {
  const result = emptyTokens();
  for (const event of events) for (const key of TOKEN_FIELDS) result[key] += event.usage[key];
  return result;
}

export function unionSeconds(intervals: { start: number; end: number }[]) {
  let total = 0, right = -Infinity;
  for (const { start, end } of [...intervals].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, end - Math.max(start, right));
    right = Math.max(right, end);
  }
  return total;
}

export function modelRows(events: UsageEvent[], intervals: ActivityInterval[]) {
  const groups = new Map<string, UsageEvent[]>();
  for (const event of events) {
    const key = dimensionKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(event);
  }
  return [...groups].map(([key, selected]) => {
    const { model, effort, speed } = selected[0];
    const parts = intervals.filter(i => dimensionKey(i) === key);
    const activeSeconds = parts.reduce((n, i) => n + i.end - i.start, 0);
    return { key, model, effort, speed, ...sumTokens(selected), sessions: new Set(selected.map(e => e.sessionId)).size,
      requests: selected.length, activeSeconds, partial: parts.some(i => i.partial) || !activeSeconds };
  }).sort((a, b) => b.total_tokens - a.total_tokens);
}

export function usageBuckets(events: UsageEvent[], intervals: ActivityInterval[], sessions: UsageSession[], since: number, until: number, hours: number): UsageBucket[] {
  const buckets: UsageBucket[] = [];
  for (let start = since; start < until;) {
    const nextDay = new Date(start * 1000);
    nextDay.setHours(24, 0, 0, 0);
    const end = Math.min(until, hours === 24 ? nextDay.getTime() / 1000 : start + hours * 3600);
    buckets.push({ ...emptyTokens(), start, end, activeSeconds: 0, rootTokens: 0, subagentTokens: 0, series: {} });
    start = end;
  }
  const parents = new Set(sessions.filter(s => s.parent).map(s => s.id));
  for (const event of events) {
    const bucket = hours === 24 ? buckets.find(b => event.t >= b.start && event.t < b.end) : buckets[Math.floor((event.t - since) / (hours * 3600))];
    if (!bucket) continue;
    for (const key of TOKEN_FIELDS) bucket[key] += event.usage[key];
    const key = dimensionKey(event);
    bucket.series[key] = (bucket.series[key] ?? 0) + event.usage.total_tokens;
    bucket[parents.has(event.sessionId) ? "subagentTokens" : "rootTokens"] += event.usage.total_tokens;
  }
  for (const interval of intervals) for (const bucket of buckets) {
    bucket.activeSeconds += Math.max(0, Math.min(interval.end, bucket.end) - Math.max(interval.start, bucket.start));
  }
  return buckets;
}

export function buildUsageReport(data: UsageData, filter: UsageFilter = {}) {
  const events = data.events.filter(e => matchesUsage(e, filter));
  const measuredTurns = new Set(data.events.map(e => JSON.stringify([e.sessionId, e.turn])));
  const intervals = data.intervals.filter(i => matchesUsage(i, filter) && (i.turn === undefined || measuredTurns.has(JSON.stringify([i.sessionId, i.turn]))));
  const sessions = data.sessions.flatMap(session => {
    const own = events.filter(e => e.sessionId === session.id);
    if (!own.length) return [];
    const parts = intervals.filter(i => i.sessionId === session.id);
    const start = Math.min(...own.map(e => e.t), ...parts.map(i => i.start));
    const end = Math.max(...own.map(e => e.t), ...parts.map(i => i.end));
    const activeSeconds = parts.reduce((n, i) => n + i.end - i.start, 0);
    return [{ ...session, ...sumTokens(own), start, end, activeSeconds,
      partial: parts.some(i => i.partial) || !activeSeconds, models: modelRows(own, parts) }];
  }).sort((a, b) => b.total_tokens - a.total_tokens);
  return { events, intervals, sessions, models: modelRows(events, intervals), summary: {
    ...sumTokens(events), activeSeconds: intervals.reduce((n, i) => n + i.end - i.start, 0),
    clockSeconds: unionSeconds(intervals), partial: sessions.some(s => s.partial),
    rootTokens: sessions.filter(s => !s.parent).reduce((n, s) => n + s.total_tokens, 0),
    subagentTokens: sessions.filter(s => s.parent).reduce((n, s) => n + s.total_tokens, 0),
  }, hourly: usageBuckets(events, intervals, data.sessions, data.since, data.until, 1),
  sixHourly: usageBuckets(events, intervals, data.sessions, data.since, data.until, 6),
  daily: usageBuckets(events, intervals, data.sessions, data.since, data.until, 24) };
}

// Attribute quota only with continuous, exclusive local activity, including all models.
function quotaOwner(start: number, end: number, intervals: ActivityInterval[]) {
  const parts = intervals.filter(i => i.start < end && i.end > start);
  if (parts.some(i => i.partial)) return { category: "uncertain_activity" };
  if (!parts.length) return { category: "no_local_activity" };
  if (new Set(parts.map(i => JSON.stringify([i.sessionId, dimensionKey(i)]))).size > 1) return { category: "parallel_or_switch" };
  if (Math.abs(unionSeconds(parts.map(i => ({ start: Math.max(start, i.start), end: Math.min(end, i.end) }))) - (end - start)) > .001) return { category: "activity_gap" };
  return { category: "isolated", owner: parts[0] };
}

export function analyzeQuota(data: UsageData, bucket: string, minimumMinutes = 10) {
  const snapshots = data.snapshots.filter(s => quotaKey(s) === bucket && s.reliable);
  const resetGroups: number[][] = [];
  for (const reset of [...new Set(snapshots.map(s => s.resetsAt))].sort((a, b) => a - b)) {
    if (!resetGroups.length || reset - resetGroups.at(-1)![0] > 60) resetGroups.push([]);
    resetGroups.at(-1)!.push(reset);
  }
  const cycles: { id: number; start: number; end: number; reset: number; firstPercent: number; highPercent: number; stale: number }[] = [];
  const series: QuotaSegment[] = [], windows: QuotaWindow[] = [];
  for (const resets of resetGroups) {
    const rows = snapshots.filter(s => resets.includes(s.resetsAt)).sort((a, b) => a.t - b.t || a.sessionId.localeCompare(b.sessionId) || a.line - b.line);
    let high = rows[0].usedPercent, previous: QuotaSnapshot | undefined, previousHigh = high, connected = false;
    const cycle = { id: cycles.length + 1, start: rows[0].t, end: rows.at(-1)!.t, reset: resets[0], firstPercent: high, highPercent: high, stale: 0 };
    for (const row of rows) {
      const stale = row.usedPercent < high;
      high = Math.max(high, row.usedPercent);
      if (stale) { cycle.stale++; connected = false; }
      else {
        if (!connected || !previous || row.t - previous.t > 300) series.push({ cycle: cycle.id, points: [] });
        series.at(-1)!.points.push([row.t, 100 - row.usedPercent]);
        connected = true;
      }
      if (previous) {
        const { owner, category: initial } = quotaOwner(previous.t, row.t, data.intervals);
        let category = initial;
        if (previous.usedPercent < previousHigh || stale) category = "stale_counter";
        else if (previous.usedPercent >= 100 || row.usedPercent >= 100) category = "quota_at_100";
        else if (row.t - previous.t > 300) category = "snapshot_gap_over_5min";
        else if (row.t === previous.t) category = "same_timestamp";
        else if (owner && (previous.sessionId !== owner.sessionId || row.sessionId !== owner.sessionId || dimensionKey(previous) !== dimensionKey(owner) || dimensionKey(row) !== dimensionKey(owner))) category = "snapshot_owner_changed";
        const isolated = category === "isolated" && owner;
        const pair: QuotaWindow = { cycle: cycle.id, start: previous.t, end: row.t,
          category, sessionId: isolated ? owner.sessionId : null,
          dimensions: isolated ? { model: owner.model, effort: owner.effort, speed: owner.speed } : null,
          startPercent: previousHigh, endPercent: high, observedPp: high - previousHigh,
          firstSource: previous.source, firstLine: previous.line, lastSource: row.source, lastLine: row.line };
        const last = windows.at(-1);
        if (last && last.cycle === pair.cycle && last.end === pair.start && last.category === pair.category && last.sessionId === pair.sessionId && JSON.stringify(last.dimensions) === JSON.stringify(pair.dimensions)) {
          last.end = pair.end; last.endPercent = pair.endPercent; last.observedPp += pair.observedPp;
          last.lastSource = pair.lastSource; last.lastLine = pair.lastLine;
        } else windows.push(pair);
      }
      previous = row; previousHigh = high;
    }
    cycle.highPercent = high;
    cycles.push(cycle);
  }
  const selected = windows.filter(w => w.category === "isolated" && w.end - w.start >= minimumMinutes * 60);
  const comparison = [...new Set(selected.map(w => dimensionKey(w.dimensions!)))].map(key => {
    const own = selected.filter(w => dimensionKey(w.dimensions!) === key);
    const seconds = own.reduce((n, w) => n + w.end - w.start, 0);
    const observedPp = own.reduce((n, w) => n + w.observedPp, 0);
    return { ...own[0].dimensions!, windows: own.length, sessions: new Set(own.map(w => w.sessionId)).size, seconds, observedPp,
      ppPerHour: perHour(observedPp, seconds), low: perHour(own.reduce((n, w) => n + Math.max(0, w.observedPp - 1), 0), seconds), high: perHour(observedPp + own.length, seconds) };
  });
  return { snapshots, cycles, series, windows, selected, comparison, observedPp: cycles.reduce((n, c) => n + c.highPercent - c.firstPercent, 0) };
}

export const quotaKey = (s: QuotaSnapshot) => `${s.limitId}/${s.windowMinutes}`;

export function quotaAt(series: QuotaSegment[], t: number) {
  const segment = series.find(s => s.points[0][0] <= t && s.points.at(-1)![0] >= t);
  if (!segment) return null;
  let lo = 0, hi = segment.points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (segment.points[mid][0] <= t) lo = mid + 1; else hi = mid;
  }
  const point = segment.points[Math.max(0, lo - 1)];
  return { time: point[0], remaining: point[1], cycle: segment.cycle };
}

export function fitRange(start: number, end: number, since: number, until: number): [number, number] {
  if (![start, end, since, until].every(Number.isFinite) || end <= start || until <= since) throw new Error("Choose a valid start and a later end.");
  const width = Math.min(until - since, Math.max(3600, end - start));
  start = Math.min(until - width, Math.max(since, start));
  return [start, start + width];
}

export function zoomRange(range: [number, number], factor: number, since: number, until: number, anchor = .5) {
  const width = Math.min(until - since, Math.max(3600, (range[1] - range[0]) * factor));
  const center = range[0] + (range[1] - range[0]) * anchor;
  return fitRange(center - width * anchor, center + width * (1 - anchor), since, until);
}

export function csvText(rows: Record<string, unknown>[]) {
  if (!rows.length) return "\uFEFF";
  const keys = Object.keys(rows[0]);
  const cell = (value: unknown) => {
    let text = value == null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
    if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return "\uFEFF" + [keys.map(cell).join(";"), ...rows.map(row => keys.map(key => cell(row[key])).join(";"))].join("\r\n");
}
