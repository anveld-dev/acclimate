@adapter @hosted @identity
Feature: Browser sign-in adapter
  Requests cross the real console identity handler and Rust session authority.
  Only the external identity provider is a deterministic fixture.

  @IDENTITY-01
  Scenario: A verified callback creates a private bounded browser session
    When I complete a valid sign-in callback
    Then a secure HttpOnly session cookie is returned and Rust recognizes the person
    And replaying the callback is rejected

  @IDENTITY-02
  Scenario Outline: Invalid callback transactions cannot mint browser sessions
    When a sign-in callback has <invalid>
    Then no session cookie is issued
    Examples:
      | invalid                 |
      | a different browser     |
      | an unknown state        |
      | an expired transaction  |
      | rejected provider claims|

  @IDENTITY-03
  Scenario: A cross-site logout request cannot revoke a valid session
    When a signed-in browser receives a cross-site logout request
    Then logout is rejected and the original session remains valid

  @IDENTITY-04
  Scenario: Same-origin logout revokes the Rust session
    When a signed-in browser submits same-origin logout
    Then the old cookie no longer authorizes identity reads

  @IDENTITY-05
  Scenario: A revoked old cookie does not prevent signing in again
    When I sign in after the prior cookie was revoked
    Then a new valid cookie identifies the same person
