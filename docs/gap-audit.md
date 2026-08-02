# Gap audit — headlesscode vs Zoo Code (VS Code)

Snapshot of known behavioral gaps between the headless harness and the interactive VS Code
extension it's ported from. Documented for prioritization, not all scheduled — checkpoints,
decision escalation, cost/token monitoring, diff-based editing, command/protected-file
permissions parity, and an automatic rework loop for `orchestrate` (previously the biggest
gaps) are now built; see [`docs/checkpoints.md`](checkpoints.md) and this doc's own history
for context. Also fixed along the way: `execute_command`'s timeout used to `SIGKILL` the
process, contradicting the vendored tool's own documented "keeps running in the background"
contract — it now actually backgrounds it, matching upstream.

## Diff-based editing — built

`apply_diff` / `search_replace` / `edit_file` are implemented, backed by a verbatim vendored
port of Zoo Code's diff-matching logic (`src/vendor/zoo-code/src/core/diff/strategies/
multi-search-replace.ts` for `apply_diff`'s fuzzy engine; `search_replace`'s strict
one-occurrence literal match and `edit_file`'s exact → whitespace-tolerant → token-based
fallback chain live in `src/tools/executor.ts`). The harness's executor also snapshots
checkpoints after any iteration that used any edit tool (including diff-only iterations).
Prior to this, every edit went through `write_to_file`, a full-file overwrite — costly (an
entire large file rewritten for a one-line change) and unsafe (a truncated/malformed model
response silently clobbered the whole file with no partial-match/hunk validation).

## Settings/permissions parity — built

Ported the load-bearing parts of Zoo Code's settings-backed enforcement layer
(`zoo-code/src/core/auto-approval/` + `packages/types/src/global-settings.ts`) as
harness-level CLI flags/env vars/a committed `permissions.json`, since there's no settings
UI: `src/permissions/commands.ts` (compound-command splitting, dangerous shell-substitution
detection, longest-prefix-match `allowedCommands`/`deniedCommands` with ties going to deny)
and `src/permissions/protected-files.ts` (glob-based protected-file writes, default-refused,
with an explicit `--allow-protected-writes` escape hatch). Enforced in
`src/tools/executor.ts` before a command runs or a file is written — not just requested via
the system prompt. Commands default-allow when unconfigured (preserves prior behavior);
`deniedCommands` and dangerous substitutions always apply regardless. Covered by both unit
tests and a dedicated e2e suite (`scripts/e2e-permissions/run.sh`) proving a real CLI
invocation actually refuses a protected write / denied command and that the escape hatch
really works, not just that the underlying matching functions are correct in isolation.

Not ported: `alwaysAllowWriteOutsideWorkspace`/`alwaysAllowReadOnlyOutsideWorkspace` (moot —
headlesscode's workspace-boundary guard is a hard path-traversal deny, not a toggle, and is
already stricter than Zoo Code's default) and `alwaysAllowMcp`/`alwaysAllowSubtasks` (no MCP
client or subtask concept exists to gate — see below).

## Other known gaps (lower priority, mostly by design)

- **No MCP tool support** — `access_mcp_resource` is a stub. No MCP client exists in the
  harness at all.
- **No real context condensation** — history truncation is a placeholder sliding window
  (`src/engine/loop.ts`, search "Phase 1 sliding-window truncation"), not token-based
  summarize+merge condensation.
- **No browser tool** — not present in the vendored native-tool set this harness exposes.
## codebase_search — built and activated

Implemented against a real OpenRouter embedding model (`qwen/qwen3-embedding-4b`, verified
live), distinct from the Phase 3 memory embedder (`src/memory/embed.ts`, which only powers
session/fact recall, not code search). See `src/codesearch/`. Requires an explicit
`headlesscode index` run per workspace before it returns real results.

Activation (2026-08-01):
- `headlesscode index --workspace .` was run against this repo and its worktrees; the
  index is **generated on first use, never committed** — it is ~168MB for this repo
  (3066 chunks × 2560-dim vectors), so it stays gitignored under
  `/.headlesscode/`. Re-running the index is incremental: unchanged chunks are skipped
  by content hash (a no-op re-index costs ~$0), so keeping it current is cheap.
- `scripts/spawn-parallel-worktrees.sh` and `-gui.sh` now **copy the main repo's index
  into each fresh worktree** (same gitignore rationale as the `zoo-code/` symlink), so a
  worker never starts with a guaranteed "not indexed".
- `.roo/rules-code/rules.md` tells `code`-mode workers to try `codebase_search` before
  whole-file reads for orientation, to treat a "not indexed" result as a fallback signal
  (not a retryable error), and that `codebase_search` complements (not replaces)
  `read_file`.
- Verified live (2026-08-01): a real `code`-mode session on "where is truncateHistory
  and how does it handle tool_calls?" reached for `codebase_search` 6 times before any
  whole-file read, then used a targeted `grep` + `read_file` to pin the exact lines.
  `scripts/e2e-codesearch/run.sh` pins the behavior with a mock-LLM session (the mock
  reads the system prompt and follows the guidance), so the activation is regression-
  guarded offline too.

- **No subtasks** (`new_task` stubbed) — previously deliberate ("multi-agent work is handled
  at the process level"), but the project owner has since confirmed wanting a real port of
  Zoo/Roo's recursive `new_task`-based Orchestrator mode for individual workers. Not yet
  scoped into a plan doc — this line is now a real open item, not a closed design decision.
- **Hetzner cloud provider** — documented sketch, not implemented
  (`docs/phase6-cloud.md`), a deliberate scope decision.
- **Playwright-MCP QA gap** — documented (`docs/phase4-qa.md`), a deliberate scope decision;
  QA sessions can run commands/tests but not interact with a live browser.
