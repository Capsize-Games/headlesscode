# Phase-gated session loop (explore → plan → implement → verify) — instructions for implementation

## Who you are working on this for

You are implementing this against the `headlesscode` repository — a standalone
Node/TypeScript CLI that runs a headless coding-agent loop (ported from a VS
Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).

Motivation (from the gap analysis that produced this plan): the session loop in
`src/engine/loop.ts` is a flat ReAct loop — the same system prompt, tool set,
and model for the entire session, with termination decided by the model's own
`attempt_completion` claim. The outer pipeline (split → parallel workers →
reviewer → rework) is already staged, but the *session inside each worker* is
not. This plan adds a **phase-gated loop** ("a harness inside the loop"):

1. **Plan artifact** — a durable plan (goals, files, acceptance criteria,
   verification commands) pinned in context, so progress is measurable and the
   harness can check against it.
2. **Phase state machine** — `explore → plan → implement → verify`, with
   per-phase tool enforcement (soft refusals, not hard removal) and a phase
   marker in the transcript.
3. **Verification-gated termination** — `attempt_completion` is only accepted
   after the plan-declared verification commands actually pass (exit-code
   parsed), with a bounded retry cycle and a documented skip path for
   untestable tasks.
4. **In-session reflexion** — on a mistake streak or a failed verification
   round, force a structured diagnose→fix pass before the next action.
5. **Per-phase model routing** — a `_phase` key in the central
   `mode-models.json` assigns cheaper models to explore/verify and the strong
   model to implement.
6. **Observability** — a `phase_transition` event, phase in session reports,
   and phase display in the dashboard.

Everything is behind an **opt-in `phaseGated` session flag (default OFF)** —
zero behavior change for existing sessions until enabled, matching this
project's established measure-first, opt-in conventions (see
`src/engine/local-explore.ts`'s `localExplore` option and
`plans/local-explore-phase-experiment.md`). Rollout: land opt-in, measure on
real tasks, then flip the default after evidence.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions, an
  `All N tests passed` trailer line. Add new test files to `package.json`'s
  `test` script the same way existing entries are chained with `&&`.
- Every new config-loading path must fail loudly on malformed input (see
  `src/permissions/config.ts`'s handling of
  `<workspaceRoot>/.headlesscode/permissions.json` — a broken config file
  throws with a clear message, it never silently falls back). This is the
  established idiom for `.headlesscode/*.json` local config files; follow it
  exactly for the new `_phase` parsing in `src/config/mode-models.ts`.
- `npx tsc --noEmit` and `npm test` must stay green. Re-run every e2e suite
  under `scripts/e2e*/run.sh` afterward (check `package.json`/`scripts/` for
  the current full list — it has grown across several rounds of work, don't
  assume the count from an old comment).
- Do not touch `src/vendor/zoo-code/` (vendored, read-only).
- No new dependencies.

## Verified current state (read these fresh before editing; shapes evolve)

- [`src/engine/loop.ts:1268`](src/engine/loop.ts:1268) — `run()` builds the
  system prompt + tool set **once** for the session's mode, seeds
  `messages = [system, task]`, optionally splices a local-explore handoff at
  index 2 (lines 1335-1351), then calls `runIterations()`.
- [`src/engine/loop.ts:2490`](src/engine/loop.ts:2490) — `runIterations()` is
  the flat loop: pause check → injected-message check → budget tick →
  condensation/truncation → one LLM call (`callMainLlm`, line 2461, which
  passes `model: this.config.model` at line 2466) → parse tool calls →
  parallel read-only wave + serial remainder (lines 2860-2949) → feed `tool`
  results → mistake accounting (lines 3038-3058) → checkpoint.
- [`src/engine/loop.ts:2775`](src/engine/loop.ts:2775) — success is
  model-declared: `attempt_completion` (with the one-time uncommitted-changes
  nudge `COMMIT_NUDGE_CONTENT`, lines 2793-2824) or a text-only reply
  (lines 2831-2837). **Nothing runs or parses tests before accepting.**
