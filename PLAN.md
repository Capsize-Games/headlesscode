# PLAN — Issue #127 slice: engine `loop.ts` slim-down (tests-first)

## Goal

Reduce [`src/engine/loop.ts`](src/engine/loop.ts:1) (6567 lines; `HeadlessSession` class at [`src/engine/loop.ts`](src/engine/loop.ts:1363)) toward [`docs/typescript-standards.md`](docs/typescript-standards.md:1) (250-line files, 20-line functions) via tests-first extraction into cohesive modules. No behavior change. If the file is too big to finish, land a coherent partial split with tests + green gates, not a sprawling WIP.

## Scope boundaries (hard)

- Owns ONLY [`src/engine/loop.ts`](src/engine/loop.ts:1) + new `src/engine/*` modules + `src/engine/__tests__/*` tests + regenerated baselines. A sibling worker owns `src/orchestrator/cli.ts` + `resume.ts` — do NOT touch them.
- No behavior change: pure moves + thin delegation. Keep all call sites compiling.

## Step 0 — Measure (record numbers for the closing report)

1. `npm run coverage -- --filter engine` → record module %.
2. `npm run check-standards` and `npm run check-architecture` → record live violation counts for `loop.ts`.
3. `npx tsc --noEmit` and `npm test` → confirm green baseline before touching anything.

## Step 1 — Tests FIRST (repo style: `src/*/__tests__/*.test.ts` via `tsx`, auto-discovered by [`scripts/run-tests.mjs`](scripts/run-tests.mjs:1))

Match the style of existing [`src/engine/__tests__/loop.test.ts`](src/engine/__tests__/loop.test.ts:1) and siblings (`switch-mode`, `new-task`, `condense`, `pause`, `inject-message`, `iteration-boundary` tests in [`src/engine/__tests__`](src/engine/__tests__:1)). Do not reshape anything until its tests exist and pass.

Add missing unit tests for every function you will touch, in this order:

1. Free helpers (cheapest, no session fixture): [`summarizeToolArg`](src/engine/loop.ts:6300), [`truncateHistory`](src/engine/loop.ts:6474), [`stripSupersededReasoning`](src/engine/loop.ts:572), [`isReadOnlyDirectCall`](src/engine/loop.ts:361)/[`isReadOnlyTurnCall`](src/engine/loop.ts:379), [`artifactRejectionNudgeMessage`](src/engine/loop.ts:524), env readers ([`envMaxPauseMs`](src/engine/loop.ts:6493) through [`envStreaming`](src/engine/loop.ts:6560)), [`messagesPrefixEquals`](src/engine/loop.ts:6415), [`sameToolNames`](src/engine/loop.ts:6387). Extend `summarize-tool-arg.test.ts` / add `loop-helpers.test.ts` (keep each test file ≤ 250 lines per standards).
2. Condensation methods: [`maybeCondenseHistory`](src/engine/loop.ts:2584), [`fireBackgroundCondense`](src/engine/loop.ts:2862), [`applyBackgroundCondense`](src/engine/loop.ts:2985), [`recordCondensationUsage`](src/engine/loop.ts:3103) — extend `condense*.test.ts` pattern with a fake `LlmClient` + `BudgetTracker`.
3. Iteration boundary/aux: [`runIterationBoundaryHook`](src/engine/loop.ts:2240), [`scheduleAux`](src/engine/loop.ts:2342)/[`drainAuxWrites`](src/engine/loop.ts:2357), [`checkPauseRequested`](src/engine/loop.ts:2439), [`checkInjectedMessage`](src/engine/loop.ts:2523).
4. Only then touch [`runIterations`](src/engine/loop.ts:3416) (~2070 lines, ends before [`initCheckpoints`](src/engine/loop.ts:5488)) and handlers [`handleNewTask`](src/engine/loop.ts:5662), [`handleSwitchMode`](src/engine/loop.ts:5842), [`handleExtensionManage`](src/engine/loop.ts:5595)/[`handleExtensionCall`](src/engine/loop.ts:5641) — cover via existing `new-task`/`switch-mode`/`iteration-boundary` test patterns first.

