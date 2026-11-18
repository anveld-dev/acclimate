@service @learning @provider_fixture
Feature: Learning from application feedback
  The application provides the evidence used to change the connection's delivered instructions.

  Background:
    Given a published bundle containing "Review code."
    And I created an integration for this bundle and channel
    And I issued a content-read credential

  @LEARNING-01
  Scenario Outline: A late correction can settle without another proposal on the current revision
    Given a job missed retry guidance before the connection released that guidance
    When the evaluator rechecks its correction with <evidence> private evidence
    Then the original job still records its failure and the correction is <state>
    And after restart the correction keeps its state without consuming proposals, audits or releases

    Examples:
      | evidence    | state                        |
      | available   | resolved                     |
      | unavailable | private_evidence_unavailable |

  @LEARNING-02
  Scenario: A proposer repairs measured development losses while held-out cases stay private
    Given a review proposal gained retry guidance but lost code-review guidance in development
    When the proposer receives the measured development feedback and tries again
    Then the revised instructions preserve code review and gain retry guidance
    When the independent audit rejects that candidate and another correction asks for a proposal
    Then the proposer receives only the permitted development history and no held-out case

  @LEARNING-03
  Scenario: Only a distinct review task qualifies as a held-out audit
    When I register the same review task for development and audit under different case names
    Then the overlapping enrollment is refused before a release or proposal
    When I replace the audit with a different review task that has the same expected answer
    Then both tasks independently improve and the connection releases the candidate

  @LEARNING-04
  Scenario: A retry distinguishes a better score from a failed execution
    Given a connection evaluates partial-credit review tasks and allows a second proposal
    When its evaluator reports these paired review results
      | case         | repetition | parent | candidate | candidate status |
      | retry-review | 0          | 0      | 0.5       | task_failed      |
      | retry-review | 1          | 0      | 0.5       | task_failed      |
    Then the next proposal receives two score gains, zero score regressions and two task failures
    And the failed development round consumes no audit or release

  @LEARNING-05
  Scenario: Withdrawn bytes under a new version ID earn a restore by passing every field replay
    Given I issued a receipt-write credential
    And an independently graded field job triggered automatic rollback
    When the source republishes the withdrawn bytes under a new version ID
    Then the eight original field jobs block restoring those bytes
    When the application repairs its default code check and replays seven original jobs
    Then the outstanding job still blocks restore on the current delivery revision
    When the last original job passes and the reviewer retries the restore after restart
    Then the connection serves the requalified version with exactly one new release

  @LEARNING-06
  Scenario Outline: Every protected repetition must meet its latency ceiling before audit
    Given development requires every critical request to finish within 100 milliseconds
    When its evaluator reports these paired review results
      | case     | repetition | parent | candidate | candidate status |
      | fast     | 0          | 100    | 10        | completed        |
      | fast     | 1          | 100    | 10        | completed        |
      | critical | 0          | 100    | <first>   | completed        |
      | critical | 1          | 100    | <second>  | completed        |
    Then the mean latency falls to 50 milliseconds and the round is <state> with <remaining> audits remaining
    Examples:
      | first | second | state    | remaining |
      | 60    | 120    | rejected | 1         |
      | 90    | 90     | audit    | 0         |

  @LEARNING-07
  Scenario: A parked correction is reconsidered once on the new delivery revision
    Given a job missed retry guidance before the connection released that guidance
    When the evaluator rechecks its correction with unavailable private evidence
    And another recheck is in flight when a reviewer restores the original instructions
    Then the old recorded verdict is recoverable and a new stale verdict cannot settle either correction
    When the recovered private evidence reproduces the original failure on the restored revision
    Then exactly one proposal is admitted against the newly restored baseline

  @LEARNING-08
  Scenario: Only the reviewer who declined a rollout can recover that decision
    Given I signed in as the configured operator
    And its audited candidate is awaiting rollout with one blocking policy
    When the signed-in reviewer declines the rollout and repeats the decision after restart
    Then a competing reviewer sees who declined and the original delivery is still served
