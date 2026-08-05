# Speed & context-efficiency — fix airunner session slowness

## Who you are working on this for

You (deepseek) are implementing this against the `headlesscode` repository — a
standalone Node/TypeScript CLI running a headless coding-agent loop. The task
spans two repos: **code changes** happen in `headlesscode` (this repo), while
**operational items** target `~/Projects/airunner` (the separate repo where
sessions run slow). You operate from the headlesscode worktree but can run
commands against airunner via `--workspace ~/Projects/airunner`.

The blocking condition ("don't start until current airunner work finishes")
has been checked: all airunner worktrees are done or failed, none running.
Confirmed from `~/Projects/airunner/.worktrees/.orchestrator-state.json`
(2026-08-04).

## The problem

Sessions run against `~/Projects/airunner` feel painfully slow — slow enough
the owner questions whether the tool is worth using. Root-cause analysis
(traced from a real `harness.log` + full source audit) found:

1. **`~/Projects/airunner` has no `.headlesscode/` directory at all** — no
   codebase-search index, no `mode-models.json`. The semantic-search subsystem
   (`src/codesearch/` — chunker, embedder, persisted index, `codebase_search`
   tool) is fully built and already wired into
   [`scripts/spawn-parallel-worktrees.sh:207-224`](scripts/spawn-parallel-worktrees.sh:207) (it
   seeds a fresh worktree's index by copying the main repo's) — but there was
   nothing to seed because the index was never built in the airunner main repo.
   Every worktree therefore had `codebase_search` unusable and fell back to raw
   `list_files`/`read_file` walks, causing exploration ballooning that
   triggered repeated condensation.

2. **Condensation runs on the same full-price model as the session.**
   [`src/engine/loop.ts:648`](src/engine/loop.ts:648) already supports a
   separate `condenseModel` (via `--condense-model` or `_condensation` in
   `.headlesscode/mode-models.json` — see
   [`src/config/mode-models.ts:39-58`](src/config/mode-models.ts:39) for the
   `extraKeys` mechanism) — but since airunner has no `mode-models.json`, every
   condensation event in the traced run (~8 events, ~55-80s each) paid full
   session-model latency.

3. **The condensation trigger's context-window value may be wrong.**
   `maybeCondenseHistory` resolves the model's real context window via
   `fetchModelContextWindow` (OpenRouter `/models/.../endpoints`,
   `src/llm/openrouter.ts`), falling back to `DEFAULT_CONTEXT_WINDOW_TOKENS =
   128_000` (`src/engine/condense.ts`). If this lookup silently fails for
   `deepseek/deepseek-v4-flash`, condensation fires at 75% of 128k instead of
   75% of the model's real window — condensing far more often than necessary.

4. **The read_file cache already exists** (`src/tools/executor.ts`,
   session-scoped, content-hash-invalidated). Nothing to do here.

5. **The local-exploration phase** (`src/engine/local-explore.ts`) is exactly
   the "cheap local recon before expensive cloud model" pattern, but defaults
   OFF. It deliberately excludes `codebase_search`
   ([`src/engine/local-explore.ts:7-11`](src/engine/local-explore.ts:7)) for
   VRAM-coexistence reasons (embedding model + generation model can't share
   limited VRAM).

6. **The codesearch chunker is already boundary-aware** —
   `src/codesearch/chunk.ts` splits at top-level function/class boundaries for
   brace-languages and Python. Tree-sitter is not a step-change improvement here.

7. **Airunner's own Docker-based test invocations** (13 `docker run` calls at
   60s+ each) are out of scope for headlesscode — airunner-side infra issue.
   Flagged for completeness, not actionable here.

## What to build

The work is split into P0 (operational — run commands against airunner, zero
new code) and P1 (code changes to headlesscode). Do P0 first — it unblocks
everything else. P2 (tree-sitter, LSP) is explicitly deferred.

### P0 — operational (do these first)

