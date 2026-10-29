# 01: Bound Query lab result collection

**What to build:** Query lab returns at most 500 rows without first collecting the complete result. A large result must not consume memory proportional to all matching rows.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Source:** Audit finding 1. The query handler currently collects all results before retaining 500. An isolated request with an error at row 501 proved that it evaluates beyond the displayed limit.

- [ ] Query results contain at most 500 rows, with only bounded lookahead if needed to determine whether results were limited.
- [ ] A fixture with substantially more than 500 rows proves collection stops at the cap plus any documented lookahead; a later evaluation failure does not fail the returned page.
- [ ] The limited indicator distinguishes truncated results from a complete result containing exactly 500 rows.
- [ ] Query errors still appear in Query lab, and database connections close on both success and failure.
- [ ] A focused check exercises the real query API with a temporary database and verifies that the database remains unchanged.

**Scope:** Bound result collection. A timeout for expensive sorting, aggregation, or other query execution is a separate concern; do not claim this change bounds execution time.
