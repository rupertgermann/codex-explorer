export type Workspace = "databases" | "memory" | "sessions" | "usage";

export const DEFAULT_WORKSPACE: Workspace = "databases";
export const WORKSPACE_COOKIE_NAME = "codex-explorer.workspace";

export function isWorkspace(value: string | undefined): value is Workspace {
  return value === "databases" || value === "memory" || value === "sessions" || value === "usage";
}
