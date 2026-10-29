# 03: Preserve newer subagent parent links in the session tree

**What to build:** Session archive groups a subagent beneath its parent when the parent relationship is stored inside thread-spawn source metadata.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Source:** Audit finding 3. A fixture with a parent and a child using nested thread-spawn metadata produced two tree roots, even though the child was classified as a Codex subtask.

- [ ] The catalog reads the parent relationship from nested thread-spawn source metadata when the existing top-level parent field is absent or empty.
- [ ] An explicit top-level parent remains authoritative when both forms are present.
- [ ] A catalog-to-tree fixture with a parent and nested-metadata child produces one root with the child beneath it.
- [ ] The same relationship is preserved for plain and compressed session files.
- [ ] Existing root sessions, legacy parent metadata, and genuinely missing parents retain their current behavior.

**Scope:** Follow the metadata interpretation already used by usage reports. No new tree abstraction or session format is needed.
