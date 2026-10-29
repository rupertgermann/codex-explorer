# 01: Bound Query lab result collection

**What to build:** Query lab returns at most 500 rows without first collecting the complete result. A large result must not consume memory proportional to all matching rows.

**Blocked by:** None (can start immediately).

**Status:** complete

**Source:** Audit finding 1. The query handler currently collects all results before retaining 500. An isolated request with an error at row 501 proved that it evaluates beyond the displayed limit.

- [x] Query results contain at most 500 rows, with only bounded lookahead if needed to determine whether results were limited.
- [x] A fixture with substantially more than 500 rows proves collection stops at the cap plus any documented lookahead; a later evaluation failure does not fail the returned page.
- [x] The limited indicator distinguishes truncated results from a complete result containing exactly 500 rows.
- [x] Query errors still appear in Query lab, and database connections close on both success and failure.
- [x] A focused check exercises the real query API with a temporary database and verifies that the database remains unchanged.

**Scope:** Bound result collection. A timeout for expensive sorting, aggregation, or other query execution is a separate concern; do not claim this change bounds execution time.

## Evidence

- RED: `node --test tests/query-limit.test.mjs` failed at the real query route: a 10,000-row fixture with integer overflow at row 502 returned HTTP 400 instead of 200.
- GREEN: the same check passes, returning precisely rows 1–500 with `limited: true`; collection consumes one lookahead row and never evaluates row 502.
- Boundary checks cover 499, exactly 500, and 501 matching rows (`limited: false`, `false`, `true`). Preparation errors and an evaluation error at lookahead row 501 remain HTTP 400 responses with error text; a subsequent count query succeeds.
- Each scenario checks the temporary SQLite file remains byte-for-byte unchanged. The route retains its `db.close()` in `finally` for success, prepare errors, and iteration errors; breaking the iterator releases its statement before that close.
- Passed: focused suite (3 tests), `npm run typecheck`, and `npx eslint app/api/query/route.ts tests/query-limit.test.mjs`.
- This bounds result collection, not SQLite sorting, aggregation, execution time, or individual row size. Empty-result columns remain outside this ticket's scope.
