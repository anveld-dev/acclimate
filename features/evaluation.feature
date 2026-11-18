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
    And both retry-review repetitions score the exact parent 0 and the exact candidate 1

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
    Then the evidence submission is rejected as invalid
    And the original attempt remains running
    When the same evaluator submits corrected evidence
    And the same evaluator finishes the request
    Then the request is completed with the submitted comparison
    Examples:
      | setting        |
      | dataset        |
      | runtime        |
      | grader         |
      | case inventory |
      | result case    |

  @EVAL-07
  Scenario Outline: Partial grades survive a failed evaluation and block measured publication
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the evaluator submits these paired grades
      | case         | repetition | parent reward | candidate execution | candidate grading | candidate reward |
      | retry-review | 0          | 0.25          | completed           | scored            | 0.75             |
      | retry-review | 1          | 0.5           | <execution>         | <grading>         | unknown          |
    And the same evaluator finishes the request
    Then the failed request retains the submitted grades and the ungraded candidate arm
    When I try to publish that draft using its incomplete evidence
    Then publication is rejected
    And applications still resolve the original release
    Examples:
      | execution             | grading |
      | completed             | missing |
      | completed             | failed  |
      | infrastructure_failed | missing |

  @EVAL-08
  Scenario: Unknown usage is preserved instead of inventing a zero cost
    Given I request evaluation of the saved snapshot
    And the evaluator starts an attempt
    When the evaluator submits evidence without usage
    Then both arms of every requested case and repetition retain unknown usage

  @EVAL-09
  Scenario Outline: An operator can interrupt pending or running work
    Given I request evaluation of the saved snapshot
    And the request is <state>
    When I interrupt the request with a reason
    And the service restarts
    Then the evaluator cannot start the interrupted request
    And <outcome>
    And new evidence for the interrupted request is rejected
    And the request is still interrupted with its reason and no linked comparison
    Examples:
      | state                           | outcome                                                          |
      | waiting for an evaluator        | no attempt or evaluator has been assigned                        |
      | running with submitted evidence | the original evaluator cannot finish with its submitted evidence |

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
