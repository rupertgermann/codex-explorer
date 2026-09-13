Feature: Control generated Codex Memories
  The explorer must make a deletion reviewable, recoverable, and resistant to regeneration.

  Scenario: Preview an exact Memory without changing the corpus
    Given a disposable Memory corpus with one exact durable source
    When I preview the first summary Memory
    Then the Forget plan is actionable
    And the preview has not changed any corpus byte

  Scenario: Preview a project through the Forget API without changing any local store
    Given a disposable project corpus with an active Memory database and session metadata
    When I preview and refresh the project through the Forget API
    Then the project preview lists its exact sources and database rows and retains shared Memory
    And all Memory, database, session and scheduler files are unchanged

  Scenario: Require confirmation for repeated durable Memories
    Given a disposable Memory corpus with repeated durable sources
    When I preview the first summary Memory
    Then the Forget plan requires a durable source confirmation
    When I confirm one exact durable source
    Then the Forget plan is actionable

  Scenario: Apply a project through the Forget API and reconcile both stores
    Given a disposable project corpus with an active Memory database and session metadata
    When I preview and refresh the project through the Forget API
    And I confirm the exact project directory and apply the plan through the Forget API
    Then targeted project Memory is absent from both stores and shared Memory remains
    And the project result reports its verified external backup and removed row count

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
