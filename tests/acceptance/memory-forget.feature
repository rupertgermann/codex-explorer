Feature: Control generated Codex Memories
  The explorer must make a deletion reviewable, recoverable, and resistant to regeneration.

  Scenario: Preview an exact Memory without changing the corpus
    Given a disposable Memory corpus with one exact durable source
    When I preview the first summary Memory
    Then the Forget plan is actionable
    And the preview has not changed any corpus byte

  Scenario: Require confirmation for repeated durable Memories
    Given a disposable Memory corpus with repeated durable sources
    When I preview the first summary Memory
    Then the Forget plan requires a durable source confirmation
    When I confirm one exact durable source
    Then the Forget plan is actionable

  Scenario: Apply a recoverable Forget plan without touching sessions
    Given a disposable Memory corpus with one exact durable source
    When I preview the first summary Memory
    And I apply the Forget plan
    Then only the selected Memory is absent
    And an external backup manifest exists
    And the session archive is byte-identical
    And exactly one delete tombstone exists
    And post-apply verification reports suppression

  Scenario: Detect a Memory that resurfaces after deletion
    Given a disposable Memory corpus with one exact durable source
    When I preview the first summary Memory
    And I apply the Forget plan
    And the positive Memory resurfaces in a later rollout
    Then the manual recheck reports the later rollout

  Scenario: Preview one project without changing any source
    Given a disposable Memory corpus with project-scoped sources
    When I preview Memory for "/work/alpha"
    Then the Project Forget plan is actionable
    And the preview lists only the project sources and retains shared Memory
    And the project preview has not changed the corpus, Memory database, or sessions

  Scenario Outline: Reject unsafe Project Forget targets
    Given a disposable Memory corpus with project-scoped sources
    When I preview Memory for "<directory>"
    Then the Project Forget plan is blocked by "<reason>"

    Examples:
      | directory     | reason                                           |
      | work/alpha    | Enter an absolute project directory.             |
      | /work         | cannot target every project-scoped Task Group.   |
      | /work/missing | No project-scoped Memory was found.               |

  Scenario: Block unresolved project provenance
    Given a disposable Memory corpus with project-scoped sources
    And one referenced project source is missing
    When I preview Memory for "/work/alpha"
    Then the Project Forget plan is blocked by "Referenced Memory source is missing"

  Scenario: Block one unresolved project rollout among resolved provenance
    Given a disposable Memory corpus with project-scoped sources
    And one project rollout has no thread provenance
    When I preview Memory for "/work/alpha"
    Then the Project Forget plan is blocked by "Project rollout provenance has no matching thread"
