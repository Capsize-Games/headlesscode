# Evaluation Suite Stage 1 Scenarios

## Scenario 1: Silent Process Termination (Issue #150)
- **Short Name**: silent-process-exit-test
- **Tool Call Sequence**:
   - Use the `execute_command` tool to run a long-running process that does not handle uncaught exceptions.
   - Simulate an unexpected error by triggering an exception in the command execution without proper handling.
- **Correct Harness Behavior**:
   - The harness should log a final message before exiting, ensuring visibility of any issues leading up to termination.
- **PASS/FAIL Signal**:
   - PASS if there is a clear exit trace logged; FAIL otherwise.

## Scenario 2: Tool Failure Streak Handling (#146 Fix Verification)
- **Short Name**: multi-tool-failure-streak-test
- **Tool Call Sequence**:
   - Execute multiple consecutive calls with varying arguments using different tools (`read_file`, `edit_file`, and `execute_command`).
   - Introduce failures intentionally within these calls while observing how many attempts are made before halting due to failure streaks.
- **Correct Harness Behavior**:
   - After reaching the defined limit for consecutive errors (Ψ), the system must stop further processing but continue logging all events accurately until completion.
- **PASS/FAIL Signal**:
   - PASS when it correctly stops after exceeding the allowed number of failed operations yet logs each event properly;
   - FAIL if either too few or too many operation retries occur,
or if no appropriate logging takes place during this phase.

### Why This Wasn't Already Covered
Existing tests focus on single-point failures rather than complex scenarios involving batched interactions across various tools. For example, existing unit testing covers basic cases like individual read/write commands failing once�but doesn't explore what happens under more realistic conditions where several distinct types of actions fail repeatedly over time. Additionally, current test suites don’t fully examine situations requiring interaction between identical call cooldown mechanisms described in issue #153.

- src/engine/loop.ts:123 - Reference to DEFAULT_MAX_ITERATIONS and DEFAULT_CONSECUTIVE_ERROR_LIMIT which are crucial for handling error streaks.
- src/engine/__tests__/loop.test.ts:102 - Example of a test setup that simulates tool calls and their outcomes.
- src/engine/__tests__/loop.test.ts:205 - Illustration of how the harness handles errors during execution.
- plans/live-message-injection-for-chat-uis.md:123 - Context about message injection and its impact on process termination.