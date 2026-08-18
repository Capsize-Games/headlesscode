# VENDOR-NOTES — vendored Zoo Code portable core

This directory contains a verbatim vendored copy of the portable (VS Code-free)
core of **Zoo Code** (`Zoo-Code-Org/Zoo-Code`, a Roo Code fork), Apache-2.0,
Copyright 2026 Zoo Code.

- Upstream clone: `~/Projects/zoo-code` (also at `./zoo-code` inside
  this workspace while vendoring is in progress).
- Inspected commit: `ca9b60fbc7b72a27352b0e2084271c28f2419f94`.
- License: `LICENSE` at repo root is the verbatim Apache 2.0 text from
  upstream. `ATTRIBUTION.md` at repo root covers attribution. The upstream
  files do not carry per-file license headers (verified while copying), so the
  repo-root LICENSE + ATTRIBUTION is the only header bookkeeping required.

**Vendoring rule applied:** files under `src/` and `types/` are copied verbatim
(`cp`), byte-for-byte, with their original relative structure so their internal
relative imports resolve unchanged. Where the original imports something that
does not exist in a headless Node process (`vscode`, `openai` SDK types,
`@anthropic-ai/sdk`, `os-name`, `strip-bom`) or a GUI-only service, we do one
of:

1. **Path-map the bare specifier to a local shim** via `tsconfig.json` →
   `compilerOptions.paths` (keeps copied files 100% unmodified), or
2. **Place a local replacement file at the same relative path** the original
   import expected (also keeps copied files unmodified).

Every shim is listed below. Nothing under `src/` or `types/` was hand-edited.

---

## 1. Files vendored verbatim (with original source paths)

### System prompt builder + sections — `zoo-code/src/core/prompts/`
| Vendored file | Original path |
|---|---|
| `src/core/prompts/system.ts` | `zoo-code/src/core/prompts/system.ts` |
| `src/core/prompts/types.ts` | `zoo-code/src/core/prompts/types.ts` (SystemPromptSettings) |
| `src/core/prompts/sections/index.ts` | `zoo-code/src/core/prompts/sections/index.ts` |
| `src/core/prompts/sections/tool-use.ts` | `zoo-code/src/core/prompts/sections/tool-use.ts` |
| `src/core/prompts/sections/tool-use-guidelines.ts` | `zoo-code/src/core/prompts/sections/tool-use-guidelines.ts` |
| `src/core/prompts/sections/capabilities.ts` | `zoo-code/src/core/prompts/sections/capabilities.ts` |
| `src/core/prompts/sections/rules.ts` | `zoo-code/src/core/prompts/sections/rules.ts` |
| `src/core/prompts/sections/system-info.ts` | `zoo-code/src/core/prompts/sections/system-info.ts` |
| `src/core/prompts/sections/objective.ts` | `zoo-code/src/core/prompts/sections/objective.ts` |
| `src/core/prompts/sections/modes.ts` | `zoo-code/src/core/prompts/sections/modes.ts` (1 `vscode.*` ref, satisfied by shim) |
| `src/core/prompts/sections/markdown-formatting.ts` | `zoo-code/src/core/prompts/sections/markdown-formatting.ts` |
| `src/core/prompts/sections/custom-instructions.ts` | `zoo-code/src/core/prompts/sections/custom-instructions.ts` (rules splicing: `.roo/rules-<slug>/`, `.roo/rules/`, `AGENTS.md`, legacy `.roorules`/`.clinerules`, cache-file filtering) |
| `src/core/prompts/sections/skills.ts` | `zoo-code/src/core/prompts/sections/skills.ts` |

### Native tool schemas + converters — `zoo-code/src/core/prompts/tools/native-tools/`
All 21 tool schema files + the index + converters + MCP-server schema builder
(top-level `*.ts`; the `__tests__/` subdirectories were **not** vendored):

