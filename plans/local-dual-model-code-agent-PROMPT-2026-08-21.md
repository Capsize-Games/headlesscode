# Prompt for a clean session — continue local-model harness accommodation

Paste everything below this line into a fresh session.

---

I'm continuing work from tonight's session on `plans/local-dual-model-code-agent.md`
(get `headlesscode`'s `code` mode running reliably on a local model on this
workstation's RTX 5080, instead of cloud DeepSeek). Read these three prior
handoffs in order first — full history you don't otherwise have:

1. `/home/joe/Projects/airunner/plans/local-dual-model-code-agent-handoff-2026-08-19.md`
2. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-19-night2.md`
3. `/home/joe/Projects/headlesscode/plans/local-dual-model-code-agent-PROMPT-2026-08-20.md`
   (this is the prompt that started TONIGHT's, 2026-08-20, session — read it
   fully, this doc only covers what changed since)

## Ground rules (carry forward, don't relitigate)

Same as doc #3 above: isolated worktrees only, don't touch cloud-only modes,
extend via lazy-tools/prompt.ts (never edit `src/vendor/zoo-code/` directly),
always read the event-level JSONL transcript for a real failure, check for
`.harness.needs-decision` before assuming a hang, don't fabricate results.

**New this session**: `headlesscode-rw`'s orphaned-process problem (noted in
doc #3's infra section) is confirmed real and can leave a PREVIOUS trial's
`tsx src/cli.ts` process running for 40+ minutes after its own `docker exec`
already reported a terminal state (bounded failure/success) in the log —
i.e. the log finishing does NOT mean the container-internal process actually
exited. Before trusting worktree state clean between trials, check for
leftover processes targeting your worktree path (there's no `ps` binary —
use the `/proc/[0-9]*/cmdline` grep loop from doc #1's Methodology section)
and `kill -9` any survivors, not just `git checkout -- . && git clean -fd`.
Verified live tonight: a trial-1 orphan survived through trials 2-4 without
corrupting worktree state (checked via `git diff --stat` after killing it —
clean), but this was luck, not a guarantee — a genuinely concurrent
`write_to_file` from two sessions on the same path would be a real hazard.

## What happened tonight (2026-08-20, second half)

### 1. Implemented the `write_to_file` overwrite guard (the task from doc #3)

Chose the **runtime-check layer**, not a blanket tool removal (doc #3's
"concrete first step" left this open): `write_to_file` now refuses to
overwrite an existing file with more than 200 bytes of content when
`guardLargeOverwrites` is on, nudging toward `edit_file`/`search_replace`.
New-file creation (the common legitimate case, e.g. test files) is
completely unaffected. Escape hatch is deliberate friction, not a flag:
delete the file first via `execute_command`, then `write_to_file` succeeds
against a path that doesn't exist.

Wired end-to-end following the exact `requireExplicitCompletion`/
`verifyBeforeCompletion` convention: `cli.ts` (auto-on for
`useLocalCodeBackend`, opt-out via `HEADLESSCODE_ALLOW_UNGUARDED_OVERWRITES`)
→ `HeadlessSessionConfig.guardLargeOverwrites` (loop.ts, propagated to
`new_task` children too) → `ToolExecutorOptions`/`ToolContext.guardLargeOverwrites`
→ `largeOverwriteRefusal` in `writeToFileHandler` (executor.ts).

New `src/tools/__tests__/write_to_file.test.ts` (4 cases: new file always
succeeds, substantial existing file refused when gated, same file succeeds
when ungated, trivial existing file unaffected even when gated) — all pass.
Full `tsc --noEmit` clean, full suite green except the pre-existing
Python-codemap failure (no Python interpreter in the container, unrelated).

**Not committed yet** — see "What to do next" below.

### 2. Found and fixed a real, separate, more serious bug:
### `verifyBeforeCompletion`'s one-shot nudge budget

While independently verifying a live trial's `attempt_completion` claim
(never trust the claim — see Methodology), discovered the guardrail added
in last night's session (`fe3c4fb`) only nudges ONCE per session
(`verificationNudged` flag). A SECOND fabricated completion later in the
same session — after a FRESH `execute_command` failure, with only a failing
`edit_file` in between, never a real re-verification — went through
unchecked, because the one-shot budget was already spent. Confirmed live:
the model claimed "typecheck and tests passed", and I independently re-ran
both `tsc --noEmit` and the test runner myself — both genuinely failed
(unterminated string literal in the test file it wrote; a duplicated,
non-exported `truncateMiddle` in `condense.ts`).

**Fixed** in `src/engine/loop.ts`: removed the one-shot gate entirely — the
guardrail now refuses attempt_completion EVERY time the last
`execute_command` failed and nothing since succeeded, however many times
that takes in one session. New regression test
`testVerifyBeforeCompletionRefusesEveryFailureNotJustTheFirst` in
`loop.test.ts` reproduces the exact live sequence (fail → fabricated
completion #1 refused → non-execute_command tool call → fabricated
completion #2, which must ALSO be refused → real success). All 56
`loop.test.ts` tests pass (was 55), full suite green except the same
pre-existing Python-codemap failure.

**Also not committed yet.**

### 3. Live trials: 4 attempts, none reached a clean, trustworthy success

All against Qwen3-14B on the bench daemon, same `truncateMiddle`/
`condense.ts` task used all of last night, `--consecutive-error-limit 8`
for trials 2-4 (trial 1 used the default 3 and died too fast to be
informative — see below).

- **Trial 1** (default consecutive-error-limit 3): bundled 4 tool calls
  (write_to_file for the NEW test file, tsc, test-run, attempt_completion)
  into iteration 1; the 2 verification commands failed because
  `condense.ts` was never touched, `attempt_completion` was correctly
  refused for bundling, and all 3 tool errors in the single batch exhausted
  the mistake limit before the model ever got a second turn — bounded
  failure at 34s, uninformative for the guard (matches a KNOWN, still-open
  finding from doc #1's handoff: "the mistake-limit should only be
  evaluated across separate LLM turns, not within one turn's tool-call
  batch"). This orphaned its container process — see the process-hygiene
  note above.
- **Trial 2**: daemon suffered a hard CUDA crash
  (`ggml-cuda.cu:97: CUDA error`, same crash CLASS as doc #1's
  Qwen3-Coder-30B finding, but this time on Qwen3-14B at the SAME
  `n_ctx=32768` that had been stable all of last night and earlier tonight
  — not obviously reproducible, may be incidental) on iteration 2's
  request, killing the daemon process outright. Restarted cleanly
  (`docker start bench-daemon-daemon-1`), reconfirmed healthy + model
  loaded via a direct curl before continuing. Not the guard's fault, but a
  real infra fragility worth watching — if this recurs, it's worth checking
  whether it's VRAM-pressure-related (other GPU users on the box?) or a
  genuine llama-cpp-python regression.
- **Trial 3**: 25 iterations, `session succeeded` per the harness — but
  independently verified BROKEN: `edit_file` left a duplicated, non-exported
  `truncateMiddle` in `condense.ts` (two identical copies, neither
  `export`ed), and the test file it wrote had a genuine syntax error
  (unterminated string literal) and never imported the function it tested.
  The model's `attempt_completion` falsely claimed both checks passed. This
  is what led to finding #2 above. Notably: across the WHOLE 25 iterations,
  `write_to_file` was called exactly once, against the NEW test file — never
  against `condense.ts`. Positive signal for the guard's intent (no
  destructive-overwrite attempt happened), but inconclusive as a test of the
  guard specifically, since it was never exercised.
- **Trial 4** (after fixing verifyBeforeCompletion): got stuck in a
  DIFFERENT, newly-discovered failure loop instead — 4 separate
  `ask_followup_question` calls asking a generic, off-task "what would you
  like me to do?" variant, each redirected per the standard methodology
  (write a plain-text answer restating the real task to
  `.harness.decision-answer`). The 1st and 2nd followed strings of `edit_file`
  failures (a pattern doc #1/#3 already documented as a real, unresolved
  model limitation, not new). The 3rd and 4th are NEW and more concerning:
  they fired immediately after a context-condensation event
  (`historyBefore: 38 → historyAfter: 13` at iteration 19), and even after
  the 3rd redirect fed the model the literal task text back verbatim, the
  VERY NEXT iteration (20) asked essentially the same generic question
  again. This strongly suggests **condensation is destroying this model's
  grip on the task** at this history size/`--context-window 16384` — not
  just losing some nice-to-have context, but losing the ability to even
  hold onto what it's supposed to be doing. Stopped chasing after the 4th
  repeat (diminishing returns, and I'd killed the leaked trial-1 process by
  then too) rather than keep feeding it redirects indefinitely. Across
  trial 4's first 16 iterations (before condensation), same story as trial
  3: repeated `edit_file` failures, zero `write_to_file` attempts against
  `condense.ts`.

**Bottom line on the guard**: implemented correctly, unit-tested, doesn't
regress anything — but 4 live trials never actually exercised it (the model
never attempted a destructive `write_to_file` against `condense.ts` in ANY
of them, guard on or off in trial framing). That's a genuinely different
result from last night's session, where the SAME task against the SAME
class of model DID produce a destructive `write_to_file` overwrite (see doc
#3's "Tonight's core finding"). Possible explanations, not yet
distinguished: (a) the guard's presence changed the model's behavior before
it ever got refused (unlikely — nothing in the tool schema signals the
guard exists), (b) the added prompt language ("never write_to_file... use
edit_file") plus "call ONE tool at a time" in this session's dispatch
command already fixed it on its own, independent of the guard, or (c) model
variance / non-determinism — last night's destructive rewrite might not
reproduce every time even with identical prompting. Can't tell which
without more trials, and after 4 attempts eaten by unrelated failure modes
tonight, that's genuinely unresolved.

## What to do next (in order)

1. **Commit tonight's two real fixes** (`guardLargeOverwrites` +
   `verifyBeforeCompletion` persistence fix + both new tests) to
   headlesscode `master` — they're correct, tested, and safe regardless of
   what trial 5+ shows. `git status` in `/home/joe/Projects/headlesscode`
   should show: `src/cli.ts`, `src/engine/loop.ts`, `src/engine/types.ts`,
   `src/tools/executor.ts`, `src/engine/__tests__/loop.test.ts`, and the new
   `src/tools/__tests__/write_to_file.test.ts`. (Also untracked:
   `plans/local-dual-model-code-agent-PROMPT-2026-08-20.md` and this file —
   yours to commit too, or leave untracked, your call.)
2. **Re-run the same trial 2-3 more times** now that verifyBeforeCompletion
   is fixed, specifically watching whether `write_to_file` ever gets
   attempted against `condense.ts` — that's still the open question the
   guard was built to answer. Kill any leaked container processes and
   verify `git diff --stat` is clean in the worktree before each trial (see
   the process-hygiene note above).
3. **Investigate the condensation context-loss finding** — this might be
   the actually-dominant problem going forward, bigger than `write_to_file`
   or `edit_file` reliability. Worth checking directly: what does the
   condensed summary message actually contain right after a condensation
   event (`.headlesscode/events/<sessionId>.jsonl`, look for the message
   with role `user`/system built by `buildCondensedMessage` in
   `condense.ts`)? Does it preserve the original task text at all, or only
   a summary of PROGRESS so far (which could plausibly omit the original
   instructions if the summarization prompt doesn't explicitly ask for
   them)? `--context-window 16384` is fairly tight for a 12K-token prefix
   session doing lots of `read_file` — consider re-testing with a larger
   `--context-window` (the daemon's `n_ctx=32768` has headroom) to see if
   avoiding condensation entirely sidesteps the problem, which would help
   isolate whether the bug is in the condensation mechanism itself or
   something else correlated with long sessions.
4. **Still open from doc #1**: the mid-batch-abort-before-retry finding
   (multiple tool-call errors in ONE turn exhausting the mistake limit
   before the model gets to react) — trial 1 tonight hit this again. Worth
   fixing independently of everything else here.
5. **Still open from doc #3**: the off-task `ask_followup_question`
   hallucination pattern itself (distinct from its condensation-triggered
   variant found tonight) — 2 more live examples tonight beyond the ones
   already documented.

## Infra state (may have decayed — reverify first)

Same bench-daemon / headlesscode-rw / bench-tier-a worktree setup as doc #3
— re-read that doc's "Infra state" section for the full compose file,
recreate commands, and dispatch-command template. As of the end of tonight:

- `bench-daemon-daemon-1`: running, healthy, Qwen3-14B loaded (confirmed via
  `docker logs` showing `model_id=qwen3-14b` and a live curl `/api/chat`
  round-trip), `n_ctx=32768`. Survived one hard CUDA crash mid-session
  (restarted cleanly) — if it crashes again, restart with `docker start
  bench-daemon-daemon-1`, wait for `health: healthy`, then hit
  `/api/chat` once directly with a trivial prompt before trusting it (the
  settings DB needs ~15-20s after healthy to be query-ready).
- `headlesscode-rw`: running. Had 2 process trees active simultaneously
  tonight (an orphan from trial 1 uses the OLD task-text-without-ESM-hints;
  killed both trees at the end of the session) — verify nothing's running
  against your target worktree before dispatching (see process-hygiene note
  above).
- `bench-tier-a` worktree: clean, checked out at `c41180e` (no local
  commits on the branch), no leftover diffs or untracked files as of the
  end of tonight.
- Left running for continuity (not torn down) — GPU VRAM stays committed
  meanwhile.
