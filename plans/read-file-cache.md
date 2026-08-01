# Session-scoped read_file cache — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI that runs a headless coding-agent loop (ported
from a VS Code extension called Zoo Code, vendored under `src/vendor/zoo-code/`).
The full original source is also available for reference (read-only, do not
edit) at `zoo-code/` in this repo.

Match this project's established style: no test framework (plain `tsx`-run
test files, hand-rolled `assert`, `All N tests passed` trailer — see
`src/tools/__tests__/apply_diff.test.ts` for the pattern); minimal new
dependencies; `npx tsc --noEmit` and `npm test` must stay green; re-run every
e2e suite under `scripts/e2e*/run.sh` afterward (six of them: `e2e`,
`e2e-phase2`, `e2e-phase4`, `e2e-phase5`, `e2e-phase6`, `e2e-permissions`).

## The problem, confirmed with real production data

A real headless session (deepseek/deepseek-v4-flash, official DeepSeek
endpoint) was traced via harness.log on 2026-08-01. By iteration 81 it had
called `read_file` on `src/engine/__tests__/loop.test.ts` **16 times** and on
`src/engine/loop.ts` **14 times** — the exact same path, same arguments, same
file content, over and over, with zero edits to those files in between. This
was caused by a separate, now-fixed bug (an overly small sliding-window
history truncation evicting earlier reads from context — see
`DEFAULT_WINDOW_SIZE`'s doc comment in `src/engine/loop.ts` for the full
story), but it exposed a real, independent inefficiency worth fixing on its
own merits: **the executor has no idea it already served this exact content
and will happily re-read + re-send it, at full token cost, every single
time.** Even with the truncation bug fixed, a model will still legitimately
re-`read_file` a path it already saw earlier in a long session (to double
check something, after other work happened in between, etc.) — there's no
reason to pay full output-token cost re-sending byte-identical content when a
short "unchanged since your last read" message conveys the same information
far more cheaply.

## What to build

A session-scoped cache in the tool executor: when `read_file` is called with
the exact same effective arguments (same `path`, same `mode`, same
`offset`/`limit` or same `indentation` options — i.e. a call that would
produce byte-identical output) as a prior call **in the same session**, AND
the file's on-disk content is unchanged since that prior call, return a short
cache-hit message instead of the full content again.

**Correctness requirement — do not trust "no write tool was called" as your
invalidation signal.** A file can change between two `read_file` calls for
reasons the executor doesn't directly control — `execute_command` running a
formatter/codegen/build step, `apply_diff`/`search_replace`/`edit_file`
touching the file, or (in principle) anything else. The only correct way to
know content hasn't changed is to **hash the actual current on-disk content**
at cache-check time and compare it to the hash you had stored from the prior
read — not to track "did a write-shaped tool get called on this path." Use a
cheap hash (Node's built-in `crypto.createHash("sha256")` or similar — no new
dependency needed).

### Where the cache lives

This needs to be scoped to one session's lifetime, not global/persisted
across sessions (a fresh session should always get real content on its first
read of each file — this is purely about not re-paying for what THIS session
already has in its own conversation history). `ToolExecutor` instances are
already constructed per-session (see `createHeadlessExecutor` in
`src/tools/executor.ts` and where `HeadlessSession` constructs one in
`src/engine/loop.ts`), so a `Map` living on the `ToolExecutor` instance itself
is the natural home — check how `pauseBudgetClock`/`resumeBudgetClock` are
already stored as instance state on `ToolExecutor` for the existing pattern
to follow. Do NOT persist this to disk, and do NOT share it across
`ToolExecutor` instances (the reviewer/QA read-only executor, if it also
calls `read_file`, should get its own independent cache, not share one with
an editing session — check `createHeadlessExecutor` vs. its read-only sibling
in this file for the two construction paths).

### The cache-hit response

