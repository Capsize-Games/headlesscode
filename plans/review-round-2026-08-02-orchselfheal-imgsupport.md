# Independent review — 2026-08-02 two-task direct-path batch (worktrees still live)

Follow `plans/review-mode-prompt.md`'s full operating procedure — this document
only adapts it for this specific round. **Both worktrees are still live under
`.worktrees/` and NOT yet merged** — review each against its checked-out branch
before any merge happens. The coordinator will not merge on self-verification
alone.

**Why this review exists:** this round used the direct task-file path
(`spawn-parallel-worktrees.sh`), which has no automated review/rework step by
design. Both tasks were flagged significant by the round coordinator: one
changes core orchestrator state/status semantics, the other adds a brand-new
subsystem (cloud vision captioning) with a real-money model-choice evaluation
and cost-accounting wiring. Treat every claim in both workers' reports as
unverified until you personally reproduce it.

**Important about your workspace:** your own workspace is `.worktrees/review-r3`
— the two worktrees under review are SIBLINGS, not children of your workspace.
Use absolute paths for everything:
- orchselfheal worktree: `/home/joe/Projects/headlesscode/.worktrees/orchselfheal`
- imgsupport worktree: `/home/joe/Projects/headlesscode/.worktrees/imgsupport`

Run commands via `execute_command` with `cd <worktree-abs-path> && ...` (e.g.
`cd /home/joe/Projects/headlesscode/.worktrees/orchselfheal && npx tsc --noEmit`).
`git -C <abs-path>` also works for diffs/logs. If a read tool rejects paths
outside your workspace, fall back to `git -C <abs> diff/show` and
`cd <abs> && cat` through `execute_command` — the diff is what matters, not
which tool produced it.

## The two worktrees + their specs