`access_mcp_resource.ts`, `apply_diff.ts`, `apply_patch.ts`,
`ask_followup_question.ts`, `attempt_completion.ts`, `codebase_search.ts`,
`converters.ts`, `edit.ts`, `edit_file.ts`, `execute_command.ts`,
`generate_image.ts`, `index.ts` (`getNativeTools()`), `list_files.ts`,
`mcp_server.ts`, `new_task.ts`, `read_command_output.ts`, `read_file.ts`,
`run_slash_command.ts`, `search_files.ts`, `search_replace.ts`, `skill.ts`,
`switch_mode.ts`, `update_todo_list.ts`, `write_to_file.ts`

→ all copied from `zoo-code/src/core/prompts/tools/native-tools/*.ts`.

### Mode config / rules loading / shared logic
| Vendored file | Original path |
|---|---|
| `src/core/config/CustomModesManager.ts` | `zoo-code/src/core/config/CustomModesManager.ts` (`.roomodes` YAML/JSON parsing, invisible-char cleaning, zod validation, project/global merge) |
| `src/services/roo-config/index.ts` | `zoo-code/src/services/roo-config/index.ts` (`.roo` directory discovery order) |
| `src/shared/modes.ts` | `zoo-code/src/shared/modes.ts` (mode lookup/selection, `FileRestrictionError`) |
| `src/shared/tools.ts` | `zoo-code/src/shared/tools.ts` (`TOOL_GROUPS`, `ALWAYS_AVAILABLE_TOOLS`, `TOOL_ALIASES`, `NativeToolArgs`, `DiffStrategy`) |
| `src/shared/language.ts` | `zoo-code/src/shared/language.ts` (`LANGUAGES`, `formatLanguage`) |
| `src/shared/globalFileNames.ts` | `zoo-code/src/shared/globalFileNames.ts` |
| `src/utils/object.ts` | `zoo-code/src/utils/object.ts` (`isEmpty`) |
| `src/utils/shell.ts` | `zoo-code/src/utils/shell.ts` (`getShell`, allowlist; `vscode.*` refs satisfied by shim) |
| `src/utils/mcp-name.ts` | `zoo-code/src/utils/mcp-name.ts` (pure; `buildMcpToolName`, sanitizers) |

### Vendored `@roo-code/types` subset — `zoo-code/packages/types/src/`
| Vendored file | Original path |
|---|---|
| `types/tool.ts` | `zoo-code/packages/types/src/tool.ts` (tool groups, tool names) |
| `types/mode.ts` | `zoo-code/packages/types/src/mode.ts` (`ModeConfig` zod schema + `DEFAULT_MODES` for architect/code/ask/debug/orchestrator) |
| `types/todo.ts` | `zoo-code/packages/types/src/todo.ts` (`TodoItem`) |
| `types/vscode.ts` | `zoo-code/packages/types/src/vscode.ts` (`Language`, `isLanguage`) |
| `types/message.ts` | `zoo-code/packages/types/src/message.ts` (`ClineAsk`, `ToolProgressStatus`) |
| `types/tool-params.ts` | `zoo-code/packages/types/src/tool-params.ts` (`GenerateImageParams`, `ReadFileToolParams`) |

### Checkpoints — `zoo-code/src/services/checkpoints/`
| Vendored file | Original path |
|---|---|
| `src/services/checkpoints/ShadowCheckpointService.ts` | `zoo-code/src/services/checkpoints/ShadowCheckpointService.ts` (shadow-git mechanism via `simple-git`; 1 `vscode.*` ref — an error toast — satisfied by the shim) |
| `src/services/checkpoints/RepoPerTaskCheckpointService.ts` | `zoo-code/src/services/checkpoints/RepoPerTaskCheckpointService.ts` (thin subclass: `shadowDir/tasks/<taskId>/checkpoints` layout) |
| `src/services/checkpoints/types.ts` | `zoo-code/src/services/checkpoints/types.ts` |
| `src/services/checkpoints/excludes.ts` | `zoo-code/src/services/checkpoints/excludes.ts` (shadow-repo `.git/info/exclude` patterns) |
| `src/services/checkpoints/index.ts` | `zoo-code/src/services/checkpoints/index.ts` (barrel) |