**1. Build the codebase-search index for airunner.**
Run: `headlesscode index --workspace ~/Projects/airunner`

The spawn script
([`scripts/spawn-parallel-worktrees.sh:207-224`](scripts/spawn-parallel-worktrees.sh:207))
already copies the index from the main repo into each worktree — this just
creates the source. Re-run incrementally (unchanged chunks are hash-skipped)
periodically or after large merges.

**2. Create `~/Projects/airunner/.headlesscode/mode-models.json`.**
Add a `_condensation` entry pointing at the cheapest capable OpenRouter model
available (a Haiku-class or small DeepSeek/Qwen model). The exact key shape is
documented in `docs/context-condensation.md`. Example minimal file:

```json
{
  "_default": "deepseek/deepseek-v4-flash",
  "code": "deepseek/deepseek-v4-flash",
  "_condensation": "qwen/qwen3-8b"
}
```

This directly cuts the ~8-10 minutes/run currently spent running condensation
on the full session model. The `extraKeys: ["_condensation"]` mechanism is
already wired in
[`src/config/mode-models.ts:39-58`](src/config/mode-models.ts:39).

**3. Verify the live context-window resolution for airunner's model.**
Grep a recent `harness.log` (e.g. under `~/Projects/airunner/.worktrees/w4/`)
for the context-window resolution log line. The log line is emitted around
`loop.ts:1163` and should say something like `contextWindowTokens=...`. Confirm
the value matches the model's real advertised context window by hitting
`https://openrouter.ai/api/v1/models/deepseek/deepseek-v4-flash/endpoints`
(requires an API key). If they disagree (the harness fell back to 128k), fix by:
- Immediate: pass `--context-window <n>` in airunner's orchestration invocation
- Investigate: why the live lookup didn't take (wrong model slug format,
  missing API key on that path, transient failure not retried).

### P1 — code changes to headlesscode

**4. No-index guardrail in spawn path.**

Today `spawn-parallel-worktrees.sh` prints a warning ("No codebase-search
index in main repo — worktree starts unindexed") and proceeds. This should be
a hard failure (or opt-in auto-index) instead.

Add an `ALLOW_UNINDEXED` env var (default: unset = fail) to
`scripts/spawn-parallel-worktrees.sh`. When unset and no index exists, exit
non-zero with a clear message: "No codebase-search index found. Run
`headlesscode index --workspace <repo>` first, or set ALLOW_UNINDEXED=1 to
proceed without it." When `ALLOW_UNINDEXED=1`, keep today's warning-and-continue
behavior.

Also add a `HEADLESSCODE_AUTO_INDEX` env var (default: unset = don't
auto-index). When set, the spawn script runs `headlesscode index --workspace
$REPO_ROOT` before the first spawn if no index exists. This costs money (cloud
embedder), so it must be opt-in, never silent.

Wire both into the orchestrator's spawn path. The orchestrator (`src/watcher/`
or `src/cloud/provider.ts`) passes env vars to the spawn script — check the
existing pattern (e.g. how `ORCHESTRATOR_MODE` is passed) and match it.

**5. Local-explore gating for orchestrated runs + reconsider codebase_search.**

Two sub-items:

5a. Wire `HEADLESSCODE_LOCAL_EXPLORE=1` into the orchestrator's spawn env
(using the same pattern as `ORCHESTRATOR_MODE` in
`src/cloud/provider.ts:149-172`). The orchestrator should pass this through to
workers so they run the local exploration phase before the cloud model's first
turn. Keep it default-off (the env var gate already exists in
`src/engine/local-explore.ts:39-40` and `src/cli.ts:810-813`; it just needs to
be threaded through the orchestrator). Also pass through any tuning env vars
the operator sets (`HEADLESSCODE_LOCAL_EXPLORE_MODEL`,
`HEADLESSCODE_LOCAL_EXPLORE_MAX_ITERATIONS`,
`HEADLESSCODE_LOCAL_EXPLORE_CONTEXT_TOKENS`).

