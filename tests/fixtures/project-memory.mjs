import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function seedProjectMemory(home, root = join(home, "memories")) {
  for (const directory of [root, join(root, "rollout_summaries"), join(root, "extensions/ad_hoc/notes"), join(home, "sessions"), join(home, "archived_sessions"), join(home, "sqlite")]) mkdirSync(directory, { recursive: true });
  const projects = [
    { id: "app", cwd: "/work/app", memory: "Keep project routing deterministic.", shared: true },
    { id: "app-ui", cwd: "/work/app/packages/ui", memory: "Reuse native controls inside project UI." },
    { id: "neighbor", cwd: "/work/application", memory: "Separate billing credentials by tenant.", shared: true },
  ];
  appendFileSync(join(root, "memory_summary.md"), "\n# Project Summary\n\n" + projects.map(({ memory }) => `- ${memory}\n`).join("") + "- Preserve accessible keyboard navigation.\n");
  for (const project of projects) {
    appendFileSync(join(root, "MEMORY.md"), `\n# Task Group: ${project.id}\napplies_to: cwd=${project.cwd}; reuse_rule=project only\n\n## Task 1: Delivery\n\n### rollout_summary_files\n\n- rollout_summaries/${project.id}.md (thread_id=${project.id})\n\n## Reusable knowledge\n\n- ${project.memory} [Task 1]\n${project.shared ? "- Preserve accessible keyboard navigation. [Task 1]\n" : ""}`);
    appendFileSync(join(root, "raw_memories.md"), `\n## Thread \`${project.id}\`\n\n- Raw details for ${project.id}.\n`);
    writeFileSync(join(root, "rollout_summaries", `${project.id}.md`), `thread_id: ${project.id}\n\n# ${project.id}\n\n- ${project.memory}\n`);
    writeFileSync(join(home, project.id === "app-ui" ? "archived_sessions" : "sessions", `${project.id}.jsonl`), JSON.stringify({ type: "session_meta", payload: { id: project.id, cwd: project.cwd } }) + "\n");
  }
  writeFileSync(join(root, "extensions/ad_hoc/notes", "routing.md"), "# Routing\n\n- Keep project routing deterministic.\n- Separate billing credentials by tenant.\n");
  writeFileSync(join(root, "rollout_summaries", "unassigned.md"), "# Unassigned\n\ncwd=/untrusted/free-text\n\nA project name is not authoritative scope.\n");
  writeFileSync(join(home, "sessions", "not-metadata.jsonl"), JSON.stringify({ type: "event_msg", payload: { id: "spoof", cwd: "/untrusted/event" } }) + "\n");
  const db = new DatabaseSync(join(home, "memories_1.sqlite"));
  db.exec("CREATE TABLE stage1_outputs (thread_id TEXT PRIMARY KEY, raw_memory TEXT NOT NULL, rollout_summary TEXT NOT NULL, rollout_slug TEXT, generated_at INTEGER NOT NULL, selected_for_phase2 INTEGER NOT NULL DEFAULT 0); CREATE TABLE jobs (kind TEXT, job_key TEXT, status TEXT)");
  for (const project of projects) db.prepare("INSERT INTO stage1_outputs VALUES (?, ?, ?, ?, ?, ?)").run(project.id, `Raw payload ${project.id}`, `Rollout payload ${project.id}`, project.id, 123, 1);
  db.prepare("INSERT INTO jobs VALUES (?, ?, ?)").run("memory", "app", "done");
  db.close();
  copyFileSync(join(home, "memories_1.sqlite"), join(home, "sqlite", "memories_1.sqlite"));
  return { home, root };
}

export function projectBytes(home) {
  const visit = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? visit(path) : [[relative(home, path), readFileSync(path), statSync(path).mtimeMs]];
  });
  return visit(home).sort(([left], [right]) => left.localeCompare(right));
}
