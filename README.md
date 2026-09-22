# Codex Explorer

A private, local Next.js workspace for exploring Codex data under `~/.codex`: SQLite databases, Markdown Memory, active and archived session telemetry, and JSONL conversation history. Search across sources, edit and forget Memories with explicit confirmation, inspect session thread trees, and generate persistent token and account-quota reports with interactive charts and CSV exports.

> **Runs on your machine, against your data.** No telemetry is sent and no external service is used. Browsing is read-only; Memory changes require explicit confirmation. Reports and backups stay local.

## What it does

Five workspaces share responsive navigation, with module-specific controls in the desktop sidebar and inline on mobile. Search is the starting workspace. Your selected workspace is remembered across reloads, and open documents, filters, chart ranges, and SQL drafts stay in place when switching workspaces. Leaving an unsaved Memory edit requires confirmation.

### Search everything

- Opens with **⌘K** on macOS or **Ctrl+K** elsewhere
- Searches Markdown Memory, complete session contents, and database schemas in one submitted search
- Shows line-level context and highlighted matches, then opens the matching Memory document, session, or database schema in place
- Displays results as each source finishes; cancellation keeps the results already found
- Keeps the query and results when switching workspaces; reports source-specific failures without hiding successful results
- Searches database, table, column, type, and index metadata, not database row contents; use the table browser or Query lab for records

### SQLite databases

- Discovers SQLite stores in `~/.codex` and `~/.codex/sqlite`
- Adapts to schema changes through live table, column, index, and foreign-key discovery
- Adds focused analytics for logs, threads, memories, goals, and automations
- Opens tables directly from the inventory, with pagination, search, sorting, and keyboard-accessible row details
- Runs guarded `SELECT`, `WITH`, and `EXPLAIN QUERY PLAN` statements
- Offers query templates for the discovered columns, with a generic preview for older schemas
- Exports query results to spreadsheet-safe, UTF-8, semicolon-separated CSV

### Markdown memory

- Discovers every Markdown file under `~/.codex/memories`
- Shows compact corpus and directory counts alongside the file browser
- Searches all memory content with file and line-level matches
- Edits Markdown with a GFM preview, **⌘S** / **Ctrl+S** to save, confirmed discard, stale-revision detection, and atomic replacement
- Previews and applies one confirmed Memory Forget plan, with affected-section review, confirmation of uncertain source matches, verified external backups, runtime rollback, a delete tombstone, and manual resurfacing checks
- Previews and applies **Forget project…** for one directory and its descendants, with exact directory confirmation, removal of matching active Memory database rows, verified external backups, coordinated Markdown/SQLite rollback, retained shared Memories, and a verified result
- Inspects dependencies before deleting one explicitly confirmed orphaned non-core Memory file, with revision revalidation and a verified external backup

See the [Memory Forget user guide](docs/memory-forgetting.md) for the individual-Memory and project workflows, recovery behavior, and current limits.

### Session archive

- Indexes every JSONL file under `~/.codex/sessions` without scanning the full archive on page load
- Caches the catalog until explicitly refreshed and filters sessions by project, month, and provenance, with a single reset action
- Browses human messages and tool calls with per-session event analysis
- Distinguishes user, Codex-subtask, automation, and legacy sessions and browses their parent-child relationships as an expandable thread forest; lists reveal more sessions in batches
- Streams complete transcripts on demand and exposes every file through a bounded, byte-paginated Raw JSONL viewer
- Searches session contents explicitly with a bounded full-text scan

### Usage report

- Scans active and archived sessions on demand, with cancellation and deduplication of repeated counters and copied events
- Groups input, cached input, output, and reasoning tokens by model, reasoning effort, and historical speed (fast / normal / unknown), with separate main-session and subagent totals
- Reports active session hours, overlap-merged active clock hours, per-session model breakdowns, and one-hour or six-hour usage windows
- Charts hourly usage alongside recorded account quota, with day/range selection, zoom, pan, fullscreen, and daily totals
- Separates quota limit IDs and windows, explains resets and unreliable gaps, and compares only continuously isolated local activity; includes data-quality diagnostics
- Saves the last successful report locally and restores it across workspace visits, page reloads, and app restarts; regeneration replaces it only after a successful scan
- Exports session, model, time-window, token-event, and quota datasets as CSV

## Using the usage report

Open **Usage report** to see the last successfully generated report automatically, including after a page reload or app restart. If no report exists, choose the start and end in your local timezone and press **Generate report**. To include new telemetry, adjust the period as needed and press **Regenerate report**. The end is exclusive. Scanning is explicit and cancellable; the previous report remains available during generation and after a failed or cancelled scan. Changing model, effort or speed filters reuses the saved telemetry. Session rows show their own filtered usage, with model breakdowns and one-hour or six-hour windows. CSV exports use UTC timestamps.

