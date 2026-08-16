# Default model → `deepseek/deepseek-v4-flash-0731` (docs + e2e consistency sweep)

## Who this is for

A code-mode worker executing a small, mechanical consistency change. The
actual runtime default is **already** the dated id; your job is to make every
user-facing doc, the one stale code comment, and the phase-2 e2e fixture agree
with it. No new behavior, no new dependencies, no test-logic redesign.

## Background / current state (verified)

The harness's single source of truth for the default model is `DEFAULT_MODEL`
in [`src/llm/openrouter.ts:31`](src/llm/openrouter.ts:31), which already reads
`deepseek/deepseek-v4-flash-0731`. The full code-level default path is already
migrated:

- [`src/llm/openrouter.ts:31`](src/llm/openrouter.ts:31) — `export const DEFAULT_MODEL = "deepseek/deepseek-v4-flash-0731"`.
- [`src/llm/openrouter.ts:118`](src/llm/openrouter.ts:118) — client default falls back to `DEFAULT_MODEL`.
- [`src/llm/preflight.ts:216`](src/llm/preflight.ts:216), [`src/engine/loop.ts:960`](src/engine/loop.ts:960) and [`src/engine/loop.ts:977`](src/engine/loop.ts:977), [`src/decision-proxy/proxy.ts:354`](src/decision-proxy/proxy.ts:354) — all resolve through `DEFAULT_MODEL`.
- [`src/cli.ts:243`](src/cli.ts:243) and [`src/cli.ts:779`](src/cli.ts:779), [`src/orchestrator/cli.ts:2514`](src/orchestrator/cli.ts:2514) — the two `--model` help text / dry-run fallback strings already say `-0731`.
- [`src/engine/loop.ts:492`](src/engine/loop.ts:492) — the `model` doc comment already says `-0731`.
- [`src/budget/cost.ts:102`](src/budget/cost.ts:102) — `deepseek/deepseek-v4-flash-0731` is already priced; [`src/budget/__tests__/cost.test.ts:59-62`](src/budget/__tests__/cost.test.ts:59) already has `testDeepseekV4Flash0731Priced`.
- [`scripts/run-worker.sh:60`](scripts/run-worker.sh:60) and [`scripts/e2e-phase6/run.sh:132`](scripts/e2e-phase6/run.sh:132) — comments already reference the dated id.

So the remaining work is purely making the following stale references match.

## What to change

For each item, replace the exact `old` string with the exact `new` string.
These are one-line (or two-line) surgical edits; do not reformat surrounding
lines.

1. [`README.md:54`](README.md:54)
   - old: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash       # default model`
   - new: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731  # default model`

2. [`README.md:150`](README.md:150)
   - old: `  --model <id>                  OpenRouter model id (default: $OPENROUTER_MODEL or deepseek/deepseek-v4-flash)`
   - new: `  --model <id>                  OpenRouter model id (default: $OPENROUTER_MODEL or deepseek/deepseek-v4-flash-0731)`

