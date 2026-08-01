# Gap audit — headlesscode vs Zoo Code (VS Code)

Snapshot of known behavioral gaps between the headless harness and the interactive VS Code
extension it's ported from. Documented for prioritization, not all scheduled — checkpoints,
decision escalation, cost/token monitoring, and diff-based editing (previously the four
biggest gaps) are now built; see [`docs/checkpoints.md`](checkpoints.md) and this doc's own
history for context.

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

## Settings/permissions parity — none

Zoo Code's VS Code settings panel backs a real enforcement layer
(`zoo-code/src/core/auto-approval/index.ts` + `packages/types/src/global-settings.ts`):

- Per-category auto-approve toggles (`alwaysAllowReadOnly`, `alwaysAllowWrite`,
  `alwaysAllowExecute`, `alwaysAllowMcp`, ...)
- `allowedCommands` / `deniedCommands` — regex allow/deny lists gating `execute_command`
- `alwaysAllowWriteProtected` — a protected-files concept
- `alwaysAllowWriteOutsideWorkspace` / `alwaysAllowReadOnlyOutsideWorkspace` — workspace
  boundary guards
- `followupAutoApproveTimeoutMs` — the interactive analogue of the decision-escalation
  timeout just built for headlesscode workers

headlesscode's executor (`src/tools/executor.ts`) has **none of this**: `execute_command`
runs anything the model asks with no allow/deny list, and `write_to_file` has only a
path-traversal guard (workspace-boundary enforcement is actually *stricter* than Zoo Code's
default there, since it's hard-denied rather than a toggle) — but nothing protects specific
files like `.env` from being overwritten by the model itself. This matters more, not less,
once VS Code (and its accidental human-approval safety net) is out of the loop entirely.

**Recommendation**: port `allowedCommands`/`deniedCommands` + a protected-file list as
harness-level config (CLI flags/env, since there's no settings UI), enforced in the executor
before a command/write runs — not just requested via the system prompt.

## Other known gaps (lower priority, mostly by design)

- **No MCP tool support** — `access_mcp_resource` is a stub. No MCP client exists in the
  harness at all.
- **No real context condensation** — history truncation is a placeholder sliding window
  (`src/engine/loop.ts`, search "Phase 1 sliding-window truncation"), not token-based
  summarize+merge condensation.
- **No browser tool** — not present in the vendored native-tool set this harness exposes.
- **No `codebase_search`** (semantic code search) — stubbed. Distinct from the Phase 3 memory
  embedder (`src/memory/embed.ts`), which only powers session/fact recall, not code search.
- **No subtasks** (`new_task` stubbed) — deliberate: multi-agent work is handled at the
  process level (separate worktrees/workers via the orchestrator) rather than in-session
  subtasking.
- **Hetzner cloud provider** — documented sketch, not implemented
  (`docs/phase6-cloud.md`), a deliberate scope decision.
- **Playwright-MCP QA gap** — documented (`docs/phase4-qa.md`), a deliberate scope decision;
  QA sessions can run commands/tests but not interact with a live browser.