### Diff-based editing — `zoo-code/src/core/diff/`
| Vendored file | Original path |
|---|---|
| `src/core/diff/strategies/multi-search-replace.ts` | `zoo-code/src/core/diff/strategies/multi-search-replace.ts` (fuzzy Levenshtein diff engine with `:start_line:` disambiguation + truncated-diff repair; backs the harness's `apply_diff` tool) |
| `src/utils/text-normalization.ts` | `zoo-code/src/utils/text-normalization.ts` (pure: `normalizeString`, `unescapeHtmlEntities`) |
| `src/integrations/misc/extract-text.ts` | `zoo-code/src/integrations/misc/extract-text.ts` (subset: only the `addLineNumbers` / `everyLineHasLineNumbers` / `stripLineNumbers` helpers the diff strategy imports; PDF/DOCX/XLSX extractors and binary detection excluded — they drag `pdf-parse`, `mammoth`, `isbinaryfile`) |
| `types/global-settings.ts` | `zoo-code/packages/types/src/global-settings.ts` (subset: only `DEFAULT_DIFF_FUZZY_THRESHOLD = 1.0`, re-exported from the `@roo-code/types` barrel) |

New real npm dep added for this: `fastest-levenshtein` (the diff strategy's Levenshtein distance function).

Real npm deps added for this (not shimmed — genuine portable packages):
`simple-git`, `p-wait-for` (see root `package.json`). Harness wiring is
`src/checkpoints/service.ts` + `src/checkpoints/cli.ts`; see
`docs/checkpoints.md`.

One adaptation note specific to checkpoints: `ShadowCheckpointService`'s
private `stageAll()` (`git add . --ignore-errors`) only stages correctly
when the shadow dir's `cwd` is unrelated to the workspace it tracks (true for
Zoo Code's real `globalStorageUri`-based shadow dir, which is always outside
any workspace). `src/checkpoints/service.ts` runtime-patches that one method
on its own subclass's prototype to `git add -A` as defense in depth, and
separately refuses (throws) to create a checkpoint service whose
`checkpointDir` resolves inside `workspaceRoot` at all — nesting also breaks
`restoreCheckpoint()`'s `git clean -f -d -f`, which would delete a nested
shadow repo's own `.git`. See the file header of `src/checkpoints/service.ts`
for the full writeup (verified empirically, not just from reading the code).
No vendored file was edited for this — the fix is a subclass-prototype patch
in the harness's own wrapper module.

---

## 2. Shims created (all under `src/vendor/zoo-code/`)

Wired by rewriting the vendored imports to real relative paths (e.g.
`import * as vscode from "../../shim/vscode"`, `import ... from "../../types"`)
— since issue #99, the package must boot from a clean `npm install`, where
tsx does NOT apply tsconfig `paths` to files under `node_modules`. The shims
sit at the same depth-relative locations regardless of install prefix, so the
relative imports resolve with no tsconfig magic:

| Shim file | Replaces (upstream) | Why / notes |
|---|---|---|
| `shim/vscode.ts` | the `vscode` module | Headless no-op stand-in: `ExtensionContext.globalState`, `workspace.workspaceFolders` (= `undefined`), no-op `createFileSystemWatcher`, `getConfiguration`, `window.showErrorMessage/WarningMessage` → console, `env.language` = `"en"`. Imported by relative path (`../../shim/vscode`). |
| `shim/openai.d.ts` | the `openai` package (types only) | Vendored schemas only use `import type OpenAI` — no runtime needed. Declares just `Chat.ChatCompletionTool` (+ `FunctionParameters`, `ChatCompletionCreateParams["tool_choice"]`). |
| `shim/anthropic.ts` | `@anthropic-ai/sdk` | Class + namespace merge (mirrors the real SDK's export shape) providing `Anthropic.Tool`/`Tool.InputSchema`/`Messages.MessageCreateParams["tool_choice"]`/`TextBlockParam`/`ImageBlockParam` plus an empty runtime class so the named import in `shared/tools.ts` resolves. Mapped via `paths`. |
| `shim/os-name.ts` | the `os-name` npm package | Returns the same `<platform> <release>` fallback the original code uses when `os-name` fails. Mapped via `paths`. |
| `shim/strip-bom.ts` | the `strip-bom` npm package | Strips a leading UTF-8 BOM. Mapped via `paths`. |
| `src/utils/path.ts` | `zoo-code/src/utils/path.ts` | Same exported surface (`toPosix` side effect on `String.prototype`, `arePathsEqual`, `getReadablePath`, `toRelativePath`, `getWorkspacePath`), but workspace root comes from `HEADLESSCODE_WORKSPACE_ROOT` env var, falling back to `process.cwd()`. Placed at the same relative path so `CustomModesManager`'s `../../utils/path` import resolves unmodified. |
| `src/utils/fs.ts` | `zoo-code/src/utils/fs.ts` | Only the subset used by the vendored core: `fileExistsAtPath`. |
| `src/utils/logging.ts` | `zoo-code/src/utils/logging.ts` | Console-backed `logger` (original wraps VS Code output channels). |
| `src/utils/globalContext.ts` | `zoo-code/src/utils/globalContext.ts` | `ensureSettingsDirectoryExists` → `~/.roo` (created if needed). |
| `src/utils/json-schema.ts` | `zoo-code/src/utils/json-schema.ts` | Identity `normalizeToolSchema` + structural `JsonSchema`. Original drags `zod/v4`; full normalization only matters for real MCP support. **Needs adaptation when MCP lands.** |
| `src/services/mcp/McpHub.ts` | `zoo-code/src/services/mcp/McpHub.ts` | Stub `McpHub` with an injectable server list; `getServers()`. No transports (Phase 1 has no MCP). |
| `src/services/code-index/manager.ts` | `zoo-code/src/services/code-index/manager.ts` | Stub `CodeIndexManager.getInstance()` (prompt builder only calls the factory; result unused). |
| `src/services/skills/SkillsManager.ts` | `zoo-code/src/services/skills/SkillsManager.ts` | Stub returning no skills from `getSkillsForMode()`. |
| `src/services/search/file-search.ts` | `zoo-code/src/services/search/file-search.ts` | `executeRipgrep` implemented with pure Node fs + a small glob matcher (`**`, `*`, `!`-excludes). Originally only served `.roo` subdirectory discovery (`roo-config`); extended for the checkpoints vendoring to also serve `ShadowCheckpointService#getNestedGitRepository()`'s `**/.git/HEAD` nested-repo scan (returns `{ path, type }`, not just `path`, to match what that caller destructures). |
| `src/i18n/index.ts` | `zoo-code/src/i18n/index.ts` | `t()` returns the key with `{param}` interpolation; original is the webview UI catalog. |
| `types/index.ts` | the `@roo-code/types` package | Re-export barrel over the vendored `types/*` modules. Imported by relative path (`../../types`). |

---

## 3. Files excluded and why

| Excluded (upstream path) | Why |
|---|---|
| `zoo-code/src/core/prompts/tools/filter-tools-for-mode.ts` | Drags `McpHub`, `CodeIndexManager`, `ModelInfo`, and `validateToolUse`; per-mode tool filtering is orchestration-layer work for a later subtask. Only the schemas themselves were required now. |
| `zoo-code/src/core/prompts/responses.ts` | Result formatting back to the model; depends on diff/terminal result shapes. Deferred to the tool-execution subtask. (Not required by this subtask's scope.) |
| `zoo-code/src/core/prompts/sections/__tests__/` and all `__tests__/` dirs | Test scaffolding (vitest) with snapshots; not needed headless. |
| `zoo-code/src/core/assistant-message/`, `core/task/`, `core/context-management/`, `core/condense/` | Orchestration loop, tool-call parsing, context management — explicitly out of scope for this subtask (next subtask). |
| `zoo-code/src/core/tools/` (tool *executions*) | Diff-view-provider/terminal-coupled; replaced by plain `fs`/`subprocess` executors in the next subtask. |
| `zoo-code/src/services/rules/rules.ts` | CRUD + path-traversal guards for rules files; the splice path only needs `custom-instructions.ts`'s own scanning (which was vendored). |
| `zoo-code/apps/cli/`, `packages/vscode-shim/`, `webview-ui/`, `src/extension.ts`, `activate/`, `api/`, `integrations/` | GUI/extension machinery — excluded per instructions. |
| `zoo-code/src/utils/path.ts` (original), `utils/fs.ts`, `utils/logging.ts`, `utils/globalContext.ts`, `utils/json-schema.ts` | Replaced by the local shims listed above (placed at the same relative paths). |
| `zoo-code/src/shared/string-extensions.d.ts` | Its `String.toPosix` declaration is provided by the vendored `src/utils/path.ts` shim instead. |

---

## 4. Remaining `vscode.*` references and adaptation notes for the next subtask

All remaining `vscode.*` references in vendored code are satisfied **at type
and runtime level** by the `shim/vscode.ts` stand-in; none require a real
VS Code. They are listed here so the next subtask knows exactly what a headless
implementation must provide or replace:

| File | `vscode.*` use | Headless plan |
|---|---|---|
| `src/core/prompts/system.ts` | `vscode.ExtensionContext` type; `vscode.env.language` | Context is a thin in-memory `globalState` object; language comes from config/env. |
| `src/core/prompts/sections/modes.ts` | `vscode.ExtensionContext` type (via `getAllModesWithPrompts`) | Same as above. |
| `src/shared/modes.ts` | `vscode.ExtensionContext` type in `getAllModesWithPrompts` | Same as above. |
| `src/utils/shell.ts` | `vscode.workspace.getConfiguration` (terminal profile lookup, inside try/catch) | Falls through to `os.userInfo()`/`$SHELL`/platform defaults. |
| `src/core/config/CustomModesManager.ts` | `vscode.Disposable`/`ExtensionContext` types; `workspace.workspaceFolders`; `workspace.createFileSystemWatcher`; `window.showErrorMessage/WarningMessage` | Harness should expose a headless `getCustomModes(cwd)` path (or set `HEADLESSCODE_WORKSPACE_ROOT`); watchers are dropped; errors go to logs. |

Other adaptation notes for the next subtask:
- `fs.readdir(..., { withFileTypes: true, recursive: true })` in
  `custom-instructions.ts` requires **Node ≥ 20.4** at runtime (fine under the
  declared `engines.node >= 18` only for shallow rules trees; bump engines or
  tolerate the TypeError if Node 18 is used with deeply nested rules dirs).
- The vendored `McpHub`, `CodeIndexManager`, `SkillsManager`, and
  `json-schema` shims are stubs; replace them with real implementations when
  MCP servers, codebase search, skills, and MCP schema normalization are
  actually needed.
- `native-tools/mcp_server.ts` is vendored and compiles against the stubs but
  returns `[]` until a real `McpHub` is wired.

---

## 5. Verification

- `npm install` — succeeded (deps: `zod`, `yaml`; devDeps: `typescript`, `tsx`,
  `@types/node`; no SDK/runtime deps added beyond the project minimum).
- `npx tsc --noEmit` — **passes with 0 errors** (no "needs adaptation"
  exclusions were necessary).
- `npm run smoke` — builds a system prompt for the `code` mode (≈15.7k chars,
  includes TOOL USE / OBJECTIVE / RULES / MODES / CAPABILITIES / SYSTEM
  INFORMATION / USER'S CUSTOM INSTRUCTIONS with passed-in custom-instructions
  text), assembles 21 native (OpenAI-format) tool schemas, converts them to
  Anthropic format, and validates a `.roomodes`-style doc against
  `customModesSettingsSchema`. See `src/vendor/tests/smoke.ts`.
