import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

writeFileSync(join(root, "atlas.md"), "# Atlas search fixture\n\nThe atlas workflow connects a remembered decision to its originating conversation and schema.\n");

const sessionsRoot = "/tmp/codex-explorer-e2e-sessions";
rmSync(sessionsRoot, { recursive: true, force: true });
mkdirSync(join(sessionsRoot, "2026", "08", "30"), { recursive: true });
cpSync(join(projectHome, "sessions"), sessionsRoot, { recursive: true });
writeFileSync(join(sessionsRoot, "2026", "08", "30", "atlas.jsonl"), [
  { timestamp: "2026-08-30T09:00:00.000Z", type: "session_meta", payload: { id: "atlas-session", cwd: "/work/atlas-project", thread_source: "user" } },
  { timestamp: "2026-08-30T09:01:00.000Z", type: "event_msg", payload: { type: "user_message", message: "Investigate the atlas workflow across all local Codex sources." } },
  { timestamp: "2026-08-30T09:02:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "The atlas workflow connects search context to the selected transcript." } },
].map((record) => JSON.stringify(record)).join("\n") + "\n");

const databaseRoot = "/tmp/codex-explorer-e2e-databases";
rmSync(databaseRoot, { recursive: true, force: true });
mkdirSync(databaseRoot, { recursive: true });
const database = new DatabaseSync(join(databaseRoot, "search-fixture.sqlite"));
database.exec("CREATE TABLE atlas_records (id INTEGER PRIMARY KEY, atlas_note TEXT NOT NULL); CREATE INDEX idx_atlas_note ON atlas_records(atlas_note)");
database.exec("CREATE TABLE empty_records (id INTEGER PRIMARY KEY, note TEXT)");
const insert = database.prepare("INSERT INTO atlas_records (atlas_note) VALUES (?)");
for (let index = 1; index <= 65; index++) insert.run(`Record ${index}`);
database.close();
