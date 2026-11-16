@service @setup
Feature: Explicit content setup
  An empty workspace stays empty until someone creates or imports content.

  @SETUP-01
  Scenario: A fresh workspace has no invented content
    When I list the configured workspace and its bundles
    Then the workspace is available and its bundle list is empty

  @SETUP-02
  Scenario Outline: Record where explicitly created content came from
    When I create a bundle as <origin> containing "Review code."
    And the service restarts
    Then its stored origin remains <origin>
    And its first release is explicitly unevaluated
    Examples:
      | origin   |
      | created  |
      | imported |
      | example  |

  @SETUP-03
  Scenario Outline: A rejected import creates no partial workspace content
    When I try to create a bundle with <invalid> content
    Then the content is rejected
    And the bundle list is still empty
    Examples:
      | invalid            |
      | path traversal     |
      | colliding paths    |
      | unsupported schema |
      | no entries         |
      | an oversized entry |

  @SETUP-04
  Scenario: Retrying initial setup returns the same bundle and seed release
    When I create a bundle with an operation ID
    And I repeat the identical setup request
    Then I receive the same bundle and initial release
    And the bundle list contains exactly 1 bundle

  @SETUP-05
  Scenario: Selecting another project cannot disclose the first project's content
    Given a published bundle containing "Private project instructions."
    When an application authorized only for another project requests this bundle
    Then access is denied

  @SETUP-06
  Scenario: An optional human source label survives restart
    When I import content labelled "Team review rules"
    And the service restarts
    Then the bundle retains the source label "Team review rules"
