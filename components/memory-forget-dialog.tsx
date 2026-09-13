"use client";

import { Loader2, RefreshCw, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ForgetPlan, ForgetResult, ForgetSection, ProjectForgetPlan } from "@/lib/memory-forget";
import { cn } from "@/lib/utils";

export type ForgetRecheck = { status: "suppressed" | "resurfaced"; resurfaced: ForgetSection[] };

type Props = {
  open: boolean;
  loading: boolean;
  error: string | null;
  plan: ForgetPlan | ProjectForgetPlan | null;
  result: ForgetResult | null;
  recheck: ForgetRecheck | null;
  confirmedDurableIds: string[];
  project?: { directory: string; confirmation: string; onConfirmationChange: (value: string) => void; onDirectoryChange: (directory: string) => void; onPreview: () => void };
  onOpenChange: (open: boolean) => void;
  onConfirm: (id: string, confirmed: boolean) => void;
  onRefresh: () => void;
  onApply: () => void;
  onRecheck: () => void;
};

function Sections({ title, sections }: { title: string; sections: ForgetSection[] }) {
  return <div className="space-y-2"><p className="text-xs font-semibold">{title} ({sections.length})</p>{sections.map((section) => <div key={section.id} className="rounded-lg border p-3 text-xs"><div className="flex items-center justify-between gap-2"><Badge variant="secondary">{section.kind}</Badge><span className="font-mono text-[10px] text-muted-foreground">{section.path}:{section.startLine}-{section.endLine}</span></div><pre className="mt-2 whitespace-pre-wrap font-sans text-[11px] text-muted-foreground">{section.content.trim()}</pre></div>)}</div>;
}

