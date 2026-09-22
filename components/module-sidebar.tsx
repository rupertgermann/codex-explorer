"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ModuleSidebarTrigger({ targetId, label }: { targetId: string; label: string }) {
  return <Button type="button" variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-xs text-accent-foreground lg:hidden" aria-controls={targetId} onClick={() => {
    const browser = document.getElementById(targetId);
    if (!(browser instanceof HTMLDetailsElement)) return;
    browser.open = true;
    browser.querySelector("summary")?.focus({ preventScroll: true });
    browser.scrollIntoView({ block: "start" });
  }}><ChevronLeft className="size-3.5" />{label}</Button>;
}

// Desktop navigation stays in the sidebar; mobile browsing yields to the reader.
export function ModuleSidebar({ children, id, label, selectionKey, active = true }: { children: ReactNode; id: string; label: string; selectionKey?: string | number; active?: boolean }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const update = () => setTarget(desktop.matches ? document.getElementById("module-sidebar") : null);
    update();
    desktop.addEventListener("change", update);
    return () => desktop.removeEventListener("change", update);
  }, [active]);

  if (!active) return null;
  return target ? createPortal(children, target) : (
    <details id={id} key={selectionKey} className="min-w-0 scroll-mt-20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-xl border bg-card px-4 py-3 text-sm font-medium hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
        {label}<ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}
