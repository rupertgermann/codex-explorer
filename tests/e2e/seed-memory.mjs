import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { seedProjectMemory } from "../fixtures/project-memory.mjs";

const root = "/tmp/codex-explorer-e2e-memory";
rmSync(root, { recursive: true, force: true });
mkdirSync(join(root, "rollout_summaries"), { recursive: true });
mkdirSync(join(root, "extensions", "ad_hoc", "notes"), { recursive: true });
writeFileSync(join(root, "memory_summary.md"), "# Summary\n\n- Keep changes simple and never add speculative features. [ad-hoc note]\n- Preserve unrelated facts.\n");
writeFileSync(join(root, "MEMORY.md"), "# Memory\n\n- Never add speculative features; keep every change simple. [Task 1] [ad-hoc note]\n- Preserve unrelated facts. [Task 1]\n");
writeFileSync(join(root, "raw_memories.md"), "# Raw\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
writeFileSync(join(root, "rollout_summaries", "one.md"), "# Rollout\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
writeFileSync(join(root, "rollout_summaries", "orphan.md"), "# Retired rollout\n\nNo positive Memory remains in this file.\n");
writeFileSync(join(root, "extensions", "ad_hoc", "notes", "simplicity.md"), "# Simplicity\n\n- Keep changes simple and never add speculative features.\n");
const projectHome = "/tmp/codex-explorer-e2e-home";
rmSync(projectHome, { recursive: true, force: true });
seedProjectMemory(projectHome, root);
