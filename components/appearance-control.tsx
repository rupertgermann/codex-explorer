"use client";

import { useId, useLayoutEffect, useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";

type Appearance = "light" | "dark" | "system";
const storageKey = "codex-explorer-appearance";
let preference: Appearance | undefined;

function validAppearance(value: string | null): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

function getAppearance(): Appearance {
  if (preference) return preference;
  try { preference = validAppearance(localStorage.getItem(storageKey)); }
  catch { preference = "system"; }
  return preference;
}

function applyAppearance() {
  const value = getAppearance();
  document.documentElement.dataset.appearance = value;
  document.documentElement.dataset.theme = value === "system"
    ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : value;
}

function subscribe(onChange: () => void) {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const update = () => { applyAppearance(); onChange(); };
  const syncStorage = (event: StorageEvent) => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = validAppearance(event.newValue);
    update();
  };
  media.addEventListener("change", update);
  window.addEventListener("storage", syncStorage);
  window.addEventListener("appearancechange", update);
  return () => {
    media.removeEventListener("change", update);
    window.removeEventListener("storage", syncStorage);
    window.removeEventListener("appearancechange", update);
  };
}

function chooseAppearance(value: Appearance) {
  preference = value;
  try { localStorage.setItem(storageKey, value); }
  catch { /* The current page still works when storage is unavailable. */ }
  applyAppearance();
  window.dispatchEvent(new Event("appearancechange"));
}

export function AppearanceControl() {
  const name = useId();
  const appearance = useSyncExternalStore(subscribe, getAppearance, () => "system" as const);

  // Reapply before paint if development Strict Mode clears the bootstrapped attributes.
  useLayoutEffect(applyAppearance, []);

  return (
    <fieldset className="appearance-control grid min-w-0 grid-cols-3 gap-1 rounded-xl border border-border bg-secondary/50 p-1">
      <legend className="sr-only">Appearance</legend>
      {([{ value: "light", label: "Light", Icon: Sun }, { value: "dark", label: "Dark", Icon: Moon }, { value: "system", label: "System", Icon: Monitor }] as const).map(({ value, label, Icon }) => (
        <label key={value} className="min-w-0 cursor-pointer">
          <input className="peer sr-only" type="radio" name={name} value={value} checked={appearance === value} onChange={() => chooseAppearance(value)} />
          <span className="flex min-h-9 items-center justify-center gap-1 rounded-lg px-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground peer-checked:bg-primary peer-checked:text-primary-foreground peer-checked:shadow-sm peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring">
            <Icon className="size-3.5 shrink-0" aria-hidden="true" />{label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
