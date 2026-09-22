"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Desktop module navigation belongs below the main menu; mobile keeps it inline.
export function ModuleSidebar({ children, active = true }: { children: ReactNode; active?: boolean }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1024px)");
    const update = () => setTarget(desktop.matches ? document.getElementById("module-sidebar") : null);
    update();
    desktop.addEventListener("change", update);
    return () => desktop.removeEventListener("change", update);
  }, [active]);

  if (!active) return null;
  return target ? createPortal(children, target) : children;
}