5b. Reconsider the `codebase_search` restriction in the local-explore phase.
Currently [`src/engine/local-explore.ts:7-11`](src/engine/local-explore.ts:7)
explicitly excludes `codebase_search` from the local tool set for
VRAM-coexistence reasons. But after P0.1, the codebase index will exist — and
the embedding call for `codebase_search` (OpenRouter,
`qwen/qwen3-embedding-4b`) is cloud-side, NOT local Ollama. The VRAM concern
was valid when the plan assumed local embeddings
(`plans/local-explore-phase-experiment.md`), but the actually-deployed embedder
is cloud-hosted. This means `codebase_search` is safe to add to the local
phase's tool set — it doesn't touch local VRAM at all.

Change: add `codebase_search` to the local-explore tool set. Remove it from the
"unavailable" list in the test at
[`src/engine/__tests__/local-explore.test.ts:476`](src/engine/__tests__/local-explore.test.ts:476).
Update the comment at the top of `src/engine/local-explore.ts` to reflect that
the restriction was lifted because embedding runs on OpenRouter, not locally.
Update `plans/local-explore-phase-experiment.md`'s analysis section if it
documents this constraint.

**6. Loop-level tool-choice guardrail for blind tree-walking.**

The rules file `.roo/rules-code/rules.md` already has a "Orient with
`codebase_search` before whole-file reads" section (lines 3-19) telling the
model to prefer `codebase_search`. This is partially done and should be kept.

What's missing: a loop-level soft cap that detects when the model is doing
dozens of `list_files`/`read_file` calls with no edit and no
`codebase_search`, and injects a gentle nudge. Add to `src/engine/loop.ts`:

After N consecutive iterations (N=8, tunable via env) where:
- Every tool call is `list_files`, `read_file`, or `search_files` (regex grep)
- None is `codebase_search`, `go_to_definition`, `find_references`, `outline`,
  `import_graph`, `write_to_file`, `apply_diff`, `search_replace`, or
  `edit_file`

...inject a user-role message: "You've made several read/exploration calls
without using `codebase_search`. If the workspace has an index (check: is
there a `.headlesscode/codesearch/index.jsonl`?), try `codebase_search` for
targeted semantic search instead of blind tree-walking. If the workspace is
not indexed, ignore this nudge."

Reset the counter when any "productive" tool (edit, codebase_search,
code-intel) is called. This is a soft nudge, not a hard block — keep it
reversible. Match the existing "empty reply nudge" pattern at
[`src/engine/loop.ts:1561-1562`](src/engine/loop.ts:1561) for consistency.

**7. Global-vs-workspace `.headlesscode/` split visibility.**

When `headlesscode orchestrate` or `headlesscode index` runs against a
workspace that has no `.headlesscode/` directory yet, print one clarifying
line: "This workspace has no `.headlesscode/` directory — per-workspace state
(index, mode-models.json) will be created here. This is distinct from
`~/.headlesscode/` which only holds checkpoints."

Find the right place to add this: trace both code paths (orchestrate entry
point in `src/orchestrator/cli.ts` or `src/cli.ts`, and the index command in
`src/codesearch/cli.ts`) and add the check + message at the earliest point
where the workspace root is known. Check whether `.headlesscode/` exists via
`fs.existsSync(path.join(workspaceRoot, '.headlesscode'))` — if absent, print
the clarification.

## What NOT to do

- **Do not add MCP integration.** headlesscode's tools are in-process
  TypeScript called directly by the loop. An MCP server would add a
  serialization/IPC hop with zero speed benefit.
- **Do not rewrite the chunker with tree-sitter.** The existing heuristic
  chunker (`src/codesearch/chunk.ts`) already produces function/class-boundary
  chunks. Revisit only if post-P0 measurement shows bad chunk boundaries on
  airunner's actual file mix.
