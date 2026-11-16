@browser @navigation
Feature: Navigate by workspace and bundle ownership
  URLs and displayed forms keep their resource identity across tabs and refreshes.

  @NAV-01
  Scenario: Workspace navigation and bundle tabs have different jobs
    Given a published bundle containing "Review code."
    When I open its scoped Content URL
    Then the workspace sidebar contains Bundles and Connections
    And the bundle tabs contain Content, Changes, Releases and App setup
    And the old seven-peer navigation and inert footer are absent

  @NAV-02
  Scenario: Edit the selected published entry in one draft editor
    Given a published bundle with instructions, a skill and reusable memory
    When I open the published memory and choose Edit entry
    Then the new draft selects that memory path and text in one editor

  @NAV-03
  Scenario: A saved draft bookmark survives another tab selecting a different bundle
    Given a published bundle containing "Review code."
    And I have saved a draft containing "Review retries."
    And another bundle is published on the same channel and revision
    When another tab opens the other bundle and I open the saved draft bookmark
    Then the bookmark still names the original bundle and saved text

  @NAV-04
  Scenario: Release history cannot bleed between bundles with matching revisions
    Given a published bundle containing "Review code."
    And another bundle is published on the same channel and revision
    When I inspect release history after another tab selects the other bundle
    Then each history view contains only its own bundle's verified content

  @NAV-05
  Scenario: Another tab cannot retarget a displayed connection creation form
    Given a published bundle containing "Review code."
    And another bundle is published on the same channel and revision
    When I prepare a connection for the first bundle
    And another tab selects the second bundle before I submit that form
    Then the created connection remains bound to the first bundle and channel

  @NAV-06
  Scenario: An unauthorized scoped URL never substitutes another workspace
    Given a published bundle containing "Private instructions."
    When I open its bundle ID under an unauthorized workspace URL
    Then that URL stays unavailable without displaying another bundle

  @NAV-07 @hosted
  Scenario: Readers can find SDK setup without connection administration
    Given an administrator created a workspace with published content
    And the administrator grants the member the viewer role
    When the member opens that content in the console
    And the reader opens App setup
    Then the SDK recipe is readable without editing or connection administration

  @NAV-08 @hosted
  Scenario: Workspace administration does not grant deployment-operator powers
    Given an administrator created a workspace with published content
    And the administrator grants the member the admin role
    When I compare their verified workspace-creation capabilities
    Then only the configured deployment operator can create a workspace
    And the member's console keeps Members but hides New workspace

  @NAV-09
  Scenario: Recover a previous browser's unconfirmed bundle creation without duplicating it
    Given a previous browser left a committed creation with an unconfirmed result
    When I reopen the bundle library with its previous operation record
    And I look up the pending creation result
    Then the original bundle opens once and the previous storage key is gone

  @NAV-10
  Scenario: Browser Back restores the published entry and its search
    Given a published bundle with instructions, a skill and reusable memory
    When I search for memory, edit that entry and go Back
    Then the published memory and its URL search are restored

  @NAV-11 @hosted
  Scenario: Switching workspace asks before discarding browser edits
    Given an administrator created a workspace with published content
    And the operator can also access another workspace
    When I edit content and try to switch workspace
    And I cancel that workspace switch
    Then the original workspace and unsaved text remain selected
    When I confirm leaving edits to switch workspace
    Then the other workspace opens without saving the abandoned text

  @NAV-12 @hosted
  Scenario: A role downgrade clears a stale membership-management form
    Given an administrator created a workspace with published content
    And the administrator grants the member the admin role
    When the member opens Members and looks up the operator
    And the operator downgrades that member to viewer
    And the member refreshes the membership page
    Then membership controls and the cached verified identity are removed

  @NAV-13
  Scenario: Bundle creation asks before discarding browser-only instructions
    Given I opened an empty console workspace
    When I type initial instructions and try to open Connections
    And I keep editing the new bundle
    Then the initial instructions remain in the creation form
    When I leave that creation form for Connections
    Then its browser text is discarded and no bundle was created
