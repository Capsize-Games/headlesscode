# Phase 4 — Headless QA (evaluation + decision + usage)

## 1. What the existing `qa-agent` mode actually is

Surveyed directly from the target repo (this doc's source of truth):

- `/home/joe/Projects/airunner/.roomodes` defines the `qa-agent` custom mode:
  - **roleDefinition**: "You are a QA agent for this project. Your job is to
    start the application, observe its behaviour in a real browser, identify
    errors, and fix them. You operate in a loop: start → observe → diagnose →
    fix → verify."
  - **groups**: `read`, `edit`, `command`, `mcp`.
  - **customInstructions** is a long operating procedure built almost entirely
    out of **CLI steps**:
    1. Check the port (`lsof -i :5173`), chmod + start `./scripts/run_web.sh`
       as a background process (`&` — "the `&` is mandatory").
    2. Tail `~/.local/share/airunner/airunner.log` for a ready signal (bounded
       wait, timeout after 60s).
    3. Run the repo's own QA runner: `node qa/runner.js --url <url> --wait <ms>`
       (this exists at `/home/joe/Projects/airunner/qa/runner.js` — a Playwright
       script that injects instrumentation and writes `qa/last-report.json`).
    4. Read `qa/last-report.json` (client-side errors, WS events, failed
       network requests) and correlate with the server log.
    5. Diagnose (read source + logs), fix one error at a time, re-run, verify.
  - The only MCP mention: "you can **also** use Playwright MCP tools directly
    to interact with the page (click buttons, fill forms, trigger flows)
    **before or after running the runner script**" — i.e. the Playwright MCP is
    an *optional enrichment*, not the mechanism that runs the QA loop.
- `/home/joe/Projects/airunner/.roo/rules-qa-agent/rules.md` adds code-style,
  multi-tenant-awareness, and scripting-principle notes. It is mode-specific
  rules content that the harness splices automatically.

## 2. Can the harness serve it? (MCP analysis)

The harness executor (`src/tools/executor.ts`) has **no MCP support**: the
vendored `McpHub` is a stub (`src/vendor/zoo-code/src/services/mcp/McpHub.ts`
returns an empty server list), and tool selection
(`selectToolsForMode` in `src/engine/prompt.ts`) intersects the mode's allowed
tool groups with `EXECUTABLE_TOOL_NAMES` — which does **not** include
`use_mcp_tool` / `access_mcp_resource`. So the `mcp` group in the qa-agent mode
is inert headlessly: no MCP tools are ever advertised to the model.

## 3. Decision

**Choice (b)-via-CLI — run `qa-agent` headlessly as a harness session, with
browser interaction via the repo's own Playwright CLI (`qa/runner.js`) through
`execute_command`. No MCP server build.**

Rationale:

- The mode's actual QA loop (start app → run `qa/runner.js` → read
  `qa/last-report.json` → correlate with the log → diagnose → fix → verify) is
  100% `read` + `execute_command` (+ `write_to_file` for remediation). All of
  that is already served by the harness executor.
- The Playwright MCP is optional enrichment, and its core value (drive a real
  browser headlessly, capture console errors/WS/network failures) is already
  delivered by the repo's own `qa/runner.js` + `qa/browserInstrumentation.js`
  — which the mode's instructions tell the agent to run every cycle anyway.
- This avoids building a full MCP server + transport layer in the harness for
  one optional tool, and it keeps the "read the same .roomodes/.roo files the
  interactive tool reads" principle intact.

**Residual gap (documented, accepted):** live Playwright-MCP interactivity
(click/fill/type via an `mcp__playwright__*` tool) is not available headlessly.
Interactive flows must be driven by whatever the repo's own Playwright scripts
support (`qa/runner.js`, `npx playwright ...` via `execute_command`), or by
extending the repo's QA script. The QA session *can* still boot the app and run
any command, so this is a tooling gap, not a capability blocker.

## 4. Non-edit discipline (decided)

QA **runs** the app + test suites (it needs `execute_command`) but must **not**
be able to modify source files unexpectedly — remediation is a separate worker
cycle. Enforced at two levels:

1. **Tool list**: `qaTools()` (`src/qa/qa.ts`) exposes only `read_file`,
   `list_files`, `execute_command`, `attempt_completion`,
   `ask_followup_question` — no `write_to_file` (even though the qa-agent mode
   has the `edit` group).
2. **Executor**: `createQaHeadlessExecutor()` (`src/tools/executor.ts`) does not
   register `write_to_file` at all, so a model that tries it gets a clear
   "not implemented" error and the loop's consecutive-mistake bound trips.

