@browser @native_walk
Feature: Deliver a native bundle with an installed application
  This is model-free orchestration evidence. Live native provider sessions have separate qualification.

  @NATIVE-WALK-01
  Scenario: Repair, release, deliver and roll back one native-target bundle
    Given I import a Codex-target bundle with a native skill and declarative payment memory in the browser
    And an isolated app installs the packed SDK and native plugin and retains its original prepared workspace
    When I upload an incomplete native version, repair it and release the compatible version
    Then the installed app prepares the released native bytes, observes its actual start and records only optional delivery evidence
    When I roll back through the browser and the next installed job has an unavailable optional reporting credential
    Then rollback delivery succeeds while both earlier prepared workspaces keep their exact pinned bytes
