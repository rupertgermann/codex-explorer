# 04: Accept valid read-only queries in Query lab

**What to build:** Query lab accepts harmless quoted text, comments, and read-only functions while continuing to reject write statements and multiple executable statements.

**Blocked by:** None (can start immediately).

**Status:** complete

**Source:** Audit finding 4. Quoted text containing a write keyword, a quoted semicolon, and the built-in text replacement function are rejected by text-wide validation.

- [x] Queries selecting quoted write-keyword text, quoted semicolons, and built-in text replacement results succeed through the real query API.
- [x] Write-keyword text and punctuation inside SQL comments or quoted identifiers do not cause false rejection.
- [x] The supported SELECT, WITH, and EXPLAIN QUERY PLAN forms remain available.
- [x] Actual write operations, schema changes, attachment operations, and multiple executable statements remain rejected; fixture data and schema remain unchanged.
- [x] SQLite connections remain read-only, independently of request validation.
- [x] Focused real-API checks cover accepted queries and rejected mutation attempts against temporary data.

**Scope:** Use the smallest statement-aware validation that preserves the existing contract. Avoid a new parser framework unless required to satisfy these cases.

## Validation evidence

- RED: `node --test tests/query-readonly.test.mjs` failed through the real POST route because `SELECT 'update' AS value` returned HTTP 400 instead of 200.
- GREEN: quoted tokens and comments are kept separate from executable keywords and semicolons; the quoted-keyword test passed.
- RED: a second slice failed through the route for SQLite `replace(...)`, returning HTTP 400.
- GREEN: allow `replace` when followed by the function-call parenthesis; the function query returns the expected replacement result.
- Final: `node --test tests/query-readonly.test.mjs` passes all 5 tests against a temporary SQLite fixture. Coverage includes quoted semicolons, escaped quotes, quoted identifiers, comments, WITH, EXPLAIN QUERY PLAN, 18 rejected statement forms (including WITH UPDATE/DELETE RETURNING and EXPLAIN QUERY PLAN DELETE), and unchanged fixture data/schema.
- Independent defense: a connection opened by `openReadonly` rejects a direct UPDATE without passing through request validation.
- `npm run typecheck` and `npx eslint lib/database.ts tests/query-readonly.test.mjs` pass.