- [`src/engine/prompt.ts:363`](src/engine/prompt.ts:363) — `selectToolsForMode`
  picks the tool list from the mode's groups; `modeHasEditGroup` at line 112
  decides edit-capability. Tool list is fixed per session
  (`this.state.tools`).
- [`src/tools/run-tests.ts:1`](src/tools/run-tests.ts:1) — `run_tests` already
  auto-selects the test files relevant to changed files via the real import
  graph (`src/tools/test-selection.ts`) and runs them through the same `tsx`
  invocation `npm test` uses. Its description tells the model to run the full
  suite before completion — **advisory, not enforced**. The handler
  (`runTestsHandler`, line 210) currently returns text; there is no structured
  exit-code/pass-fail result the harness could gate on.
- [`src/config/mode-models.ts:1`](src/config/mode-models.ts:1) — central
  `mode-models.json` maps mode → model with `_default`, `_condensation`, and
  `_reasoning_effort` extra keys (read via `extraKeys`, lines 54-76). No
  per-phase concept.
- [`src/engine/condense.ts:167`](src/engine/condense.ts:167) — condensation
  splices on the `[2, 2+count)` slice, keeping `messages[0]` (system) and
  `messages[1]` (first user) pinned. The stable-prefix invariants
  (`messagesPrefixEquals`, `condensedUpToMsgIndex`, `skipOrphanedToolMessages`)
  are strict and must not be broken (DeepSeek HTTP 400 class on mid-group
  boundaries; see the guard comments).
- [`src/engine/events.ts`](src/engine/events.ts) — `EventFeed` with
  occurrence-order scheduling via `scheduleAux` (see loop.ts:1590); every
  event type is truncation-safe.
- [`src/engine/reports.ts`](src/engine/reports.ts) — `writeSessionReport`
  persists the final report.
- The vendored `DEFAULT_MODES` (`src/vendor/zoo-code/types/mode.ts:174`) are
  `architect`, `code`, `ask`, `debug`, `orchestrator` — there is **no** `plan`
  mode; phase gating is a harness-side construct, not a new mode.

## What to build

### W1 — Verification-gated termination (highest ROI, land first, independent)

**Goal:** `attempt_completion` is accepted only after the plan-declared
verification commands pass, with a bounded retry cycle and a skip path.

1. [`src/tools/run-tests.ts`](src/tools/run-tests.ts) — add a structured
   result alongside the existing text content: `runTestsHandler` (line 210)
   must also return `{ passed: boolean, failed: number, summary: string }`
   (parse exit codes from the `tsx` invocations; keep `spawn` argv-only,
   `shell: false` — the security contract at lines 13-17 is non-negotiable).
   Keep the tool's text output byte-compatible so existing model-facing
   behavior doesn't change; the structured fields are consumed only by the
   harness gate.
2. [`src/engine/types.ts`](src/engine/types.ts) — add gate types:
   `VerificationPlan { commands: string[], mode: "run_tests" | "custom" | "none" }`
   and `GateResult { passed: boolean, summary: string, cycle: number }`.
3. [`src/engine/loop.ts`](src/engine/loop.ts) — in the `attempt_completion`
   block (line 2775), **after** the existing commit nudge (so the ordering
   contract at lines 2799-2823 is preserved) and **only when**
   `this.config.phaseGated && modeHasEditGroup(this.config.mode, this.customModes)`
   (read-only reviewer/QA/local-explore sessions never gate — they have no
   edits to verify), add `runVerificationGate()`:
   - Skip path: `VerificationPlan.mode === "none"` (plan-declared; e.g.
     docs-only tasks) → gate passes trivially.
   - Otherwise run the plan's verification (default: `run_tests` with no
     `paths` — which infers from the session baseline checkpoint / git status —
     then the full `npm test` once, mirroring the tool's own guidance at
     lines 19-24). Parse `GateResult`.
   - Green → proceed to `persistFinalReport` as today.
   - Red → refuse completion: push a `tool` message for `attempt_completion`
     with a findings text (same shape as `COMMIT_NUDGE_CONTENT`), set
     phase → `implement` (W4 wiring; before W4 lands, just continue the loop),
     count one gate cycle. Cap at `gateMaxCycles` (default 3, configurable via
     `HeadlessSessionConfig`); past the cap, accept with a warning in the
     report rather than killing the session — the gate must never lose a
     session's result (same non-fatal philosophy as every auxiliary write in
     this codebase).
   - Gate execution failures (timeout, command missing) are logged and
     **do not** count as `consecutiveMistakes` — a broken verification command
     in the plan is a plan bug, not a model mistake.
