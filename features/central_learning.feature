@central-learning
Feature: Learn from service-owned tasks

  @browser @UI-LEARNING-01
  Scenario: Configure and operate a bundle learning loop in the console
    Given a published chat bundle and a real executor
    When I configure learning and import material through the console
    And the imported cards pass admission
    And I try an admitted card and start through the console
    And the service releases an adoption and confirms a held-out regression
    And a production job reports an outcome
    Then I inspect the alert, roll back the live round and stop through the console

  @LEARNING-01
  Scenario: Configure and operate a bundle learning loop through the API
    Given a published chat bundle and a real executor
    When I configure learning and import material through the API
    And the imported cards pass admission
    And I try an admitted card and start through the API
    And the service releases an adoption and confirms a held-out regression
    And a production job reports an outcome
    Then I roll back the live round and stop through the API