## Step 2 — Refactor (phased; stop at a coherent partial if needed)

Follow the existing precedent modules (`condense.ts`, `handoff.ts`, `reports.ts`, `usage.ts`, `events.ts`, `lazy-tools.ts`, `local-explore.ts` in [`src/engine`](src/engine/loop.ts:1) dir listing). Each extraction = move + re-export/delegate from `loop.ts` so call sites keep compiling; one commit per module.

- Phase A (free helpers, lowest risk): extract `src/engine/loop-helpers.ts` — `summarizeToolArg`, `truncateHistory`, `stripSupersededReasoning`, read-only predicates, artifact/citation helpers ([`countVerifiedCitations`](src/engine/loop.ts:613), [`matchingArtifactFileStatus`](src/engine/loop.ts:649)), env readers, `messagesPrefixEquals`/`sameToolNames`, `estimateTokenSize` ([`src/engine/loop.ts`](src/engine/loop.ts:6283)).
- Phase B (condensation): extract `src/engine/loop-condense.ts` — `maybeCondenseHistory`, `fireBackgroundCondense`, `applyBackgroundCondense`, `recordCondensationUsage`, `recordHandoffCondensationUsage` ([`src/engine/loop.ts`](src/engine/loop.ts:3135)). Keep thin methods on the class delegating to functions taking an explicit state/options object (params rule: ≤ 5 params — bundle into options).
- Phase C (handlers): extract `src/engine/loop-handlers.ts` — `handleNewTask`, `handleSwitchMode`, `handleExtensionManage`, `handleExtensionCall`, `handleListTools` ([`src/engine/loop.ts`](src/engine/loop.ts:6056)), `handleActivateSkill` ([`src/engine/loop.ts`](src/engine/loop.ts:6060)), `handleReadSkillReference` ([`src/engine/loop.ts`](src/engine/loop.ts:6083)), `handleRequestTool` ([`src/engine/loop.ts`](src/engine/loop.ts:6105)).
- Phase D (only if A–C green with budget left): carve sub-steps out of `runIterations` (per-iteration helpers: LLM call via [`callMainLlm`](src/engine/loop.ts:3315), tool-dispatch block, stall/nudge block, completion-verification block) into `src/engine/loop-iterations.ts`. Do NOT attempt to move all of `runIterations` in one commit.

Rules per move: ≤ 250-line new files, ≤ 20-line functions (split further if needed), full type annotations, no `any`, no suppression comments, tabs/double-quotes/no-semicolons/80-col. Watch for import cycles (`loop.ts` ↔ new module) — pass dependencies as parameters, never import the session class back into the extracted module.

## Step 3 — Verify + close

Gates, all green in this order: `npx tsc --noEmit`; `npm test` (FULL suite, not just engine); `npm run check-standards`; `npm run check-architecture`; regenerate both baselines in the same change (`npm run check-standards -- --write-baseline`, architecture equivalent — never hand-edit); `npm run coverage -- --min 24` must not regress vs Step 0. Commit per logical unit with `#127` in the message. Push branch, open PR against `master` linking #127, post the issue-closing report (Files changed / Baseline before+after / Boot check / Residual risk / PR link).

## Risks

- Cited `loop.ts` lines will drift as you extract — treat them as "approximately here" and re-verify with `outline` before each move.
- `runIterations` carries the most implicit state (`this.*` fields lines 1363–1569); prefer small parameter-object helpers over splitting the method body blindly — a partial A–C split is an acceptable outcome.
- Baseline regen must be in the same commit as the fix, or CI ratchets fail.
- Coverage floor is 24 (`--min 24`); engine-filter percentage from Step 0 is informational, the floor gate is what must not regress.
