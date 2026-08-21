# Evaluation Suite Stage 1 Scenarios

## Overview
This document outlines the scenarios for evaluating the headlesscode project's stage 1 functionality. These scenarios are designed to test various aspects of the system, including task execution, tool usage, and session management.

## Scenario 1: Task Execution Flow
- **Description**: Verify that the system can execute a series of tasks as defined in the todo list.
- **Steps**:
  1. Create a new task with a specified mode and initial todo list.
  2. Execute each step in the todo list sequentially.
  3. Ensure that the system correctly updates the todo list as each step is completed.
- **Expected Outcome**: The todo list should be updated accurately, reflecting the completion status of each task.

## Scenario 2: Tool Usage Verification
- **Description**: Test the correct usage of various tools within the system.
- **Steps**:
  1. Use the `read_file` tool to read the contents of a specific file.
  2. Use the `edit_file` tool to modify the content of a file.
  3. Use the `execute_command` tool to run a shell command.
- **Expected Outcome**: Each tool should function as intended without errors, and the changes made should be reflected in the respective files or outputs.

## Scenario 3: Session Management
- **Description**: Evaluate how the system manages sessions, including termination conditions and budget tracking.
- **Steps**:
  1. Start a new session with a predefined set of iterations and budget limits.
  2. Perform actions that consume the session's budget and iterate through the allowed number of steps.
  3. Check if the session terminates correctly when the iteration limit or budget is reached.
- **Expected Outcome**: The session should terminate gracefully upon reaching its limits, providing appropriate feedback on the reason for termination.

## Scenario 4: Guardrails Against Blind Tree-Walking
- **Description**: Test the implementation of guardrails to prevent blind tree-walking during exploration phases.
- **Steps**:
  1. Simulate an exploration phase where multiple read-only commands are executed consecutively.
  2. Monitor for the injection of nudges to guide the model away from blind tree-walking.
- **Expected Outcome**: The system should inject appropriate nudges to encourage more targeted exploration rather than random file traversal.

## Scenario 5: Concurrent Read-Only Call Handling
- **Description**: Assess the logic for determining whether a call can run concurrently with others.
- **Steps**:
  1. Execute several read-only calls simultaneously.
  2. Verify that the system handles these calls appropriately based on their potential impact on shared resources.
- **Expected Outcome**: The system should handle concurrent read-only calls efficiently, ensuring no conflicts arise due to overlapping operations.

### File Citations
- src/engine/loop.ts:126
- src/engine/loop.ts:280
- src/engine/loop.ts:515
- src/engine/loop.ts:550

## Why Not Yet Covered
The current evaluation suite does not cover certain areas of the system that require further investigation. These include:
- Testing the interaction between different modes (e.g., code, architect) during complex task execution.
- Evaluating the performance of the system under high load conditions with many concurrent users.
- Ensuring robustness against edge cases and unexpected user inputs.
- Validating the accuracy of the system's internal state tracking and recovery mechanisms.