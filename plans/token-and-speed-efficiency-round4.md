# Token, speed & robustness efficiency, round 4: reasoning strip, checkpoint/emit off critical path, tool-call parallelism, bounded executor output, atomic state

## Who you are working on this for

You are implementing this against the `headlesscode` repository — a standalone
Node/TypeScript CLI that runs a headless coding-agent loop, ported from the
open-source Zoo Code VS Code extension (vendored verbatim under
`src/vendor/zoo-code/`). It has no build step; everything runs directly via
`tsx`.

Read `.roo/rules/rules.md` in full before starting — especially the
"non-fatal failure pattern" and the "plan docs must cite verified file:line
locations" rules. The verification bar in that file is repeated here because it
is the gate for every item below.

**Commit your work before calling `attempt_completion`.** Run `git add` +
`git commit` with a descriptive message per logical change (run
`git log --oneline` for this repo's normal style). Do not merge, push, or open
a PR — the orchestrator handles that.

## Verification bar (applies to every item)

- `npx tsc --noEmit` must be clean.
- `npm test` must pass in full. This repo has NO test framework — tests are
  plain `.test.ts` files run directly via `tsx`, with hand-rolled `assert`
  calls and an `All N tests passed` trailer. Look at any existing
  `src/*/__tests__/*.test.ts` file before writing a new one.
- **Test runner is glob-based, NOT a package.json list.** `package.json`'s
  `test` script is `node scripts/run-tests.mjs`
  ([`package.json:19`](package.json:19)); that runner glob-discovers every
  `*.test.ts` under `src/` and runs it in sorted order
  ([`scripts/run-tests.mjs:28-42`](scripts/run-tests.mjs:28) for discovery,
  [`scripts/run-tests.mjs:79-84`](scripts/run-tests.mjs:79) for the file list,
  [`scripts/run-tests.mjs:101-110`](scripts/run-tests.mjs:101) for the run
  loop). Its own header comment
  ([`scripts/run-tests.mjs:1-16`](scripts/run-tests.mjs:1)) states explicitly
  that adding a test file requires touching zero lines outside the new file.
  **Do NOT edit `package.json` to add new test files** — drop a new
  `src/**/*.test.ts` and the glob picks it up. Any older guidance telling you
  to chain new tests into `package.json` is stale.
- Because several items below touch `src/engine/loop.ts` (the core loop), the
  e2e suites are also in scope for those items: re-run
  `scripts/e2e/run.sh` (and, if you touch checkpoints, the checkpoint flows it
  exercises). The loop items do not touch `src/orchestrator/` or
  `src/watcher/`, so the full `scripts/e2e-phase*/run.sh` set is not required
  unless your edits wander into those directories.

## Ordering & grouping — read this before anything else

This document is a **single, strictly sequential work order** meant to be
executed in **one worktree, one item at a time**. Rationale: six of the ten
items concentrate in [`src/engine/loop.ts`](src/engine/loop.ts) (T1, S1, S2,
S3, and the tool-catalog half of T2/T3); editing that file from parallel
worktrees is guaranteed to conflict. Do not split the loop items across
worktrees.

Execution order (each item is verified with `tsc` + the relevant tests before
moving to the next):

1. **E4** — atomic orchestrator state write (`src/orchestrator/state.ts`) — independent, low risk.
2. **E1** — cap `execute_command` output accumulation (`src/tools/executor.ts`).
3. **E2** — `list_files` short-circuit (`src/tools/executor.ts`).
4. **E3** — `read_file` hash fast-path (`src/tools/executor.ts`).
5. **S4** — cache stack detection (`src/engine/stacks.ts`) — independent, low value, do last of the independent items.
6. **S2** — fire-and-forget/coalesce auxiliary writes (`src/engine/loop.ts`) — first loop.ts change; it introduces the ordering-guard helper reused by S1.
7. **S1** — decouple checkpoints from the critical path + skip read-only turns (`src/engine/loop.ts`) — reuses S2's helper.
8. **T1** — strip superseded reasoning from assistant history (`src/engine/loop.ts` + [`src/engine/__tests__/events.test.ts`](src/engine/__tests__/events.test.ts)) — **RISKY**.
9. **T2/T3** — shrink fixed system prompt + per-mode tool catalog — **MEASURE FIRST**, no surgery until numbers justify it.
10. **S3** — parallelize independent tool calls within a turn (`src/engine/loop.ts`) — **RISKIEST**, last on purpose so any regression is isolated to one commit and can be reverted without disturbing items 1–9.

Items 1–5 touch different files from 6–10 and can be committed independently as
you go. Items 6–10 all touch `src/engine/loop.ts`; commit each one separately
with a descriptive message so a bisect can pin a regression to a single item.

Line numbers cited below were verified against the source at plan-writing time.
If a cited line no longer matches the file content when you arrive, treat it as
"approximately here — verify before trusting" and re-locate the construct by
its described shape (the value is narrowing the search, not an exact-match
guarantee).

---

## Item E4 — atomic orchestrator state write (independent, low risk)

### The evidence

`saveState` writes the durable orchestrator state file with a single direct
`fsp.writeFile` — no temp file, no rename — at
[`src/orchestrator/state.ts:329-334`](src/orchestrator/state.ts:329). The sync
variant does the same at
[`src/orchestrator/state.ts:337-342`](src/orchestrator/state.ts:337). A crash
or kill mid-write truncates the JSON and corrupts the one file that is treated
as the authoritative source of truth for a round (see the file header's own
note that it is "durable source of truth" at
[`src/orchestrator/state.ts:1-30`](src/orchestrator/state.ts:1)).

### What to build

Make **both** `saveState` and `saveStateSync` atomic via write-to-temp-then-rename:

- Serialize to a sibling temp path in the same directory as `statePath`
  (e.g. `${statePath}.tmp-${process.pid}` or a fixed `${statePath}.tmp`) so
  the `rename` stays on the same filesystem.
- `fsp.writeFile` / `fs.writeFileSync` the temp file, then
  `fsp.rename` / `fs.renameSync` over `statePath`. `rename` is atomic on
  POSIX for same-filesystem paths, which this is (the temp lives next to the
  target).
- Preserve the exact current serialization (`JSON.stringify(cleaned, null, 2) + "\n"`) and the `sanitize` + `updated` stamping — do not change the on-disk shape.
- Keep the `mkdir` of `path.dirname(statePath)` before the temp write.

The repo already has a `rename` + fallback idiom you can look at for style, but
not reuse directly (it moves directories, not files): `moveVerified` at
[`src/project-store.ts:263-275`](src/project-store.ts:263). For a single
same-filesystem file write, plain `rename` is sufficient; do not add a
cross-device copy fallback (the temp is always adjacent to the target).

### What NOT to do

- Do not change the JSON schema, the `updated` stamping, or `sanitize`.
- Do not change the public signatures of `saveState`/`saveStateSync`.
- Do not write the temp file anywhere outside the state file's own directory
  (and never to `/tmp`).

### Test changes

Existing coverage: `src/orchestrator/__tests__/state.test.ts` already
round-trips `saveState`/`saveStateSync` (e.g.
[`src/orchestrator/__tests__/state.test.ts:32-59`](src/orchestrator/__tests__/state.test.ts:32)).
Add assertions there (or a new test in the same file):

- After `saveState`, the target file exists and parses, and **no `.tmp` file is
  left behind** in the directory.
- The same for `saveStateSync`.
- (Optional but cheap) an interrupted-write simulation: write garbage to the
  temp path yourself is not needed — the meaningful assertion is "no temp
  residue after a successful write" plus "the existing round-trip still
  passes".

### Verification

`npx tsc --noEmit`; `npm test -- state` then full `npm test`.

---

## Item E1 — cap `execute_command` output accumulation (executor.ts)

### The evidence

`executeCommandHandler` accumulates `stdout += chunk` / `stderr += chunk`
unbounded across the whole run of the command
([`src/tools/executor.ts:1252-1264`](src/tools/executor.ts:1252)), with the
combined string built on close at
[`src/tools/executor.ts:1270-1294`](src/tools/executor.ts:1270). The only size
discipline is applied **after** the fact, at the very end, by
`summarizeCommandOutput` → `truncate`
([`src/tools/executor.ts:438-451`](src/tools/executor.ts:438),
[`src/tools/executor.ts:412-420`](src/tools/executor.ts:412)), which cuts at
`MAX_RESULT_CHARS = 30_000`
([`src/tools/executor.ts:119`](src/tools/executor.ts:119)). A command that
streams hundreds of MB (a noisy build, a runaway log) therefore consumes
hundreds of MB of harness RAM before truncation.

### What to build

Bound the accumulation while still **draining the pipe so the child never
blocks on a full buffer**:

- In the `data` handlers at
  [`src/tools/executor.ts:1252-1264`](src/tools/executor.ts:1252), keep the
  `.on("data", ...)` listeners attached unconditionally (drain always — the
  existing `!timedOut` guard stays), but stop appending to `stdout`/`stderr`
  once that stream's accumulated length has reached a cap. Use a cap around
  `MAX_RESULT_CHARS` (e.g. `MAX_RESULT_CHARS` per stream, or a small margin
  above it — do not invent a new magic number; anchor it to `MAX_RESULT_CHARS`).
- The final `combined` string on close (and the timeout path at
  [`src/tools/executor.ts:1244-1249`](src/tools/executor.ts:1244)) must keep
  working unchanged: it joins whatever was captured and passes it to
  `summarizeCommandOutput`, which remains the single place that produces the
  user-visible "output truncated" trailer. Do NOT add a second truncation
  message.
- Do not change the timeout semantics, the `detached`/`shell`/`stdio` spawn
  options, the permissions gate, or the SIGKILL/close/error handling.

### What NOT to do

- Do not stop reading the pipe (that would deadlock a child whose buffer fills).
- Do not change the final truncation/summarization contract — the model must
  still see the same "truncated at N chars" trailer when summarization is off.
- Do not touch `read_file`/`write_to_file`/diff output — this item is
  `execute_command` only.

### Test changes

Extend `src/tools/__tests__/execute_command.test.ts` (or add a focused test
there): run a command that emits several times `MAX_RESULT_CHARS` (e.g.
`node -e "process.stdout.write('x'.repeat(200000))"`), and assert:

- The call **completes** (does not hang) — this is the regression the item
  guards against.
- The result content is bounded near `MAX_RESULT_CHARS` (plus the existing
  trailer), not the full 200k chars.
- The existing "blunt truncation trailer" assertion still holds when local
  summarization is off.

### Verification

`npx tsc --noEmit`; `npm test -- execute_command` then full `npm test`.

---

## Item E2 — `list_files` short-circuit (executor.ts)

### The evidence

`listFilesHandler` calls `collectEntries`, which recursively walks the entire
tree and builds the **full** entry array
([`src/tools/executor.ts:1330-1354`](src/tools/executor.ts:1330)), then sorts
it ([`src/tools/executor.ts:1316-1321`](src/tools/executor.ts:1316)) and only
then truncates to `MAX_LIST_FILES = 500`
([`src/tools/executor.ts:1323-1324`](src/tools/executor.ts:1323),
[`src/tools/executor.ts:146`](src/tools/executor.ts:146)). A recursive listing
of a huge tree (e.g. `node_modules`) builds and sorts hundreds of thousands of
entries before discarding all but 500.

### What to build

Stop collecting once the cap is exceeded:

- Thread a budget through `collectEntries` (default `MAX_LIST_FILES`). Once the
  accumulated count reaches the cap, stop descending into further
  subdirectories and stop pushing entries. Return the bounded array plus a
  `truncated: boolean` signal (or a sentinel) so the caller knows the full
  total is no longer known.
- Keep the dirs-first, then alphabetical sort over the **collected subset**
  ([`src/tools/executor.ts:1316-1321`](src/tools/executor.ts:1316)) — the
  natural walk already pushes a directory before recursing into it
  ([`src/tools/executor.ts:1344-1348`](src/tools/executor.ts:1344)), so dirs
  still tend to come first.
- Update the truncation trailer at
  [`src/tools/executor.ts:1324`](src/tools/executor.ts:1324) to omit the exact
  total when it is no longer known (e.g. "File list truncated: 500 entries
  shown. Use list_files on specific subdirectories to see more."). Do not drop
  the trailer entirely — it is the signal that more exists.
- The non-recursive top-level listing path must keep its current exact behavior
  (it rarely exceeds 500; only the recursive walk is the unbounded case).

### What NOT to do

- Do not change `MAX_LIST_FILES`'s value or the "dirs first" ordering rule.
- Do not add a new dependency for this — plain `node:fs` recursion already works.
- Do not change `collectEntries`'s depth guard (`depth > 32`).

### Test changes

Add a test (new `src/tools/__tests__/list-files.test.ts`, or extend an existing
executor test if one already covers `list_files` — check first) that:

- Creates a directory with > `MAX_LIST_FILES` (500) files (a loop writing 600
  small files is fine) and asserts the listing returns exactly 500 entries plus
  the truncation trailer, and completes quickly.
- Asserts a small directory still returns the complete, dirs-first listing
  without the trailer.

### Verification

`npx tsc --noEmit`; `npm test -- list_files` then full `npm test`.

---

## Item E3 — `read_file` hash fast-path (executor.ts)

### The evidence

On every `read_file` call the handler reads the whole file and computes a
full-content `sha256` to key the session read-cache — even for a small slice of
a large file ([`src/tools/executor.ts:604-618`](src/tools/executor.ts:604),
with `hashFileContent` at
[`src/tools/executor.ts:569-571`](src/tools/executor.ts:569)). The cache entry
stores `{ hash, toldUnchanged }` and the hit decision is
`cache.hash === currentHash`
([`src/tools/executor.ts:611-634`](src/tools/executor.ts:611)).

### What to build

Avoid re-hashing the full file when it demonstrably has not changed:

- `fsp.stat` the target first and capture its `size` plus the highest-resolution
  mtime available (`mtimeNs`; `mtimeMs` is an acceptable fallback).
- Extend the cache entry to `{ hash, size, mtimeNs, toldUnchanged }`. On a
  cache lookup:
  - If `size` **and** `mtimeNs` match the cached entry, reuse the cached
    `hash` without re-reading or re-hashing (skip the full-content sha256).
  - On any mismatch, fall back to today's path: read the file, compute the full
    sha256, and update the entry's `{ hash, size, mtimeNs }`.
- The cache-hit decision stays content-hash-based: `cache.hash === currentHash`
  where `currentHash` is either the reused cached hash or a freshly computed
  one. Do NOT change the `toldUnchanged` short-circuit semantics or the
  `READ_FILE_CACHE_HIT_MESSAGE` result.
- Add a one-line comment explaining the trust model (size+mtime unchanged ⇒
  same content; fall back to full hash on any mismatch). This is the one place
  the WHY is non-obvious, per the repo's comment convention.

### What NOT to do

- Do NOT regress the read-cache correctness contract. In particular, a file
  rewritten to the **same length but different content** must still be
  re-served as real content, not as "unchanged". Your `size+mtime` fast-path
  handles this via the mtime check — verify it with a test (below).
- Do NOT apply this fast-path to anything other than `read_file`'s cache key.
- Do NOT change the cache-hit message text or the `toldUnchanged` flag
  behavior.

### Test changes

Extend `src/tools/__tests__/read-cache.test.ts`:

- Unchanged file + same args → still returns the cache-hit message (behavior
  preserved).
- Rewrite the file to different content of the **same byte length** (e.g.
  `"aaaa"` → `"bbbb"`) and assert the next `read_file` returns the real new
  content, NOT the cache-hit message. (If your filesystem mtime is coarse, make
  this robust by bumping mtime explicitly via `fs.utimes` before the read, or
  write with a delay — the point is to prove the fallback fires.)

### Verification

`npx tsc --noEmit`; `npm test -- read-cache` then full `npm test`.

---

## Item S4 — cache stack detection (engine/stacks.ts, independent, LOW priority)

### The evidence

`detectStacks` runs a full project file walk on every call — manifest stats,
then a `listProjectFiles` walk (git-tracked files, or a bounded recursive walk
when not a git repo) with a per-file extension scan
([`src/engine/stacks.ts:243-327`](src/engine/stacks.ts:243), with
`listProjectFiles` at
[`src/engine/stacks.ts:199-202`](src/engine/stacks.ts:199) and the extension
scan loop at
[`src/engine/stacks.ts:309-324`](src/engine/stacks.ts:309)). It is invoked
from prompt construction via `loadStackRules`
([`src/engine/prompt.ts:310`](src/engine/prompt.ts:310)), which runs at session
start and again on each tool-set-changing `switch_mode` — not per iteration.

### What to build

A per-workspace in-process cache, invalidated by a cheap root mtime signal:

- Memoize `detectStacks` results in a module-level `Map<workspaceRoot, { rootMtimeNs, stacks: Set<StackName> }>` (or a `Map` of resolved root → cached result).
- On each call, `stat` `workspaceRoot`; if the cached `rootMtimeNs` matches, return the cached `Set` (a copy, or document that callers must not mutate it).
- On mismatch (or first call), run the existing detection, store `{ rootMtimeNs, stacks }`, and return.
- Never throw from the cache path; a failed `stat` falls back to running detection (matching the existing "never throws" contract documented at
  [`src/engine/stacks.ts:238-242`](src/engine/stacks.ts:238)).

### What NOT to do

- Do not change which stacks are detected or the order/priority of detection.
- Do not persist the cache to disk — it is per-process only.
- Do not skip the detection on a cache miss.

### Test changes

`src/engine/__tests__/stacks.test.ts` already exercises detection. Add a test
that: (a) calling `detectStacks` twice on the same root returns equal results,
and (b) creating a new stack-signal file (e.g. adding a `CMakeLists.txt`) and
calling again picks up the new stack. Because the cache is in-process, expose a
reset only if needed for the test (prefer making the test create the file
before the first call vs. after, in two separate workspaces, to avoid needing a
reset hook).

### Test changes / verification

`npx tsc --noEmit`; `npm test -- stacks` then full `npm test`.

---

## Item S2 — fire-and-forget / coalesce non-fatal auxiliary writes (loop.ts — FIRST loop.ts change)

### The evidence

Five auxiliary write paths are awaited inline in the critical path, even though
each is already non-fatal (try/catch + warn inside `emitEvent` /
`writeLiveSnapshot`):

- `iteration_start` — `await this.emitEvent("iteration_start", ...)` at
  [`src/engine/loop.ts:2292`](src/engine/loop.ts:2292).
- live usage snapshot — `await this.writeLiveSnapshot(...)` at
  [`src/engine/loop.ts:2420`](src/engine/loop.ts:2420).
- `llm_response` — `await this.emitEvent("llm_response", ...)` at
  [`src/engine/loop.ts:2448-2471`](src/engine/loop.ts:2448) (the `await` at `:2450`).
- `tool_call` — `await this.emitEvent("tool_call", ...)` at
  [`src/engine/loop.ts:2619-2633`](src/engine/loop.ts:2619) (`await` at `:2622`).
- `tool_result` — `await this.emitEvent("tool_result", ...)` at
  [`src/engine/loop.ts:2708-2721`](src/engine/loop.ts:2708) (`await` at `:2708`).

`emitEvent` (which wraps each feed write in try/catch and only then calls
`eventHook`) is defined at
[`src/engine/loop.ts:1439-1452`](src/engine/loop.ts:1439); `writeLiveSnapshot`
at [`src/engine/loop.ts:1395-1415`](src/engine/loop.ts:1395).

### What to build

Introduce a fire-and-forget dispatcher that preserves **ordering** so events
land in the feed in the order they occurred:

- Add a private helper on `HeadlessSession`, e.g.
  `scheduleAux(fn: () => Promise<void>): void`, which appends `fn` to a
  per-session promise chain (`this._auxChain = this._auxChain.then(fn).catch(...)`)
  so later scheduled writes never overtake earlier ones. Errors are already
  swallowed inside `emitEvent`/`writeLiveSnapshot`; the `.catch` is a
  belt-and-suspenders no-op log.
- Replace the five `await this.emitEvent(...)` / `await this.writeLiveSnapshot(...)`
  sites above with `this.scheduleAux(() => this.emitEvent(...))` (same for the
  snapshot). Keep the exact event payloads and call signatures unchanged.
- Because these are "append to feed / overwrite one snapshot file" writes, the
  ordering guard is what makes them safe to de-await. Do NOT de-await anything
  that is not already wrapped in a non-fatal try/catch.
- This helper is then reused by S1 for the checkpoint path.

### What NOT to do

- Do NOT de-await the LLM call, the tool execution, `checkPauseRequested`, or
  `checkInjectedMessage` — only the five auxiliary event/snapshot writes.
- Do NOT change the failure contract: a feed/snapshot failure must still be
  logged and must still never fail the session.
- Do NOT fire-and-forget `recordUsage`/final-report/checkpoint writes here —
  those are separate items with their own constraints.

### Test changes

Existing event-sequence tests (e.g. `src/engine/__tests__/events.test.ts`
`testEventSequenceWithToolThenCompletion` and the live-snapshot tests in
`src/engine/__tests__/loop.test.ts:786-895`) must still pass — they assert the
events exist and are ordered. Because the loop still awaits the LLM call and
tool execution between scheduling, ordering is preserved in practice; verify
those tests still pass unmodified. If a test needs the events to be durable
before the session returns, that test now has a race — look for any assertion
that reads the feed/snapshot immediately after `run()` returns and, if it
flakes, have the session drain `this._auxChain` at the end of `run()` (await
the chain before returning) so "session ended" still implies "aux writes
flushed". Add the drain-at-end if any test needs it; otherwise the chain can
run to completion in the background.

### Verification

`npx tsc --noEmit`; `npm test -- events` and `npm test -- loop`; then
`scripts/e2e/run.sh`; then full `npm test`.

---

## Item S1 — decouple checkpoints from the critical path + skip read-only turns (loop.ts)

### The evidence

After every turn with `calls.length > 0`, the loop awaits a full checkpoint
snapshot — including turns that only read/explore:
[`src/engine/loop.ts:2790-2793`](src/engine/loop.ts:2790) (`await this.saveIterationCheckpoint(iteration)` at `:2793`).
`saveIterationCheckpoint` calls `checkpointService.save(...)`
([`src/engine/loop.ts:2869-2885`](src/engine/loop.ts:2869)), which delegates to
`saveCheckpoint` ([`src/checkpoints/service.ts:180-182`](src/checkpoints/service.ts:180))
→ a shadow-git `git add -A --ignore-errors` + commit (the patched `stageAll` at
[`src/checkpoints/service.ts:141-150`](src/checkpoints/service.ts:141)). A
shadow-git commit per exploration turn is pure critical-path latency.

The loop already computes "every call in this turn is read-only" for the
blind-tree-walking nudge at
[`src/engine/loop.ts:2760-2788`](src/engine/loop.ts:2760), using
`READ_ONLY_TOOL_NAMES` plus `isReadOnlyEquivalentShellCommand` for
`execute_command` (the classifier at
[`src/engine/loop.ts:301-349`](src/engine/loop.ts:301)).

### What to build

Two changes, in this order:

1. **Skip read-only turns.** Reuse the exact `allReadOnly` computation from the
   nudge block ([`src/engine/loop.ts:2761-2767`](src/engine/loop.ts:2761)) at
   the checkpoint site: only call `saveIterationCheckpoint` when the turn is
   NOT all-read-only (i.e. it made, or attempted, an edit-capable/state-changing
   call). A pure `read_file`/`list_files`/`search_files`/read-only-shell turn
   no longer pays a shadow-git commit.
2. **Fire-and-forget with ordering guard.** For the turns that DO checkpoint,
   schedule `saveIterationCheckpoint` through the `scheduleAux` helper added in
   S2 instead of `await`ing it, so the shadow-git commit runs off the critical
   path. The ordering guard ensures a later snapshot's commit can never land
   before an earlier one. Keep `saveIterationCheckpoint`'s internal try/catch
   and "disable checkpoints for the rest of the session on failure" behavior
   unchanged.

Note the ordering interaction: skip-read-only (change 1) is the primary,
lowest-risk win; fire-and-forget (change 2) depends on S2's helper and is the
secondary win. If S2 is not yet landed, do change 1 only and note change 2 as
blocked on S2.

### What NOT to do

- Do not skip the **baseline** checkpoint in `initCheckpoints`
  ([`src/engine/loop.ts:2820-2860`](src/engine/loop.ts:2820)).
- Do not skip checkpoints for `apply_diff`/`write_to_file`/`execute_command`
  (mutating) turns — `testCheckpointTriggeredByApplyDiffOnly` must stay green
  ([`src/engine/__tests__/loop.test.ts:977-1022`](src/engine/__tests__/loop.test.ts:977)).
- Do not change `allowEmpty: true` or the checkpoint message format.
- Do not make `saveIterationCheckpoint` throw to the caller.

### Test changes

- Keep [`src/engine/__tests__/loop.test.ts:977-1022`](src/engine/__tests__/loop.test.ts:977)
  green (edit turn still checkpoints).
- Add a new test in `src/engine/__tests__/loop.test.ts`, e.g.
  `testReadOnlyTurnDoesNotTriggerCheckpoint`: a session whose turns are
  `read_file` then `attempt_completion`; assert the shadow-git history contains
  only the baseline (length 1 — no per-iteration snapshot for the read-only
  turn). Model the fixture on the existing apply_diff checkpoint test's
  `createCheckpointService(...).list()` assertions.

### Verification

`npx tsc --noEmit`; `npm test -- loop`; `scripts/e2e/run.sh`; full `npm test`.

---

## Item T1 — strip superseded reasoning from assistant history (loop.ts) — RISKY

### The evidence

The loop constructs the assistant history message carrying the full reasoning
string verbatim:
[`src/engine/loop.ts:2478-2484`](src/engine/loop.ts:2478) (`reasoning: assistant.reasoning` at `:2482`),
and that message is re-sent on every subsequent request because
`buildRequestBody` forwards `request.messages` whole
([`src/llm/openrouter.ts:752-756`](src/llm/openrouter.ts:752), `messages: request.messages` at `:755`).

The constraint being honored is documented at
[`src/engine/loop.ts:2473-2477`](src/engine/loop.ts:2473): native DeepSeek
drops prior reasoning unless it is echoed on assistant messages **within
tool-call turns** — i.e. only the **immediately-preceding** assistant message in
the active tool-call chain needs its reasoning. Condensation already omits
reasoning from the summarizer transcript
([`src/engine/condense.ts:179-200`](src/engine/condense.ts:179), comment at
`:180-183`) and already counts it for sizing
([`src/engine/condense.ts:325-336`](src/engine/condense.ts:325), `chars += m.reasoning?.length` at `:329`),
so condensation is consistent with stripping.

### What to build

Strip reasoning from every assistant message **except the most recent one**:

- After `messages.push(assistantMessage)` at
  [`src/engine/loop.ts:2484`](src/engine/loop.ts:2484), walk `messages` and set
  `reasoning = undefined` (or `null`) on every assistant-role message other
  than the one just pushed. The just-pushed message keeps its reasoning because
  it is the immediately-preceding assistant message for the NEXT request.
- Implement this as a small pure helper (e.g. `stripSupersededReasoning(messages: ChatMessage[]): void`) so it is unit-testable without spinning up a full session. Keep it in `loop.ts` or a nearby module that already holds message-shaping helpers.
- The invariant to preserve: at the moment any LLM request is built, at most
  the single most-recent assistant message carries `reasoning`; every earlier
  assistant message has it stripped. Tool messages and user messages are never
  touched.

### What NOT to do

- Do NOT strip reasoning from the immediately-preceding assistant message in an
  active tool-call chain (that is the one message DeepSeek requires it on).
- Do NOT remove `include_reasoning` on the request side (that is a different
  lever, not in this item's scope).
- Do NOT change condensation sizing (`estimateMessageChars`) or the summarizer
  transcript builder — they already handle reasoning correctly.
- Do NOT change the reasoning pricing tables.

### Test changes

The existing echo assertion is
[`src/engine/__tests__/events.test.ts:527-534`](src/engine/__tests__/events.test.ts:527)
inside `testReasoningFlowsToEventFeedTruncated` (full test at
[`src/engine/__tests__/events.test.ts:494-538`](src/engine/__tests__/events.test.ts:494)).
That fixture has only ONE assistant turn, so under "keep only the most recent",
turn-1's reasoning is still the most-recent at request 2 and the assertion may
continue to pass. Required changes:

- **Add a new ≥3-turn test** (the test that actually proves the win): three
  assistant turns (turn 1 tool call → result, turn 2 tool call → result, turn
  3 completion). Assert that the **third** request's messages contain NO
  assistant message carrying turn-1's reasoning, while turn-2's reasoning (the
  most recent at request 3) IS still present.
- Re-verify the existing 2-request test at
  [`src/engine/__tests__/events.test.ts:527-534`](src/engine/__tests__/events.test.ts:527)
  still passes. If your chosen strip point makes it fail, update its assertion
  to match the actual invariant (and update its comment). The invariant — not
  the old assertion text — is the contract.
- Also unit-test `stripSupersededReasoning` directly (pure function): given
  `[system, user, assistant(reas=1), tool, assistant(reas=2)]`, it leaves only
  the last assistant's reasoning.

### Verification

`npx tsc --noEmit`; `npm test -- events` and `npm test -- loop`; a real or
`scripts/e2e/run.sh` mock session shows `lastPromptTokens` stops growing with
accumulated reasoning history and no new DeepSeek HTTP 400s; full `npm test`.

---

## Item T2/T3 — shrink fixed system prompt + per-mode tool catalog — MEASURE FIRST

### The evidence

The system prompt is the full vendored `SYSTEM_PROMPT` output
([`src/engine/prompt.ts:291-305`](src/engine/prompt.ts:291)), and every mode's
tool list is the full `selectToolsForMode` result plus browser/describe-image/
code-intel/run-tests schemas appended unconditionally
([`src/engine/loop.ts:1184-1193`](src/engine/loop.ts:1184)). Because cache-read
is billed per token, a trimmed headless-minimal prompt and per-mode tool list
would reduce every call's cost — but the size of the win must be measured
before surgery.

### Step 1 — measure (do this before any prompt surgery)

Add a cheap, non-invasive prefix-size measurement and record it per session:

- Compute and log the character/token size of the final system prompt
  (`this.state.systemPrompt`) and the serialized tool schemas
  (`this.state.tools`) at the one place they are assembled
  ([`src/engine/loop.ts:1195-1196`](src/engine/loop.ts:1195)), and again on
  each `switch_mode`. An approximate token estimate (e.g. `Math.ceil(chars / 4)`)
  is fine; log it via the session logger (and/or the existing `[usage]` line)
  so real sessions in `harness.log` carry it.
- Run one or two real (or `scripts/e2e/run.sh`) sessions and capture: prompt
  prefix size, per-mode tool count, and cache-hit rate
  (`lastCachedTokens / lastPromptTokens`). The decision to proceed to Step 2
  hinges on these numbers showing the fixed prefix is a material fraction of
  every request.

### Step 2 — trim only if Step 1 justifies it

- Build a headless-minimal prompt by **wrapping or substituting** the vendored
  `SYSTEM_PROMPT` result — do NOT edit files under `src/vendor/zoo-code/`.
  The existing convention is already "append headless conventions AFTER the
  vendored output" ([`src/engine/prompt.ts:315-324`](src/engine/prompt.ts:315));
  a trim belongs in the same layer (a new builder function in `src/engine/`,
  not a vendored-file edit).
- Trim per-mode tools: gate the unconditional browser/describe-image/
  code-intel/run-tests appends
  ([`src/engine/loop.ts:1184-1193`](src/engine/loop.ts:1184)) on mode, so a
  mode that never uses them doesn't carry their schemas.

### What NOT to do

- Do not edit `src/vendor/zoo-code/` for the prompt trim (vendoring convention:
  [`src/vendor/zoo-code/`](src/vendor/zoo-code/) is copied verbatim).
- Do not remove a tool a mode can actually invoke — the append guards already
  key off `this.executor.has(...)` for the code-intel/run-tests tools; preserve
  that gate.
- Do not ship the trim if Step 1 does not show a real, material prefix cost.

### Test changes

- For Step 1: no test changes required beyond keeping `tsc`/`npm test` green.
  If you add a helper to estimate token size, unit-test it with a known string.
- For Step 2: a test that a trimmed mode's tool list excludes the browser tool
  (and includes it where it should), plus `tsc` + full `npm test`. Reuse the
  existing mode/tool-selection tests under `src/engine/__tests__/`.

### Verification

`npx tsc --noEmit`; full `npm test`; record before/after prefix-size numbers
and cache-hit rate in the report.

---

## Item S3 — parallelize independent tool calls within a turn (loop.ts) — RISKIEST, LAST

### The evidence

The turn's tool calls execute strictly serially:
[`src/engine/loop.ts:2608-2746`](src/engine/loop.ts:2608) is
`for (const call of calls) { ... await this.executor.execute(...) ... }`.
Independent read-only/exploration calls (several `read_file`/`search_files`/
`list_files` in one turn) could run concurrently with no shared-state hazard,
cutting wall-clock on exploration-heavy turns.

### Constraints that MUST be preserved (read these before coding)

1. **Same-file edit ordering.** The loop tracks which paths earlier calls in
   the batch already modified (`batchEditedPaths` at
   [`src/engine/loop.ts:2607`](src/engine/loop.ts:2607)) and appends a
   diagnosis to a later same-file failure
   ([`src/engine/loop.ts:2660-2668`](src/engine/loop.ts:2660)). Two EDIT calls
   to the SAME file must stay serialized in submission order, and the
   `batchEditedPaths` bookkeeping must remain correct under the new execution
   model.
2. **Single decision marker.** `switch_mode` and `ask_followup_question` share
   one `.harness.needs-decision` / `.harness.decision-answer` marker pair;
   `switch_mode` is already refused when called alongside siblings
   ([`src/engine/loop.ts:2516-2522`](src/engine/loop.ts:2516), with the
   `new_task` refusal at
   [`src/engine/loop.ts:2497-2503`](src/engine/loop.ts:2497)). The single-
   writer guarantee must survive parallelism — only one escalated decision tool
   may run per turn, and it must not race its siblings.
3. **Checkpoint after the turn, not per call.** `saveIterationCheckpoint`
   (post-S1) must still fire once per turn, after all calls settle.
4. **Tool-message adjacency.** The `messages.push({ role: "tool", ... })` per
   call ([`src/engine/loop.ts:2670-2675`](src/engine/loop.ts:2670)) must end up
   in the SAME order as `assistant.tool_calls` so the assistant→tool adjacency
   contract holds; and the `pendingModeSwitchMarker` append after a successful
   `switch_mode` ([`src/engine/loop.ts:2683-2691`](src/engine/loop.ts:2683))
   must not be reordered.
5. **`attempt_completion` interception** still short-circuits before the
   execution loop ([`src/engine/loop.ts:2525-2526`](src/engine/loop.ts:2525)) —
   do not route it through the parallel executor.

### What to build

- Partition each turn's `calls` into a **serial group** and a **parallel group**.
  Serial: edit-capable calls (anything `editToolTargetPath` identifies as
  touching a file for modification — see its use at
  [`src/engine/loop.ts:2612`](src/engine/loop.ts:2612)), `switch_mode`,
  `ask_followup_question`, `new_task`, and `attempt_completion`. Parallel:
  read-only calls (`read_file`, `list_files`, `search_files`, code-intel reads,
  read-only `execute_command` per
  [`src/engine/loop.ts:301-349`](src/engine/loop.ts:301)).
- Run the parallel group with `Promise.all`, then run the serial group in
  order, then splice the per-call `tool` results back into `messages` in the
  original `assistant.tool_calls` order. Preserve `consecutiveMistakes`,
  `batchEditedPaths`, and the per-call tool_call/tool_result event emission
  (now via S2's `scheduleAux`) exactly as today, just re-ordered around
  execution.
- Keep it conservative: if partitioning is ambiguous for a call, treat it as
  serial. The first milestone is "parallelize pure read-only calls only"; do
  not attempt to parallelize edits in this item.

### What NOT to do

- Do not parallelize two edits to the same file, or any edit against a file
  another call reads in the same turn (read-then-edit within a turn must stay
  ordered so the read sees the pre-edit content the model composed against).
- Do not change the refusal/decision-marker semantics for `switch_mode` /
  `ask_followup_question` / `new_task`.
- Do not move `attempt_completion` into the executor loop.
- Do not change the checkpoint cadence (post-S1) from once-per-turn.

### Test changes

- Keep `testSameFileBatchFailureGetsDiagnosis`
  ([`src/engine/__tests__/loop.test.ts:1145`](src/engine/__tests__/loop.test.ts:1145))
  and `testDifferentFileBatchFailureGetsNoDiagnosis`
  ([`src/engine/__tests__/loop.test.ts:1318`](src/engine/__tests__/loop.test.ts:1318))
  green — they encode constraint 1.
- Add a test that a turn with several read-only calls (e.g. three `read_file`
  calls) completes and feeds each tool result back in the same order as the
  assistant's `tool_calls`.
- Add a test (or reuse an existing switch_mode test) that `switch_mode`
  alongside siblings is still refused and the siblings still execute.

### Verification

`npx tsc --noEmit`; `npm test -- loop` and `npm test -- switch-mode`;
`scripts/e2e/run.sh`; full `npm test`. This item is the most likely to
introduce a subtle ordering regression — budget time to run the full suite and
the e2e suite even if a targeted run is green.

---

## What to report back

For each item you complete, report:

1. The item id (E1–E4, S1–S4, T1, T2/T3), a one-line summary, and the files
   changed with their final `path:line` locations of the key edits.
2. The test files added/changed and the exact assertions.
3. `npx tsc --noEmit` result (clean) and `npm test` result (full pass).
4. For loop/orchestrator/watcher/spawn-adjacent items, which `scripts/e2e*/run.sh`
   suites you re-ran and their result.
5. For T2/T3: the measured prefix-size / tool-count / cache-hit-rate numbers
   before and after, and whether Step 2 surgery was performed or skipped.
6. For T1 and S3 (the risky items): explicit confirmation that the listed
   safety constraints were preserved, and any test you had to update (and why).
7. The output of `git log --oneline -1` (your commit hash) for each committed
   change, so the orchestrator can confirm it landed.
