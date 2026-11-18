@service @proposals @provider_fixture
Feature: Bounded service proposals
  An explicitly authorized provider suggests edits without publishing them.
  Provider responses here are deterministic fixtures, not a quality experiment.

  Background:
    Given a published bundle with instructions and approved reusable memory

  @PROPOSAL-01
  Scenario: A valid proposal creates a reviewable immutable candidate
    When I request a proposal that may edit only "AGENTS.md"
    Then the proposal succeeds with a candidate changing only "AGENTS.md"
    And applications still resolve the original release

  @PROPOSAL-02
  Scenario: Provider edits outside the allowed paths are rejected
    Given the provider fixture tries to edit unselected memory
    When I request a proposal that may edit only "AGENTS.md"
    Then the proposal fails without a candidate
    And the service rejects the returned memory edit as outside the allowed paths
    And applications still resolve the original release

  @PROPOSAL-03
  Scenario: Provider errors do not become pretend improvements
    Given the provider fixture is unavailable
    When I request a proposal that may edit only "AGENTS.md"
    Then the proposal fails without a candidate
    And the service reports a provider request failure
    And applications still resolve the original release

  @PROPOSAL-04
  Scenario: Disabled proposal generation reports failure honestly
    Given proposal generation is not configured
    When I request a proposal that may edit only "AGENTS.md"
    Then the proposal fails without a candidate
    And applications still resolve the original release

  @PROPOSAL-05
  Scenario: A refreshed client can find and inspect its proposal
    When I request a proposal that may edit only "AGENTS.md"
    And the service restarts
    Then the same proposal is discoverable in the scoped proposal list
