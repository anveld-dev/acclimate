@browser @ux
Feature: Recover a submitted draft after a browser reload
  Reloading an uncertain fresh draft must distinguish baseline hydration from local edits.

  @UX-06
  Scenario: Reopen the committed fresh snapshot after its response is lost and the browser reloads
    Given a published bundle containing "Review code."
    And I opened its Content page
    When the browser loses a successful create snapshot response for text A
    And I reload that uncertain fresh draft and check the result
    Then the committed snapshot reopens without duplicating or overwriting its saved text
