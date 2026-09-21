# headlesscode v1.2.1

Released 2026-09-21.

## Fixes

- Malformed `attempt_completion` results now fail closed as bounded session
  failures. Recursive child sessions return an honest failure to their parent
  instead of promoting malformed completion data into the next prompt.

## Verification

- `npm run typecheck`
- `npm test` (147 test files passed)
- `bash scripts/e2e/run.sh` (9 assertions passed)
- `git diff --check`

# headlesscode v1.2.0

Released 2026-09-20.

This release adds the first bounded recursive self-improvement workflow to
headlesscode. It lets a local worker propose focused harness changes while a
supervisor owns the evaluator, fitness calculation, archive, and selection
decision.

## Highlights

- Added `headlesscode improve` with dry-run planning, isolated candidate
  worktrees, regression/visible/hidden evaluation gates, Pareto-aware parent
  selection, checkpoints, resume support, and generation reports.
- Added local Qwen 3.5 9B support through the existing Ollama backend as the
  default worker path for the RSI loop.
- Added trajectory capture and export into SFT, preference, and failure
  datasets, with trusted-success filtering and a manifest hash.
- Added model-candidate, harness/model-combination, resource-tagged job, role,
  and curriculum proposal records so future training and supervision work has
  explicit provenance.
- Reworked the README for people evaluating or installing the project, with
  CI, npm, Node.js, and license badges plus an honest RSI roadmap.

## Verification

- `npm run typecheck`
- `npm test` (147 test files passed)
- `git diff --check`

## Known limitations

The current recursive self-improvement loop is deliberately bounded and does
not claim capabilities it does not yet have. Follow-up work is tracked in
GitHub issues for [OS-level sandboxing](https://github.com/Capsize-Games/headlesscode/issues/3),
[cryptographic evaluator integrity](https://github.com/Capsize-Games/headlesscode/issues/4),
[resource-aware scheduling](https://github.com/Capsize-Games/headlesscode/issues/5),
[adaptive multi-trajectory search](https://github.com/Capsize-Games/headlesscode/issues/6),
[curriculum validation](https://github.com/Capsize-Games/headlesscode/issues/7),
[adversarial and cross-model supervision](https://github.com/Capsize-Games/headlesscode/issues/8),
and a [real LoRA/QLoRA backend](https://github.com/Capsize-Games/headlesscode/issues/9).
