export type Workspace = "search" | "databases" | "memory" | "sessions" | "usage";

export const DEFAULT_WORKSPACE: Workspace = "search";
export const WORKSPACE_COOKIE_NAME = "codex-explorer.workspace";

export function isWorkspace(value: string | undefined): value is Workspace {
  return value === "search" || value === "databases" || value === "memory" || value === "sessions" || value === "usage";
}