When a call is a confirmed cache hit (same effective args AND same content
hash as this session's prior call), return a short message instead of the
full file content — something like: `[cache] '<path>' is unchanged since
your last read of it earlier in this session (identical content, same
range). Re-read the earlier tool result for the content, or call read_file
again if you specifically need it re-sent.` Do NOT make this an error result
(`isError: true`) — it's informational, not a failure; the model should be
able to just proceed with what it already knows, or explicitly ask for the
content again if it genuinely needs it re-sent (in which case: on a SECOND
identical call in a row for the same args, just serve the real content again
rather than looping a cache-hit message forever — see "what NOT to do"
below for why this matters).

### Cache key

The key must capture everything that affects the tool's actual output for
`read_file`: `path` (resolved/normalized), `mode` ('slice' vs 'indentation'),
and the mode-specific args (`offset`/`limit` for slice, the `indentation`
object's fields for indentation mode). Two calls with different `offset`
values are NOT a cache hit even for the same path — they can return
different content. Read `readFileHandler` in `src/tools/executor.ts` (and the
tool's schema in
`src/vendor/zoo-code/src/core/prompts/tools/native-tools/read_file.ts`,
already read today for an unrelated schema fix — this project's context on
its args shape) to get the exact arg set right; don't guess at the schema.

## What NOT to do

- Do not cache other tools (`list_files`, `execute_command`, etc.) in this
  pass — `read_file` is the one with the confirmed, measured waste. If you
  see similar waste elsewhere while working on this, flag it in your report
  rather than silently expanding scope.
- Do not return a cache-hit message on a SECOND consecutive identical call
  for the same key — only apply the cache-hit short-circuit once per
  "unchanged streak," then serve real content again on the next identical
  call, so a model that's confused/insistent isn't stuck being told "it's
  cached" forever with no way to actually get the content back. (Track
  "already told them it's cached since the last real content I served" per
  key, reset that flag whenever real content is served again.)
- Do not build a cross-session/persisted cache — explicitly out of scope,
  see "Where the cache lives" above.
- Do not change `write_to_file`/`apply_diff`/`search_replace`/`edit_file`'s
  behavior — they should keep working exactly as today. (Though: after your
  change, verify a `read_file` immediately following an edit to that same
  path correctly returns fresh content, not a stale cache hit — this is the
  hash-check doing its job, not something you need to special-case.)

## Tests

New `src/tools/__tests__/read-cache.test.ts` (or extend the existing
`src/tools/__tests__/` suite for `read_file` if one already covers it — check
first):
- Two identical `read_file` calls (same path, same args) in a row, with no
  changes to the file in between: first returns real content, second returns
  the short cache-hit message (assert it's NOT the full content, assert
  `isError: false`).
- Three identical calls in a row: first real, second cache-hit, **third
  real again** (per the "don't loop cache-hit forever" rule above).
- Two identical `read_file` calls, but the file is modified on disk (via
  `fs.writeFileSync` in the test, simulating an out-of-band change like a
  build step) between them: second call returns real, fresh content, not a
  cache hit — proves the hash-check catches non-tool-mediated changes, not
  just tracking whether `write_to_file` was called.
- Two `read_file` calls with the same path but DIFFERENT `offset`/`limit`
  (or slice vs. indentation mode): never a cache hit, even though the path
  is the same.
- A `write_to_file` (or `apply_diff`) to a path, followed by `read_file` on
  that same path with the same args as an earlier read: NOT a cache hit
  (content actually changed) — confirms the hash-check invalidates correctly
  through the normal edit path too, not just the out-of-band case above.
- Two independently-constructed `ToolExecutor` instances (simulating two
  separate sessions) each reading the same path: no cache hit across them —
  confirms the cache is per-instance, not accidentally global/module-level
  state.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including the new one.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes (these exercise
   real `read_file` calls through the full loop — confirm none of them
   assert on exact tool-result content in a way your change would break; if
   one does and the assertion is now testing a cache-hit path unexpectedly,
   investigate rather than silencing the test).
4. If you have real OpenRouter API access, run one real short session
   against a scratch repo where you deliberately have the model (or a
   scripted task) read the same file twice, and confirm in `harness.log`
   that the second read's tool result is the short cache-hit message, not
   full content. If you do NOT have real API access, say so plainly and
   describe what you verified instead (the unit tests above, run against
   the real `readFileHandler`, not a mock of it).

## What to report back

- Files changed/added.
- Confirmation of tsc/test/e2e results (actual pass/fail counts).
- Whether the manual smoke test was run against a real API or not, and why.
- Rough estimate, from the test fixtures or a real run, of how much this
  actually saves (e.g. "avoided resending an N-char file on the Mth repeat
  read") — this is the whole point of the change, so quantify it if you can.
- Any deviation from this spec, and why.
- Anything you noticed while doing this that looks like a related bug or
  gap, even if unfixed — flag it rather than ignoring it.
