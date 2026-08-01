# Per-mode model assignment + dashboard settings page — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions, an
  `All N tests passed` trailer line. Add new test files to `package.json`'s
  `test` script the same way existing entries are chained with `&&`.
- Every new config-loading path must fail loudly on malformed input (see
  `src/permissions/config.ts`'s handling of `<workspaceRoot>/.headlesscode/permissions.json`
  — a broken config file throws with a clear message, it never silently
  falls back) — this is the established idiom for `.headlesscode/*.json`
  local config files in this project, follow it exactly for the new one.
- `npx tsc --noEmit` and `npm test` must stay green. Re-run every e2e suite
  under `scripts/e2e*/run.sh` afterward (check `package.json`/`scripts/` for
  the current full list — it has grown across several rounds of work, don't
  assume the count from an old comment).

## IMPORTANT — check for a merge conflict with concurrent work first

Another task (`plans/realtime-monitoring.md`) may have already landed or be
landing around the same time as this one, and it also adds `POST` support to
`src/dashboard/server.ts` (which currently rejects all non-GET methods
outright — check its own header comment and routing code before assuming its
current shape). If that work has already landed, **extend its existing
POST-routing mechanism** for the new settings endpoint below rather than
building a second, parallel way of handling POST requests — read
`src/dashboard/server.ts` fresh before writing anything, don't assume the
shape described anywhere else. If it hasn't landed yet, build the minimal
POST-handling this task needs, but keep it generic enough that a later POST
route (pause/resume) can reuse the same pattern rather than needing its own
separate mechanism.

## The problem

Zoo Code's real VS Code settings support per-mode model assignment
(`modeApiConfigs` in `zoo-code/src/core/config/ProviderSettingsManager.ts` —
read it for the concept, not to copy code from, since it's stored via VS
Code's encrypted `context.secrets` API and is not accessible outside the
extension host). headlesscode has no equivalent at all: every worker,
reviewer, and QA session uses the same single model
(`--model` flag → `OPENROUTER_MODEL` env → the hardcoded
`deepseek/deepseek-chat` default — see `src/cli.ts` around
`const model = options.model ?? process.env.OPENROUTER_MODEL ?? undefined`
and the equivalent in `src/orchestrator/cli.ts`, which currently takes ONE
`--model` flag applied to workers, the reviewer, AND QA alike).

The goal, deliberately kept simple per the project owner's explicit
instruction (complexity-based model gating is an explicit future idea, NOT
in scope here): a plain local config file mapping mode slug → model id, with
a browser-based settings page on the existing dashboard to edit it.

## What to build

### 1. Config file + resolution helper

New `src/config/mode-models.ts` (or fold into an existing
`src/permissions/config.ts`-adjacent location if you find a cleaner home —
your call, but keep it a separate, focused module, don't bloat an unrelated
file):

- Storage: `<workspaceRoot>/.headlesscode/mode-models.json`, shape:
  ```json
  { "code": "deepseek/deepseek-chat", "deepseek-reviewer": "deepseek/deepseek-reasoner", "_default": "deepseek/deepseek-chat" }
  ```
  Every key except `_default` is a mode slug; `_default` (optional) is the
  fallback when a mode isn't listed.
- `resolveModelForMode({ workspaceRoot, mode, explicitModel, env })` →
  returns the model id to use, precedence:
  1. `explicitModel` (an actual `--model` flag value, if the caller passed
     one) — always wins, this is a deliberate manual override.
  2. `mode-models.json[mode]`, if the file exists and has that key.
  3. `mode-models.json["_default"]`, if the file exists and has that key.
  4. `env.OPENROUTER_MODEL`.
  5. The hardcoded default (`DEFAULT_MODEL` from `src/llm/openrouter.ts`) —
     actually, leave this step to the caller (the OpenRouter client already
     falls back to this itself when given `undefined`) — this function
     should return `undefined` if nothing more specific is configured
     ​rather than hardcoding the model id itself, so the existing fallback
     in `src/llm/openrouter.ts` stays the single source of truth for the
     ultimate default. Don't duplicate that constant.
- Malformed `mode-models.json` (invalid JSON, or a value that isn't a
  string) must throw a clear error — same fail-loudly idiom as
  `permissions.json`. A missing file is NOT an error (falls through to env/
  default, same as today's behavior — zero config means zero behavior
  change).

### 2. Wire into every place a model is currently chosen