- **Do not build LSP integration.** This is a separate multi-day build (P2).
  Scope it as its own plan doc if pursued later.
- **Do not make index-building automatic/silent.** Indexing costs real money
  via the cloud embedder. Always require an explicit opt-in or operator action.
- **Do not touch airunner's Docker-based test infrastructure.** That's
  airunner-side (`docker run` → `docker exec`), not headlesscode's problem.
- **Do not change `.orchestrator-state.json`'s schema.** This task is pure
  spawn/env/prompt changes.
- **Do not touch the read_file cache** (`src/tools/executor.ts`). It already
  works.

## Tests

- **P1.4 (no-index guardrail):** Add tests to the existing
  `scripts/spawn-parallel-worktrees.sh` test coverage (check if there's an
  e2e test that exercises the spawn script — trace through
  `scripts/e2e-phase2/run.sh`). At minimum: manual verification that the
  script exits non-zero when `ALLOW_UNINDEXED` is unset and no index exists,
  and proceeds when `ALLOW_UNINDEXED=1`.
- **P1.5 (local-explore + codebase_search):** Update the existing local-explore
  test at `src/engine/__tests__/local-explore.test.ts`:
  - Remove `codebase_search` from the "unavailable" list at line 476.
  - Add a test that the local-explore tool set now includes `codebase_search`.
  - Existing tests for env gate, empty-reply nudge, fail-open behavior should
    still pass (no behavior change other than the tool set).
- **P1.6 (loop-level guardrail):** Add tests to
  `src/engine/__tests__/loop.test.ts` (or a new test file if it fits the
  structure better):
  - N consecutive read-only calls trigger the nudge.
  - A codebase_search or edit tool call resets the counter.
  - Nudge is NOT injected when the workspace is unindexed (check by looking for
    `.headlesscode/codesearch/index.jsonl`).
- **P1.7 (global-vs-workspace notice):** If a helper function is extracted
  (e.g. `checkAndNoteHeadlesscodeDir`), test it. Otherwise manual verification
  is acceptable — the message is a one-line print.

## Verification checklist

1. `npx tsc --noEmit` clean.
2. `npm test` — all suites green including new ones.
3. Every e2e suite under `scripts/e2e*/run.sh` still passes.
4. After P0.1: confirm `~/Projects/airunner/.headlesscode/codesearch/index.jsonl`
   exists and is non-empty. Next orchestrated run's spawn log should say
   "Seeded codebase-search index from main repo" instead of the warning.
5. After P0.2: confirm `~/Projects/airunner/.headlesscode/mode-models.json`
   exists with the `_condensation` key. Condensation events in `harness.log`
   should show the cheap model and wall-clock should drop below the previously
   observed 55-80s.
6. After P0.3: report whether the context-window lookup was correct or needed
   fixing. If a fix was applied, expect fewer condensation events per run.
7. After P1.5: a `HEADLESSCODE_LOCAL_EXPLORE=1` run should show a local-explore
   phase in the harness log before the first cloud-model iteration, with
   `codebase_search` calls visible in the local phase's tool-call mix.

## What to report back

- P0.1: Index build summary (files scanned, chunks embedded, cost, file size).
- P0.2: The exact model chosen for `_condensation` and why.
- P0.3: The context-window value found in the log vs. the model's real
  advertised window. Whether a fix was needed and what it was.
- P1.4: Where exactly the guardrail was added (script lines), the env var names
  chosen, and the behavior when triggered (exit message verbatim).
- P1.5: Whether `codebase_search` was successfully added to the local-explore
  tool set, and whether the VRAM assessment was correct (cloud embedder, not
  local).
- P1.6: The exact injection point in `loop.ts` and the nudge message text. How
  you chose N=8 (or whatever value you settle on).
- P1.7: Where the one-line notice was added.
- Confirmation of tsc/test/e2e results.
- Any deviation from this spec, and why.
