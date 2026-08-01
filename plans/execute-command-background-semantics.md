# Fix execute_command timeout semantics — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled assertions, `All N tests passed` trailer — see
`src/tools/__tests__/*.test.ts` for the pattern); add new test files to
`package.json`'s `test` script the same way existing entries are chained with
`&&`; `npx tsc --noEmit` and `npm test` (currently 22 suites) must stay green.

## The problem

This is a small, tightly-scoped correctness fix, not a big feature. The
vendored `execute_command` tool's own documented contract (read
`zoo-code/src/vendor/zoo-code/src/core/prompts/tools/native-tools/execute_command.ts`
— note the ACTUAL path may just be
`zoo-code/src/core/prompts/tools/native-tools/execute_command.ts` in the full
reference clone at `zoo-code/`, check both) says, verbatim:

> timeout: (optional) Timeout in seconds. When exceeded, the command keeps
> running in the background and you receive the output so far. Set this for
> commands that may run indefinitely, such as dev servers or file watchers,
> so you can proceed without waiting for them to exit.

headlesscode's actual implementation, `executeCommandHandler` in
`src/tools/executor.ts`, does NOT do this. On timeout it does:

```ts
const timer = setTimeout(() => {
    child.kill("SIGKILL")
}, timeoutS * 1000)
```

It kills the process outright and returns whatever output was captured up to
that point. This is a real behavioral difference from what the tool's own
prompt text (which the model reads and relies on to decide how to use the
tool) promises. A worker that starts a dev server or a long migration with an
explicit `timeout` value, expecting to get control back while the process
keeps running, will instead have that process killed — which is exactly
wrong for the target repo's own established patterns (its QA mode
instructions specifically rely on long-running background processes like
`./scripts/run_web.sh` staying alive after control returns).

## What to build

Change `executeCommandHandler` in `src/tools/executor.ts` so that when the
timeout elapses:

1. The child process is **NOT killed**. It keeps running, detached from the
   tool call's own return, exactly as the tool's documented contract
   promises.
2. The tool result returned to the model at the timeout point contains
   whatever stdout/stderr was captured so far, clearly marked as a timeout
   (not a completion) — e.g. prefix/suffix the output with something like
   `[execute_command] timed out after Ns — process is still running in the
   background, output captured so far:` so the model can tell the difference
   between "the command finished" and "the command is still going." Look at
   how the existing success/timeout-adjacent code paths format their output
   (`ok(...)`/`err(...)` helpers already in this file) and stay consistent.
3. This is NOT an error result (`isError: true`) — a timeout in this sense is
   expected/intentional behavior the model asked for via the `timeout` arg,
   not a failure. Don't let it count toward the consecutive-mistake bounded
   failure counter in `src/engine/loop.ts`.
4. The now-detached child process must not become a resource leak across a
   whole session or a whole worker's lifetime:
   - Continue draining its stdout/stderr in the background (don't let the
     pipe buffers fill up and block the child) even after the tool call has
     returned.
   - Make sure the harness process itself can still exit cleanly at the end
     of a session even if a backgrounded child is still running (check how
     Node's process exit behaves with a still-running detached child — you
     may need `child.unref()` or similar so the backgrounded process doesn't
     keep the harness's own event loop alive waiting on it).
   - Think about what happens if the SAME session later calls
     `execute_command` again for something like `docker compose down` or
     `pkill` intended to clean up the earlier backgrounded process — that
     should keep working normally, this fix shouldn't need any new tracking
     mechanism for the model to reference the backgrounded process (it can
     just target it by port/name/pattern the same way a human would, same
     as today).
5. **Preserve the existing "hard kill" path where it's actually correct**:
   if the whole harness process itself is being torn down (e.g. the CLI
   process exits, or the loop hits a bounded failure / budget-exceeded abort
   and the session is ending for good), it's fine — arguably correct — for
   any still-running backgrounded child processes to be cleaned up at that
   point rather than orphaned forever. Distinguish "a single tool call timed
   out mid-session, keep going" from "the session itself is ending, clean up
   everything" — don't conflate the two. Check how the harness already
   handles cleanup at session end (if any) as a starting point.

## What NOT to do

- Do not change the default timeout value (`DEFAULT_COMMAND_TIMEOUT_S = 120`)
  — that's a separate, much smaller judgment call and not what this task is
  about. Only the *behavior* at timeout is changing, not the duration.
- Do not add process-tracking/PID-registry infrastructure beyond what's
  strictly needed to (a) drain output and (b) clean up at true session end —
  keep this a minimal, targeted fix.
- Do not touch checkpoint, decision-escalation, dashboard, or orchestrator
  code — this is scoped entirely to `execute_command`'s own handler in
  `src/tools/executor.ts` (and whatever minimal session-teardown hook is
  needed in `src/engine/loop.ts` to satisfy point 5 above).

## Tests

Add to `src/tools/__tests__/` (new file or extend the existing executor test
file if one already covers `execute_command` — check first):

- A command that runs longer than its `timeout` arg: confirm the tool result
  is NOT `isError: true`, confirm it includes the partial output captured so
  far, confirm the process is still alive immediately after the tool call
  returns (e.g. spawn something that writes a marker file after a delay
  longer than the timeout, then check after the tool call returns — before
  that delay elapses — that the process hasn't been killed, then wait past
  the delay and confirm the marker file DID eventually get written, proving
  it kept running).
- A command that finishes well within its timeout: confirm totally normal
  behavior, unaffected by this change.
- A real session-level test (or extend one in `src/engine/__tests__/`)
  proving a timed-out `execute_command` call does NOT increment the
  consecutive-mistake counter.
- A test proving that when the session itself ends (normal completion, not
  mid-timeout), no zombie/orphaned test-harness child processes are left
  behind that would fail a CI runner's process-count sanity checks (use
  something introspectable in-process, e.g. tracking a `pid` and checking
  `process.kill(pid, 0)` throws afterward — don't rely on OS-level `ps`
  shelling out if you can avoid it, keep it portable).

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Run all five e2e suites under `scripts/e2e*/run.sh` — confirm nothing
   regressed (none of them currently rely on the old kill-on-timeout
   behavior as far as is known, but verify rather than assume).

## What to report back

- Files changed.
- Confirmation of tsc/test/e2e results (actual pass/fail counts, not just
  "they pass").
- How you solved the "don't leak the harness process's own exit" problem
  (point 4) — explain the mechanism you used.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or gap,
  even if unfixed — flag it rather than ignoring it.
