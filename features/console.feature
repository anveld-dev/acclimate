@browser @console
Feature: Work with content through the console
  These scenarios use a real browser, console, Rust service and private database.

  @UI-SETUP-01
  Scenario Outline: Create content only after an explicit action
    Given I opened an empty console workspace
    When I create content from <source> in Bundles
    Then the bundle is selected and its stored origin is <origin>
    Examples:
      | source             | origin   |
      | Write instructions | created  |
      | Import JSON        | imported |
      | Import files       | imported |

  @UI-SETUP-02
  Scenario: Correct a rejected setup without getting stuck on a pending operation
    Given I opened an empty console workspace
    When I submit invalid setup and then correct it
    Then the corrected bundle is created once

  @UI-CONTENT-01
  Scenario: Browse, filter and download published content
    Given a published bundle with instructions, a skill and reusable memory
    And I opened its Content page
    When I filter published entries and download the memory file
    Then the downloaded file contains the published memory

  @UI-CONTENT-02
  Scenario: Published instructions can be inspected from the console
    Given a published bundle containing "Review code."
    And I opened its Content page
    Then the content shows the instructions without a manual edit action

  @UI-DRAFT-02
  Scenario: A historical draft bookmark shows its saved change after restart
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."
    When the service restarts
    And I reopen the saved draft bookmark
    Then I can inspect its change without a publication action

  @UI-EVAL-02
  Scenario: Incomplete evidence shows all missing grades and unknown cost
    Given a draft with a comparison that has no returned grades
    When I inspect that comparison in the console
    Then the page shows 4 missing grades and unknown cost
    And measured publication is unavailable

  @UI-RELEASE-01
  Scenario: Inspect the initial release and the absence of manual restore
    Given a published bundle containing "Review code."
    When I open its release history
    Then the console shows the seed and has no restore action

  @UI-INTEGRATION-01
  Scenario: Issue a one-time credential and revoke it through the console
    Given a published bundle containing "Review code."
    When I create an integration and issue a read credential in the console
    Then its secret is shown once and missing delivery is labelled unknown
    When I close the secret dialog and revoke that credential
    Then the closed secret is not displayed and its next fetch is denied

  @UI-LEARNING-01 @provider_fixture
  Scenario: Inspect a blocked release and its rejection reason
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And a connected audit is blocked by a recorded application policy
    Then the connection shows the rejection reason without an approval action

  @UI-LEARNING-02 @provider_fixture
  Scenario: Trace a failed job to the withdrawn release and its independent audit
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And I issued a receipt-write credential
    And an independently graded field job triggered automatic rollback
    When I look up the triggering job on the connection
    Then its outcome identifies the withdrawn release, the restored revision and the triggering verdict
    When I follow its audit evidence
    Then the console opens the independent audit for the exact served candidate
    When I return and look up the job graded after the rollback
    Then its regression identifies the same withdrawn release without claiming it triggered rollback

  @UI-LEARNING-03 @provider_fixture @learning
  Scenario: A reviewer traces a rejected rollout to the regressed audit case
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And a candidate improved development but lost a protected code-review instruction in audit
    When I open the rejected round on the connection
    Then I see the audit rejection reason and cannot approve that round
    When I follow the round's audit evidence to the regressed case
    Then the case shows the parent earned 1 and the candidate earned 0
    And the next application job uses the original revision and instructions

  @UI-LEARNING-04 @provider_fixture @learning
  Scenario: Stopping learning during a passing audit prevents a late automatic rollout
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And an automatic rollout is waiting for its evaluator to finish a passing audit
    When I confirm Stop learning on the connection
    And the evaluator delivers the late audit completion and the service restarts
    Then the stopped connection shows a rejected round and assigns no further work
    And the next application job uses the original revision and instructions

  @UI-STATUS-01
  Scenario: A failed refresh shows the last observation without displaying stale content as current
    Given a published bundle containing "Review code."
    And I opened its Content page
    When the service becomes unavailable
    And I refresh the console
    Then the page shows the last read and unknown current state without editable content

  @UI-NAV-01
  Scenario: Main routes remain readable and navigable on desktop and mobile
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I visit every main route at desktop and mobile sizes
    Then the routes have no browser errors or horizontal overflow

  @UI-SETUP-03
  Scenario: Source changes preview real content and cannot conceal an unresolved publication
    Given I opened an empty console workspace
    When I compare all three creation sources without publishing
    Then only the selected source is rendered and no content has been created
    When the browser loses the successful initial publication response
    Then source changes cannot replace the frozen publication and checking its result opens it once

  @UI-NAV-02
  Scenario: App setup and a scoped connection preserve bundle and channel ownership
    Given a published bundle containing "Review code."
    And a connection for its bundle and channel
    When I follow App setup to Connections and back from the selected connection
    Then App setup remains active for the same bundle and channel
