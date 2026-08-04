# Review: speed-and-context-efficiency (worktree speedeff)

## What to review

The worktree `.worktrees/speedeff` has uncommitted changes implementing
`plans/speed-and-context-efficiency.md` (P0 + P1 items, 7 total).

The worker's completion report claims:
- 28 files changed, 1115 insertions, 144 deletions
- P0.1: codebase-search index built for airunner (907MB, 37419 chunks)
- P0.2: mode-models.json created with _condensation entry
- P0.3: context-window resolution fixed (now 1,048,576 not 128k) + retry + warn
- P1.4: spawn-path no-index guardrail (ALLOW_UNINDEXED, HEADLESSCODE_AUTO_INDEX)
- P1.5: codebase_search in local-explore tool set + orchestrator env threading
- P1.6: blind-tree-walking nudge in loop.ts (N=8, tunable)
- P1.7: global-vs-workspace .headlesscode/ notice
- tsc clean, npm test 76 suites all pass
- e2e, e2e-codesearch, e2e-phase2, e2e-phase4, e2e-permissions, e2e-phase5, e2e-phase6 all pass
- TWO latent codesearch bugs fixed (40961-token chunk overflow, 1.97GB single-string index) + parse cache
- Iteration cost: $0.19 over 308 iterations (97% cache hit rate)

## Risk profile

This round was flagged **significant** because it touches:
- `src/engine/loop.ts` — core request/cost/safety logic
- `src/tools/executor.ts` — tool execution (codebase_search registration)
- `src/llm/openrouter.ts` — llm client (retry logic)
- `src/codesearch/chunk.ts`, `src/codesearch/index.ts`, `src/codesearch/search.ts` — codesearch fixes

Highest-risk areas:
1. Loop-level nudge injection (P1.6) — changes main loop control flow
2. codesearch chunk overflow fix — changes index build/data integrity
3. codesearch parse cache — memory/session-scoped state
4. openrouter retry logic — changes LLM call behavior

## Review procedure

This is `plans/review-mode-prompt.md` applied to this specific worktree. Follow it exactly.

The diff to review is the uncommitted working tree:
```
git -C .worktrees/speedeff diff HEAD
```

Files changed (all modifications, no new files):
- docs/context-condensation.md
- plans/local-explore-phase-experiment.md
- scripts/e2e-phase2/run.sh, scripts/e2e-phase4/run.sh
- scripts/spawn-parallel-worktrees.sh
- src/cli.ts
- src/cloud/provider.ts
- src/codesearch/chunk.ts, src/codesearch/cli.ts, src/codesearch/index.ts, src/codesearch/search.ts
- src/codesearch/__tests__/chunk.test.ts, src/codesearch/__tests__/index.test.ts, src/codesearch/__tests__/search.test.ts
- src/config/mode-models.ts, src/config/__tests__/mode-models.test.ts
- src/engine/local-explore.ts, src/engine/loop.ts
- src/engine/__tests__/local-explore.test.ts, src/engine/__tests__/loop.test.ts
- src/index-util.ts, src/index-util.test.ts
- src/llm/openrouter.ts, src/llm/__tests__/openrouter.test.ts
- src/orchestrator/cli.ts, src/orchestrator/__tests__/cli.test.ts, src/orchestrator/__tests__/spawn-model.test.ts
- src/tools/executor.ts

When re-running verification, work inside `.worktrees/speedeff/`:
```
cd .worktrees/speedeff && npx tsc --noEmit
cd .worktrees/speedeff && npm test
```

## Special attention

1. The worker fixed two latent codesearch bugs that it says were "blockers for P0.1" — verify these are real fixes, not regressions. Check the chunk test changes carefully.
2. The parse cache in codesearch/search.ts — confirm it's session-scoped and doesn't leak across queries or sessions.
3. The context-window retry in src/llm/openrouter.ts — confirm it doesn't retry on 404 (deterministic failure) and has bounded backoff.
4. The loop.ts nudge at line 1742 — verify it doesn't inject nudges when the workspace is unindexed.
5. Check "What NOT to do" from the task plan: no MCP, no tree-sitter, no LSP, no schema changes, no touching read_file cache. Verify none of these were violated.
