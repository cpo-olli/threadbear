Feature: Project coordinators
  A project's conversation sits beside its shared, editable project state.
  Routine helpers report to the coordinator and stay outside the inbox.

  Background:
    Given the app is connected to a runner with the demo threads

  @coordinators.home @coordinators @swift-pending
  Scenario: A project can add its coordinator using the ordinary model controls
    When I open the project "Photo sync"
    And I add the project's coordinator
    Then the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator is listed once in its own sidebar section

  @coordinators.home @coordinators @swift-pending
  Scenario: A project home opens its real coordinator conversation
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator is listed once in its own sidebar section
    And the coordinator's document contains "Two helpers are working"
    When I open the coordinator's "To-dos" tab
    Then the coordinator's "To-dos" tab is open
    And the coordinator has the to-do "Build the project home" in "Helper working"
    When I pause the project coordinator
    Then the project coordinator is "paused"

  @coordinators.home @coordinators @swift-pending
  Scenario: Helper results update the shared project state without another thread
    When I open the project "Threadbear"
    And a coordinator helper finishes its work
    Then the coordinator's document contains "The project home is ready"
    And the coordinator has the to-do "Build the project home" in "Done"
    And the coordinator is listed once in its own sidebar section
