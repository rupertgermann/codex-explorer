# 03: Preserve newer subagent parent links in the session tree

**What to build:** Session archive groups a subagent beneath its parent when the parent relationship is stored inside thread-spawn source metadata.

**Blocked by:** None (can start immediately).

**Status:** complete

**Source:** Audit finding 3. A fixture with a parent and a child using nested thread-spawn metadata produced two tree roots, even though the child was classified as a Codex subtask.

- [x] The catalog reads the parent relationship from nested thread-spawn source metadata when the existing top-level parent field is absent or empty.
- [x] An explicit top-level parent remains authoritative when both forms are present.
- [x] A catalog-to-tree fixture with a parent and nested-metadata child produces one root with the child beneath it.
- [x] The same relationship is preserved for plain and compressed session files.
- [x] Existing root sessions, legacy parent metadata, and genuinely missing parents retain their current behavior.

**Scope:** Follow the metadata interpretation already used by usage reports. No new tree abstraction or session format is needed.

## Implementation and verification

Session summary metadata uses the same nested thread-spawn fallback as usage reports. A non-empty top-level `parent_thread_id` keeps precedence.

- RED: `node --test tests/session-parent-metadata.test.mjs` failed all four absent/empty top-level parent cases across plain JSONL and compressed JSONL.ZST fixtures: the catalog-to-tree seam returned two roots instead of one.
- GREEN: the same four cases passed after the metadata-only fix. Two compatibility cases additionally exercise explicit top-level precedence, legacy links, ordinary roots, absent parent metadata, and unavailable-parent orphans for both file formats.
- `node --test tests/session-parent-metadata.test.mjs tests/session-repository.test.mjs tests/session-tree.test.mjs`: 28 passed.
- `npm run typecheck`: passed.
- `npx eslint lib/sessions.ts tests/session-parent-metadata.test.mjs`: passed.

Only temporary archive fixtures were used. No servers or external records were changed.
