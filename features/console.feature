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

  @UI-RECOVERY-02
  Scenario: Authorization loss cannot settle an uncertain restore
    Given a published bundle containing "Review code."
    When the browser loses a successful restore response
    And the operator loses mutation rights and retries or looks up that pending operation
    Then the exact recovery record remains until rights return and the commit is reconciled

  @UI-RELEASE-01
  Scenario: Inspect, download and restore a historical release with a reason
    Given a published bundle containing "Review code."
    And I have uploaded a version containing "Review retries."
    And I released the uploaded version
    When I inspect the old release and restore it through the console
    Then the original content is current at revision 3 with the restore reason

  @UI-RELEASE-03
  Scenario: Review the new current release before retrying a stale restore
    Given a published bundle containing "Review code."
    And I have uploaded a version containing "Review retries."
    And I released the uploaded version
    When I open a restore of revision 1 against revision 2
    And another operator publishes "Review retry limits."
    And I confirm the restore I reviewed
    Then the console explains the conflict and the other operator's revision 3 still serves
    When I review the current release and confirm a new restore against revision 3
    Then exactly one restore follows the other operator's release in history

  @UI-INTEGRATION-01
  Scenario: Issue a one-time credential and revoke it through the console
    Given a published bundle containing "Review code."
    When I create an integration and issue a read credential in the console
    Then its secret is shown once and missing delivery is labelled unknown
    When I close the secret dialog and revoke that credential
    Then the closed secret is not displayed and its next fetch is denied

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

  @UI-KEYBOARD-01
  Scenario: Search, inspect and change tabs using the keyboard
    Given a published bundle with instructions, a skill and reusable memory
    And I opened its Content page
    When I search and select an entry using only the keyboard
    Then the published entry is readable and tabs remain keyboard reachable

  @UI-POLL-01
  Scenario: Published content updates without a refresh button
    Given a published bundle containing "Review code."
    And I opened its Content page
    When another operator publishes "Updated policy."
    Then the published entry becomes "Updated policy." without a refresh control
