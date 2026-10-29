# 02: Keep session reads inside the configured archive

**What to build:** Session document, complete-transcript, and Raw JSONL reads reject paths that escape the configured archive through linked directories.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

**Source:** Audit finding 2. An isolated archive containing a directory link allowed the Raw JSONL reader to return an outside JSONL file.

- [ ] Every session content endpoint checks the resolved file location against the resolved archive root before reading content.
- [ ] An existing directory link to an outside JSONL file is rejected by document, complete-transcript, and raw-page requests without returning outside content.
- [ ] A configured archive root that is itself a directory link continues to support legitimate files beneath its resolved location.
- [ ] Ordinary in-root plain and compressed sessions remain readable through the existing user-facing paths.
- [ ] Focused temporary-fixture checks cover allowed and rejected paths without changing source sessions.

**Scope:** Reuse the existing approach to resolved-path containment. This finding requires an existing linked directory; it does not imply a session-write capability.