3. [`README.md:233`](README.md:233)
   - old: `` `OPENROUTER_APP_TITLE`; model default `deepseek/deepseek-v4-flash` (env ``
   - new: `` `OPENROUTER_APP_TITLE`; model default `deepseek/deepseek-v4-flash-0731` (env ``

4. [`docs/phase1-live-run.md:31`](docs/phase1-live-run.md:31)
   - old: ``| `OPENROUTER_MODEL` | Model id (e.g. `deepseek/deepseek-v4-flash`). Defaults to `deepseek/deepseek-v4-flash` if unset; overridable per-run with `--model`. |``
   - new: ``| `OPENROUTER_MODEL` | Model id (e.g. `deepseek/deepseek-v4-flash-0731`). Defaults to `deepseek/deepseek-v4-flash-0731` if unset; overridable per-run with `--model`. |``

5. [`docs/phase1-live-run.md:135`](docs/phase1-live-run.md:135)
   - old: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash # optional (default model)`
   - new: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731 # optional (default model)`

6. [`docs/phase1-live-run.md:190`](docs/phase1-live-run.md:190)
   - old: ``- `--model <id>` (CLI flag) → `OPENROUTER_MODEL` env var → `deepseek/deepseek-v4-flash`.``
   - new: ``- `--model <id>` (CLI flag) → `OPENROUTER_MODEL` env var → `deepseek/deepseek-v4-flash-0731`.``

7. [`docs/phase2-orchestration.md:347`](docs/phase2-orchestration.md:347)
   - old: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash`
   - new: `export OPENROUTER_MODEL=deepseek/deepseek-v4-flash-0731`

8. [`docs/phase6-cloud.md:306`](docs/phase6-cloud.md:306)
   - old: ``Baseline: one harness session, `deepseek/deepseek-v4-flash``` 
   - new: ``Baseline: one harness session, `deepseek/deepseek-v4-flash-0731```

9. [`docs/phase6-cloud.md:320`](docs/phase6-cloud.md:320)
   - old: `` `deepseek/deepseek-v4-flash` work. ``
   - new: `` `deepseek/deepseek-v4-flash-0731` work. ``

10. [`docs/decision-proxy.md:77`](docs/decision-proxy.md:77)
    - old: ``  model (the default `deepseek/deepseek-v4-flash`) can return HTTP 200 with``
    - new: ``  model (the default `deepseek/deepseek-v4-flash-0731`) can return HTTP 200 with``

11. [`scripts/e2e-phase2/run.sh:215-216`](scripts/e2e-phase2/run.sh:215) — the
    `mode-models.json` fixture this test writes. Change **both** lines:
    - old:
      ```
        "_default": "deepseek/deepseek-v4-flash",
        "code": "deepseek/deepseek-v4-flash",
      ```
    - new:
      ```
        "_default": "deepseek/deepseek-v4-flash-0731",
        "code": "deepseek/deepseek-v4-flash-0731",
      ```

12. [`scripts/e2e-phase2/run.sh:753`](scripts/e2e-phase2/run.sh:753) — the
    assertion that must stay in lockstep with item 11:
    - old: `	grep -q "model=deepseek/deepseek-v4-flash" "$PLAN_MOCK_LOG"; then`
    - new: `	grep -q "model=deepseek/deepseek-v4-flash-0731" "$PLAN_MOCK_LOG"; then`

13. [`src/decision-proxy/proxy.ts:316`](src/decision-proxy/proxy.ts:316) — a
    stale code comment that names the default:
    - old: ` * default deepseek/deepseek-v4-flash) sometimes returns HTTP 200 with EMPTY`
    - new: ` * default deepseek/deepseek-v4-flash-0731) sometimes returns HTTP 200 with EMPTY`

## What NOT to change

These also contain `deepseek/deepseek-v4-flash`, but changing them would be
wrong. Leave them exactly as-is:

- [`src/budget/cost.ts:79-80`](src/budget/cost.ts:79) and [`src/budget/cost.ts:103`](src/budget/cost.ts:103) — the un-dated id is **intentionally** kept priced so an explicit override to it still estimates correctly (the comment says so directly).
- [`docs/reasoning-effort-ab.md`](docs/reasoning-effort-ab.md) (whole file) — a dated 2026-08-06 experiment record; the model actually used there was the un-dated id. Historical, must not be rewritten.
- Capability statements that are true of both ids (same model line): [`docs/gap-audit.md:139`](docs/gap-audit.md:139), [`docs/vision.md:10`](docs/vision.md:10) and [`docs/vision.md:90`](docs/vision.md:90), [`src/tools/browser/tool.ts:20-22`](src/tools/browser/tool.ts:20) ("cannot process images").
- Dated historical comments: [`src/engine/condense.ts:99`](src/engine/condense.ts:99), [`src/engine/loop.ts:188`](src/engine/loop.ts:188) and [`src/engine/loop.ts:202`](src/engine/loop.ts:202).
- Example-only snippets (not assertions about the default): [`src/config/mode-models.ts:11`](src/config/mode-models.ts:11), [`docs/phase1-live-run.md:50-51`](docs/phase1-live-run.md:50).
- Every test fixture that passes the literal `deepseek/deepseek-v4-flash` as an input (e.g. [`src/llm/__tests__/openrouter.test.ts`](src/llm/__tests__/openrouter.test.ts), [`src/llm/__tests__/preflight.test.ts`](src/llm/__tests__/preflight.test.ts), [`src/budget/__tests__/cost.test.ts`](src/budget/__tests__/cost.test.ts), [`src/orchestrator/__tests__/cost-history.test.ts`](src/orchestrator/__tests__/cost-history.test.ts), [`src/dashboard/__tests__/`](src/dashboard/__tests__), [`src/config/__tests__/mode-models.test.ts`](src/config/__tests__/mode-models.test.ts), [`src/decision-proxy/__tests__/proxy.test.ts`](src/decision-proxy/__tests__/proxy.test.ts), [`src/project-store.test.ts`](src/project-store.test.ts)). These exercise the **still-valid** un-dated override id; they are not asserting the default.
- [`plans/mode-models-first-spawn.md:89-91`](plans/mode-models-first-spawn.md:89) — historical narrative about how past rounds were run.

## Verification checklist

1. `npx tsc --noEmit` — must be clean (no type changes expected; item 13 is a comment only).
2. `npm test` — must pass in full. (No `.test.ts` file is edited, so this should be unaffected, but run it.)
3. Because items 11–12 touch a spawn/e2e script (`scripts/e2e-phase2/run.sh`), re-run that suite:
   `bash scripts/e2e-phase2/run.sh`. It runs against a local mock LLM server (it sets `HEADLESSCODE_OPENROUTER_API_KEY="test-key"` and points `OPENROUTER_BASE_URL` at `http://127.0.0.1:<port>` — see [`scripts/e2e-phase2/run.sh:225-226`](scripts/e2e-phase2/run.sh:225)), so no real API key is needed. The suite must exit 0 and its "plan-first" assertion (item 12) must pass.
4. Sanity grep after editing, from the repo root:
   `grep -rn "deepseek/deepseek-v4-flash[^-0-9]" README.md docs/phase1-live-run.md docs/phase2-orchestration.md docs/phase6-cloud.md docs/decision-proxy.md scripts/e2e-phase2/run.sh src/decision-proxy/proxy.ts`
   Confirm the only remaining hits are the intentionally-kept ones listed under "What NOT to change".

## What to report back

- Confirmation of each of the 13 edits applied.
- The exit code and pass/fail of `npx tsc --noEmit`, `npm test`, and
  `bash scripts/e2e-phase2/run.sh`.
- The output of the final sanity grep (step 4) showing no unintended
  remaining references.
- Any file whose line numbers no longer match the citations here (the worker
  should treat them as "approximately here, verify before trusting the line
  numbers" per the repo's citation convention).
