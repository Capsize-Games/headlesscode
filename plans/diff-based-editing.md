# Diff-based file editing (apply_diff / search_replace / edit_file) — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo — a complete clone of the upstream project.

Match this project's established style:

- No test framework — plain `tsx`-run test files, hand-rolled assertions,
  `All N tests passed` trailer (see `src/tools/__tests__/*.test.ts` or
  `src/checkpoints/__tests__/service.test.ts` for the pattern). Add new test
  files to `package.json`'s `test` script the same way existing entries are
  chained with `&&`.
- Vendor upstream source verbatim where practical, with an entry added to
  `ATTRIBUTION.md` (check its existing format/style before adding to it) —
  this is how checkpoints, mode-loading, and prompt-building were all done
  previously in this project. Only reimplement rather than vendor if the
  upstream file has heavy VS Code coupling that isn't worth carrying — check
  first, don't assume.
- `npx tsc --noEmit` and `npm test` (currently 22 suites) must stay green.
  Re-run all five e2e suites under `scripts/e2e*/run.sh` afterward.

## The problem

Every file edit in `headlesscode` today goes through `write_to_file`
(`writeToFileHandler` in `src/tools/executor.ts`) — a full-file overwrite.
The vendored tool schema (`src/vendor/zoo-code/src/core/prompts/tools/native-tools/`,
mirrored from `zoo-code/src/core/prompts/tools/native-tools/index.ts`) actually
advertises three additional, more surgical edit tools to the model —
`apply_diff`, `search_replace`, and `edit_file` — but headlesscode currently
stubs all three (`IMPLEMENTED_TOOLS` in `src/tools/executor.ts` only lists
`read_file`/`write_to_file`/`execute_command`/`list_files`). A model that
tries any of them today just gets a "not implemented" error and has to fall
back to `write_to_file`.

This is the most consequential gap identified in this project's own
`docs/gap-audit.md`: full-file rewrites cost far more output tokens per edit
than a targeted diff, and there is zero partial-match/hunk validation the way
these tools provide — a truncated or slightly malformed model response
silently clobbers the entire file instead of failing a validation check on a
much smaller diff.

## What to build

Implement all three tools for real. They are genuinely different in
matching strategy, and the model may call any of them depending on its own
training/preference — this project's `getNativeTools()` exposes all three
unconditionally (confirmed by reading `zoo-code/src/core/prompts/tools/native-tools/index.ts`),
so all three need real handlers, not just one.

### 1. `apply_diff`

Format: one or more `SEARCH`/`REPLACE` blocks in a single `diff` string
parameter (see `zoo-code/src/core/prompts/tools/native-tools/apply_diff.ts`
for the exact block syntax the model is told to produce — `<<<<<<< SEARCH`,
optional `:start_line:N`, `-------`, the search content, `=======`, the
replacement content, `>>>>>>> REPLACE`).

The real matching engine is `zoo-code/src/core/diff/strategies/multi-search-replace.ts`
(~670 lines) — read it fully before starting. It does fuzzy matching (not
just exact string match) so minor whitespace/formatting drift in the
model's SEARCH block can still find the right location, with the
`:start_line:` hint used to disambiguate when a search block could match in
more than one place. Vendor this file (and whatever it imports from
`zoo-code/src/core/diff/` — check `types.ts`, any shared distance/similarity
helper) into `src/vendor/zoo-code/src/core/diff/`. Look at
`zoo-code/src/core/tools/ApplyDiffTool.ts` (301 lines) to see how the real
extension wires the parsed diff string into the strategy and turns the
result into a success/failure response — mirror that flow in a new
`applyDiffHandler` in `src/tools/executor.ts`, adapted to this project's
`ToolResult`/`ok`/`err` conventions instead of the VS Code webview messaging
`ApplyDiffTool.ts` uses.

### 2. `search_replace`

