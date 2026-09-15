# Codex DB Explorer

A local Next.js interface for exploring the OpenAI Codex CLI's SQLite databases, the complete Markdown memory corpus, and JSONL session history stored under `~/.codex`.

> **Runs on your machine, against your data.** No telemetry, no external services, no data leaves your device.

## What it does

- Discovers SQLite stores in `~/.codex` and `~/.codex/sqlite`
- Adapts to schema changes through live table, column, index, and foreign-key discovery
- Adds focused analytics for logs, threads, memories, goals, and automations
- Browses tables with pagination, search, sorting, and expanded row details
- Runs guarded `SELECT`, `WITH`, and `EXPLAIN QUERY PLAN` statements
- Exports query results to CSV
- Searches Memory, complete session contents, and database schemas from one keyboard-accessible workspace, with contextual matches that open in place
- Discovers every Markdown file under `~/.codex/memories`
- Analyzes corpus size, structure, directories, and frequent terms
- Searches all memory content with file and line-level matches
- Edits Markdown with a GFM preview, stale-revision detection, and atomic replacement
- Previews and applies one explicitly confirmed Memory Forget plan with external backup, rollback, a delete tombstone, and manual resurfacing checks; see the [Memory Forget user guide](docs/memory-forgetting.md)
- Previews and applies **Forget project…** in the same Memory workspace with exact directory confirmation, verified external backups, coordinated Markdown/SQLite rollback, retained shared Memories, and a verified result
- Inspects dependencies before deleting one explicitly confirmed orphaned non-core Memory file, with revision revalidation and a verified external backup
- Indexes every JSONL file under `~/.codex/sessions` without scanning the full archive on page load
- Browses human messages and tool calls with per-session event analysis
- Distinguishes user, Codex-subtask, automation, and legacy sessions and browses their parent-child relationships as an expandable thread forest
- Streams complete transcripts on demand and exposes every file through a bounded, byte-paginated Raw JSONL viewer
- Searches session contents explicitly with a bounded full-text scan
- Reports token usage across active and archived sessions, grouped by model, reasoning effort and historical speed (fast / normal / unknown)
- Charts hourly usage alongside recorded account quota, with day/range selection, zoom, pan, fullscreen, daily totals and CSV exports

## Usage report

Open **Usage report** to see the last successfully generated report automatically, including after a page reload or app restart. If no report exists, choose the start and end in your local timezone and press **Generate report**. To include new telemetry, adjust the period as needed and press **Regenerate report**. The end is exclusive. Scanning is explicit and cancellable; the previous report remains available during generation and after a failed or cancelled scan. Changing model, effort or speed filters reuses the saved telemetry. Session rows show their own filtered usage, with model breakdowns and one-hour or six-hour windows. CSV exports use UTC timestamps.

The latest successful telemetry is stored atomically in the gitignored `.cache/usage-reports/` directory, separately for each configured Codex home and pair of session roots. Session and Memory sources remain unchanged; cached telemetry stays on your machine.

The report adapts the counting, active intervals, quota ledger and SVG chart from `codex-insights-2026-09-10-1013` (`extract_usage.py`, `build_report.py`, `quota_analysis.py`, `usage-chart.js`) into the app's TypeScript runtime. It requires no Python process, new dependency, copied private report data or external source directory at runtime.

Tokens are input + output; cached input and reasoning output are subsets. Repeated cumulative counters and duplicated files do not add usage twice. Model and effort come from each turn context; speed comes from historical `service_tier` settings (`priority` = fast, `default` = normal). Missing settings remain unknown. Active session hours exclude pauses between turns and count concurrent sessions separately; active clock hours merge overlap. Missing task boundaries make rates approximate. Restored streams with rewritten timestamps are excluded from dated token/quota totals and still block unsafe quota attribution.

Quota is account-wide, so model filters never alter its timeline. Each limit ID/window is kept separate. Resets, stale readings and gaps over five minutes break the line. Comparisons require continuous isolated local activity, matching model/effort/speed and a configurable minimum measured duration. Percentage points are observations, not token prices or proof that one setting is cheaper; remote usage is unobserved. The data-quality section reports skipped telemetry and unknown speed.

## Privacy & security

- Databases are opened with SQLite's read-only flag; the query endpoint rejects write and schema-changing statements.
- Memory files change only when you explicitly press **Save**, **Apply Forget plan**, or confirm the separate advanced **Delete orphaned file…** workflow. Forget remains the only regular deletion path. Orphan cleanup blocks referenced files, session-linked files, positive Memories, and aggregate files; it revalidates the exact revision and verifies an external backup before deleting one confirmed file.
- Session files are strictly read-only. Large previews state exactly why content was omitted. A complete transcript scan reads the full file while retaining at most 20,000 entries; the Raw JSONL viewer reads one fixed-size byte page at a time.
- The app reads whatever is in `~/.codex` — that can include prompts, conversations, and memories. Treat any screenshot, CSV export, or shared query result as potentially sensitive.
- Intended for `localhost` only. The API routes have **no authentication**, so anyone who can reach the port can read databases and edit memory Markdown. Do not deploy this or bind it to a public interface.
- CSV exports are written wherever your browser downloads go and are gitignored inside this repo by default.

## Run locally

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Root directory scanned for SQLite stores |
| `CODEX_DB_DIRECTORY` | – | Additional directory of SQLite files to include |
| `CODEX_MEMORY_DIRECTORY` | `$CODEX_HOME/memories` | Markdown memory root |
| `CODEX_SESSIONS_DIRECTORY` | `$CODEX_HOME/sessions` | JSONL session archive root |
| `CODEX_ARCHIVED_SESSIONS_DIRECTORY` | `$CODEX_HOME/archived_sessions` | Archived JSONL root inspected read-only for usage reports and orphan provenance |

```bash
CODEX_DB_DIRECTORY=/absolute/path/to/databases npm run dev
```

## Checks

```bash
npm run typecheck
npm run lint
npm run build
npm test
npm run test:acceptance
npm run test:coverage
npm run test:e2e
npm run test:mutation
```

Node 24 or newer is recommended because the app uses the built-in `node:sqlite` module and does not need a native SQLite package.
Session full-text search also expects [`rg` (ripgrep)](https://github.com/BurntSushi/ripgrep) on `PATH`.

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router) with React 19 and TypeScript
- [Tailwind CSS 4](https://tailwindcss.com/) with Radix UI primitives and shadcn/ui components
- [Recharts](https://recharts.org/) for analytics, [react-markdown](https://github.com/remarkjs/react-markdown) + `remark-gfm` for Markdown rendering
- Node's built-in `node:sqlite` for read-only database access

## Contributing

Issues and pull requests are welcome. Please run the checks above before opening a PR.

## License

[MIT](LICENSE)
