@browser @hosted
Feature: Use the console with personal workspace rights

  @UI-ACCESS-01
  Scenario Outline: Content editing follows current workspace membership
    Given an administrator created a workspace with published content
    And the administrator grants the member the <role> role
    When the member opens that content in the console
    Then browser content editing is <editing>
    Examples:
      | role   | editing     |
      | viewer | unavailable |
      | editor | available   |

  @UI-ACCESS-02
  Scenario: Confirm a verified person before granting and removing membership
    Given an administrator created a workspace with published content
    When the administrator invites that person by email in the console
    Then an invitation does not grant membership before acceptance
    When the invitation is sent and the recipient accepts viewer access
    Then the member can read the current content
    When the administrator confirms and removes access in the console
    Then the member is denied on the next content request

  @UI-ACCESS-03
  Scenario: Create a workspace from the console
    Given I signed in as the configured operator
    When I create a workspace through the console
    Then its creator can select it with administrator rights

  @UI-ACCESS-04
  Scenario: Existing member roles are visible before identity confirmation
    Given an administrator created a workspace with published content
    And the administrator grants the member the viewer role
    When the administrator opens the current member list
    Then the existing member can be selected with their current role

  @UI-ACCESS-05
  Scenario: A lost issuance is reconciled before confirmed revocation and replacement
    Given an administrator created a workspace with published content
    And the administrator has a scoped connection
    When the browser loses a successful credential issuance response
    And the administrator reloads and reconciles the original issuance
    Then replacement is unavailable until original revocation is confirmed
    When the browser loses original revocation and the administrator reconciles before replacement
    Then exactly one active replacement remains and secrets were never stored

  @UI-ACCESS-06
  Scenario: A storage cleanup failure cannot hide a successfully issued one-time credential
    Given an administrator created a workspace with published content
    And the administrator has a scoped connection
    When credential recovery cleanup fails after successful issuance
    Then its one-time secret remains visible and usable without storing or issuing another secret
