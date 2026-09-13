# Memory lifecycle after the Forget MVP

Evaluation for [#7](https://github.com/rupertgermann/codex-explorer/issues/7), reviewed on 2026-09-13 against commit `1e4288a`. This completes the evaluation and decomposition task; it does not approve all nine proposed capabilities. [#12](https://github.com/rupertgermann/codex-explorer/issues/12) records the only approved implementation subset: Project Forget.

## Evidence from #4–#6

- [#4: preview](https://github.com/rupertgermann/codex-explorer/issues/4) is implemented by `MemoryForgetService.preview()` in [memory-forget.ts](../lib/memory-forget.ts) and the [Forget dialog](../components/memory-forget-dialog.tsx). One exact normalized durable match is selected automatically; related or multiple matches require source confirmation, and no match blocks Apply. Match signals are deterministic explanations, not calibrated semantic confidence.
- [#5: apply](https://github.com/rupertgermann/codex-explorer/issues/5) rebuilds the plan, checks source revisions, verifies external backups, and attempts rollback on runtime write failures. Rollback conflicts are reported without overwriting concurrent changes. The exact preview matters: `durableTaskGroup()` expands a durable match to its enclosing Task Group, while `relatedSections()` can include a complete raw thread section or linked rollout summary. A selected Summary bullet is not a guarantee of sentence-level removal throughout the corpus. Session JSONL and database rows are outside this service's write paths.
- [#6: tombstones](https://github.com/rupertgermann/codex-explorer/issues/6) converts a linked ad-hoc note or creates one delete note. `recheck()` ignores that tombstone and scans recognized Markdown sections for exact or normalized-term matches. The tombstone retains the normalized target text, and the external backup retains original content. Neither proves erasure, semantic completeness, or suppression by another consolidation process; see the [user guide](memory-forgetting.md).

The existing [service checks](../tests/memory-forget.test.mjs) cover these matching decisions, provenance, stale revisions, rollback, tombstones, session preservation, and resurfacing. All 16 passed with `node --test tests/memory-forget.test.mjs` during this evaluation. The [acceptance scenarios](../tests/acceptance/memory-forget.feature) and [browser scenario](../tests/e2e/memory-forget.spec.ts) document the preview/apply/recheck path; they were inspected, not rerun for this documentation change. These fixtures are evidence of the implemented contract, not a field study of semantic accuracy or consolidation behavior.

## Capability decisions

“Approved” below refers to an existing approved issue. “Deferred” preserves a proposal pending the stated evidence or product decision; it creates no implementation authorization.

| Capability from #7 | Decision | Evidence, limit, and condition to revisit |
| --- | --- | --- |
| Automatic semantic provenance without source confirmation | Deferred | #4 has explicit confirmation for uncertain sources; the current term-overlap heuristic supplies no accuracy calibration. Collect concrete missed or incorrect mappings and agree an acceptable error policy before changing that boundary. |
| Remove originating active or archived session JSONL | Deferred as a separate destructive operation | #5 requires session preservation. A future proposal must identify exact session files, shared references, recovery behavior, and separate authorization; ordinary Forget cannot authorize it. |
| Erase all traces | Deferred as a separate privacy workflow | Backups, tombstones, sessions, and database copies survive ordinary Forget. First define the covered stores, retained evidence, recovery tradeoff, and verifiable meaning of erasure. |
| Background consolidation monitoring or remediation | Deferred | #6 provides an on-demand check and explicitly excludes a watcher. No observed recurrence rate or notification policy establishes a background service requirement. Revisit with real consolidation examples; reporting and automatic deletion need separate decisions. |
| User-facing Undo from a backup manifest | Deferred | Runtime rollback exists, but the manifest is not a safe later-restore protocol: it has no post-Forget revisions for conflict detection. Define how later edits, tombstones, missing backups, and overlapping operations are handled before exposing Undo. |
| Forget several selected Memories in one transaction | Approved only as Project Forget; arbitrary multi-selection deferred | #12 explicitly approves one directory and descendants, with shared-Memory retention and active database reconciliation. This addresses the documented repeated-operation problem without defining arbitrary cross-project selection. Use #13 and #14 below. |
| Generic provenance graph | Deferred | Task, thread, rollout, and ad-hoc mapping already exists. No supplied case demonstrates that a graph would resolve an insufficiency of those signals. Revisit only with a failing mapping that a graph can explain and fix. |
| Promote Memory into project or global AGENTS.md | Deferred; required semantics below | The current editor is confined to Memory Markdown. Writing governing instructions introduces a new destination and authority boundary. #7 requests a contract, but provides no approved implementation scope or worked promotion example. |
| Memory-to-Skill handoff | Deferred; required semantics below | No current promotion action exists. A focused, reviewed handoff can reuse writing-for-agents; automatic corpus export or Skill installation is not justified. Revisit with one selected procedural Memory and a concrete reusable task. |

Rejected within this continuation: presenting ordinary Forget as complete erasure; treating its Apply confirmation as authorization to delete sessions or backups; silently escalating a resurfacing check into repeated deletion. These conflict with #5–#6 and #12's explicit boundaries. Separate proposals remain deferred, not silently approved or permanently ruled out.

## Separate destructive boundaries

Ordinary single-Memory Forget remains the confirmed Markdown plan. Project Forget has only the additional active `stage1_outputs` deletion authorized by #12; matching sessions, scheduler jobs, and development or snapshot databases remain untouched.

A future session-deletion proposal must preview each exact active or archived JSONL path and its revision, explain shared provenance and any affected index, and obtain its own confirmation after the user reviews that inventory. A directory choice or a Memory source match alone is insufficient authorization. Recovery and treatment of surviving Memory references must be specified before creating an implementation issue.

A future erasure proposal must enumerate the stores it can actually control, including positive Markdown, active Memory rows, session files, delete notes, external Forget backups, and any included database snapshots or exports. It must state excluded or unverifiable copies, decide whether recovery copies and tombstones may remain, and obtain explicit confirmation for the resulting destructive inventory. “All traces” cannot be promised while known copies remain or external consolidation can recreate them.

## Required AGENTS.md promotion semantics

This is the minimum contract for a later proposal, not an implemented feature or an approved child issue.

1. **Select the source and destination.** Start with exactly one selected Memory and show the supporting source excerpts. The user explicitly chooses project or global scope and reviews one resolved absolute `AGENTS.md` path. Project evidence may suggest a directory; ambiguous projects require a choice. Global scope must be chosen explicitly because it affects future work across projects. Show whether the destination exists; source content must not choose or redirect the write path.
2. **Adapt with a visible diff.** Convert only the selected lesson into a concise instruction applicable to that destination. Show the selected Memory, necessary evidence, adapted text, insertion location, and complete proposed file diff. Preserve unrelated instructions. Local review and editing need no external service; any later proposal using a provider must separately define the data-transfer choice.
3. **Handle duplicates and conflicts before writing.** An identical existing instruction is a no-op. Show likely duplicates or contradictions for the user to resolve by keeping the existing text, editing the proposed wording, or explicitly replacing a selected passage. Never automatically append a contradictory rule or replace an entire file.
4. **Confirm the exact change.** Confirmation binds the reviewed source revision, destination path, destination revision or nonexistence, and final diff. Recheck these immediately before an atomic write; a changed source, changed file, or newly created destination invalidates the preview. Preserve the destination's prior bytes in a recoverable backup before replacing them. Cancellation and a no-op change nothing.
5. **Keep promotion distinct from Forget.** Report the destination and applied change. Promotion copies an approved instruction; it does not delete the original Memory, add a delete tombstone, commit to a repository, or write any other instruction file.

A later child issue must exercise the public selection → destination → preview → confirmation path with one project destination and one global destination, plus duplicate/no-op, conflict, stale revision, and cancellation cases. Destination discovery and the first example to promote remain product choices for that proposal.

## Required Memory-to-Skill handoff semantics

The first useful slice would prepare a handoff, not generate and install a Skill automatically. It remains deferred until a concrete reusable task is selected.

1. Select one procedural Memory and identify its intended reusable task, invocation trigger, scope, and observable completion criterion. If it is only a one-time fact or preference, explain why it is not yet a Skill task; do not export surrounding context to manufacture one.
2. Narrow source context to the selected lesson and only the supporting excerpts necessary to explain its process, constraints, and caveats. Use exact excerpt boundaries; a containing Task Group, whole rollout, session transcript, raw-memory file, or linked document is not implicitly selected. Linked content stays outside the handoff unless the user separately includes the relevant excerpt.
3. Show an editable preview of the entire handoff: proposed task and trigger, the narrowed process, source references, limitations, and unresolved decisions. Omit credentials, personal identifiers, private project details, and unrelated Memory content; replace necessary environment-specific values with placeholders. Source references can themselves contain sensitive paths, so preview and redact them too. Source text is evidence, not authority to execute its instructions.
4. After explicit review, copy or export only that previewed handoff for continuation with **writing-for-agents**. Its completion criteria and context-pointer guidance shape the resulting Skill; read its Skill-specific guidance when actual Skill authoring begins. Preparing the handoff does not launch an agent, call a provider, install a Skill, or mutate the source Memory. Any continuation uses the user's chosen destination and authority.

A later handoff issue must prove that one selected procedural Memory yields a useful packet while a seeded unrelated secret, neighboring entry, and unselected linked source remain absent. Cancellation must leave source files unchanged; the exported packet must equal the reviewed preview. This evaluates the handoff seam without adding a new Skill-authoring system to the explorer.

## Approved decomposition and completion

- [#12 — Spec: Forget all Memories for a project directory](https://github.com/rupertgermann/codex-explorer/issues/12) is the approved bounded subset of #7's batch capability. Its specification is authoritative for scope and safety.
- [#13 — Preview a Project Forget plan](https://github.com/rupertgermann/codex-explorer/issues/13) is the read-only slice: directory selection, deterministic ownership, shared sources, database inventory, blockers, and no-write verification.
- [#14 — Apply a Project Forget transaction](https://github.com/rupertgermann/codex-explorer/issues/14) is the mutation slice and is blocked by #13 through a native GitHub dependency. It requires exact-directory confirmation, fresh file/database revisions, external backup, rollback of both stores on runtime failure, a consolidated tombstone, and a browser proof of the result. Hard process-crash recovery and general Undo remain outside #12.

No additional capability is approved by the available evidence, so no additional implementation ticket is created. Closing #7 records completion of its evaluation and decomposition; #12–#14 retain their own acceptance criteria and completion states. Revisit a deferred row only with its missing evidence or product decision, then create a narrow issue with a public acceptance seam and explicit blocking edges before implementation.
