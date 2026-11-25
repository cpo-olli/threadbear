Feature: Project coordinators
  A project's conversation sits beside its shared, editable project state.
  Routine helpers report to the coordinator and stay outside the inbox.

  Background:
    Given the app is connected to a runner with the demo threads

  @coordinators.home @coordinators @swift-pending
  Scenario: Ordinary finished threads keep their Archive button
    When I open the thread "Tidy the imports in the uploader"
    Then the ordinary Done card has its Archive button

  @coordinators.home @coordinators @swift-pending
  Scenario: A project can add its coordinator using the ordinary model controls
    When I open the project "Photo sync"
    And I add the project's coordinator
    Then the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator's Done card has no Archive button
    And the coordinator is listed once in its own sidebar section

  @coordinators.home @coordinators @swift-pending
  Scenario: A project home opens its real coordinator conversation
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator's Done card has no Archive button
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
    Then the coordinator has the to-do "Build the project home" in "Needs review"
    When the coordinator checks and accepts the helper result
    Then the coordinator's document contains "The project home is ready"
    And the coordinator has the to-do "Build the project home" in "Done"
    And the coordinator is listed once in its own sidebar section

  @coordinators.home @coordinators @swift-pending
  Scenario: A conflicting document edit keeps the draft until the current version is reviewed
    When I open the project "Threadbear"
    And I edit the project notes and add "My draft decision."
    And the coordinator changes the saved notes to "The coordinator's new decision."
    And I save the project text
    Then the project editor shows the current version "The coordinator's new decision."
    And the project editor still contains "My draft decision."
    When I acknowledge the current project text
    Then the project editor still contains "My draft decision."
    When I append "The coordinator's new decision." to the project draft
    And I save the project text
    Then the project notes contain "My draft decision."
    And the project notes contain "The coordinator's new decision."
    And the project editor is closed
    And there's no error bar
