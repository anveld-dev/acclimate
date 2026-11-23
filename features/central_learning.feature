@central-learning
Feature: Learn from service-owned tasks

  @browser @UI-LEARNING-01
  Scenario: Configure and operate a bundle learning loop in the console
    Given a published chat bundle and a fixture executor
    When I connect two models and enroll the bundle through the console
    And I import a reference task and try it through the console
    And the executor records admission results for both splits
    And I start the admitted loop through the console
    And the executor records a release, usage and a production outcome
    Then I can inspect the release and roll it back through the console

  @LEARNING-01
  Scenario: Configure and operate a bundle learning loop through the API
    Given a published chat bundle and a fixture executor
    When I configure learning and import a reference task through the API
    And the executor records admission results for both splits
    And I try the task and start the admitted loop through the API
    And the executor records a release, usage and a production outcome
    Then the API exposes the tasks, round and usage and rolls back the release
