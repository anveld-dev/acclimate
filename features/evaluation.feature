@service @evaluation
Feature: App-owned evaluation
  A request describes one fixed comparison. Only its evaluator can finish it.

  Background:
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."

  @EVAL-01
  Scenario: A requested comparison does not pretend execution has started
    When I request evaluation of the saved snapshot
    Then the request is waiting for an application evaluator
    And its version identities and cases are fixed

  @EVAL-02 @sdk
  Scenario: An application runs both exact versions and submits complete evidence
    Given I request evaluation of the saved snapshot
    When the application compares both versions using the SDK
    And the same evaluator finishes the request
    Then the request is completed with the submitted comparison
    And the comparison preserves both exact version digests

  @EVAL-03
  Scenario: Starting the same attempt again does not create another run
    Given I request evaluation of the saved snapshot
    When the evaluator starts an attempt
    And it repeats the same start request
    Then the same attempt remains running

  @EVAL-04
  Scenario: A competing attempt cannot take over a running evaluation
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When a different attempt tries to start
    Then the competing attempt is rejected
    And the original attempt remains running

  @EVAL-05
  Scenario: Another writer cannot finish someone else's evaluation
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    And the evaluator submits complete fixture evidence
    When another writer tries to finish that request
    Then completion is rejected
    And the original attempt remains running

  @EVAL-06
  Scenario Outline: Bound evidence must match the requested experiment at submission
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the evaluator submits evidence with a changed <setting>
    Then completion is rejected
    Examples:
      | setting |
      | dataset |
      | runtime |
      | grader  |
      | cases   |

  @EVAL-07
  Scenario Outline: Missing or failed evidence remains incomplete
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the evaluator submits <outcome> evidence
    And the same evaluator finishes the request
    Then the request is failed with its incomplete evidence still inspectable
    Examples:
      | outcome              |
      | missing grades       |
      | grader failures      |
      | infrastructure errors|

  @EVAL-08
  Scenario: Unknown usage is preserved instead of inventing a zero cost
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the evaluator submits evidence without usage
    Then the comparison retains unknown usage

  @EVAL-09
  Scenario Outline: An operator can interrupt pending or running work
    Given I request evaluation of the saved snapshot
    And the request is <state>
    When I interrupt the request with a reason
    Then it stays interrupted after restart
    And late start or completion is rejected
    Examples:
      | state     |
      | requested |
      | running   |

  @EVAL-10
  Scenario: A service restart does not invent evaluator completion
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the service restarts
    Then the original attempt remains running

  @EVAL-11
  Scenario: Repeated completion links the same immutable comparison
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    And the evaluator submits complete fixture evidence
    When the same evaluator finishes the request
    And it repeats completion with the same comparison
    Then the request is completed with the submitted comparison
