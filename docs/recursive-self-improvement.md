# Recursive Self-Improvement

`headlesscode improve` is an intentionally bounded experiment for improving the
agent harness under an external evaluator. The supervisor owns the evaluator,
fitness calculation, archive, and selection decision. The local worker model
only proposes changes inside an isolated candidate worktree.

## Phase 1: Implemented

Phase 1 established the mutation-to-evaluation loop: a worker session runs in a
git worktree, regression and visible/hidden commands are measured, hard gates
protect acceptance, and a JSON/Markdown record is written. The worker default
is local Qwen through Ollama. The initial real run produced two bounded worker
failures and selected no candidate, which is retained as experimental data.

The phase-one audit found four constraints that shaped phase two: candidate
execution was sequential, `--max-concurrent` was only parsed, the archive was
written at the end of a run with no checkpoint/resume state, and the next
generation followed only one scalar champion. Hidden commands were not shown in
the mutation prompt, but their tracked scripts were still physically present
in candidate worktrees.

## Phase 2: Current Work

The current extension adds archive v2 migration and active-run checkpoints,
resume support, explicit champion/specialist/novelty and Pareto parent policies,
raw multi-objective metric vectors, mutation hypotheses and classes,
resource-tagged experiment jobs, model-candidate and harness/model-combination
records, structured transcript-backed trajectory exports, and deterministic
curriculum proposals from recurring failures. Hidden commands now execute from
the supervisor checkout with `HEADLESSCODE_RSI_CANDIDATE_ROOT` identifying the
candidate under test.

These pieces are deliberately small interfaces. They make the research data
and lifecycle explicit without pretending that a training backend, adversarial
critic, or OS-level sandbox exists yet.

## Loop

1. Resolve a base commit and create a small population of candidate worktrees.
2. Ask the worker model to make a focused, test-backed improvement.
3. Inspect the candidate before evaluation. Changes to `src/rsi/`, `scripts/`,
   tests, package metadata, git metadata, and configured protected paths are
   rejected before candidate-controlled tests execute.
4. Run regression tests and visible evaluations, followed by supervisor-only
   hidden evaluations when configured.
5. Apply hard gates, calculate a multidimensional fitness score, select the
   highest-scoring candidate, and retain the result in a JSON archive.
6. Write a Markdown report so a person can inspect the generation without
   reconstructing the run from logs.

The initial worker default is the locally installed `wxrq-qwen3.5-9b:latest`
model. Override it with `--model`. The worker is invoked through the existing
Ollama backend, so the normal local-model guardrails remain active.

## Usage

```sh
npx tsx src/cli.ts improve --repo . --dry-run
npx tsx src/cli.ts improve --repo . --population 2 --generations 1
```

The default archive is `.headlesscode/rsi/archive.json`; generation reports are
written beside it. Candidate worktrees live under `.worktrees/rsi/` and are
removed after evaluation unless `--keep-worktrees` is supplied. Dry runs resolve
the base commit and print the planned candidates without creating worktrees or
writing the archive.

## Fitness and safety

Regression success is the first hard gate. Visible and hidden evaluations,
completion, absence of a crash, and protected-path integrity are also gates.
The score combines regression, visible evaluation, hidden evaluation,
efficiency, and recovery components. A candidate that fails a hard gate cannot
be selected even when its partial score is high.

Trajectory datasets are written as separate `sft.jsonl`, `preferences.jsonl`,
and `failures.jsonl` files with a manifest. Only independently verified success
trajectories enter the SFT or preferred side of a preference pair.

This is an experiment, not an unattended permission escalation mechanism. The
candidate process receives no hidden evaluation details, and the supervisor
must remain the only writer of archive and scoring state. Future work should
move from post-hoc protected-path checks to a stronger OS-level sandbox before
running untrusted candidate code for long periods.

## Future Phases

- Add adaptive multi-trajectory compute and critic/adversarial evaluation.
- Connect the model-candidate interface to one small external LoRA/QLoRA
  backend, then evaluate model × harness factorial cells.
- Add cross-model role routing, curriculum validation from executable fixtures,
  plateau detection, regression retention, and meta-evaluation of mutation
  strategies.
- Add OS-level isolation and artifact hashing before treating the loop as a
  long-running unattended research process.
