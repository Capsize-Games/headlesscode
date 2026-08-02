# Independent review — today's 9-task direct-path batch (merged, no worktrees remain)

Follow `plans/review-mode-prompt.md`'s full operating procedure — this
document only adapts it for the fact that every task in this round has
ALREADY been merged to `master` and its worktree/branch already removed.
There is nothing under `.worktrees/` to check out for this review; instead,
review the real merged diffs on `master` directly.

**Why this review exists:** this round used the direct task-file path
(`spawn-parallel-worktrees.sh`), which has no automated review/rework step
by design — each worker self-verified (tsc/test/e2e) and self-merged. That
was an acceptable risk for small, isolated task files earlier in this
project's history. This round was NOT that: it included changes to core
loop semantics (`src/engine/loop.ts`, twice, sequentially), new external
process dependencies (Playwright, Ollama HTTP calls), and new
dashboard-exposed HTTP surface. The project owner explicitly asked for an
independent adversarial pass before trusting it further — approach this
with the same "assume at least one overstated claim until personally
confirmed" posture `review-mode-prompt.md` describes.

## Commit range to review

`git log --oneline 5e57b70..0610044` on `master` — 9 merged tasks, 16
commits (a 10th task, `mcp-tool-support`, correctly stopped on a real `tsc`
error and was NOT merged; its worktree `.worktrees/mcp` / branch
`issues/mcp-2026-08-01` still exists if you want to also sanity-check that
the stop was legitimate and not a worker giving up prematurely — worth a
quick look, lower priority than the two items below).

For each of the 9 merged tasks, the pattern is `<work commit>` then
`Merge <name> (issues/<name>-2026-08-01)` — diff each work commit
individually (`git show <hash>` or `git diff <hash>^..<hash>`) against its
own `plans/<task>.md` spec, per `review-mode-prompt.md`'s step 5.

## Two items to prioritize — read these before anything else

**1. `dashboard-checkpoint-diff-ui`** (`8ddaf19`/`e8f6e1b`,
`plans/dashboard-checkpoint-diff-ui.md`). The worker's own report says it
*"died on 3 consecutive tool errors in its own verification loop, but code
complete + tsc/tests/6 e2e green → merged."* A rocky verification run that
happened to pass on some later attempt is weaker evidence than a clean run.
Specifically check: what were those 3 tool errors actually about (if
recoverable from `harness.log` history, or infer from the diff what might
have caused them)? Is the checkpoint-restore route (the genuinely dangerous
one — reverts real files) actually gated behind the bearer-token auth as
the spec required, verified by a real passing test, not just present in the
code? Actually exercise `GET /api/checkpoints`, the diff route, and a real
restore against a scratch repo with real checkpoints — don't just read the
route handlers and assume they work.

**2. `local-output-summarization`** (`09d88bb`/`01b2599`,
`plans/local-output-summarization.md`) — **the specific open concern**: the
project owner reported a cost jump after this landed and asked whether
local summarization is (a) recording a bogus/incorrect cost for something
that should cost $0 (it calls local Ollama, not a billed API), or (b)
breaking prompt-cache stability (busting the stable-prefix property
`src/engine/loop.ts`'s `truncateHistory` batching was specifically built to
protect earlier today — check whether summarized tool output changes size
non-deterministically call-to-call in a way that would shift the sent
prefix and defeat caching). Read `src/tools/output-summarizer.ts`'s
interaction with `src/budget/cost.ts` line by line. Construct a real
before/after comparison if you can (a session with summarization on vs.
off, same task, comparing `costUsd` and cache-hit-rate from the usage
files) rather than reasoning about it in the abstract. This is the single
most important finding to get right in this whole review — say clearly
whether the cost jump is a real bug, a red herring, or working as intended
(and if the latter, explain precisely why the cost/cache profile changed).

## Everything else — standard adversarial pass

Apply `review-mode-prompt.md`'s full procedure to the remaining 7 merged
tasks (`local-embeddings-ollama`, `codebase-search-activation`,
`dashboard-chat-ui`, `dashboard-file-browser-and-permissions-ui`,
`browser-tool`, `context-condensation`, `streaming-and-reasoning`).
Specifically prioritize, per that document's own risk-ordering guidance:

- `context-condensation` and `streaming-and-reasoning` — both touch
  `src/engine/loop.ts` core request-handling, sequentially, one merged on
  top of the other. Verify the tool-call-group-boundary safety (the exact
  incident class that caused a real HTTP 400 earlier today) still holds
  after BOTH changes are layered, not just each individually — construct or
  find a test that exercises condensation AND streaming together if one
  doesn't already exist, and flag it as a gap if it doesn't.
- `browser-tool` and (if you also check `mcp-tool-support`'s stopped state)
  any new child-process spawning — verify session-end cleanup actually
  kills the spawned process, don't just read that a `dispose()` call exists.
- `dashboard-file-browser-and-permissions-ui` — the path-traversal guard on
  the new file-browser routes and the bearer-token gate on the permissions
  settings POST are both security-relevant; verify both with a real
  request, not a read-through.
- Confirm the operator notes the report flagged as "resolved" actually are:
  a `package-lock.json` was committed for the new Playwright dependency
  (confirm it's actually there and consistent with `package.json`), and a
  "node_modules symlink mishap... fixed + amended before push" during the
  `local-embeddings-ollama` merge (confirm nothing broken was left behind —
  check `git show acf931b`/`d01be55` for anything suspicious around
  `node_modules` or symlinks).

## What to report back

Follow `review-mode-prompt.md`'s verdict format exactly: pass/fail per
task (not just an overall verdict), with real command output as evidence
for anything you confirm, and file:line-precise, actionable findings for
anything you don't. Lead with the two prioritized items above — the
project owner is waiting specifically on the cost/cache question before
deciding whether to keep `local-output-summarization` enabled at all.
