# Activate codebase_search — build the index, make workers actually prefer it — instructions for implementation

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop.

Match this project's established style: no test framework (plain `tsx`-run
test files, `All N tests passed` trailer); `npx tsc --noEmit` and `npm test`
must stay green; re-run every e2e suite under `scripts/e2e*/run.sh`.

## Note on concurrent work

`plans/local-embeddings-ollama.md` may be running at the same time as this
task — it touches `src/codesearch/embedder.ts` and adds a new file, this
task touches index-building/worktree setup/prompt guidance. Low file-overlap
risk, but if you hit a merge conflict on anything under `src/codesearch/`,
resolve by re-reading the other task's actually-merged final state rather
than guessing.

## The problem

`codebase_search` (`src/codesearch/`) is fully implemented and verified live
against OpenRouter (`qwen/qwen3-embedding-4b`) — but it is currently **inert**:
1. No `.headlesscode/codesearch/index.jsonl` has ever been built for this
   repo or any worktree (`headlesscode index` has never been run for real).
2. Nothing in the `code` mode's system prompt, rules, or task-file
   conventions tells a worker to try `codebase_search` before falling back
   to `read_file`/`grep`-via-`execute_command` for orientation. Having the
   tool available doesn't mean a model reaches for it — confirmed today: a
   real worker burned 100+ iterations on `execute_command`/`curl`
   exploration before making any progress, never once calling
   `codebase_search`, even though it existed the whole time.

This task closes both gaps. It's the highest-leverage remaining cost item —
don't build more on top of an unused feature before this lands.

## What to build

**1. Build and keep the index current.** Add index-building to this
project's own workflow: run `headlesscode index --workspace .` against this
repo itself as part of doing this task (commit the resulting
`.headlesscode/codesearch/index.jsonl`? — check whether `.gitignore` already
excludes `.headlesscode/` broadly; if so, decide and document whether the
index should be committed (repo-shipped, always fresh at clone time) or
generated on first use (smaller repo, costs a bit of embedding spend per
fresh clone/worktree) — this is a real tradeoff, make the call and justify
it in your report rather than picking silently).

Also: worktrees are created fresh per task (`spawn-parallel-worktrees.sh`)
— if the index is NOT committed, a fresh worktree has no index and
`codebase_search` will return "not indexed" every time, defeating the whole
point for exactly the workflow this project uses most. Investigate whether
`spawn-parallel-worktrees.sh` should copy/symlink an existing index from the
main repo into each new worktree (similar to how it already symlinks the
`zoo-code/` reference clone — check that script's current worktree-setup
section for the pattern) rather than requiring every worktree to rebuild it
from scratch.

**2. Prompt/rule guidance to actually prefer it.** Add explicit guidance
(check whether this belongs in `.roo/rules-code/` if that exists, or in the
mode's own instructions in `.roomodes`, or in a new short rule file — follow
whatever this project's existing convention is for mode-specific guidance,
don't invent a new mechanism) telling a `code`-mode worker:
- Before reading whole files to understand "where is X" or "how does Y
  work," try `codebase_search` first if an index exists for the workspace.
- If `codebase_search` returns "not indexed," that's a real signal to fall
  back to today's behavior (read_file/grep) — not an error to work around
  by retrying the search tool.
- `codebase_search` complements, not replaces, `read_file` — once you know
  WHERE something is (from search), `read_file` (or the indentation-mode
  slice) is still how you actually see the full code to edit it.

**3. Verify the guidance actually changes behavior.** This is the part that
matters most, and it's hard to unit-test — a real (or realistically scripted
mock-LLM) session should show `codebase_search` actually getting called
before `read_file` for an orientation-style task. If you have real API
access, run one real short session on a task that requires finding
something (e.g. "where is the truncateHistory function and how does it
handle tool_calls?") against this repo's own index, and show in your report
whether the model reached for `codebase_search` on its own given the new
guidance, or still defaulted to old habits — an honest negative result here
is more valuable than an unverified claim of success.

## What NOT to do

- Do not make indexing automatic/implicit at session start — it's explicit
  by design (`headlesscode index`), costs real money, and this project's
  own `codebase-search.md` spec already established that; don't relitigate
  it here.
- Do not touch the embedding/chunking/index-storage logic itself
  (`src/codesearch/embedder.ts`/`chunk.ts`/`index.ts`) — this task is about
  activation (build + guide), not the underlying implementation, which is
  already built and tested.

## Tests

- If you add worktree index-copying logic to `spawn-parallel-worktrees.sh`,
  add a test/manual verification proving a fresh worktree actually has a
  usable index (or a clear absence + guidance to build one) rather than
  silently starting from zero every time.
- No new unit tests are strictly required for prompt/rule text changes, but
  if you add a helper function (e.g. "does an index exist for this
  workspace" used by the guidance or the worktree-copy logic), test it.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites still green.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. `headlesscode index --workspace .` actually run against this repo — quote
   its summary output (files/chunks/cost) in your report.
5. The manual/real-session smoke test described above, or an honest
   explanation of why it couldn't be run.

## What to report back

- Whether the index is committed or generated-on-first-use, and why.
- Whether/how fresh worktrees get a usable index.
- Exact wording and location of the new guidance.
- Result of the real-session smoke test (or why it couldn't run).
- Index build summary (files scanned, chunks embedded, cost).
- Any deviation from this spec, and why.