export function MemoryForgetDialog({ open, loading, error, plan, result, recheck, confirmedDurableIds, project, onOpenChange, onConfirm, onRefresh, onApply, onRecheck }: Props) {
  const projectPlan = plan && "kind" in plan ? plan : null;
  const summaryPlan = plan && !("kind" in plan) ? plan : null;
  const visiblePlan = project && projectPlan?.directory !== project.directory ? null : plan;
  const needsSourceConfirmation = summaryPlan && (summaryPlan.durableCandidates.length > 1 || summaryPlan.durableCandidates.some(({ match }) => match === "related"));

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{project ? "Forget project…" : "Forget this Memory?"}</DialogTitle>
          <DialogDescription>{project ? "Preview Memories assigned to one directory and its descendants. Previewing, refreshing, and cancelling change nothing." : "Review every exact section first. Nothing is changed until you apply the confirmed plan."}</DialogDescription>
        </DialogHeader>
        {project && <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); project.onPreview(); }}><label htmlFor="forget-project-directory" className="text-xs font-semibold">Project directory</label><Input id="forget-project-directory" list="forget-project-scopes" value={project.directory} onChange={(event) => project.onDirectoryChange(event.target.value)} placeholder="/absolute/project/directory" disabled={loading || !!result} autoComplete="off" /><datalist id="forget-project-scopes">{projectPlan?.knownProjectScopes.map((scope) => <option key={scope} value={scope} />)}</datalist><Button type="submit" variant="outline" size="sm" disabled={loading || !!result || !project.directory.trim()}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />{visiblePlan && project.directory ? "Refresh preview" : "Preview project"}</Button></form>}
        {loading && !plan ? <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Building read-only preview…</div> : null}
        {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">{error}</div>}
        {visiblePlan && <div className="space-y-4">
          {summaryPlan && <div className="rounded-lg border bg-muted/30 p-3 text-xs"><p className="font-semibold">Selected summary entry</p><p className="mt-1 text-muted-foreground">{summaryPlan.target}</p></div>}
          {needsSourceConfirmation && summaryPlan && !result && <div className="space-y-2">
            <p className="text-xs font-semibold">Confirm the durable sources</p>
            {summaryPlan.durableCandidates.map((candidate) => <label key={candidate.id} className="flex gap-2 rounded-lg border p-3 text-xs"><input type="checkbox" checked={confirmedDurableIds.includes(candidate.id)} onChange={(event) => onConfirm(candidate.id, event.target.checked)} /><span><b>{candidate.path}:{candidate.startLine}</b><span className="mt-1 block text-muted-foreground">{candidate.content.trim()}</span>{candidate.signals?.length ? <span className="mt-1 block text-[10px] text-indigo-600">Matched by {candidate.signals.join(", ")}</span> : null}</span></label>)}
            <Button variant="outline" size="sm" onClick={onRefresh} disabled={loading || confirmedDurableIds.length === 0}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} />Update plan</Button>
          </div>}
          {visiblePlan.reason && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{visiblePlan.reason}</p>}
          {projectPlan && <div className="space-y-2 text-xs"><p className="break-all font-mono">{projectPlan.directory}</p><p>{projectPlan.untouchedSessionCount} matching sessions stay untouched. Scheduler jobs and database snapshots stay untouched.</p><p className="font-semibold">Affected source artifacts ({new Set(projectPlan.sections.map(({ path }) => path)).size})</p><ul className="list-disc pl-4 font-mono text-[10px]">{[...new Set(projectPlan.sections.map(({ path }) => path))].map((path) => <li key={path}>{path}</li>)}</ul></div>}
          {visiblePlan.sections.length > 0 && <Sections title="Exact affected sections" sections={visiblePlan.sections} />}
          {projectPlan && <><Sections title="Retained shared Memories" sections={projectPlan.retainedShared} /><div className="space-y-2 text-xs"><p className="font-semibold">Matching stage1_outputs ({projectPlan.database.rows.length})</p><p className="break-all font-mono text-[10px] text-muted-foreground">{projectPlan.database.path ?? "No active Memory database found."}</p>{projectPlan.database.rows.map((row) => <details key={String(row.thread_id)} className="rounded-lg border p-3"><summary className="cursor-pointer font-mono text-[10px]">{String(row.thread_id)}{row.rollout_slug ? ` · ${row.rollout_slug}` : ""}</summary><pre className="mt-2 whitespace-pre-wrap text-[11px]">{JSON.stringify(row, null, 2)}</pre></details>)}</div></>}
          {project && projectPlan && !result && <div className="space-y-2">
            <label htmlFor="confirm-project-directory" className="text-xs font-semibold">Confirm project directory</label>
            <p className="text-xs text-muted-foreground">Type {projectPlan.directory} exactly to apply this plan.</p>
            <Input id="confirm-project-directory" value={project.confirmation} onChange={(event) => project.onConfirmationChange(event.target.value)} disabled={loading || !projectPlan.actionable} autoComplete="off" />
            <Button variant="destructive" onClick={onApply} disabled={loading || !projectPlan.actionable || project.confirmation !== projectPlan.directory}><Trash2 className="size-4" />Apply Forget plan</Button>
          </div>}
          {result && <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"><p className="font-semibold">Memory removed and verified; delete tombstone written.</p><p>Tombstone: {result.tombstonePath}</p><div><p className="font-medium">Changed artifacts ({result.changedPaths.length})</p><ul className="mt-1 list-disc pl-4 font-mono text-[10px]">{result.changedPaths.map((path) => <li key={path}>{path}</li>)}</ul></div><p className="break-all font-mono text-[10px]">Backup: {result.manifestPath}</p></div>}
          {result?.removedDatabaseRows !== undefined && <p className="text-xs text-emerald-800">{result.removedDatabaseRows} database Memory rows removed. No targeted positive Memory remains in Markdown or stage1_outputs.</p>}
          {recheck && <div className={cn("rounded-lg border p-3 text-xs", recheck.status === "suppressed" ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-amber-200 bg-amber-50 text-amber-800")}>{recheck.status === "suppressed" ? "No positive copy currently appears in the Memory corpus." : `Memory resurfaced in ${recheck.resurfaced.map(({ path }) => path).join(", ")}.`}</div>}
          {!project && <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Close</Button>{result ? <Button onClick={onRecheck} disabled={loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}Recheck now</Button> : <Button variant="destructive" onClick={onApply} disabled={!visiblePlan.actionable || loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Apply Forget plan</Button>}</div>}
        </div>}
        {project && <div className="flex justify-end"><Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>{result ? "Close" : "Cancel"}</Button></div>}
      </DialogContent>
    </Dialog>
  );
}