The latest successful telemetry is stored atomically in the gitignored `.cache/usage-reports/` directory, separately for each configured Codex home and pair of session roots. Session and Memory sources remain unchanged; cached telemetry stays on your machine.

All report processing runs in the app's TypeScript runtime; no Python process, external account API, or private reference-report directory is required.

Tokens are input + output; cached input and reasoning output are subsets. Repeated cumulative counters and duplicated files do not add usage twice. Model and effort come from each turn context; speed comes from historical `service_tier` settings (`priority` = fast, `default` = normal). Missing settings remain unknown. Active session hours exclude pauses between turns and count concurrent sessions separately; active clock hours merge overlap. Missing task boundaries make rates approximate. Restored streams with rewritten timestamps are excluded from dated token/quota totals and still block unsafe quota attribution.

Quota is account-wide, so model filters never alter its timeline. Each limit ID/window is kept separate. Resets, stale readings and gaps over five minutes break the line. Comparisons require continuous isolated local activity, matching model/effort/speed and a configurable minimum measured duration. Percentage points are observations, not token prices or proof that one setting is cheaper; remote usage is unobserved. The data-quality section reports skipped telemetry and unknown speed.

## Privacy & security

- Database browsing and queries use SQLite's read-only flag; the query endpoint rejects write and schema-changing statements. The only database mutation is a separately confirmed **Forget project…** transaction, which deletes matching `stage1_outputs` rows from the single active `memories_<version>.sqlite` store. Scheduler jobs and development/snapshot databases remain unchanged.
- Memory files change only when you explicitly press **Save**, **Apply Forget plan**, or confirm the separate advanced **Delete orphaned file…** workflow. Save rejects stale revisions before atomic replacement. Forget remains the only regular deletion path. Orphan cleanup blocks referenced files, session-linked files, positive Memories, and aggregate files; it revalidates the exact revision and verifies an external backup before deleting one confirmed file.
- Forget uses verified backups outside the Memory corpus and attempts coordinated rollback on runtime failures without overwriting concurrent changes. A hard process or system crash can require manual recovery. Forget is not complete erasure: backups, tombstones, and session history remain, and there is no automatic resurfacing watcher or user-facing Undo.
- Session files are strictly read-only. Large previews state exactly why content was omitted. A complete transcript scan reads the full file while retaining at most 20,000 entries; the Raw JSONL viewer reads one fixed-size byte page at a time.
- Usage reports read existing local telemetry, never fetch live account limits, and write only their local report cache. Cached reports and external Forget/orphan-cleanup backups can contain sensitive data.
- The app reads whatever is in `~/.codex` — that can include prompts, conversations, and memories. Treat any screenshot, CSV export, or shared query result as potentially sensitive.
- Intended for `localhost` only. The API routes have **no authentication**, so anyone who can reach the port can read databases, edit or delete eligible Memory content, and apply Project Forget database changes. Do not deploy this or bind it to a public interface.
- CSV exports are written wherever your browser downloads go and are gitignored inside this repo by default.

## Run locally

```bash
npm install
npm run dev -- --hostname 127.0.0.1
```

Then open [http://localhost:3000](http://localhost:3000).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_HOME` | `~/.codex` | Codex data root for SQLite discovery, default Memory/session roots, and usage-report session titles |
| `CODEX_DB_DIRECTORY` | – | Additional directory of SQLite files to include |
| `CODEX_MEMORY_DIRECTORY` | `$CODEX_HOME/memories` | Markdown memory root |
| `CODEX_SESSIONS_DIRECTORY` | `$CODEX_HOME/sessions` | JSONL session archive root |
| `CODEX_ARCHIVED_SESSIONS_DIRECTORY` | `$CODEX_HOME/archived_sessions` | Archived JSONL root inspected read-only for usage reports, Project Forget provenance, and orphan dependencies |

```bash
CODEX_DB_DIRECTORY=/absolute/path/to/databases npm run dev -- --hostname 127.0.0.1
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
Session full-text search, including unified search, also expects [`rg` (ripgrep)](https://github.com/BurntSushi/ripgrep) on `PATH`. Unified search requires at least three characters; session scans are bounded to 20 seconds and 100 matching sessions.

Browser checks require Google Chrome and a successful `npm run build`; the Playwright configuration starts a separate production server on `127.0.0.1:3317` against temporary fixture data, not your Codex home.

## Tech stack

- [Next.js 16](https://nextjs.org/) (App Router) with React 19 and TypeScript
- [Tailwind CSS 4](https://tailwindcss.com/) with Radix UI primitives and shadcn/ui components
- [Recharts](https://recharts.org/) and an interactive SVG usage/quota chart for analytics, [react-markdown](https://github.com/remarkjs/react-markdown) + `remark-gfm` for Markdown rendering
- Node's built-in `node:sqlite` for read-only browsing and confirmed Project Forget transactions

## Contributing

Issues and pull requests are welcome. Please run the checks above before opening a PR.

## License

[MIT](LICENSE)
