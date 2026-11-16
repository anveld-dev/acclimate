@browser @ux
Feature: Recoverable content editing and explicit imports
  Browser work remains understandable and recoverable before a deliberate save or publication.

  @UX-01
  Scenario: Correct an invalid fresh draft without entering submission recovery
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I try to save a fresh browser draft with an invalid entry path
    Then the draft explains the invalid content without locking another save
    When I correct the invalid path and save the draft
    Then only the corrected draft snapshot is saved and the release stays unchanged

  @UX-02
  Scenario: Reload the latest saved generation after keeping browser edits once
    Given a published bundle containing "Review code."
    And I opened its Content page
    And I saved a browser draft before an external newer generation
    When I cancel reloading that saved draft with unsaved browser edits
    Then the exact browser edits remain while the newer generation stays saved
    When I explicitly discard those browser edits and reload the saved draft
    Then the editor reads the externally saved generation without creating another save

  @UX-03
  Scenario: Recover from a bookmarked content path that does not exist
    Given a published bundle with instructions, a skill and reusable memory
    When I open a bookmarked content path missing from that channel
    Then the missing selection is explained without displaying unrelated content
    When I clear the missing selection and choose the memory entry
    Then I read that published memory in the same bundle without creating a draft

  @UX-04
  Scenario: Keep exact custom evaluator JSON when cancelling navigation
    Given a published bundle containing "Review code."
    And I opened its Content page
    When I enter custom evaluator JSON and try to leave its review page
    Then navigation warns before losing the custom evaluator configuration
    When I keep editing the custom evaluator configuration
    Then its exact JSON remains without requesting or running an evaluation

  @UX-05
  Scenario: Create an imported bundle from real instruction and skill files
    Given I started a new bundle with unused typed instructions
    When I choose Import files and select a real bundle folder
    Then I can review the actual instruction and skill contents before publication
    When I confirm the imported entries and publish the bundle
    Then the published bundle contains exactly those imported files
