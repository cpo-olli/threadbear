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
  Scenario: The coordinator experiment switch updates the open app
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    When I open Settings on "general"
    And I press "Turn Project coordinators off" in Settings
    Then the coordinator experiment is "off"
    When I open the project "Photo sync"
    Then the project hides its Add coordinator control
    When I press "Try Project coordinators" in Settings
    Then the coordinator experiment is "on"
    And the project offers its Add coordinator control
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    And the coordinator's document contains "Two helpers are working"

  @coordinators.home @coordinators @swift-pending
  Scenario: Reconnecting refreshes a cached experiment setting before restoring the home
    When I open Settings on "general"
    And I press "Turn Project coordinators off" in Settings
    Then the coordinator experiment is "off"
    When the coordinator setting is restored without a notification
    And the runner restarts
    Then the app is connected again
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    And the coordinator's document contains "Two helpers are working"

  @coordinators.home @coordinators @swift-pending
  Scenario: A project can add its coordinator from a pop-up dialog
    When I open the project "Photo sync"
    And I open the project's Add coordinator dialog
    Then the Add coordinator dialog is open
    When I press Escape to dismiss the Add coordinator dialog
    Then the Add coordinator dialog is closed
    When I open the project's Add coordinator dialog
    Then the Add coordinator dialog is open
    When I cancel the Add coordinator dialog
    Then the Add coordinator dialog is closed
    And the project offers its Add coordinator control
    When I add the project's coordinator
    Then the Add coordinator dialog is closed
    And the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator shows no Done card
    And the coordinator is listed once in its own sidebar section

  @coordinators.home @coordinators @swift-pending
  Scenario: A project home opens its real coordinator conversation
    When I open the project "Threadbear"
    Then the coordinator's "Conversation" tab is open
    And the transcript shows a reply starting "The project home is taking shape."
    And the coordinator shows no Done card
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
    And I open agent memory
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

  @coordinators.home @coordinators @swift-pending
  Scenario: Agent memory stays collapsed until opened
    When I open the project "Threadbear"
    Then agent memory is collapsed
    When I open agent memory
    Then agent memory is open
    When I close agent memory
    Then agent memory is collapsed

  @coordinators.home @coordinators @swift-pending
  Scenario: Open loops stay pinned until closed and can be undone
    When I open the project "Threadbear"
    Then the coordinator has 2 open loops
    When I close the answered open loop
    Then the coordinator has 1 open loops
    And the undo banner is shown for the closed loop
    When I undo closing the open loop
    Then the coordinator has 2 open loops
    And there's no error bar

  @coordinators.home @coordinators @swift-pending
  Scenario: A decision waiting on me is answered on the Needs you card, not in Open loops
    When I open the project "Threadbear"
    And the coordinator asks me a decision
    Then Open loops shows the decision without answer buttons
    When I open the coordinator's "Activity" tab
    And I click the decision in Open loops
    Then the coordinator's "Conversation" tab is open
