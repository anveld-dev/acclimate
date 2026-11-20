@sdk @service @delivery
Feature: Application SDK delivery
  Applications get verified, pinned files. Cache and reporting policy stay explicit.

  Background:
    Given a published bundle containing "Review code."
    And the application enrolls this bundle for automatic delivery

  @SDK-01
  Scenario: Resolve and prepare real files from a verified release
    When an application resolves and prepares the stable release
    Then its prepared instruction file contains "Review code."
    And its selected version and digest match the original release

  @SDK-02
  Scenario: A fresh job cannot select a version by ID
    When a fresh job requests the original version by ID
    Then the job rejects the pinned version

  @SDK-03
  Scenario: An unavailable service does not silently enable offline delivery
    Given an application resolved and prepared the stable release
    When the service becomes unavailable
    And the application requests delivery without offline permission
    Then delivery fails rather than returning cached content

  @SDK-04
  Scenario: A legacy offline option cannot bypass the connection
    Given an application resolved and prepared the stable release
    When the service becomes unavailable
    And the application permits bounded offline delivery
    Then delivery fails rather than returning cached content

  @SDK-05
  Scenario: Another SDK identity cannot reuse the first identity's offline mapping
    Given an application resolved and prepared the stable release
    When the service becomes unavailable
    And another SDK identity requests bounded offline delivery
    Then no cached mapping is disclosed

  @SDK-06
  Scenario: Known revocation is not treated as an offline outage
    Given I issued a content-read credential
    And that integration cached the published release
    When the service becomes unavailable
    And that integration requests bounded offline delivery
    Then delivery fails rather than returning cached content
    When the service restarts
    And I revoke that credential
    And that integration requests bounded offline delivery
    Then delivery is denied despite the cached files

  @SDK-07
  Scenario: Job-local edits do not contaminate the immutable cache
    When an application edits its prepared instruction file
    And it prepares the same release for another job
    Then the second job receives "Review code."

  @SDK-08
  Scenario: Preparation cannot overwrite an application's existing file
    When an application prepares into a folder with its own instructions
    Then preparation is rejected and the existing instructions stay unchanged

  @SDK-09
  Scenario: Cleanup removes prepared files but keeps application-owned files
    When the application cleans up a prepared workspace containing its own note
    Then prepared files are removed and the note remains

  @SDK-10
  Scenario Outline: Native plugins stage the supported resources without a model call
    Given the bundle contains an instruction and a packaged skill
    And the application enrolls this bundle for automatic delivery
    When the application prepares it for <plugin>
    Then the native instruction is named "<instruction>" and the skill is present
    Examples:
      | plugin | instruction |
      | codex  | AGENTS.md   |
      | claude | CLAUDE.md   |
      | pi     | AGENTS.md   |
      | cursor | AGENTS.md   |

  @SDK-11
  Scenario Outline: Cursor memory staging requires explicit path approval
    Given the bundle also contains reusable memory
    And the application enrolls this bundle for automatic delivery
    When Cursor preparation has <approval> memory approval
    Then exactly <count> memory resources are staged
    Examples:
      | approval | count |
      | no       | 0     |
      | explicit | 1     |

  @SDK-12
  Scenario: A temporary reporting outage preserves the original prepared receipt
    Given I issued both credential kinds
    When the application prepares content during a reporting outage and recovers within the retry window
    Then the prepared file is usable while the service has no receipt for it
    And recovery records the original prepared event exactly once

  @SDK-13
  Scenario: Reporter stages reflect explicit application actions
    Given I issued both credential kinds
    When the application reports resolution, verification, preparation and its own start
    Then exactly those observed stages are recorded for the selected version

  @SDK-14
  Scenario: Expired queued observations are dropped instead of reminted
    Given I issued both credential kinds
    When the application prepares content during a reporting outage and recovers after the retry window
    Then the prepared file is usable while the service has no receipt for it
    And recovery drops every expired event without sending another request

  @SDK-15
  Scenario: A mutating failed grader does not change the next grading attempt
    Given I have saved a draft containing "Review retries."
    When the SDK retries a grader that changes its input before failing
    Then execution happened once per version and both retries saw the original output

  @SDK-16
  Scenario: Asynchronous caller changes cannot relabel executed versions
    Given I have saved a draft containing "Review retries."
    When the caller changes version and runtime labels during comparison
    Then the SDK report still names the versions and settings it executed
