# Gap audit — headlesscode vs Zoo Code (VS Code)

Snapshot of known behavioral gaps between the headless harness and the interactive VS Code
extension it's ported from. Documented for prioritization, not all scheduled.

## Built

- **Checkpoints, decision escalation, cost/token monitoring, diff-based editing,
  command/protected-file permissions parity, an automatic rework loop for `orchestrate`** —
  see [`docs/checkpoints.md`](checkpoints.md) and this doc's own git history for context.
- **`execute_command` timeout** now actually backgrounds the process (matching the vendored
  tool's own documented contract) instead of `SIGKILL`ing it.
- **Diff-based editing** — `apply_diff`/`search_replace`/`edit_file`, backed by a verbatim
  vendored port of Zoo Code's diff-matching logic
  (`src/vendor/zoo-code/src/core/diff/strategies/multi-search-replace.ts`). Checkpoints snapshot
  after any iteration using any edit tool, not just `write_to_file`.
- **Settings/permissions parity** — `src/permissions/commands.ts` +
  `src/permissions/protected-files.ts`, enforced in `src/tools/executor.ts` before a command
  runs or a file is written, not just requested via the system prompt. Covered by
  `scripts/e2e-permissions/run.sh`. Not ported: `alwaysAllowWriteOutsideWorkspace`/
  `alwaysAllowReadOnlyOutsideWorkspace` (moot — the workspace-boundary guard is already a hard
  deny, stricter than Zoo Code's default toggle).
- **Real-time worker monitoring + pause/resume** — `src/engine/events.ts`'s per-session JSONL
  event feed, dashboard live session detail view, pause/resume control (the dashboard's first
  write path — bearer-token gated, see `src/dashboard/server.ts`'s header comment).
- **`codebase_search`** — real semantic search backed by an embedding model, built AND
  activated (not just built-and-unused): `headlesscode index` builds a per-workspace index
  (generated on first use, gitignored, incremental by content hash), `spawn-parallel-worktrees.sh`
  copies an existing index into fresh worktrees so a worker never starts un-indexed, and
  `.roo/rules-code/rules.md` tells `code`-mode workers to try it before whole-file reads.
  Verified live: a real session reached for `codebase_search` before any whole-file read.
  Two embedding backends: `openrouter` (default, `qwen/qwen3-embedding-4b`) and `ollama`
  (opt-in via `HEADLESSCODE_EMBEDDING_BACKEND=ollama`, local `qwen3-embedding:8b`, verified
  live against a real local Ollama instance — zero marginal cost per index build). Distinct
  from the Phase 3 memory embedder (`src/memory/embed.ts`), which only powers session/fact
  recall, not code search.
- **Real context condensation** — `src/engine/condense.ts` replaces the old sliding-window-only
  placeholder with token-budget-aware summarize+merge, sharing its tool-call-group-boundary
  safety logic with `truncateHistory`'s own eviction path (one implementation family, not two
  independently-maintained ones). Falls back to the message-count sliding window for sessions
  that never approach the token threshold — condensation is a supplement, not a replacement.
- **A local-model narrow support role, evaluated honestly** — `src/tools/output-summarizer.ts`
  can compress oversized tool output via a local Ollama model, opt-in
  (`HEADLESSCODE_LOCAL_SUMMARIZATION=1`, off by default). An independent review found real
  problems with the shipped default model (non-deterministic output breaks prompt-cache
  stability on repeated commands; a live test showed it dropping the one relevant line from a
  buried-failure log and adding forbidden meta-commentary) — it stays off by default. This is
  useful evidence, not just caution: a narrow, well-scoped local-model role already showed
  real reliability gaps, which bears on any broader local-model ambitions (see the project
  owner's ongoing local-LLM/vision discussion).
- **Streaming responses + reasoning-content capture** — opt-in SSE streaming
  (`llm_stream_chunk` events) and `include_reasoning` capture for `deepseek/*` models, both
  previously fully absent. Verified to work correctly alongside context condensation in the
  same session (a combined test was added specifically because the two features were merged
  sequentially, both touching `src/engine/loop.ts`'s core request path).
- **A real browser-automation tool** (`browser_action`, Playwright-backed) — this was NOT a
  port (confirmed: no such tool exists anywhere in the Zoo Code reference clone), genuinely new
  work. Session-end cleanup verified to actually kill a still-open browser process; hung actions
  time out rather than hanging the session.
- **Dashboard browser parity** — chat-thread session view (not just a flat event log),
  checkpoint list/diff/restore from the browser (restore gated behind the same bearer-token
  auth as other control-plane POSTs), a read-only workspace file browser (reuses the existing
  path-traversal guard, does not add file editing), and a permissions-settings page mirroring
  the earlier mode-models settings page.
- **Minimal MCP client — fixture/dependency only, feature incomplete.** A real stdio-transport
  test fixture (built on the official `@modelcontextprotocol/sdk`) compiles and is merged, but
  the actual client (`src/mcp/client.ts`), executor wiring, and session lifecycle management
  were never built — the original implementation attempt stopped early and only a follow-up
  fixture-compile fix landed. The fixture currently has no test importing it. Treat MCP as
  still NOT implemented for any practical purpose; only the groundwork (a working test fixture
  + the SDK dependency) is in place.

## Real open gaps

- **No subtasks / recursive orchestration** (`new_task` stubbed) — the project owner has
  confirmed wanting a real port of Zoo/Roo's recursive `new_task`-based Orchestrator mode for
  individual workers (headless-native design already speced in
  `plans/recursive-orchestrator-mode.md`, explicitly NOT a literal port of the VS Code
  implementation, which is coupled to a single-active-task webview UI this project has no
  equivalent of). Not yet implemented.
- **The real MCP client/executor wiring** — see above; only a compiling fixture exists.
- **`headlesscode index`'s default embedding backend is still `openrouter`, not the free local
  `ollama` option** — the capability exists and is verified working, it's just not the default
  for local development where a GPU is available.
- **GitHub App provisioning** — built and unit-tested against GitHub's documented API shape,
  but never exercised end-to-end against a real registered App (that step needs a human to
  register the App on GitHub — not something an agent can do).
- **Multi-tenant hosting** — a design document plus one bounded proof-of-concept
  (`DockerSessionProvider` implementing `CloudProvider`), not real per-tenant isolation.
  Correctly parked per the project owner's stated local-first priority.
- **Hetzner cloud provider** — documented sketch, not implemented (`docs/phase6-cloud.md`), a
  deliberate scope decision.
- **Playwright-MCP QA interactivity** — documented (`docs/phase4-qa.md`), a deliberate scope
  decision; QA sessions can run commands/tests but not interact with a live browser
  interactively (distinct from the new `browser_action` tool above, which the CODING agent can
  use — QA's gap is specifically about live MCP-driven interactivity during QA verification).
- **No local vision model for image input** — `deepseek/deepseek-v4-flash` (the pinned model)
  cannot process images. Under discussion: a local Ollama vision model captioning/describing
  attached images to text before they reach the cloud model, since that's a capability gap the
  cloud model literally cannot fill locally, not a decision being handed to a less-reliable
  local model. Not yet scoped into a plan doc.
