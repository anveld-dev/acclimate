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
  Scenario: Add, rename, classify and save a new entry
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I add and rename an entry as shared memory
    And I save the browser draft
    Then reopening the draft preserves that entry's path, kind and text

  @UI-CONTENT-03
  Scenario: Rename and remove an entire skill package without orphaning support files
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I add a skill with a support file and rename the package
    And I save the browser draft
    Then both skill paths and the manifest name use the new package name
    When I remove that skill package and save again
    Then neither its manifest nor its support files remain

  @UI-IMPORT-01
  Scenario: Folder import previews nested skill paths before applying them
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I select a bundle folder containing a skill and support file
    Then both relative skill paths appear in the import preview
    When I apply the preview and save the browser draft
    Then the saved bundle contains the complete skill package

  @UI-IMPORT-02
  Scenario Outline: Rejected imports leave the current browser edits intact
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I select an import with <invalid>
    Then the import is rejected and the original text remains
    Examples:
      | invalid       |
      | a collision   |
      | invalid UTF-8 |
      | a flat skill  |

  @UI-DRAFT-01
  Scenario Outline: Unsaved navigation asks before discarding text
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I edit text and try to navigate away
    And I choose to <choice>
    Then the unsaved edit is <outcome>
    Examples:
      | choice       | outcome   |
      | keep editing | preserved |
      | leave editor | discarded |

  @UI-DRAFT-02
  Scenario: Reopen the exact saved generation after closing the browser and restarting Rust
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I save two browser draft generations
    And I close the browser and restart the service
    Then the saved generation reopens with its exact snapshot and history

  @UI-DRAFT-03
  Scenario: Explicitly leaving edits before refresh really discards those edits
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I edit text and choose to leave the editor during refresh
    Then the unsaved text is replaced with the published content

  @UI-DRAFT-04
  Scenario: A pristine new draft follows a newly published release on refresh
    Given a published bundle containing "Review code."
    And I opened its Content page
    And I opened a new draft for that entry
    When another operator publishes "New current instructions."
    And I refresh the console
    Then a new browser draft starts with "New current instructions."

  @UI-EVAL-01
  Scenario: A reviewer overrides a failed policy to publish the evaluated snapshot
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I save a browser draft and request its evaluation
    And the test application runs the downloaded handoff using the displayed command
    And I review the failed policy and publish with an override reason
    Then the release records the evaluated snapshot, overridden policy and reviewer reason

  @UI-EVAL-02
  Scenario: Incomplete evidence shows all missing grades and unknown cost
    Given a draft with a comparison that has no returned grades
    When I inspect that comparison in the console
    Then the page shows 4 missing grades and unknown cost
    And measured publication is unavailable

  @UI-EVAL-03
  Scenario: Select the native app evaluator without launching a model from the browser
    Given a published bundle with instructions, a skill and reusable memory
    And I opened its Content page
    When I save a browser candidate and paste the installed Codex evaluator description
    Then its strict frozen request and copied command match the installed Codex evaluator

  @UI-EVAL-04
  Scenario: Freeze an app supplied evaluator configuration after rejecting malformed intent
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I select my app evaluator and enter malformed then valid public configuration
    Then only the valid strict configuration is persisted and later form edits cannot change it

  @UI-RECOVERY-01
  Scenario Outline: Retrying a lost snapshot response preserves later edits in the same editor
    Given a published bundle containing "Review code."
    And I opened its Content page
    When the browser loses a successful <command> snapshot response for text A
    And I edit the uncertain snapshot to text B and retry the exact request
    Then the service retains only text A and the same editor keeps unsaved text B
    Examples:
      | command |
      | create  |
      | save    |

  @UI-RECOVERY-02
  Scenario Outline: Authorization loss cannot settle an uncertain browser write
    Given a published bundle containing "Review code."
    When the browser loses a successful <operation> response
    And the operator loses mutation rights and retries or looks up that pending operation
    Then the exact recovery record remains until rights return and the commit is reconciled
    Examples:
      | operation |
      | draft     |
      | restore   |

  @UI-RELEASE-01
  Scenario: Inspect, download and restore a historical release with a reason
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."
    And I published the saved draft manually
    When I inspect the old release and restore it through the console
    Then the original content is current at revision 3 with the restore reason

  @UI-RELEASE-03
  Scenario: Review the new current release before retrying a stale restore
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."
    And I published the saved draft manually
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

  @UI-LEARNING-01 @provider_fixture
  Scenario: Refresh a stale rollout approval and acknowledge both blocking policies
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And its audited candidate is awaiting rollout with one blocking policy
    When the reviewer opens the rollout dialog and acknowledges the first policy
    And the evaluator records another blocking policy before the reviewer confirms
    And the reviewer submits the open rollout dialog
    Then the console explains the conflict and the connection still serves the original revision
    When the reviewer refreshes learning status and reviews both policies
    And the reviewer approves with a new reason
    Then exactly one release records the candidate, reviewer, new reason and both receipts

  @UI-LEARNING-05 @provider_fixture
  Scenario: A competing reviewer sees the decision that already released the candidate
    Given a published bundle containing "Review code."
    And I signed in as the configured operator
    And I created an integration for this bundle and channel
    And I issued a content-read credential
    And its audited candidate is awaiting rollout with one blocking policy
    When the reviewer opens the rollout dialog and acknowledges the first policy
    And a different reviewer approves that candidate and retries the recorded decision
    And the reviewer submits the open rollout dialog
    Then the console identifies the reviewer and reason that won the race
    And the release retains one decision even if its author sends a different acknowledgment

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

  @UI-RELEASE-02
  Scenario: Manually release the reviewed saved generation without requesting evaluation
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I save a draft and leave later unsaved text to review its manual release
    Then manual publication requires its own reason and confirms the saved generation
    When I confirm the manual release
    Then only the saved snapshot is released with its manual reason and no evaluation

  @UI-EVAL-05
  Scenario: Recording an interruption never supplies a manual publication reason
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I save a browser draft and request its evaluation
    And I record an interruption while keeping a separate manual release reason
    Then the request records only its interruption reason and the manual reason remains independent

  @UI-NAV-02
  Scenario: App setup and a scoped connection preserve bundle and channel ownership
    Given a published bundle containing "Review code."
    And a connection for its bundle and channel
    When I follow App setup to Connections and back from the selected connection
    Then App setup remains active for the same bundle and channel

  @UI-KEYBOARD-01
  Scenario: Search, rename, dismiss a dialog and change tabs using the keyboard
    Given a published bundle with instructions, a skill and reusable memory
    And I opened its Content page
    When I search and rename an entry using only the keyboard
    And I dismiss the unsaved-work dialog and return to the invoking link
    Then the renamed browser text is preserved and tabs remain keyboard reachable

  @UI-RECOVERY-03
  Scenario Outline: Reverting to older browser text still preserves edits when a lost save is reconciled
    Given a published bundle containing "Review code."
    And I opened its Content page
    When the browser loses a successful <command> snapshot response for text A
    And I revert the uncertain browser text to its previously displayed saved text and check the result
    Then the committed snapshot remains text A while the same editor keeps the reverted text as unsaved
    Examples:
      | command |
      | create  |
      | save    |

  @UI-RECOVERY-04 @provider_fixture
  Scenario Outline: Recovering a submitted suggestion preserves a later hypothesis and evidence
    Given a published bundle containing "Review code."
    When the browser loses a successfully submitted suggestion response
    And I change the suggestion hypothesis and evidence before <recovery>
    Then the earlier suggestion is reconciled once and my later suggestion form stays intact
    Examples:
      | recovery            |
      | checking its result |
      | retrying exactly    |

  @UI-RECOVERY-05
  Scenario Outline: Another bundle page reconciles the original uncertain save before permitting new writes
    Given a published bundle containing "Review code."
    And an older historical release exists before the uncertain draft
    And I opened its Content page
    When the browser loses a successful save snapshot response for text A
    And I leave the uncertain editor for <destination>
    Then that page blocks new writes until its notice checks the original save result
    Examples:
      | destination    |
      | Review release |
      | Releases       |

  @UI-POLL-01
  Scenario: Published content updates without a refresh button
    Given a published bundle containing "Review code."
    And I opened its Content page
    When another operator publishes "Updated policy."
    Then the published entry becomes "Updated policy." without a refresh control

  @UI-POLL-02
  Scenario: Keep an unsaved edit across publication and see the latest content after discarding it
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I type "My unfinished review." in a new draft
    And another operator publishes "Updated policy."
    And I return to Content but choose to keep editing
    Then the draft editor still contains "My unfinished review."
    When I discard the unsaved edit and return to Content
    Then the published entry shows "Updated policy." and no draft was saved
