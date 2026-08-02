# Make read_file usage patterns observable, and nudge toward targeted reads — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. Small,
two-part task motivated by a real gap noticed today: `read_file` is used
heavily across real sessions, it defaults to returning up to 2,000 lines
per call (`DEFAULT_LINE_LIMIT` in
`src/vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.ts`),
and it already supports a targeted `indentation` mode (extract just the
function/class containing a given line) — but nobody can currently tell
from `harness.log`/the event feed whether real sessions are actually using
that targeted mode or defaulting to broad slice reads, because the
existing diagnostic logging only records the file path, not the mode/
range. This task closes that visibility gap and adds a cheap guidance nudge.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## What to build

### 1. Extend diagnostic logging for read_file specifically

`summarizeToolArg` in `src/engine/loop.ts` (used for both `harness.log`
diagnostic lines and, check whether `EventFeed.toolCall`'s `args` field in
`src/engine/events.ts` reuses the same helper or has its own — if they're
separate, update both consistently) currently returns just `args.path` for
`read_file`. Extend it (for `read_file` specifically only — do not change
the summary shape for other tools) to also include `mode` (default to
`"slice"` when absent, matching the tool's own real default), and either
`offset`/`limit` (slice mode) or the `indentation.anchor_line` (indentation
mode), in a short one-line format — e.g. `src/engine/loop.ts [slice
offset=1 limit=2000]` or `src/engine/loop.ts [indentation anchor=245]`.
Keep it short — this is a diagnostic line, not a full args dump.

### 2. Add a rule-guidance nudge for indentation mode

`.roo/rules-code/rules.md` (added during today's `codebase-search-activation`
task — re-read its current content first, don't duplicate or contradict
what's already there about preferring `codebase_search` before whole-file
reads) currently stops at "try `codebase_search` before blind reads." Add
the next step: once a search/grep result gives a specific line number,
prefer `read_file`'s `indentation` mode anchored on that line over a broad
`slice` read — extract the containing function/class, not the whole file
around it. State this as guidance, not a hard rule (there are legitimate
reasons to want a slice read — initial file orientation, reading a small
config/data file in full, etc. — the guidance should say when indentation
mode is the better choice, not forbid slice mode outright).

## What NOT to do

- Do not change `read_file`'s actual default behavior — this task is
  observability + guidance, not a behavior change to the tool itself.
- Do not bloat the diagnostic log line for every tool — this change is
  specific to `read_file`'s extra detail, other tools' summaries stay as
  they are.
- Do not weaken or contradict the existing `codebase_search`-preference
  guidance already in `.roo/rules-code/rules.md` — this is additive.

## Tests

- Extend `src/engine/__tests__/` (wherever `summarizeToolArg` or its
  equivalent is currently tested, or add a new small test file if it isn't
  tested directly yet) with cases for: slice mode with explicit
  offset/limit, slice mode with no args (defaults shown), indentation mode
  with an anchor line — assert the exact expected summary string for each.
- If `EventFeed`'s `tool_call` event has its own separate args-summarizing
  logic, test that too, not just the `harness.log` path.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new/updated ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. If you have real API access: run one real session that calls
   `read_file` a few times with a mix of default/slice/indentation usage,
   and quote the resulting `harness.log` lines in your report — prove the
   new detail actually shows up, not just that the code compiles.

## What to report back

- Files changed.
- Real example log lines showing the new detail (from a real session if
  you have API access; from a scripted/mock session otherwise — say which).
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
- If you have real API access and can run a quick before/after-style
  comparison (a session with the new guidance vs. one without, on a task
  that clearly has a findable line number to anchor on), note whether the
  guidance actually changed behavior — this is optional given the task's
  small scope, but valuable if easy to check.
