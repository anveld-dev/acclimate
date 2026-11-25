@service @releases
Feature: Deliberate releases
  Publishing changes future resolutions only after a person chooses exact content.

  Background:
    Given a published bundle containing "Review code."
    And I have uploaded a version containing "Review retries."

  @RELEASE-05
  Scenario: A release requires a reason
    When I try to release without a reason
    Then publication is rejected
    And applications still resolve the original release

  @RELEASE-06
  Scenario: Roll back through another recorded channel revision
    Given I released the uploaded version
    When I roll back to the original version with a reason
    Then future applications resolve the original content at a new revision
    And rollback appears in release history

  @RELEASE-07
  Scenario: History pagination exposes every release once
    Given I released the uploaded version
    And I roll back to the original version with a reason
    When I browse release history one revision at a time
    Then all 3 release decisions are returned once

  @RELEASE-08
  Scenario: A reader cannot publish content
    When a read-only application tries to release the uploaded version
    Then access is denied
    And applications still resolve the original release
