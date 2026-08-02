# `headlesscode orchestrate status` — a clean, structured replacement for ad hoc polling loops

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop, with a
multi-agent orchestrator (`headlesscode orchestrate`, `src/orchestrator/`)
that spawns worker sessions in separate git worktrees and tracks their
progress in `.worktrees/.orchestrator-state.json` (schema:
`src/orchestrator/state.ts`'s `OrchestratorState`/`OrchestratorGroup`).

## Why this exists

The project owner's separate, interactive orchestrator agent (a Zoo Code
"multi-agent-orchestrator-headless" mode running in VS Code, in a sibling
project `~/Projects/airunner`, NOT part of this repo) currently checks on
spawned workers with a raw bash polling loop written inline as an
`execute_command` call: a `for` loop, up to 20 iterations, `sleep 25`
between each, re-deriving status by `grep`-ing magic strings out of
`harness.log` (`"MAX_ITERATIONS (exit"`, `"BUDGET_ABORT (exit"`, etc.) and
checking marker files (`.harness.done`, `.harness.needs-decision`) by hand.

This is fragile (a log-message wording change silently breaks the grep),
wasteful (one tool call + full log tail per check, ~20 near-identical
"running (pid ...)" lines dumped into the calling agent's context over a
single wait), and duplicates information `.orchestrator-state.json` already
tracks in real time, structured, via `src/orchestrator/watch.ts`. The
project owner explicitly asked for something cleaner — "we need to come up
with something cleaner" — because this genuinely burns context/tokens for
no benefit, directly opposed to this project's stated efficiency goals.

## What to build

A new `headlesscode orchestrate status` subcommand (`src/orchestrator/cli.ts`
already dispatches `orchestrate`'s subcommands — check its current structure
before adding a new one, follow whatever precedent exists for adding a
subcommand there).

### 1. One-shot status (baseline)

```
headlesscode orchestrate status --repo <path> [--json]
```

Reads `.worktrees/.orchestrator-state.json` (via `loadState`/`loadStateSync`,
already built in `src/orchestrator/state.ts` — do not re-implement
parsing) and prints a compact per-group summary: name, status, last activity,
review verdict if present, usage if present. `--json` prints the raw/lightly
shaped `OrchestratorState` for programmatic consumption instead of the
human-readable table. This alone replaces "one grep-laden bash loop
iteration" with "one clean call."

### 2. The actual win: `--wait`

```
headlesscode orchestrate status --repo <path> --wait [--timeout-ms <n>] [--json]
```

Blocks **inside this one process** (not the calling agent re-invoking a tool
repeatedly) until every group in the state file reaches a terminal status
(`"done"`, `"failed"`, `"needs-human"` — check `state.ts`'s doc comment for
the full terminal set; `"blocked"` is explicitly NOT terminal, it's a
decision-escalation wait state that should keep this command waiting, not
exit early) or `--timeout-ms` elapses (default: your call, document the
reasoning — something on the order of the existing 2h stall-guard timeout in
`watch.ts` is a reasonable ceiling).

Implementation: poll the state file internally with a reasonable interval
(a few seconds — this runs once, inside one `execute_command` call from the
calling agent's perspective, so the interval doesn't cost the calling agent
anything the way the old bash loop's per-iteration tool-call overhead did),
OR use `fs.watch`/`fs.watchFile` on the state file for a push-based approach
if that's cleaner — your call, but justify it in your report. Either way,
**the calling agent makes ONE tool call and gets ONE structured result**
when everything's done (or timed out), not N calls with N noisy outputs.

On completion (or timeout), print the same summary shape as the non-`--wait`
form, plus a top-level `allDone: boolean` / one-line verdict ("3/3 groups
done, 0 failed" or "timed out after 2 of 3 groups done"). Exit code should
reflect outcome: 0 if all groups reached a clean terminal state (`done`),
non-zero if any group is `failed`/`needs-human` or the wait timed out —
this lets a calling script/agent branch on exit code alone without even
parsing output if it just wants a yes/no.

### 3. Update the interactive orchestrator's own instructions

This is a real, in-scope part of the task, not an afterthought: update
`~/Projects/airunner/.roomodes` (the `multi-agent-orchestrator-headless`
mode) and/or its rules file to use `headlesscode orchestrate status --wait`
instead of the inline bash polling loop shown to the project owner. Read the
existing polling loop pattern in that file first (search for the `for i in
$(seq` idiom or similar) and replace it, keeping any genuinely
orchestrator-specific logic (e.g. what to do once done) but removing the
grep-based status derivation entirely.

## What NOT to do

- Do not touch `watch.ts`'s own internal polling loop (the one that
  actually monitors live worker processes and writes state) — that's a
  different, already-working mechanism. This task only adds a read-side
  status command for an EXTERNAL caller (the interactive orchestrator agent)
  to use instead of hand-rolling its own polling.
- Do not change `.orchestrator-state.json`'s schema — this is a pure
  read-side addition against the existing, already-structured data.
- Do not build a general-purpose "watch any file" utility — scope this
  specifically to orchestrator state.

## Tests

`src/orchestrator/__tests__/status-cli.test.ts` (or extend `cli.test.ts` if
that fits the existing structure better):
- One-shot status against a fixture state file with a mix of
  running/done/failed groups — assert the printed summary and `--json`
  output shape.
- `--wait` against a state file that starts with groups running and
  transitions to done partway through (simulate by writing the state file
  from the test after a short delay, or by injecting a fake state-reader if
  that's cleaner for the polling-interval logic) — assert it returns once
  all groups are terminal, not before.
- `--wait --timeout-ms` against a state file that never completes — assert
  it returns (does not hang forever) with a non-zero exit and a clear
  "timed out" indication.
- Exit code correctness for done/failed/timeout cases.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual: run this against the real, live `.worktrees/.orchestrator-state.json`
   in this repo (there will be real state there from ongoing rounds) and
   confirm the output is sensible against real data, not just fixtures.

## What to report back

- Files changed/added.
- Your choice of poll-interval vs. fs.watch for `--wait`, and why.
- Your chosen default `--timeout-ms` and reasoning.
- Confirmation of tsc/test/e2e results.
- Whether `~/Projects/airunner/.roomodes` was actually updated, and if not,
  why (e.g. if that file isn't accessible from this worktree — flag this
  clearly rather than silently skipping it, since it's the actual point of
  the "why this exists" section above).
- Any deviation from this spec, and why.
