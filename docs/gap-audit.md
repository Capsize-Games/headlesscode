# Gap audit — headlesscode vs Zoo Code (VS Code)

Snapshot of known behavioral gaps between the headless harness and the interactive VS Code
extension it's ported from. Documented for prioritization, not all scheduled — checkpoints,
decision escalation, and cost/token monitoring (previously the three biggest gaps) are now
built; see [`docs/checkpoints.md`](checkpoints.md) and this doc's own history for context.

## Recommended next: diff-based editing

`apply_diff` / `search_replace` / `edit_file` are not implemented — every edit goes through
`write_to_file`, a full-file overwrite (`src/tools/executor.ts`). Two consequences:

- **Cost**: rewriting an entire large file for a one-line change burns far more output tokens
  than a targeted diff, on every single edit.
- **Safety**: no diff review step exists even at the model level — a truncated or malformed
  model response silently clobbers the whole file with no partial-match/hunk validation the
  way `apply_diff`'s fuzzy matching provides upstream.

This is a self-contained port of Zoo Code's diff-matching logic (`zoo-code/src/core/diff/`)
and is the single highest-value remaining gap. Not built in this round — recommend scheduling
it next.

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
