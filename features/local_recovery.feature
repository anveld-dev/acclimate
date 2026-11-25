@runtime
Feature: Keep the local console available through backend ownership failures
  The old backend exits before a replacement acquires the queue.
  A database stall is a fault fixture, not a change to the user's database.

  @RUNTIME-01
  Scenario: Recover from a temporary database stall and a dropped ownership connection
    Given a published bundle containing "Survives backend reconnect."
    When the local stack experiences a stalled and a dropped ownership connection
    Then each replacement serves the exact stored release through the same console
    And an intentional local shutdown still succeeds