4. Tests — [`src/engine/__tests__/verification-gate.test.ts`](src/engine/__tests__/verification-gate.test.ts):
   green→accept, red→refuse+findings, `none`→skip, cycle cap, gate failure
   never throws / never trips mistake accounting, read-only modes never gate.

### W2 — In-session reflexion (independent, small)

**Goal:** on a mistake streak or a failed verification round, force a
structured diagnose→fix pass before the next action.

1. [`src/engine/loop.ts`](src/engine/loop.ts) — in the mistake-accounting
   block (lines 3042-3058) and the verification-gate refusal path, when
   `this.config.phaseGated` and the streak hits a threshold (`reflexionAt`,
   default 2, i.e. the second consecutive mistake), inject a `user`-role
   message (the existing nudge-message idiom, cf. the empty-reply nudge at
   line 2841 and `READ_ONLY_NUDGE_MESSAGE`):
   `[System: diagnose the last failure. State (a) root cause, (b) minimal fix, (c) next action. Do not repeat tool calls without this analysis.]`
   - Injected **once per streak**; resets on any success (same reset rule as
     `lastCallSignature` at line 3057). Never itself counts as a mistake.
2. Tests — extend the loop test file: reflexion appears in the request after
   the second consecutive mistake; absent on success; one per streak.

### W3 — Plan artifact (prerequisite for W4)

**Goal:** a durable, validated plan pinned in context at a fixed position that
condensation never touches.

