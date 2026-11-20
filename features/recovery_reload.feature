@browser @ux
Feature: Open an old editing link

  @UX-06
  Scenario: A retired editing bookmark leads to connected learning after reload
    Given a published bundle containing "Review code."
    When I reload a bookmark that used to create a draft
    Then the console points to connections and has no release action
