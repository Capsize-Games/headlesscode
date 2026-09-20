# RSI Progress

Last updated: 2026-09-20

The first bounded RSI slice is implemented in `src/rsi/` and exposed as
`headlesscode improve`.

Phase two is now in progress without replacing the phase-one controller.

Current state:

- Local worker default is `wxrq-qwen3.5-9b:latest` through the Ollama backend.
- Candidate worktrees, lineage metadata, protected-path checks, regression and
  evaluation trials, hard gates, fitness scoring, JSON archive, and Markdown
  generation reports are implemented.
- `--dry-run` resolves the base commit and prints the planned population
  without creating worktrees or writing archive state.
- The evaluator rejects protected-path changes before running candidate tests.
- Archive v2 migrates the phase-one JSON shape, checkpoints active runs after
  lifecycle transitions, and supports `--resume <run-id>`.
- Parent selection now records champion, specialist, novelty, Pareto, or archive
  reasons; candidates carry hypotheses, mutation classes, raw metric vectors,
  and explicit model/harness combination ids.
- Captured Ollama/OpenRouter transcripts can be normalized into trajectory files
  and filtered into SFT, preference, and failure-analysis JSONL datasets.
- Repeated failure classes produce untrusted curriculum proposals with an
  executable ground-truth command that still requires validation.
- A real phase-two Qwen run completed as
  `rsi-20260920091313-78f3e206`: the supervisor baseline passed, the worker
  reached the bounded eight-iteration cap, no candidate was accepted, and the
  v2 archive retained the failed trajectory, report, curriculum proposal, and
  completed job state.
- The full repository suite passed 147 test files after these changes.
- Verification completed: `npx tsc --noEmit` and `npm test -- --filter rsi`
  passed. A real two-candidate run completed as
  `rsi-20260920025005-b0ef3ddf`; both Qwen workers hit the bounded 20-iteration
  cap, both worktrees were cleaned, and no candidate was selected. The failure
  evidence is retained in the local archive and report.

Local Qwen review completed on this checkpoint. It identified three follow-up
hardening items: replace post-hoc path checks with OS-level sandboxing, expose
only supervisor-approved evaluation endpoints to candidates, and hash critical
evaluator/archive artifacts before use. These are recorded as next work rather
than claimed as implemented.

The adaptive compute policy is currently a planning abstraction and mutation
prompt input; it does not yet launch multiple worker trajectories. Model
candidate records and the external training backend interface exist, but no
LoRA/QLoRA training run is claimed. Curriculum proposals remain untrusted until
their executable ground truth is validated.

The durable per-run records live under `.headlesscode/rsi/`, which is ignored
by git so repeated experiments do not create source churn. The evaluator,
scoring code, and hidden evaluation commands remain supervisor-owned.
