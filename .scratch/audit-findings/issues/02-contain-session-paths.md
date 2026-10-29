# 02: Keep session reads inside the configured archive

**What to build:** Session document, complete-transcript, and Raw JSONL reads reject paths that escape the configured archive through linked directories.

**Blocked by:** None (can start immediately).

**Status:** complete

**Source:** Audit finding 2. An isolated archive containing a directory link allowed the Raw JSONL reader to return an outside JSONL file.

- [x] Every session content endpoint checks the resolved file location against the resolved archive root before reading content.
- [x] An existing directory link to an outside JSONL file is rejected by document, complete-transcript, and raw-page requests without returning outside content.
- [x] A configured archive root that is itself a directory link continues to support legitimate files beneath its resolved location.
- [x] Ordinary in-root plain and compressed sessions remain readable through the existing user-facing paths.
- [x] Focused temporary-fixture checks cover allowed and rejected paths without changing source sessions.

**Scope:** Reuse the existing approach to resolved-path containment. This finding requires an existing linked directory; it does not imply a session-write capability.

## Evidence

- RED: `node --test tests/session-path-api.test.mjs` failed for all three real content routes: an existing ancestor directory link to `archive-outside` returned HTTP 200 instead of 404.
- GREEN: `node --test tests/session-path-api.test.mjs tests/session-repository.test.mjs` passed all 33 checks. The temporary archives cover sibling-prefix escape rejection, ordinary and linked archive roots, plain and compressed files, complete streamed transcripts, and preserved relative session paths.
- `npx eslint lib/sessions.ts tests/session-path-api.test.mjs` and `npm run typecheck` passed.
- Containment compares canonical root/file locations before reading, while retaining the logical session path for existing readers. Concurrent filesystem mutation during a read is outside this ticket's agreed seam.
