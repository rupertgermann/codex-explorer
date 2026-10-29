# 05: Show successful empty Query lab results

**What to build:** After a successful query finds no matching records, Query lab shows “No rows returned” instead of the initial “Ready for a query” prompt.

**Blocked by:** None (can start immediately).

**Status:** complete

**Source:** Audit finding 5. The query API derives column names from the first row, so a successful empty result returns no column names and selects the initial UI state.

- [x] The query API returns selected column names and aliases even when the result has zero rows.
- [x] Before the first query, Query lab still shows its initial prompt.
- [x] After a successful zero-row query, Query lab shows the empty-result message and completed duration.
- [x] A later non-empty query renders normally, and a failed query still shows the error state.
- [x] A focused API check uses an empty temporary table, and a browser check exercises the successful empty-result path.

**Scope:** Obtain column metadata independently of returned rows. Keep existing export behavior for non-empty results.

## Evidence

- RED: `node --test tests/query-empty.test.mjs` failed because the empty temporary table returned `columns: []` rather than `["id", "note"]`.
- GREEN: `node --test tests/query-empty.test.mjs tests/query-limit.test.mjs tests/query-readonly.test.mjs` passes all 10 checks. Empty selected names and aliases survive, completed timing and `limited: false` remain present, and duplicate aliases preserve the existing object-row result (`SELECT 1 AS x, 2 AS x` returns one `x` column with value 2).
- The route obtains deduplicated column names from SQLite statement metadata independently of rows. No UI change is needed.
- `npm run build` hits the isolated linked-dependency Turbopack resolution limitation; `npm run build -- --webpack` passes, including TypeScript, against installed Next 16.4.2. Package files remain untouched.
- `npm run test:e2e -- tests/e2e/query-empty.spec.ts` passes against the real API and isolated fixture server on port 3317: initial prompt, successful empty message and duration, subsequent named populated result and CSV action, then visible query failure without stale results.
- Focused ESLint and `git diff --check` pass.
- Final focused browser run: `npm run test:e2e -- tests/e2e/query-empty.spec.ts tests/e2e/product-polish.spec.ts --grep 'Query lab distinguishes|SQL results and drafts'` passes both checks, including existing navigation/draft persistence and failed-run timing behavior.
- Merged the latest integration branch (`2968bd6`) before completion; all 10 query API checks and focused ESLint pass again afterward. The added integration changes concern session metadata and do not change the browser query path built above.
