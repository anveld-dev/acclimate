@service @integrations
Feature: Optional application delivery reports
  Read and reporting credentials have separate scopes. Reports are app observations.

  Background:
    Given a published bundle containing "Review code."
    And I created an integration for this bundle and channel

  @INTEGRATION-01
  Scenario: New integrations have unknown delivery rather than invented success
    When I inspect the integration's recent reports
    Then no delivery report is returned

  @INTEGRATION-02
  Scenario: A content-read credential can fetch the released bytes
    Given I issued a content-read credential
    When the integration resolves and fetches the published version
    Then it receives "Review code." with the released digest

  @INTEGRATION-03
  Scenario: A content-read credential cannot fetch unreleased versions
    Given I issued a content-read credential
    And I have uploaded a version containing "Unpublished work."
    When the integration requests the unreleased version's bytes
    Then access is denied

  @INTEGRATION-04
  Scenario Outline: Integration credentials are not console or publishing authority
    Given I issued a <kind> credential
    When that credential requests <resource>
    Then access is denied
    Examples:
      | kind         | resource        |
      | content-read | receipt history |
      | receipt-write| content bytes   |
      | receipt-write| publish         |
      | content-read | publish         |

  @INTEGRATION-05
  Scenario: An app reports the exact version it verified
    Given I issued a receipt-write credential
    When the app reports verified delivery
    Then the stored observation names the same version and digest
    And it contains no content, memory or model-use claim

  @INTEGRATION-06
  Scenario: Retrying an observation does not duplicate it
    Given I issued a receipt-write credential
    When the app reports verified delivery
    And it repeats the identical event
    Then the same event is returned and history contains one report

  @INTEGRATION-07
  Scenario: Reusing an event ID with changed facts is rejected
    Given I issued a receipt-write credential
    And the app reports verified delivery
    When it reuses the event ID for another stage
    Then the changed observation is rejected

  @INTEGRATION-08
  Scenario: Reporting for another integration in the same project is denied
    Given I issued a receipt-write credential
    And another integration exists in this project
    When the first credential tries to report for the second integration
    Then access is denied

  @INTEGRATION-09
  Scenario Outline: Impossible or expired observations are rejected
    Given I issued a receipt-write credential
    When the app submits a report with <invalid>
    Then the observation is rejected
    Examples:
      | invalid                   |
      | an old occurrence time    |
      | a mismatched digest       |
      | a download from cache     |
      | a partial channel mapping |

  @INTEGRATION-10
  Scenario: Revoking a read credential blocks its next fetch
    Given I issued a content-read credential
    When I revoke that credential
    And it requests the published bytes
    Then access is denied

  @INTEGRATION-11
  Scenario: Revoking an integration disables both credential kinds
    Given I issued both credential kinds
    When I revoke the integration
    Then neither credential can read or report

  @INTEGRATION-12
  Scenario: A lost credential response cannot create another secret on retry
    When I issue a read credential using an operation ID
    And I retry that same issuance operation
    Then issuance is not repeated and the original credential ID is recoverable
    And integration listings disclose no credential secret
