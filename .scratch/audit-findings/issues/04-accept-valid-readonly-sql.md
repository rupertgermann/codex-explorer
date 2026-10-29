# 04: Accept valid read-only queries in Query lab

**What to build:** Query lab accepts harmless quoted text, comments, and read-only functions while continuing to reject write statements and multiple executable statements.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Source:** Audit finding 4. Quoted text containing a write keyword, a quoted semicolon, and the built-in text replacement function are rejected by text-wide validation.

- [ ] Queries selecting quoted write-keyword text, quoted semicolons, and built-in text replacement results succeed through the real query API.
- [ ] Write-keyword text and punctuation inside SQL comments or quoted identifiers do not cause false rejection.
- [ ] The supported SELECT, WITH, and EXPLAIN QUERY PLAN forms remain available.
- [ ] Actual write operations, schema changes, attachment operations, and multiple executable statements remain rejected; fixture data and schema remain unchanged.
- [ ] SQLite connections remain read-only, independently of request validation.
- [ ] Focused real-API checks cover accepted queries and rejected mutation attempts against temporary data.

**Scope:** Use the smallest statement-aware validation that preserves the existing contract. Avoid a new parser framework unless required to satisfy these cases.
