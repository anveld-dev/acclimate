@sdk @python
Feature: Python application integration
  Python applications use the same real content and evidence contracts.

  Background:
    Given a published bundle containing "Review code."
    And the application enrolls this bundle for automatic delivery

  @PYTHON-01
  Scenario: Resolve and materialize a verified release through the Python SDK
    When a Python application prepares the stable release
    Then Python receives "Review code." and the exact released digest

  @PYTHON-02
  Scenario: Python requires a current connection for each new job
    Given a Python application prepared the stable release
    When the service becomes unavailable
    And Python requests the release without offline permission
    Then Python delivery fails without returning content
    When Python explicitly permits bounded offline delivery
    Then Python delivery fails without returning content

  @PYTHON-03
  Scenario: Author and evaluate one snapshot through the Python client
    When a Python application saves two generations and records comparison evidence
    Then Python preserves both saved generations and the connected job still receives the seed

  @PYTHON-04
  Scenario: Python reporting records only the stages the application observed
    Given I issued both credential kinds
    When Python prepares and explicitly reports its own session start
    Then Python observations identify the verified version without content

  @PYTHON-05
  Scenario: Optional Python receipt denial leaves delivery and app start successful
    When Python starts its application with an unavailable reporting credential
    Then Python delivery and app start succeed with pending optional observations