Format: `file_path`, `old_string`, `new_string`, optional
`expected_replacements` (default 1). Simpler than `apply_diff`: a literal
string search requiring the model to include enough surrounding context to
be unique (see `zoo-code/src/core/prompts/tools/native-tools/search_replace.ts`
for the exact contract/description text the model is shown). Read whatever
handler backs this upstream (search `zoo-code/src/core/tools/` for a
`SearchReplaceTool.ts`-equivalent — check the actual filename, don't guess)
and port the matching logic:
- If `old_string` matches a different number of times than expected
  (default 1), fail clearly (don't guess which occurrence was meant) —
  this exact-count check is the tool's core safety property, preserve it.
- Empty-string handling: check upstream's behavior for `old_string === ""`
  on an existing vs. non-existing file and match it.

### 3. `edit_file`

Format: `file_path`, `old_string`, `new_string`, optional
`expected_replacements`. Per its own description (read
`zoo-code/src/core/prompts/tools/native-tools/edit_file.ts` in full), this
one is explicitly resilient to formatting drift via a fallback chain: exact
match → whitespace-tolerant match → token-based match, and supports file
creation when `old_string` is `""` (must fail clearly if the file already
exists in that case — check the exact upstream behavior). Find and read the
real handler upstream (again, search `zoo-code/src/core/tools/` for the
matching implementation — do not assume it shares code with `search_replace`
just because the schemas look similar; verify).

### 4. Wire into `src/tools/executor.ts`

- Move `apply_diff`, `search_replace`, `edit_file` out of
  `VENDORED_TOOL_NAMES`'s stub set and into `IMPLEMENTED_TOOLS`, each with a
  real handler registered in `createHeadlessExecutor`.
- These are edit tools — do NOT register them in the read-only
  reviewer/QA executor (`createReadCommandExecutor`) any more than
  `write_to_file` already is; keep the existing non-edit discipline for
  those two roles intact.
- **Checkpoints**: the checkpoint work (already landed) saves a checkpoint
  after any iteration that executed at least one tool call, keyed off the
  executor having `write_to_file` registered — check
  `src/engine/loop.ts`'s exact condition (search for how it currently
  decides whether to checkpoint) and make sure an iteration where the model
  used ONLY `apply_diff`/`search_replace`/`edit_file` (no `write_to_file`
  call at all) still triggers a checkpoint — these are edits too, don't let
  them slip through uncheckpointed because the condition was written before
  they existed.
- **Decision on failure-reporting granularity**: when a diff/search/replace
  fails to match (e.g. `old_string` not found, or found the wrong number of
  times), return a clear, actionable `isError: true` result telling the
  model what went wrong (not found / found N times, expected M / ambiguous
  match) so it can retry with better context, rather than a generic
  "failed" message — match the quality bar of the upstream tool
  descriptions' own guidance to the model.

### 5. Which tool does the model actually reach for?

Note in your report which edit tool(s) you observed a real model (or your
manual smoke tests) actually choosing when given a task with all four edit
tools (`write_to_file` + the three new ones) available — this project
defaults to `deepseek/deepseek-chat`; if you have a way to test against it
via the existing e2e mock pattern or a real key, useful to know for future
tuning, but not required if you don't have API access — a note either way
is fine.

## What NOT to do

- Do not remove or change `write_to_file` — it stays as the full-overwrite
  fallback/file-creation tool, unaffected.
- Do not touch checkpoints, decision-escalation, dashboard, orchestrator
  rework, or permissions work — scoped to `src/tools/executor.ts` plus the
  newly vendored `src/vendor/zoo-code/src/core/diff/` tree (and the
  checkpoint-trigger-condition fix described in point 4, which is a small,
  necessary touch to `src/engine/loop.ts`, not a broader change).
- Do not add a new diff-matching *library* dependency — the whole point is
  porting the existing, already-battle-tested matching logic, not replacing
  it with something else.

## Tests

New `src/tools/__tests__/apply_diff.test.ts`: single block applies cleanly;
multiple blocks in one call; a block with a `:start_line:` hint disambiguates
a search string that appears more than once; a block that doesn't match
returns a clear error, doesn't touch the file; fuzzy/whitespace-tolerant
matching actually tolerates minor drift (prove this with a real test case,
not just exact-match happy path).

New `src/tools/__tests__/search_replace.test.ts` and
`src/tools/__tests__/edit_file.test.ts`: exact-match replace; wrong
occurrence count fails clearly; `edit_file`'s fallback-matching chain
(exact → whitespace-tolerant → token-based) each individually proven with a
case that only the later strategies would catch; `edit_file` file-creation
path (`old_string: ""`) both for a non-existing file (succeeds) and an
existing one (fails clearly, per whatever upstream's real behavior is).

Extend whatever test currently covers checkpoint-triggering (in
`src/checkpoints/__tests__/` or `src/engine/__tests__/loop.test.ts`) with a
case proving an iteration using only `apply_diff` (no `write_to_file`) still
triggers a checkpoint.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. All five e2e suites under `scripts/e2e*/run.sh` still pass.
4. A real manual smoke test: run a session (via the existing
   `scripts/e2e/mock-openrouter.mjs` mock-LLM pattern, or a real API key if
   you have one) where the mock/model is scripted to call `apply_diff`
   against a real scratch file, and confirm the file actually changed
   correctly on disk.

## What to report back

- Files changed/added (including the vendored diff-strategy files and their
  `ATTRIBUTION.md` entry).
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whichever upstream handler files you found for `search_replace`/`edit_file`
  (their real paths — the spec above didn't hand you exact filenames on
  purpose, since guessing wrong and copying the wrong file would be worse
  than you verifying it yourself).
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