1. **orchselfheal** — `.worktrees/orchselfheal` (branch
   `issues/orchselfheal-2026-08-02`), spec
   `plans/orchestrate-status-self-healing.md`. Work commit `3dad5b6`
   ("orchestrate status: reconcile stale group state against real worktree
   markers"). Diff vs master: 5 files, +507/−55 — `src/orchestrator/status.ts`
   (+231), `src/orchestrator/cli.ts` (+83), `src/orchestrator/state.ts` (+20),
   `src/orchestrator/index.ts` (+11), `src/orchestrator/__tests__/status-cli.test.ts`
   (+217). Worker's own report claims: tsc clean, all 73 suites pass
   (status-cli.test.ts 20/20), `scripts/e2e-phase2/run.sh` PASS 16/16, and a
   manual incident reproduction done against a scratch copy (real state file
   never touched). It also reports the working tree clean except untracked
   round artifacts — the commit 3dad5b6 was verified by the coordinator.

2. **imgsupport** — `.worktrees/imgsupport` (branch
   `issues/imgsupport-2026-08-02`), spec `plans/image-support.md`. Work commits
   `0af220f` ("image support: cloud vision captioning...") + `c2309c0`
   ("docs: vision captioning subsystem..."). Diff vs master: 16 files, +1251/−26.
   New subsystem: `src/vision/describe.ts` (+242), `src/vision/tool.ts` (+91),
   `src/vision/__tests__/describe.test.ts` (+303), `src/tools/__tests__/describe_image.test.ts`
   (+223); wiring into `src/tools/browser/tool.ts`/`handler.ts`,
   `src/tools/executor.ts`, `src/engine/loop.ts` (+62), `src/budget/cost.ts`
   (+9), `src/engine/types.ts` (+30), `src/engine/prompt.ts`, `src/cli.ts`,
   `.roo/rules-code/rules.md`, `package.json`, new `docs/vision.md`. IMPORTANT
   CONTEXT: the worker's first session hit its 150-iteration cap mid-final-
   verification (e2e sweep running) and was RESUMED by the coordinator — the
   resume session (commit c2309c0 + final report) completed with exit 0. Its
   report claims: tsc clean, all suites pass, all e2e suites pass, a real
   model evaluation with real OpenRouter candidates and cost numbers, a real
   screenshot-to-description-to-diagnosis smoke test, and real
   `usage/*.jsonl` evidence for captioning cost. Verify these — the project
   owner explicitly said they will check the evaluation evidence.

## Prioritized review items — read before anything else

### 1. orchselfheal — core orchestrator state semantics (the genuinely dangerous class)

Verify personally, not from the report:
- `cd /home/joe/Projects/headlesscode/.worktrees/orchselfheal && npx tsc --noEmit`
  and `npm test` — compare actual suite/pass counts to the claims.
- Re-run `bash scripts/e2e-phase2/run.sh` in the worktree (the change touches
  `src/orchestrator/` and the e2e-phase2 suite is the one that exercises real
  status/watch flows).
- **The reconciliation rules themselves** (`src/orchestrator/status.ts` diff):
  (a) worktree exists + `.harness.done` present → reconcile to `done` (exit 0)
  or `failed` (non-zero), set `exit_code`, PERSIST to state file via
  `updateGroup`/`saveState` (read the actual persistence call — is it real, and
  does it write to the right file?); (b) worktree entirely gone + non-terminal
  → new `"orphaned"` status, terminal for `--wait`, rendered DISTINCTLY from
  `done` in both text and `--json`; (c) worktree exists but no `.harness.done`
  → left `running` (absence-of-evidence must NOT be treated as done/failed).
- **What NOT to do compliance**: `watch.ts` must be untouched; no
  auto-reconstruction of outcomes from git history.
- **`--json` `reconciled` field** exists and lists groups patched by the pass;
  the one-shot form (no `--wait`) runs the same reconciliation.
- The new `"orphaned"` status is documented in `state.ts`'s `OrchestratorGroup`
  doc comment alongside existing values, and the type/union actually accepts it.
- **Reproduce the incident yourself** on a scratch copy (`.headlesscode/scratch/`,
  NEVER the real state file): a `running` group with a real `.harness.done` +
  `.harness.exit`(0) → reconciles to done and the state file on disk is
  updated; a `running` group whose worktree path doesn't exist → orphaned; a
  `running` group with worktree present but no marker → left running; `--wait`
  with only a stale-but-reconcilable group returns promptly (not waiting out
  the timeout).

### 2. imgsupport — new subsystem + real-money evaluation + cost accounting

Verify personally:
- `cd /home/joe/Projects/headlesscode/.worktrees/imgsupport && npx tsc --noEmit`
  and `npm test` — compare suite/pass counts to claims (new suites:
  `describe.test.ts`, `describe_image.test.ts`, extended browser-action test).
- Re-run every e2e suite under `scripts/e2e*/run.sh` in the worktree (the spec
  requires all of them).
- **The model evaluation** — the project owner will check the evidence. Find
  the eval artifacts (the worker said outputs live under
  `.headlesscode/scratch/eval/` and `.headlesscode/scratch/smoke*` in the
  worktree). Confirm: real candidate models spanning the price range tested
  (not just the cheapest), real per-image cost numbers, and a real quality
  comparison quoting actual descriptions side by side. Confirm the chosen
  default model is justified against the "cheapest that isn't materially worse
  than the quality anchor" bar — not hardcoded on a guess. If the eval was NOT
  actually run for real, that is a FAIL finding (the spec explicitly says to
  say so plainly rather than claim it ran).
- **Cost/usage accounting** (`src/budget/cost.ts` + `src/engine/loop.ts` diff):
  captioning calls must flow into the SAME usage-tracking path as regular LLM
  calls with real token/cost numbers — check for a real `usage/*.jsonl` entry
  (the worker claims one exists; find it and read it), and read the loop.ts
  diff for how the aux vision call is recorded. This is the cost-relevant
  claim in the round — get it right. Also check it doesn't break prompt-cache
  stability (the aux call must not inject non-deterministic content into the
  main loop's sent prefix).
- **`describeImage` request shape** (`src/vision/describe.ts`): base64
  `image_url` content part, direct HTTP to OpenRouter, `HEADLESSCODE_VISION_MODEL`
  env default, uses `HEADLESSCODE_OPENROUTER_API_KEY`.
- **Path safety**: `describe_image` tool reuses `resolveWithinWorkspace` (must
  not re-derive its own path logic); missing-file error is clear.
- **What NOT to do compliance**: `ChatMessage`/`LlmRequest`/`LlmResponse` core
  types must NOT have gained multimodal content-array support; no local Ollama
  vision model; no dashboard image-upload UI built (docs/vision.md may FLAG it
  as a follow-up but must not implement it).
- **Tool-adoption nudge**: `.roo/rules-code/rules.md` has a short scannable
  entry telling the model when to reach for `describe_image` (match the
  existing compact bullet-list format, not a long prose paragraph).

## Everything else — standard adversarial pass

Apply `review-mode-prompt.md`'s full procedure to both diffs (read the whole
diff — both are under ~1300 lines; for imgsupport prioritize executor/loop/
budget/vision files first, then sample the rest). Specifically:
- orchselfheal: check the one-shot `--json` shape change didn't break the
  pre-existing shape tests in a way that weakens what they assert (the worker
  noted it updated fixtures — verify the updates are honest, not tests made
  weaker to pass).
- imgsupport: `src/tools/browser/tool.ts`'s screenshot result must return a
  real description (not the old "read it back if your model supports images"
  dead-end) — check the handler/tool wiring end to end; `src/cli.ts` changes
  (why did a vision feature touch cli.ts? read the diff and confirm it's
  legitimate); `package.json` (test-script chaining for the new test files,
  and confirm no new runtime dependency was added without reason).

## What to report back

Follow `review-mode-prompt.md`'s verdict format exactly: pass/fail per
worktree (not just an overall verdict), with real command output as evidence
for anything you confirm, and file:line-precise, actionable findings for
anything you don't. Lead with: (1) the orchselfheal reconciliation rules
reproduced for real, (2) the imgsupport model evaluation + cost/usage evidence
— the project owner is waiting specifically on whether those are real.
