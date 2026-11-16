@service @releases
Feature: Deliberate releases
  Publishing changes future resolutions only after a person chooses exact content.

  Background:
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."

  @RELEASE-01
  Scenario: Publish exactly the evaluated draft snapshot
    Given the saved snapshot has complete matching evidence
    When I publish that draft using its evidence
    Then the channel points to the evaluated snapshot
    And release history records the comparison and previous version
    And the draft is closed as published

  @RELEASE-02
  Scenario: Evidence for an older saved snapshot cannot publish newer text
    Given the saved snapshot has complete matching evidence
    And I save another generation containing "Untested edits."
    When I try to publish that newer generation with the older evidence
    Then publication is rejected
    And applications still resolve the original release

  @RELEASE-03
  Scenario: An incomplete comparison cannot justify a measured release
    Given the saved snapshot has incomplete evidence
    When I try to publish that draft using its incomplete evidence
    Then publication is rejected
    And applications still resolve the original release

  @RELEASE-04
  Scenario: A manual publication is labelled as unevaluated
    When I publish the saved draft with reason "Operator reviewed this edit manually."
    Then release history records that manual reason without a comparison
    And the draft is closed as published

  @RELEASE-05
  Scenario: Manual publication requires a reason
    When I try to publish without evidence or a reason
    Then publication is rejected
    And applications still resolve the original release

  @RELEASE-06
  Scenario: Roll back through another recorded channel revision
    Given I published the saved draft manually
    When I roll back to the original version with a reason
    Then future applications resolve the original content at a new revision
    And rollback appears in release history

  @RELEASE-07
  Scenario: History pagination exposes every release once
    Given I published the saved draft manually
    And I roll back to the original version with a reason
    When I browse release history one revision at a time
    Then all 3 release decisions are returned once

  @RELEASE-08
  Scenario: A reader cannot publish content
    When a read-only application tries to publish the draft
    Then access is denied
    And applications still resolve the original release
