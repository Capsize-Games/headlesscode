# headlesscode v1.2.2

Released 2026-09-28.

## NVIDIA OpenShell and security enhancements

- Added an NVIDIA OpenShell execution provider for orchestrated workers,
  planning, continuation, review, QA, and rework, plus a one-off
  `openshell-session` command. Each session runs from a disposable Git clone;
  the host worktree and harness control files are not mounted in the sandbox.
- Validate and import worker results only after sandbox deletion. Bundle checks
  enforce size, expected branch, ancestry, and unchanged host branch state.
- Added OpenShell setup guidance, a worker image, sample provider profile and
  policy, and lifecycle tests. A live OpenShell 0.1.2 gateway run completed a
  DeepSeek V4 Flash task through OpenRouter and imported its result.
- Hardened iteration-boundary callbacks and added a bounded synthetic monitor
  pilot. The pilot uses local scripted trajectories and does not establish
  real-model monitoring effectiveness.

OpenShell Landlock permissions are additive. The prior host-worktree mount was
removed after a live probe showed that nested read-only rules did not revoke
write access inherited from a writable parent. The current provider mounts a
disposable clone instead. NVIDIA Sentry, BlueField enforcement, hardware
telemetry, quarantine, and hardware-level containment are not configured.
Committed secrets remain readable through Git history in the clone; do not
commit credentials to a repository.

## Verification

- `npm run typecheck`
- `npm test` (151 test files passed; the optional 6 Chromium tests were run
  separately after installing Playwright Chromium)
- `npm test -- browser-action` (6 tests passed)
- `bash scripts/e2e/run.sh` (9 assertions passed)
- `bash -n scripts/run-worker.sh scripts/spawn-parallel-worktrees.sh scripts/stop-worker.sh`
- `git diff --check`

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
