# Issue tracker: GitHub

Specs, implementation tickets, blocking dependencies, and tracked status live in GitHub Issues for rupertgermann/codex-explorer. Use the gh CLI. Scratch can hold working notes; existing local plans and tickets stay in place unless migration is requested.

## Destination and access

Before the first issue write in a session, verify the target with gh repo view --json nameWithOwner. Use rupertgermann/codex-explorer explicitly if gh resolves another repository.

Teamwork URLs are read-only source references. Read relevant tickets and comments; record resulting specs and tickets in this repository's GitHub Issues. Teamwork records, including comments, labels, assignments, and time entries, remain read-only through every tool and access path.

## Issue operations

- Create one issue per spec or implementation ticket. Use gh issue create --repo rupertgermann/codex-explorer --title TITLE --body-file FILE for multiline bodies.
- Read the full body, labels, and comments with gh issue view NUMBER --repo rupertgermann/codex-explorer --json number,title,body,labels,comments.
- List issues with gh issue list --repo rupertgermann/codex-explorer --state open --json number,title,body,labels,assignees.
- Comment with gh issue comment NUMBER --repo rupertgermann/codex-explorer --body-file FILE.
- Apply or remove configured labels with gh issue edit NUMBER --add-label LABEL or --remove-label LABEL.
- Post the resolution explanation before closing an issue. Use gh issue close NUMBER after the comment; gh issue close --comment can silently omit the comment when the issue is already closed.

## Parent tickets and blockers

Use GitHub native sub-issues for parent-child relationships and native issue dependencies for blockers. Use numeric database IDs returned by gh api repos/rupertgermann/codex-explorer/issues/NUMBER --jq .id, rather than issue numbers or GraphQL node IDs, for REST relationship operations.

- Attach a child: gh api --method POST repos/rupertgermann/codex-explorer/issues/PARENT/sub_issues -F sub_issue_id=CHILD_DATABASE_ID.
- Add a blocker: gh api --method POST repos/rupertgermann/codex-explorer/issues/CHILD/dependencies/blocked_by -F issue_id=BLOCKER_DATABASE_ID.
- Count open blockers: gh api repos/rupertgermann/codex-explorer/issues/NUMBER --jq .issue_dependencies_summary.blocked_by.

Where native relationships are unavailable, record Part of #PARENT and Blocked by: #BLOCKER references in ticket bodies. Only open blockers gate a ticket.

## Pull requests as a request surface

PRs as a request surface: no.

## Skill operations

- Publish to the issue tracker: create or update the appropriate GitHub issue.
- Fetch the relevant ticket: read its full body and relevant comments.
- Wayfinding map: one parent issue with child issues for tickets. Keep Notes, Decisions-so-far, and Fog in the parent body.
- Frontier: select an open, unassigned child whose blockers are all closed, following parent ticket order.
- Claim: assign the ticket to the current user before implementation, using gh issue edit NUMBER --add-assignee @me.
- Resolve: post the answer or implementation result, close the ticket, and update the parent's context pointer. Keep the parent's remaining work and recorded decisions intact.
