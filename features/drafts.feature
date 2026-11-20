@service @drafts
Feature: Durable drafts
  Saved work stays available without changing the release used by applications.

  Background:
    Given a published bundle containing "Review code."

  @DRAFT-01
  Scenario: Reopen saved work after a service restart
    When I save a draft containing "Review retries."
    And the service restarts
    Then I can reopen the same saved snapshot containing "Review retries."
    And the source still contains only the original release

  @DRAFT-02
  Scenario: Keep both saved generations as immutable history
    Given I have saved a draft containing "Review retries."
    When I save another generation containing "Review duplicate retries."
    Then draft history contains both snapshots with their original text
    And the source still contains only the original release

  @DRAFT-03
  Scenario: A stale tab cannot overwrite a newer save
    Given I have saved a draft containing "Review retries."
    And I save another generation containing "Review duplicate retries."
    When an older tab tries to save "Outdated edits."
    Then the save is rejected with a conflict
    And the draft still contains "Review duplicate retries."

  @DRAFT-04
  Scenario: Retry a confirmed save without creating another generation
    Given I have saved a draft containing "Review retries."
    When I save another generation containing "Review duplicate retries."
    And I retry the identical save with its original operation ID
    Then I get the same saved snapshot
    And draft history contains exactly 2 snapshots

  @DRAFT-05 @fault_injection
  Scenario: Recover an unconfirmed save after restart and response-cache expiry
    Given I have saved a draft containing "Review retries."
    When the response to saving "Review duplicate retries." is lost
    And the short-lived response cache expires
    And the service restarts
    Then the original operation ID recovers the saved snapshot containing "Review duplicate retries."
    When I retry the identical save with its original operation ID
    Then draft history contains exactly 2 snapshots

  @DRAFT-06
  Scenario: Reusing an operation ID with changed text is rejected
    Given I have saved a draft containing "Review retries."
    And I save another generation containing "Review duplicate retries."
    When I reuse that save operation ID for "Different content."
    Then the save is rejected with a conflict
    And the draft still contains "Review duplicate retries."

  @DRAFT-07
  Scenario: Another writer cannot recover my operation
    Given I have saved a draft containing "Review retries."
    When another writer looks up my save operation
    Then no committed result is disclosed

  @DRAFT-08
  Scenario: A discarded draft stays closed after restart
    Given I have saved a draft containing "Review retries."
    When I discard the saved draft
    And the service restarts
    Then the draft is listed as discarded
    When I try to publish the discarded draft
    Then publication is rejected
    And the source still contains only the original release

  @DRAFT-09
  Scenario Outline: Invalid edits cannot partially replace a saved snapshot
    Given I have saved a draft containing "Review retries."
    When I try to save <invalid> content
    Then the content is rejected
    And the draft still contains "Review retries."
    And draft history contains exactly 1 snapshots
    Examples:
      | invalid             |
      | path traversal      |
      | colliding paths     |
      | unsupported schema  |
      | no entries          |
      | an oversized entry  |

  @DRAFT-10
  Scenario: Browse all saved drafts through pagination
    Given I have saved 3 independent drafts
    When I browse saved drafts one page at a time
    Then all 3 drafts are returned once

  @DRAFT-11
  Scenario: A saved draft stays open after a manual publication attempt
    Given I have saved a draft containing "Review retries."
    When I try to publish the saved draft manually
    Then publication is rejected
    And the saved draft remains available
