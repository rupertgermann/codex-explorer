"use client";

import { useState } from "react";
import { Archive, FileWarning, Link2, Loader2, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OrphanPlan, OrphanResult } from "@/lib/memory-orphan";
import { formatDate } from "@/lib/utils";

type Props = {
  open: boolean;
  loading: boolean;
  error: string | null;
  plan: OrphanPlan | null;
  result: OrphanResult | null;
  onOpenChange: (open: boolean) => void;
  onApply: () => void;
};

export function MemoryOrphanDialog({ open, loading, error, plan, result, onOpenChange, onApply }: Props) {
  const [confirmed, setConfirmed] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!loading) onOpenChange(next); }}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto [overflow-wrap:anywhere]">
        <DialogHeader>
          <DialogTitle>Delete orphaned file?</DialogTitle>
          <DialogDescription>This advanced cleanup removes one whole file. It is separate from ordinary Memory Forget and starts with a read-only dependency inspection.</DialogDescription>
        </DialogHeader>
        {loading && !plan ? <div role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Inspecting references and provenance…</div> : null}
        {error && <div role="alert" className="rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-xs text-destructive">{error}</div>}
        {plan && <div className="space-y-4">
          <div className="rounded-lg border bg-muted/30 p-3 text-xs">
            <p className="font-semibold">Exact candidate file</p>
            <p className="mt-1 font-mono">{plan.path}</p>
            <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">Revision {plan.expectedHash}</p>
          </div>

          <div className={plan.eligible ? "rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-400/25 dark:bg-emerald-400/10 p-3 text-xs text-emerald-800 dark:text-emerald-200" : "rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-400/25 dark:bg-amber-400/10 p-3 text-xs text-amber-900 dark:text-amber-200"}>
            {plan.eligible ? "No blockers found. This file is an eligible orphan." : plan.reason}
          </div>

          <section className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold"><Link2 className="size-3.5 text-accent-foreground" />Incoming Memory references ({plan.incomingReferences.length})</p>
            {plan.incomingReferences.length === 0 ? <p className="text-xs text-muted-foreground">None discovered.</p> : plan.incomingReferences.map((reference, index) => <div key={`${reference.path}:${reference.line}:${index}`} className="rounded-lg border p-3 text-xs"><p className="font-mono text-[11px] text-muted-foreground">{reference.path}:{reference.line}</p><p className="mt-1">{reference.excerpt}</p></div>)}
          </section>

          <section className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold"><Archive className="size-3.5 text-accent-foreground" />Linked session provenance ({plan.sessionLinks.length})</p>
            {plan.sessionLinks.length === 0 ? <p className="text-xs text-muted-foreground">No active or archived session links discovered.</p> : plan.sessionLinks.map((session) => <div key={`${session.location}:${session.path}`} className="rounded-lg border p-3 text-xs"><div className="flex items-center justify-between gap-2"><Badge variant="secondary">{session.location}</Badge><span className="text-[11px] text-muted-foreground">{formatDate(session.startedAt)}</span></div><p className="mt-2 font-mono text-[11px]">{session.id}</p><p className="mt-1 font-mono text-[11px] text-muted-foreground">{session.path}</p></div>)}
          </section>

          <section className="space-y-2">
            <p className="flex items-center gap-2 text-xs font-semibold"><FileWarning className="size-3.5 text-accent-foreground" />Positive Memory entries ({plan.positiveMemories.length})</p>
            {plan.positiveMemories.length === 0 ? <p className="text-xs text-muted-foreground">None discovered.</p> : <><p className="text-xs text-amber-800 dark:text-amber-200">Remove these consistently through Forget before deleting the file.</p>{plan.positiveMemories.map((entry) => <pre key={`${entry.line}:${entry.content}`} className="whitespace-pre-wrap rounded-lg border p-3 font-sans text-[11px] text-muted-foreground"><span className="font-mono text-[11px]">Lines {entry.line}-{entry.endLine}</span>{"\n"}{entry.content}</pre>)}</>}
          </section>

          {result ? <div className="space-y-2 rounded-lg border border-emerald-200 bg-emerald-50 dark:border-emerald-400/25 dark:bg-emerald-400/10 p-3 text-xs text-emerald-800 dark:text-emerald-200"><p className="flex items-center gap-2 font-semibold"><ShieldCheck className="size-4" />The confirmed orphan file was deleted.</p><p className="font-mono text-[11px]">{result.deletedPath}</p><p className="break-all font-mono text-[11px]">Backup manifest: {result.manifestPath}</p></div> : plan.eligible ? <label className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/8 p-3 text-xs text-destructive"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" disabled={loading} checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /><span><b>I confirm this exact orphan file should be deleted.</b><span className="mt-1 block">The verified backup remains outside the Memory corpus.</span></span></label> : null}

          <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>Close</Button>{!result && <Button variant="destructive" onClick={onApply} disabled={!plan.eligible || !confirmed || loading}>{loading ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}Delete confirmed orphan</Button>}</div>
        </div>}
      </DialogContent>
    </Dialog>
  );
}
