# A real browser-automation tool for the coding agent — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## Important — this is NOT a port, verify that before assuming otherwise

Unlike almost everything else vendored in this project, there is **no
existing Zoo Code browser tool to port**. Confirmed by searching: no
`browser_action` (or similarly-named) native tool schema, and no browser-
automation service, exists anywhere in `zoo-code/` (the full reference
clone) or in `src/vendor/zoo-code/`. `docs/gap-audit.md`'s "No browser
tool" line reflects this correctly — it's a real absence in the upstream
source this project is ported from, not something that exists upstream and
was simply left un-vendored. **Re-verify this yourself before writing any
code** (`grep -rli browser zoo-code/src/core/tools/
zoo-code/src/core/prompts/tools/native-tools/` and similar) in case a
version mismatch or a spot you haven't checked has it — but as of this
document, it does not exist. This task is new design work, not a port, and
should be scoped and evaluated accordingly (more room for judgment calls,
more need to justify design choices since there's no reference
implementation to defer to).

The ONLY existing browser-automation precedent in this project's orbit is
QA-side, not an in-session agent tool: `docs/phase4-qa.md` documents that
QA sessions can invoke a Playwright-based runner
(`~/Projects/airunner/qa/runner.js`) as an `execute_command` call, and that
"live Playwright-MCP interactivity... is not available headlessly" is an
already-accepted, documented gap for QA specifically. This task is
different in purpose (an interactive tool the CODING agent can call
mid-session to inspect a running dev server / verify UI changes visually)
but can reasonably reuse Playwright as the underlying library, since it's
already a proven dependency in this project's sibling repo.

## What to build

**A new native tool** (e.g. `browser_action`, or whatever name you land on
after checking whether this project has any existing naming convention
worth following — there is none from Zoo Code here, so pick something clear
and document it) backed by Playwright, supporting a minimal, well-justified
action set — do not try to build a full browser-automation DSL in one pass:

- `launch(url)` — start a headless browser, navigate to a URL (typically a
  local dev server the agent itself started via `execute_command`).
- `screenshot()` — capture the current page state, returned to the model as
  an image if the model/tool-result path supports image content (check
  whether `ChatMessage`/tool-result plumbing in this project's
  `src/engine/types.ts` supports non-text content at all — if not, that's a
  real prerequisite gap to flag, not silently work around with a text-only
  placeholder).
- `click(selector)` / `type(selector, text)` — basic interaction.
- `getConsoleLogs()` / `getNetworkErrors()` — since `docs/phase4-qa.md`
  notes this kind of instrumentation already exists in airunner's
  `qa/browserInstrumentation.js` for the QA use case; check whether that
  logic is reusable/portable or needs independent reimplementation for this
  different (interactive, not QA-report) use case.
- `close()` — clean shutdown.

**Session lifecycle discipline**, matching this project's established
non-fatal/cleanup idioms:
- The browser process must be torn down on session end even if the model
  never calls `close()` — extend `ToolExecutor.dispose()`'s existing
  child-process-cleanup pattern (it already reaps backgrounded
  `execute_command` children; a launched browser needs the same discipline,
  see the `mcp-tool-support.md` plan doc for the same requirement applied
  to MCP server processes — if that task's dispose()-extension work has
  landed, follow its established pattern rather than diverging).
- A crashed/hung browser must produce a clear tool error, never hang the
  whole session waiting on it — apply a timeout to every browser action,
  matching `execute_command`'s own timeout-then-background (or timeout-
  then-kill, whichever fits a browser action better — a stuck browser
  action isn't like a legitimately long-running background process, so
  killing rather than backgrounding is likely the right call here; justify
  your choice).

## What NOT to do

- Do not claim this ports an existing upstream feature — it doesn't, be
  explicit about that in commit messages/your report.
- Do not build a full browser-automation DSL (arbitrary Playwright API
  passthrough) — a small, well-defined action set per above.
- Do not let a hung/crashed browser process survive session end.
- Do not duplicate `qa/runner.js`'s QA-report-generation logic — that's a
  different concern (structured pass/fail QA output) from this task's
  interactive tool-call use case.

## Tests

- `src/tools/__tests__/browser-action.test.ts`: launch/screenshot/click/
  type/getConsoleLogs/close against a real local static page served for
  test purposes (spin up a trivial `http` server in the test, don't depend
  on network access), covering success and error cases (bad selector,
  navigation failure).
- A test proving session end kills a still-open browser process, mirroring
  the existing `execute_command` orphan-reaping test's approach in
  `src/engine/__tests__/loop.test.ts`.
- A timeout test proving a hung action doesn't hang the whole session.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. A real manual smoke test: launch a real local dev server (this repo's
   own `headlesscode dashboard` is a convenient real target), use the new
   tool for real to navigate/screenshot/click something in it, and include
   the result (or the actual screenshot, if you can attach one) in your
   report.

## What to report back

- Files changed/added.
- Confirmation this is new work, not a port (and why, per the verification
  above).
- Whether image content in tool results is actually supported by this
  project's message/type plumbing, or what gap you found/worked around.
- Confirmation of tsc/test/e2e results.
- Real manual smoke-test result.
- Any deviation from this spec, and why.
