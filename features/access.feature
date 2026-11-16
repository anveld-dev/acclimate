@service @hosted @access
Feature: Workspace identity and access
  Verified people use membership. Applications keep separate machine credentials.
  The trusted identity-adapter seam is a fixture; no live identity provider is used.

  @ACCESS-01
  Scenario: Console transport alone does not identify a signed-in person
    When the console transport requests workspaces without a session
    Then access is denied

  @ACCESS-02
  Scenario: Machine SDK grants still work without browser sessions in hosted mode
    When a configured application lists its own workspace
    Then its configured project is returned

  @ACCESS-03
  Scenario: An allowlisted operator creates a project and becomes its administrator
    Given I signed in as the configured operator
    When I create a new workspace
    Then I can select it with administrator rights

  @ACCESS-04
  Scenario: The first signed-in visitor does not become an operator
    Given I signed in as an ordinary person
    When I try to create a new workspace
    Then access is denied

  @ACCESS-05
  Scenario Outline: Membership controls access to current content
    Given an administrator created a workspace with published content
    And the administrator grants the member the <role> role
    When the member tries to save a draft
    Then the write is <decision>
    And the member can read the current content
    Examples:
      | role   | decision |
      | viewer | denied   |
      | editor | allowed  |
      | admin  | allowed  |

  @ACCESS-06
  Scenario: Downgrading a member blocks a later write from the same session
    Given an administrator created a workspace with published content
    And the administrator grants the member the editor role
    When the administrator changes the member to viewer
    And the member tries to save a draft
    Then the write is denied

  @ACCESS-07
  Scenario: Removing membership blocks a stale browser session
    Given an administrator created a workspace with published content
    And the administrator grants the member the viewer role
    When the administrator removes the member
    And the member requests the content again
    Then access is denied

  @ACCESS-08
  Scenario: A viewer cannot grant themselves administration
    Given an administrator created a workspace with published content
    And the administrator grants the member the viewer role
    When the member tries to promote themselves to administrator
    Then access is denied

  @ACCESS-09
  Scenario: An administrator confirms an already verified identity before adding it
    Given an administrator created a workspace with published content
    When the administrator looks up the member's opaque user ID
    Then the verified issuer and subject are returned for confirmation

  @ACCESS-10
  Scenario: Signing out revokes the session and a later sign-in replaces it
    Given I signed in as an ordinary person
    When I sign out
    Then the old session cannot read my identity
    When I sign in again while carrying the old cookie
    Then I receive a different valid session for the same person

  @ACCESS-11
  Scenario: The final administrator cannot remove their own membership
    Given an administrator created a workspace with published content
    When the final administrator tries to remove their own membership
    Then the service preserves the final administrator

  @ACCESS-12
  Scenario: A current administrator can inspect existing membership and nullable lookup roles
    Given an administrator created a workspace with published content
    And the administrator grants the member the viewer role
    When the administrator inspects current workspace members
    Then the member is listed with the current viewer role

  @ACCESS-13 @production_only
  Scenario: Machine startup registration never creates human ownership
    Given I signed in as the configured operator
    When I inspect the configured machine workspace before adoption
    Then it has no memberships and is absent from my personal workspace list

  @ACCESS-14 @production_only
  Scenario: Explicit operator adoption preserves the registered workspace and its content
    Given a published bundle containing "Content before explicit adoption."
    And I signed in as the configured operator
    When I explicitly adopt that memberless workspace with a reason
    Then my administrator membership and immutable adoption audit preserve the original release

  @ACCESS-15 @production_only
  Scenario: Retrying historical adoption never restores a removed membership
    Given I signed in as the configured operator
    And I explicitly adopted a workspace then transferred its administration
    When I retry the original adoption with a different reason
    Then the original audit is returned without restoring my removed membership

  @ACCESS-16 @production_only
  Scenario: An operator cannot adopt an already owned workspace
    Given an administrator created a workspace with published content
    When I attempt to adopt that already owned workspace
    Then existing workspace ownership is preserved

  @ACCESS-17 @production_only
  Scenario Outline: Machine credentials cannot become a browser identity
    Given I signed in as the configured operator
    When I request browser identity using a machine grant with <session>
    Then access is denied
    Examples:
      | session        |
      | a live session |
      | no session     |

  @ACCESS-18 @production_only
  Scenario: The login authority cannot assert another issuer
    When the trusted login authority submits a different issuer
    Then the unpinned identity is rejected before any session is issued
