@browser @ux
Feature: Recoverable content editing and explicit imports
  Browser work remains understandable and recoverable before a deliberate save or publication.

  @UX-03
  Scenario: Recover from a bookmarked content path that does not exist
    Given a published bundle with instructions, a skill and reusable memory
    When I open a bookmarked content path missing from that channel
    Then the missing selection is explained without displaying unrelated content
    When I clear the missing selection and choose the memory entry
    Then I read that published memory in the same bundle without creating a draft

  @UX-05
  Scenario: Create an imported bundle from real instruction and skill files
    Given I started a new bundle with unused typed instructions
    When I choose Import files and select a real bundle folder
    Then I can review the actual instruction and skill contents before publication
    When I confirm the imported entries and publish the bundle
    Then the published bundle contains exactly those imported files
