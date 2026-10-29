# 05: Show successful empty Query lab results

**What to build:** After a successful query finds no matching records, Query lab shows “No rows returned” instead of the initial “Ready for a query” prompt.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Source:** Audit finding 5. The query API derives column names from the first row, so a successful empty result returns no column names and selects the initial UI state.

- [ ] The query API returns selected column names and aliases even when the result has zero rows.
- [ ] Before the first query, Query lab still shows its initial prompt.
- [ ] After a successful zero-row query, Query lab shows the empty-result message and completed duration.
- [ ] A later non-empty query renders normally, and a failed query still shows the error state.
- [ ] A focused API check uses an empty temporary table, and a browser check exercises the successful empty-result path.

**Scope:** Obtain column metadata independently of returned rows. Keep existing export behavior for non-empty results.
