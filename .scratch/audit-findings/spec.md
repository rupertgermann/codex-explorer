# Audit findings implementation

**Status:** implementing

Implement the five audit findings approved by the implement-spec invocation on one integration branch, `feat/audit-findings`.

## Acceptance target

Query lab bounds result collection, accepts valid read-only SQL, and distinguishes successful empty results. Session content stays inside its resolved archive root, and the session tree preserves newer subagent parent links. Each ticket supplies the complete acceptance criteria.

## Tickets and execution

All five tickets are independent and have no semantic blockers. Sequence edits to shared files to avoid merge conflicts: ticket 03 follows ticket 02, and ticket 05 follows ticket 01. This scheduling does not add ticket dependencies.

- 01: Bound Query lab result collection.
- 02: Keep session reads inside the configured archive.
- 03: Preserve newer subagent parent links in the session tree.
- 04: Accept valid read-only queries in Query lab.
- 05: Show successful empty Query lab results.

## Verification seams

These are the acceptance seams already specified in the approved tickets:

- Real query API with temporary SQLite databases: catches response limits, SQL acceptance, read-only enforcement, and empty-result metadata; does not verify browser rendering.
- Session content endpoints with temporary archives: catches resolved-path escapes and permitted linked archive roots; does not verify filesystem changes racing an already-open read.
- Session catalog through tree construction: catches parent metadata extraction and rendered-tree input; does not verify tree styling.
- Isolated browser Query lab flow: catches initial, empty, populated, and error feedback; uses test fixture data and an isolated build, never the daily-driver preview.

Use focused red/green tests at these seams, then the existing unit, acceptance, type, and lint checks. Review the final branch against its pinned starting commit.

## Boundaries

Application changes, tickets, and status updates remain local. Do not publish GitHub issues or a PR. Teamwork is read-only. Preserve existing package changes and unrelated Scratch data. Do not start, stop, or rebuild the user's daily-driver server; any browser server must be isolated and use fixture data.
