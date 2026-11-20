@service @releases
Feature: A bundle is seeded once
  Connected learning decides which changes an app receives after setup.

  Background:
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."

  @RELEASE-01
  Scenario: A complete standalone comparison cannot publish a draft
    Given the saved snapshot has complete matching evidence
    When I submit that evidence to the retired draft publication endpoint
    Then the source release history contains only the original seed

  @RELEASE-02
  Scenario: An operator cannot send edited content straight to the source channel
    When I submit a direct release for the saved snapshot on the original channel
    Then the source release history contains only the original seed

  @RELEASE-03
  Scenario: A second channel name cannot bypass initial setup
    When I try to seed the bundle again under another channel name
    Then the source release history contains only the original seed

  @RELEASE-04
  Scenario: Delivery requires an enrolled connection
    When an application resolves the source without a connection
    Then the source release history contains only the original seed
