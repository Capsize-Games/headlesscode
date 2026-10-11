# Project work and harness repair

`headlesscode work-loop` runs a finite queue of repository tasks. After each
attempt, the host supervisor checks recorded observations and can request a
separate HeadlessCode repair. A repair must pass an independent regression
check and the observation's reproducer before a new worker uses its runtime.
Failed project tasks can then retry with the verified harness revision.

```sh
headlesscode work-loop --config /operator/campaign.json --driver /operator/driver.mjs
```

Both files are trusted operator inputs. Keep them and the ledger outside
worker-accessible repositories and sandbox mounts. The driver exports
`createWorkLoopDriver(config)` and implements the `WorkLoopDriver` interface
in `src/rsi/work-loop.ts`. The command imports this module as host code; it
does not sandbox an untrusted driver. Use the existing contained execution
profile for worker isolation and external evidence collection.

The JSON configuration contains:

```json
{
  "tasks": [{ "id": "issue-123", "prompt": "Fix issue 123 and preserve existing behavior." }],
  "harness": { "commit": "0123456789abcdef0123456789abcdef01234567", "runtimeId": "sha256:immutable-runtime" },
  "ledgerPath": "/operator/run-001.jsonl",
  "maxTasks": 1,
  "maxTaskAttempts": 2,
  "maxRepairs": 2,
  "maxRepairAttempts": 1,
  "maxRuntimeMs": 1800000,
  "maxSpendUsd": 1
}
```

The driver runs tasks and repairs in separate workers. It must enforce the
remaining spending allowance and deadline on every inference call, settle
actual billing for failed calls too, and pass the phase's `AbortSignal` to
active requests and child processes. Verification, activation, and acceptance
callbacks perform host checks and must not make unaccounted inference calls.
Unknown charges stop the loop before further work. Verification verdicts bind
to full candidate commit SHAs; worker completion text is insufficient.

`confirmObservation` independently qualifies a finding before requesting a
repair. Tool errors and configured timing thresholds are signals to inspect,
not proof that changing the harness will help. Worker suggestions about
missing tools or improvements can enter this path with a concrete evidence
reference and an independent reproducer. `workObservationsFromEvents` provides
deterministic tool-error, missing-tool, and slow-tool findings from a session's
structured events. It does not classify provider latency as a harness defect.

Repairs can use the existing workspace skills, extension tools, and MCP bundle
interfaces. Their validation and permissions still apply. `activateHarness`
creates an immutable executable runtime for the verified candidate and returns
its identity. It never replaces the running supervisor, its evaluator, or its
limits. Future task workers receive that runtime through their phase context.

The command records phase results, observations, independent verdicts,
activations, and the stopping reason in a private hash-linked JSONL ledger.
This record is not a signed evidence collector. Existing ledgers are refused;
restart with a new ledger and an operator-reviewed queue of remaining tasks.
SIGINT or SIGTERM cancels the active phase. The driver is responsible for
terminating its worker and retaining evidence during cleanup.

This is an engineering repair loop. Accepted patches and task success do not
establish a controlled multi-generation performance improvement.
