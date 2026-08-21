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

**Editor's note (added after mechanical citation verification —
`scripts/eval-suite/verify-citations.mjs`, 2026-08-21): the citations
originally written here were real file:line locations but carried
FABRICATED claims that did not match the actual content at those
lines — e.g. `loop.ts:123` was cited as "DEFAULT_CONSECUTIVE_ERROR_LIMIT"
but is actually an unrelated `import` statement; a review-daemon
judgment pass (deepseek-r1-distill-qwen-7b) scored this document PASS
without catching the mismatch, since a text-only judge has no way to
cross-check a citation against the real file. Replaced below with
citations verified by actually reading each location.**

Neither #150 (silent process death) nor this specific multi-tool
repeated-failure interaction has an existing test:

- `src/engine/loop.ts:153` — `DEFAULT_CONSECUTIVE_ERROR_LIMIT = 3`, the
  generic consecutive-mistake limit. It counts ANY mistake (error,
  parse failure, empty result, identical repeat) toward one shared
  counter — it has no concept of "this specific tool has failed
  repeatedly across a multi-tool turn," only a flat total.
- `src/engine/loop.ts:3052` — `excludedToolCooldowns`, the identical-call
  guardrail's tool-exclusion mechanism (issue #153's interaction
  partner). No existing test exercises this cooldown excluding a tool
  at the SAME time the repeated-tool-failure nudge (issue #146's fix)
  is telling the model to use that exact tool for re-diagnosis.
- `src/engine/__tests__/loop.test.ts:1840` —
  `testToolFailureNudgeFiresOnVariedArgsRepeatedFailure`, the only
  existing test for #146's fix. It uses a SINGLE tool (`edit_file`)
  failing twice in a row — it never exercises a MIXED-tool turn (e.g.
  `read_file` + `edit_file` + `execute_command` in one batch, or
  interleaved across turns) or the cooldown interaction from #153.
- `src/cli.ts:1264` — the process's real entry point
  (`if (import.meta.url === ...) { main().then(...) }`). It catches a
  rejected `main()` promise, but nothing here or in `loop.ts` registers
  a `process.on("SIGTERM"|"uncaughtException"|"unhandledRejection")`
  handler (confirmed via `grep -rn` across both files: zero matches) —
  there is no code path that guarantees a final log line before the
  process disappears, which is exactly #150's observed failure mode.