- `src/cli.ts`'s single-session path: replace the `options.model ??
  process.env.OPENROUTER_MODEL ?? undefined` line with a call to
  `resolveModelForMode`, passing the resolved `mode` (find where `mode` is
  already resolved nearby — likely `options.mode ?? "code"`) and
  `options.model` as `explicitModel`.
- `src/orchestrator/cli.ts`: this is the more involved one, since
  `orchestrate` currently applies ONE `--model` value to workers, the
  reviewer, and QA uniformly (search for how `options.model` flows into
  the worker-spawn call, `runReview(...)`, and `runQa(...)` — there are
  three separate call sites per the grep below). Each should resolve its
  OWN model independently via `resolveModelForMode`, using:
  - workers: the group's own `mode` (default `"code"`, or whatever
    `--mode`/`ORCHESTRATOR_MODE` resolves to for that round)
  - reviewer: `options.reviewMode` (default `"deepseek-reviewer"`)
  - QA: `options.qaMode` (default `"qa-agent"`)
  - the rework-loop's re-spawn (already built — search `src/orchestrator/cli.ts`
    for `handleReviewVerdict`/the rework spawn call) should resolve the
    same way workers do, since it's still the worker's mode.
  Grep starting points in the current file (verify these are still
  accurate before relying on them, the file has grown across several
  rounds of work):
  ```
  grep -n "model: \|model,\|--model\|options.model" src/orchestrator/cli.ts
  ```
  A single explicit `--model` flag passed to `orchestrate` should still
  work as a blanket override for all three roles (precedence rule 1 above
  applies per-call, so an explicit flag beats every mode's own config
  entry, not just one role's).

### 3. Dashboard settings page

- **New endpoint** `GET /api/settings/mode-models?repo=<path>` — returns the
  current `mode-models.json` content (or `{}` if the file doesn't exist).
- **New endpoint** `POST /api/settings/mode-models?repo=<path>` — accepts a
  JSON body of the same shape and writes it to
  `<repo>/.headlesscode/mode-models.json` (create the `.headlesscode/` dir
  if needed). Validate the body server-side the same way the config loader
  does (reject non-string values, reject a body that isn't a plain object)
  — a malformed save must fail with a clear error response, not write
  garbage that later throws when a worker tries to read it.
- **UI** (`src/dashboard/page.ts`): a simple settings section — a small
  editable table (mode slug + model id, add/remove rows) with a save
  button that POSTs the current table state and shows a success/error
  message inline. No new client-side framework — this project's dashboard
  page is plain vanilla JS/HTML, keep it that way. Populate the mode-slug
  dropdown/suggestions from `.roomodes` if you can read it easily (nice to
  have, not required — a plain text input for the slug is acceptable if
  reading `.roomodes` from the dashboard's aggregation layer turns out to
  be awkward).

### What NOT to do

- Do not attempt to read Zoo Code's VS Code `modeApiConfigs`/secrets — it's
  genuinely inaccessible from outside the extension host, this was
  confirmed by direct source inspection, not an oversight to "fix."
- Do not add complexity-based model routing (picking a model based on task
  size/complexity) — explicitly out of scope per the project owner, a
  possible future idea, not this task.
- Do not change `.roomodes`'s own schema to add a `model` field — that
  file's schema is shared with the real Zoo Code extension for
  compatibility (a mode file might be used by both), and adding fields
  risks breaking real Zoo Code's own parsing of it. Keep model assignment
  in the separate `.headlesscode/mode-models.json` file.

## Tests

- New `src/config/__tests__/mode-models.test.ts`: precedence order (explicit
  beats file, mode-specific beats `_default`, `_default` beats env, env
  beats returning `undefined`), missing file behaves as zero-config,
  malformed file throws clearly, malformed VALUE (non-string) throws
  clearly.
- Extend whatever test currently covers `src/cli.ts`'s model resolution (or
  add a focused new one) proving a configured mode-model mapping actually
  changes which model a session is constructed with — check via the fake
  `LlmClient`/session config in existing loop tests for the pattern, don't
  need a real API call.
- New `src/dashboard/__tests__/settings.test.ts` (or extend the server test
  file from the realtime-monitoring work if it exists by the time you do
  this): GET returns the current file content; POST writes it and a
  subsequent GET reflects the change; POST with a malformed body is
  rejected with a clear error and does NOT corrupt the existing file.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. Manual smoke test: configure a mode→model mapping via a raw `curl -X POST`
   to the new endpoint, confirm a subsequent `orchestrate --dry-run` (or a
   direct single-session `--dry-run`, which doesn't call the LLM but does
   resolve the model — check what's printed/loggable at that point) reflects
   the configured model for that mode, not the global default.

## What to report back

- Files changed/added.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whether `plans/realtime-monitoring.md`'s POST-routing work had already
  landed when you started, and how you integrated with it (or didn't, if it
  hadn't landed yet).
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