1. New [`src/engine/plan.ts`](src/engine/plan.ts) — one module owns one layout
   (the established idiom: `src/engine/handoff.ts` for handoff, `src/engine/reports.ts`
   for reports):
   - Layout: `<workspaceRoot>/.headlesscode/plan.md`.
   - `PlanArtifact { goals: string[], files: string[], acceptance: string[], verification: VerificationPlan }`
     (reuse W1's `VerificationPlan`).
   - `readPlan(workspaceRoot)`, `writePlan(workspaceRoot, plan)`,
     `parsePlan(markdown)` — a light, fail-loudly parser with a fixed
     markdown template (sections: `## Goals`, `## Files`, `## Acceptance`,
     `## Verification`). Malformed content throws with a clear message (the
     config idiom), but a *missing* file is not an error (returns `null`).
2. [`src/engine/types.ts`](src/engine/types.ts) — `SessionPhase`,
   `PlanArtifact`, `VerificationPlan`, `GateResult`, `SessionState.phase`
   (default `"explore"`), `HeadlessSessionConfig.phaseGated`,
   `gateMaxCycles`, `reflexionAt`, `SessionResult.gate` (optional
   `{ cycles: number, finalGate: GateResult }`).
3. [`src/engine/loop.ts`](src/engine/loop.ts) — in `run()` after the local
   explore splice (line 1351), when `phaseGated`:
   - If a plan already exists on disk (continuation worker on the same
     worktree — the handoff idiom), read it and splice a synthetic
     `user`-role plan message at index 2: same idiom as `localResult.handoffMessage`
     at lines 1344-1346.
   - If not, the session starts in `explore`; the plan is produced during the
     `plan` phase (W4) and written via `writePlan`.
4. [`src/engine/condense.ts`](src/engine/condense.ts) — the pinned window
   becomes `[0, 2]` (system, first user, plan message). All slice math that
   currently assumes index 2 as the boundary — `computeEvictCount`,
   `condenseOldestTurns`, `maybeCondenseHistory`, `writeIterationCapHandoff`
   (loop.ts:2341, its `startIndex = 2` logic), `skipOrphanedToolMessages` —
   must shift to a single shared `PLAN_PINNED_END = 3` constant (define it in
   `src/engine/condense.ts` and import it). **Do not** hardcode 3 in scattered
   places. When no plan message exists (plan is absent/`null`), the window
   stays `[0, 2)` exactly as today — the presence of the plan must be the only
   thing that widens it.
5. Tests — [`src/engine/__tests__/plan.test.ts`](src/engine/__tests__/plan.test.ts):
   write/read round-trip, fail-loudly on malformed, missing→null; and
   condensation tests: plan message survives condensation, boundary math with
   and without a plan.

### W4 — Phase state machine (depends on W3)

**Goal:** `explore → plan → implement → verify` transitions driven by tool
usage + explicit signals, with **soft** per-phase enforcement and a phase
marker in the transcript.

Design decision (important): **keep the system prompt and the tool list
fixed**; enforce phase rules via loop-level refusals, exactly like the
existing `refusedNewTaskIds` / `refusedSwitchModeIds` pattern (loop.ts:2747-2773
and 2920-2935). Rationale: per-phase system-prompt changes would break the
stable-prefix/prompt-caching design that condensation depends on (see the
constraint section); per-phase tool-list changes would break `state.tools`
stability and the provider cache within a phase. Refusals are **guidance, not
errors** — a refused phase-violating call returns a non-error tool result
(`isError: false`) with phase guidance text, so it never trips
`consecutiveMistakes` (line 3043).

1. New [`src/engine/phases.ts`](src/engine/phases.ts):
   - `SessionPhase = "explore" | "plan" | "implement" | "verify"`.
   - Per-phase allowed tool sets (reuse `READ_ONLY_TOOL_NAMES` and
     `isReadOnlyEquivalentShellCommand` from loop.ts for `explore`):
     - `explore`: read/list/search + code-intel reads + read-only-equivalent
       `execute_command` + `attempt_completion` (a trivial task may complete
       without a plan).
     - `plan`: `explore` set + markdown-only edit tools (`write_to_file` /
       `apply_diff` gated to `*.md` — mirror the architect mode's group
       restriction `["edit", { fileRegex: "\\.md$" }]`) + `update_todo_list` +
       `attempt_completion`.
     - `implement`: everything (no restriction).
     - `verify`: `explore` set + `run_tests` + `execute_command` (full) +
       `attempt_completion` (which triggers W1's gate). **No edit tools.**
   - `phaseMarkerText(phase)` — a stable one-paragraph phase declaration
     (what the phase is for, what the model should do, which tools are
     restricted) used for the transcript marker.
   - `transitionPhase(current, signal, state)` — the transition rules:
     - `explore → plan`: explicit signal (model calls `update_todo_list` with
       a plan, or writes `plan.md`, or calls a new lightweight
       `mark_phase_ready`-style signal — prefer reusing existing tools: writing
       `plans/*.md` or `plan.md` via an md edit, or the model's first edit
       attempt) **or** soft nudge after the read-only stagnation nudge has
       already fired (loop.ts:3096). Permissive: a model that starts editing
       directly from `explore` is nudged once to plan first, then allowed
       through (never hard-blocked).
     - `plan → implement`: plan artifact exists on disk (validated by
       `readPlan`) or the model's first non-md edit attempt.
     - `implement → verify`: the model signals readiness (`attempt_completion`
       call → W1 gate decides), or an edit-then-`run_tests` cycle completes.
       The gate refusal path (W1) forces `verify → implement` (bounded by
       `gateMaxCycles`).
     - `verify → done`: gate green (W1 accepts completion).
   - `refusePhaseViolation(phase, callName)` → guidance text or `null`.
2. [`src/engine/loop.ts`](src/engine/loop.ts):
   - `run()`: init `this.state.phase` from `readPlan` (plan present → start at
     `implement`, since a continuation worker already has a plan) or
     `"explore"`.
   - `runIterations()`: at the top of each iteration (after the injected-
     message check, line 2536), when `phaseGated`: evaluate
     `transitionPhase(...)`; on transition, push the `phaseMarkerText` as a
     `user`-role message (the `switch_mode` transcript-marker idiom,
     lines 2994-3002) and emit a `phase_transition` event (W6).
   - `runCall` (line 2914): before `this.executor.execute`, when `phaseGated`
     and `refusePhaseViolation(this.state.phase, call.name)` returns text,
     short-circuit with that text as a **non-error** result (same shape as the
     refusal branches at lines 2917-2935).
   - `attempt_completion` block: gate stays (W1).
3. Tests — [`src/engine/__tests__/phases.test.ts`](src/engine/__tests__/phases.test.ts):
   each transition rule, permissive fall-through, refusal guidance is
   non-error / not a mistake, marker message content is stable, plan-on-disk
   starts at `implement`.

### W5 — Per-phase model routing (depends on W4)

**Goal:** cheaper models for explore/verify, strong model for implement.

1. [`src/config/mode-models.ts`](src/config/mode-models.ts) — extend the
   central file with a `_phase` key:
   `{ "_phase": { "explore": "qwen/qwen3-8b", "plan": null, "implement": null, "verify": "deepseek/deepseek-v4-flash" } }`
   (`null`/absent phase key = fall through to the normal precedence). Add
   `resolveModelForPhase(workspaceRoot, mode, phase, explicitModel)` with
   precedence: explicit `--model` flag → `_phase[phase]` → mode entry →
   `_default` → `OPENROUTER_MODEL` → `undefined` (client default). Malformed
   `_phase` (non-object, non-string values) throws — the fail-loudly idiom.
   Note the existing `extraKeys` mechanism (lines 54-76) — `_phase` follows
   the same shape, but because it's an object-valued key the current
   string-typed `extraKeys` lookup won't handle it; extend `ResolveModelOptions`
   with an explicit `phase` field instead of shoehorning it through
   `extraKeys`.
2. [`src/engine/loop.ts`](src/engine/loop.ts) — `callMainLlm` (line 2461):
   when `phaseGated`, resolve the model per `this.state.phase` instead of
   `this.config.model` (line 2466). Cost/token accounting already keys on
   `model` per call (lines 2622-2628) — no change needed there.
3. Tests — extend the mode-models tests: `_phase` parsing, precedence order,
   fail-loudly on malformed, null phase key falls through.

### W6 — Observability (independent, small)

1. [`src/engine/events.ts`](src/engine/events.ts) — new `phaseTransition`
   event type `{ from, to, iteration }` (truncation-safe, occurrence-order
   scheduling via the existing `scheduleAux` idiom).
2. [`src/engine/reports.ts`](src/engine/reports.ts) — append a phase timeline
   (phase + iteration ranges) and gate outcome to the session report.
3. [`src/dashboard/server.ts`](src/dashboard/server.ts) + `page.ts` — render
   the current phase from the session-start/phase events (small; the events
   feed already carries everything). Dashboard work is optional polish — do it
   only if it doesn't expand scope.
4. Tests — event ordering (phase_transition lands between its surrounding
   events), report includes the timeline.

## What NOT to do (hard constraints)

- **Never change the system prompt per phase.** The condensation machinery
  (`messagesPrefixEquals`, `condensedUpToMsgIndex`, `skipOrphanedToolMessages`,
  `computeEvictCount`) and provider prompt caching depend on a stable
  `[system, firstUser]` prefix. Phase is expressed via transcript markers and
  loop-level refusals only.
- **Do not remove tools from the per-request tool list per phase.** Keep
  `this.state.tools` fixed; enforce via refusals. (Tool-list churn breaks the
  provider cache and the `state.tools` invariant `callMainLlm` relies on.)
- **Do not gate read-only sessions** (reviewer / QA / local-explore executors
  — they don't register edit tools; `modeHasEditGroup` is the test).
- **Do not let the gate lose a session**: gate failures return to the loop
  (nudge + bounded cycles), never throw, never convert a would-be success into
  a hard error. Past `gateMaxCycles`, accept with a warning.
- **Do not count phase-guidance refusals or gate-execution failures as
  `consecutiveMistakes`.**
- **Do not block untestable tasks**: plan-declared `verification: none` skips
  the gate.
- **Do not touch `src/vendor/zoo-code/`** and **do not add dependencies.**
- **Do not rename or break** the S3 parallel read-only wave, the commit nudge,
  checkpoint scheduling, budget accounting, handoff writing, or the
  `run_tests` security contract (`shell: false`, argv-only paths).
- **Do not mutate `alembic_version`** — irrelevant here (no DB), listed only
  because it's a standing repo-wide rule.

## Sequencing & dependencies

| Stage | Work | Depends on | Independent? |
|---|---|---|---|
| W1 | Verification-gated termination | run_tests structured result | Yes (land first) |
| W2 | In-session reflexion | — | Yes |
| W3 | Plan artifact | — | Yes (W4 needs it) |
| W4 | Phase state machine | W3 | No |
| W5 | Per-phase model routing | W4 | No |
| W6 | Observability | W4 (phase events) | Mostly (reports/events can precede W4's wiring) |

Suggested commit order: W1 → W2 → W3 → W4 → W5 → W6, each a self-contained
commit that leaves `npm test` green with `phaseGated` default OFF.

## Tests

- New: `src/engine/__tests__/plan.test.ts`, `phases.test.ts`,
  `verification-gate.test.ts` (file names follow the existing `*.test.ts`
  convention; add each to `package.json`'s `test` chain).
- Extended: `src/engine/__tests__/loop.test.ts` (reflexion injection, phase
  marker presence in requests, gate defers `attempt_completion`),
  `src/config/__tests__/mode-models.test.ts` (`_phase` parsing/precedence),
  `src/engine/__tests__/condense.test.ts` (plan message pinned through
  condensation, boundary math with and without plan),
  `src/tools/__tests__/run-tests.test.ts` (structured result fields).
- Regression: all existing suites + every `scripts/e2e*/run.sh` suite.

## Verification checklist

1. `npx tsc --noEmit` — green.
2. `npm test` — all suites green (including the new ones).
3. Every `scripts/e2e*/run.sh` suite — green.
4. **Default-off golden run**: run a session with no `phaseGated` flag and
   diff its request sequence / events against a pre-change run — must be
   byte-identical (no behavior change when off).
5. **Opt-in smoke** (e.g. against a small fixture repo with a deliberately
   failing test):
   - explore → plan → implement → verify transitions appear in the transcript
     markers and the event feed;
   - a phase-violating tool (e.g. an edit during `verify`) is refused with
     guidance, not an error;
   - `attempt_completion` with failing tests is refused with findings, the
     loop returns to `implement`, and completion succeeds once tests pass
     (within `gateMaxCycles`);
   - a docs-only task with `verification: none` completes without a gate;
   - reflexion appears after the second consecutive mistake;
   - per-phase model routing is visible in the usage log (different model ids
     per phase) when `_phase` is configured;
   - the session report contains the phase timeline and gate outcome.
6. Handoff path: a continuation worker on a worktree with an existing
   `plan.md` starts at `implement` and condensation never evicts the plan
   message.

## What to report back

- Which stages (W1-W6) landed and the commit order used.
- Before/after measurements on a real task with `phaseGated` on: iterations,
  token spend (input/output/cached), wall-clock, and gate trip counts — the
  numbers that decide whether to flip the default.
- Any transition rule that fired too aggressively/too rarely during the smoke
  test (this is tuning feedback for `phases.ts`, not a defect).
- The exact `mode-models.json` `_phase` snippet used in testing.
