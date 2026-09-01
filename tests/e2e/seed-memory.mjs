import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = "/tmp/codex-explorer-e2e-memory";
const codexHome = "/tmp/codex-explorer-e2e-home";
const sessionsRoot = "/tmp/codex-explorer-e2e-sessions";
rmSync(root, { recursive: true, force: true });
rmSync(codexHome, { recursive: true, force: true });
rmSync(sessionsRoot, { recursive: true, force: true });
mkdirSync(join(root, "rollout_summaries"), { recursive: true });
mkdirSync(join(root, "extensions", "ad_hoc", "notes"), { recursive: true });
mkdirSync(codexHome, { recursive: true });
mkdirSync(sessionsRoot, { recursive: true });
writeFileSync(join(root, "memory_summary.md"), "# Summary\n\n- Keep changes simple and never add speculative features. [ad-hoc note]\n- Preserve unrelated facts.\n\n### /work/alpha\n- Alpha uses a narrow release workflow.\n- Shared release checks.\n\n### /work/alpha-tools\n- Beta keeps separate release notes.\n");
writeFileSync(join(root, "MEMORY.md"), [
  "# Memory",
  "",
  "- Never add speculative features; keep every change simple. [Task 1] [ad-hoc note]",
  "- Preserve unrelated facts. [Task 1]",
  "",
  "# Task Group: Alpha",
  "scope: Alpha delivery knowledge.",
  "applies_to: cwd=/work/alpha; reuse_rule=alpha only.",
  "",
  "## Task 1: Alpha delivery",
  "### rollout_summary_files",
  "- rollout_summaries/alpha.md (thread_id=thread-alpha)",
  "",
  "## Reusable knowledge",
  "- Alpha uses a narrow release workflow. [Task 1] [ad-hoc note]",
  "- Shared release checks. [Task 1]",
  "",
  "# Task Group: Beta",
  "scope: Beta delivery knowledge.",
  "applies_to: cwd=/work/alpha-tools; reuse_rule=beta only.",
  "",
  "## Task 1: Beta delivery",
  "### rollout_summary_files",
  "- rollout_summaries/beta.md (thread_id=thread-beta)",
  "",
  "## Reusable knowledge",
  "- Shared release checks. [Task 1]",
  "",
].join("\n"));
writeFileSync(join(root, "raw_memories.md"), "# Raw\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n\n## Thread `thread-alpha`\n- Alpha uses a narrow release workflow.\n\n## Thread `thread-beta`\n- Shared release checks.\n");
writeFileSync(join(root, "rollout_summaries", "one.md"), "# Rollout\n\n- Keep changes simple and never add speculative features.\n- Preserve unrelated facts.\n");
writeFileSync(join(root, "rollout_summaries", "orphan.md"), "# Retired rollout\n\nNo positive Memory remains in this file.\n");
writeFileSync(join(root, "rollout_summaries", "alpha.md"), "thread_id: thread-alpha\n\n- Alpha uses a narrow release workflow.\n");
writeFileSync(join(root, "rollout_summaries", "beta.md"), "thread_id: thread-beta\n\n- Shared release checks.\n");
writeFileSync(join(root, "extensions", "ad_hoc", "notes", "simplicity.md"), "# Simplicity\n\n- Keep changes simple and never add speculative features.\n");
writeFileSync(join(root, "extensions", "ad_hoc", "notes", "alpha.md"), "# Alpha\n\n- Alpha uses a narrow release workflow.\n");
writeFileSync(join(sessionsRoot, "alpha.jsonl"), `${JSON.stringify({ timestamp: "2026-08-24T10:00:00Z", type: "session_meta", payload: { id: "thread-alpha", cwd: "/work/alpha" } })}\n`);
writeFileSync(join(sessionsRoot, "beta.jsonl"), `${JSON.stringify({ timestamp: "2026-08-24T11:00:00Z", type: "session_meta", payload: { id: "thread-beta", cwd: "/work/alpha-tools" } })}\n`);
const database = new DatabaseSync(join(codexHome, "memories_1.sqlite"));
database.exec("CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, rollout_slug TEXT, selected_for_phase2 INTEGER NOT NULL DEFAULT 0)");
database.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?)").run("thread-alpha", "alpha", 1);
database.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?)").run("thread-beta", "beta", 1);
database.close();
