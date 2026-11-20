@service @learning @provider_fixture
Feature: Learning from application feedback
  The application provides the evidence used to change the connection's delivered instructions.
  A qualified multi-step chain delivers its head with its development parent intact.

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
    Then both cohorts independently improve and the connection releases the candidate

  @LEARNING-04
  Scenario: A retry distinguishes a better score from a failed execution
    Given a connection evaluates partial-credit review tasks and allows a second proposal
    When its evaluator reports these paired review results
      | case             | repetition | parent | candidate | candidate status |
      | retry-review     | 0          | 0      | 0.5       | task_failed      |
      | retry-review     | 1          | 0      | 0.5       | task_failed      |
      | retry-review     | 2          | 0.5    | 0.5       | completed        |
      | reference-review | 0          | 0.5    | 0.5       | completed        |
      | reference-review | 1          | 0.5    | 0.5       | completed        |
      | reference-review | 2          | 0.5    | 0.5       | completed        |
    Then the next proposal receives two score gains, zero score regressions and two task failures
    And the failed development round consumes no audit or release

  @LEARNING-05
  Scenario: Replaying withdrawn content can requalify a candidate without releasing it
    Given I issued a receipt-write credential
    And an independently graded field job triggered automatic rollback
    When the evaluator stages the withdrawn bytes under a new version ID
    Then the candidate must replay the eight original field jobs
    When the application repairs its default code check and replays seven original jobs
    Then the outstanding job still blocks requalification on the current delivery revision
    When the last original job passes and the service restarts
    Then the candidate is requalified and the connection still serves the automatic rollback

  @LEARNING-06
  Scenario Outline: Every protected repetition must meet its latency ceiling before audit
    Given development requires every critical request to finish within 100 milliseconds
    When its evaluator reports these paired review results
      | case     | repetition | parent | candidate | candidate status |
      | fast     | 0          | 70     | 20        | completed        |
      | fast     | 1          | 70     | 20        | completed        |
      | fast     | 2          | 70     | 20        | completed        |
      | critical | 0          | 130    | <first>   | completed        |
      | critical | 1          | 130    | <second>  | completed        |
      | critical | 2          | 130    | 80        | completed        |
      | search   | 0          | 100    | 50        | completed        |
      | search   | 1          | 100    | 50        | completed        |
      | search   | 2          | 100    | 50        | completed        |
      | update   | 0          | 100    | 50        | completed        |
      | update   | 1          | 100    | 50        | completed        |
      | update   | 2          | 100    | 50        | completed        |
    Then the mean latency falls to 50 milliseconds and the round is <state> with <remaining> audits remaining
    Examples:
      | first | second | state    | remaining |
      | 40    | 120    | rejected | 1         |
      | 80    | 80     | audit    | 0         |

  @LEARNING-07
  Scenario: A manual restore cannot move the baseline of a parked correction
    Given a job missed retry guidance before the connection released that guidance
    When the evaluator rechecks its correction with unavailable private evidence
    And an administrator tries to restore the previous version while a correction is parked
    Then the connection still serves the automatic release and preserves the parked correction

  @LEARNING-08
  Scenario: A blocked audit closes permanently and retains its evidence
    Given a connected audit is blocked by a recorded application policy
    When a signed-in administrator tries to approve that blocked round
    Then the rejection and original delivery survive restart

  @LEARNING-09
  Scenario Outline: Fenced feedback and bounded screening settle before evaluation
    When the fixture screens a managed proposal in <mode> mode
    Then the screened proposal settles as <result>

    Examples:
      | mode           | result                   |
      | repair         | repaired                 |
      | reject         | critic-rejected          |
      | malformed-once | format-retried           |
      | malformed      | proposal-format-rejected |