`createQaHeadlessExecutor` is functionally identical to the reviewer's
`createReadOnlyHeadlessExecutor` (both are read + command, no write); it exists
under a QA-specific name so the intent is explicit at every call site.

## 5. Implementation

- [`src/qa/qa.ts`](../src/qa/qa.ts) — `runQa({ workspaceRoot, taskText?, mode?,
  model?, llmClient?, baseUrl?, maxIterations?, memory?, project? })`:
  - Default mode slug `qa-agent`. The vendored prompt builder splices the
    target repo's `.roomodes` `qa-agent` entry + `.roo/rules-qa-agent/`
    automatically (same mechanism as the reviewer).
  - If the target repo defines **no** `qa-agent` mode, `GENERIC_QA_CHECKLIST`
    is used as a `systemPromptOverride`: boot the app, run the relevant test
    suite, exercise the changed behavior, report evidence with real command
    output, terminate with `QA PASS`/`QA FAIL` + an Evidence section. Any
    scratch the QA session needs goes in `<workspace>/.headlesscode/scratch/`
    — never `/tmp` (issue #123, same workspace-containment rule as the
    reviewer; a probe script written to `/tmp` is an outside-workspace write
    and a documented violation).
  - Returns `{ verdict: 'pass'|'fail'|'error', evidence, summary }`.
  - `parseQaResult(text)` (exported, unit-tested) mirrors
    `src/orchestrator/reviewer.ts`:
    - **pass** — explicit pass markers (`QA PASS`, all tests pass, no errors
      found, `errors: []`, …).
    - **fail** — explicit fail markers (`QA FAIL`, failed, errors found, bug,
      regression, definition of done NOT met, …). Negative lookbehinds keep
      pass statements like "no errors found" from tripping the fail branch.
    - **default fail (fail-closed)** — an inconclusive report never passes,
      because QA gates a deploy.
    - **evidence** — an `## Evidence` section when present, else the full
      summary.
  - `memory`/`project` are optional and passed through to `HeadlessSession`
    (Phase 3 memory can be reused for QA runs; default off).
- **Orchestrate wiring** (`src/orchestrator/cli.ts`): `--qa` runs a QA session
  per group after that group's review passes (verdict clean, or review
  disabled); `--qa-mode <slug>` selects the QA mode (default `qa-agent`).
  Results are recorded in the group's `qa: { status, verdict, evidence,
  updated }` field in `.worktrees/.orchestrator-state.json`
  (`src/orchestrator/state.ts`). Default behavior when `--qa` is absent is
  unchanged.
- [`scripts/run-qa.sh`](../scripts/run-qa.sh) — thin bash wrapper (mirrors
  `scripts/run-worker.sh`): writes `<wt>/.qa-task.md` (the QA checklist),
  launches the harness CLI in `--mode <slug>` against the worktree, records
  `<wt>/.qa.pid`, logs to `<wt>/qa.log`, and on exit writes `<wt>/.qa.exit` +
  `<wt>/.qa.done/`.

## 6. How to run QA

Standalone against one worktree:

```bash
HEADLESSCODE_OPENROUTER_API_KEY=... npx tsx src/cli.ts \
  --task-file <wt>/.qa-task.md --workspace <wt> --mode qa-agent
# or the wrapper:
HEADLESSCODE_OPENROUTER_API_KEY=... bash scripts/run-qa.sh <wt> --mode qa-agent
```

Inside a full orchestration round (QA runs after each group's review passes):

```bash
npx tsx src/cli.ts orchestrate --repo ~/Projects/airunner --issue 27 \
  --qa --qa-mode qa-agent
```

The QA verdict is parsed by `runQa` and written to the state file's per-group
`qa` field; the deploy gate (Phase 4.2) refuses to run unless every group's QA
verdict is `pass` (see [`docs/phase4-deploy-gate.md`](./phase4-deploy-gate.md)).

## 7. Tests

- Unit: `src/qa/__tests__/qa.test.ts` — verdict/evidence parsing
  (pass/fail/fail-closed/evidence extraction), mirroring
  `src/orchestrator/__tests__/reviewer.test.ts`.
- E2E: `scripts/e2e-phase4/run.sh` (section 4-7) — full `orchestrate --qa`
  round against the fixture via the mock LLM (`MOCK_SCENARIO=qa-orchestrate`,
  `qa-pass`, `qa-fail` in `scripts/e2e/mock-openrouter.mjs`), asserting the
  state `qa` field, QA tool discipline (no `write_to_file`), verdict parsing,
  and the `run-qa.sh` wrapper markers.
