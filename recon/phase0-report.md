# Phase 0 Recon Report — Zoo-Code (Roo Code fork) headless harness feasibility

**Date:** 2026-07-31
**Clone location:** `/home/joe/Projects/zoo-code`
**Source repo:** `https://github.com/Zoo-Code-Org/Zoo-Code`
**Committed hash inspected:** `ca9b60fbc7b72a27352b0e2084271c28f2419f94` (`fix(router-provider): fetch model metadata before context management decisions (#1053)`)
**Prepared for:** Headless coding-agent harness project (see `/home/joe/Projects/headlesscode/headless-coding-harness-project.md`)

---

## 1. Clone status

The shallow clone completed successfully:

```
git clone --depth 1 https://github.com/Zoo-Code-Org/Zoo-Code /home/joe/Projects/zoo-code
```

- HEAD: `ca9b60f` (single commit due to `--depth 1`)
- `git remote -v` shows origin = `Zoo-Code-Org/Zoo-Code`
- Working tree is clean and fully checked out (`.git` ~73 MB)
- The repo is a pnpm monorepo. Root `package.json` name is `roo-code` (i.e., this is the **Roo Code** codebase, branded/renamed "Zoo Code" in prompts and LICENSE). Workspaces: `src` (extension), `webview-ui`, `apps/*` (cli, vscode-e2e, vscode-nightly), `packages/*` (types, core, telemetry, vscode-shim, cloud, ipc, build, config-*).

Note: the first clone attempt appeared to stall/fail (directory vanished). A second explicit clone (with the destination removed first) succeeded with `EXIT_CODE=0`.

---

## 2. License verification

- **`LICENSE`:** Full Apache License 2.0 text. Header: `Apache License / Version 2.0, January 2004 / http://www.apache.org/licenses/`.
- Appendix boilerplate copyright line: **`Copyright 2026 Zoo Code.`** SPDX identifier: **`Apache-2.0`**.
- **`README.md`:** `## License` → `[Apache 2.0 © 2026 Zoo Code Org](./LICENSE)`.
- **Root `package.json`:** *no* explicit `license` field (only `name: "roo-code"`). Individual packages may declare their own (e.g., `apps/cli`/`packages/*` should be checked at copy time, but LICENSE + README are unambiguous for the repo as a whole).
- **Conclusion:** Permissive Apache-2.0. Prompt text, tool schemas, and code may be reused directly (with attribution and a copy of the license, per Apache-2.0 §4). Clean-room reimplementation is *not* required. This resolves the "open questions" item in the parent project spec: direct reuse of prompt text/tool schema is permitted.

---

## 3. Repo structure map (relevant parts)

```
zoo-code/
├── src/                        # The VS Code extension itself (package name "roo-code")
│   ├── extension.ts            # Extension entry
│   ├── activate/               # activate(), commands, CodeActionProvider
│   ├── api/                    # Public API (startNewTask etc.)
│   ├── core/
│   │   ├── prompts/            # ★ System prompt builder + sections + native tool schemas
│   │   │   ├── system.ts       # SYSTEM_PROMPT() assembles everything
│   │   │   ├── responses.ts    # formatResponse: tool_result / error JSON, noToolsUsed, etc.
│   │   │   ├── types.ts        # SystemPromptSettings
│   │   │   └── sections/       # capabilities, rules, system-info, objective, modes,
│   │   │                       #   custom-instructions, tool-use, tool-use-guidelines,
│   │   │                       #   markdown-formatting, skills
│   │   ├── prompts/tools/
│   │   │   ├── native-tools/   # ★ 22 OpenAI ChatCompletionTool JSON schema definitions
│   │   │   │   ├── index.ts    # getNativeTools() assembles the array
│   │   │   │   └── converters.ts # OpenAI schema <-> Anthropic schema converters
│   │   │   └── filter-tools-for-mode.ts  # per-mode tool filtering/aliasing
│   │   ├── tools/              # ★ BaseTool + concrete tool implementations (execution)
│   │   │   ├── BaseTool.ts
│   │   │   ├── ReadFileTool.ts / WriteToFileTool.ts / ExecuteCommandTool.ts /
│   │   │   │   ListFilesTool.ts / EditFileTool.ts / ApplyDiffTool.ts / ... (21 impls)
│   │   │   └── helpers/toolResultFormatting.ts
│   │   ├── assistant-message/
│   │   │   ├── NativeToolCallParser.ts   # ★ OpenAI-style JSON function-call parser
│   │   │   └── presentAssistantMessage.ts # ★ tool dispatch + execution + results
│   │   ├── task/
│   │   │   └── Task.ts          # ★ THE ORCHESTRATION LOOP (4796 lines)
│   │   │   ├── build-tools.ts   # mode-filtered tool arrays for API requests
│   │   │   └── ...
│   │   ├── context-management/  # ★ history truncation + condensing (index.ts)
│   │   ├── condense/            # summarization-based context condensing
│   │   ├── config/CustomModesManager.ts  # ★ .roomodes parsing + merging
│   │   ├── auto-approval/, checkpoints/, diff/, ignore/, protect/, webview/ ...
│   ├── services/
│   │   ├── rules/rules.ts       # rule file scanning/CRUD (.roo/rules, .roo/rules-<slug>)
│   │   └── roo-config/index.ts  # getGlobalRooDirectory(), getProjectRooDirectoryForCwd()
│   ├── shared/
│   │   ├── tools.ts             # ★ NativeToolArgs type map, TOOL_GROUPS, ALWAYS_AVAILABLE_TOOLS, aliases
│   │   └── modes.ts             # mode lookup, getToolsForMode, FileRestrictionError
│   └── api/                     # ApiHandler, providers, stream transform
├── packages/
│   ├── types/src/mode.ts        # ★ ModeConfig zod schema + DEFAULT_MODES (5 built-in modes)
│   ├── types/src/tool.ts        # toolNames, toolGroups
│   ├── vscode-shim/             # ★ headless VSCode API mock (~4.5k LOC) — powers the CLI
│   ├── core/, telemetry/, ipc/, cloud/, build/, config-*
├── apps/
│   ├── cli/                     # ★ FULL HEADLESS CLI (see §7 — major finding)
│   └── vscode-e2e/, vscode-nightly/
└── webview-ui/                  # React chat UI (not needed headless)
```

---

## 4. System prompt inventory

**Location:** `src/core/prompts/`. The system prompt is built by `SYSTEM_PROMPT()` in [`system.ts`](../../zoo-code/src/core/prompts/system.ts) as a string concatenation of section builders:

```
roleDefinition
+ markdownFormattingSection()
+ getSharedToolUseSection()   (TOOL USE — "use the provider-native tool-calling mechanism")
+ getToolUseGuidelinesSection()
+ getCapabilitiesSection(cwd, mcpHub, allowedMcpServers)
+ getModesSection(context)
+ getSkillsSection(...)
+ getRulesSection(cwd, settings)         (RULES)
+ getSystemInfoSection(cwd)
+ getObjectiveSection()
+ addCustomInstructions(baseInstructions, globalCustomInstructions, cwd, mode, {...})
```

Important: the tool *catalog itself is not embedded in the system prompt* (`const toolsCatalog = ""` at system.ts:93). Tools are passed to the API via native function calling (OpenAI `ChatCompletionTool` schemas), and the prompt just instructs the model to use that mechanism. **There are no mode-specific system prompt *files*** in this fork — mode-specific behavior comes from `ModeConfig.roleDefinition`/`customInstructions` (from `DEFAULT_MODES` or `.roomodes`) spliced in via `addCustomInstructions`, not from separate per-mode prompt files.

### Prompt section inventory (all under `src/core/prompts/sections/`)

| File | Purpose | vscode refs |
|---|---|---|
| `tool-use.ts` | Instructs: "Use the provider-native tool-calling mechanism. Do not include XML markup or examples." | 0 |
| `tool-use-guidelines.ts` | 3-step tool-choice guidance | 0 |
| `capabilities.ts` | Lists what tools can do (CLI, file ops, workspace listing, MCP) | 0 |
| `rules.ts` | RULES section — cwd constraints, `cd`-stuck rule, shell chaining op, "wait for user response after each tool use", stealth-model confidentiality | 0 |
| `system-info.ts` | OS/shell/home/cwd block | 0 |
| `objective.ts` | Iterative goal breakdown, "use attempt_completion when done" | 0 |
| `modes.ts` | Lists available modes (from DEFAULT_MODES + custom modes) | 1 |
| `markdown-formatting.ts` | Markdown/link formatting rules | 0 |
| `custom-instructions.ts` | ★ Rules loading: `.roo/rules`, `.roo/rules-<slug>`, `AGENTS.md`, `.clinerules` etc. (see §5) | 0 |
| `skills.ts` | Skills section (optional) | 0 |

### Representative snippet — TOOL USE (`src/core/prompts/sections/tool-use.ts`)

```ts
export function getSharedToolUseSection(): string {
	return `====

TOOL USE

You have access to a set of tools that are executed upon the user's approval. Use the provider-native tool-calling mechanism. Do not include XML markup or examples. You must call at least one tool per assistant response. Prefer calling as many tools as are reasonably needed in a single response to reduce back-and-forth and complete tasks faster.`
}
```

### Representative snippet — RULES (`src/core/prompts/sections/rules.ts`)

```
RULES

- The project base directory is: ${cwd.toPosix()}
- All file paths must be relative to this directory...
- You cannot \`cd\` into a different directory to complete a task...
- Before using the execute_command tool, you must first think about the SYSTEM INFORMATION context...
- Some modes have restrictions on which files they can edit...
- You are only allowed to ask the user questions using the ask_followup_question tool...
- NEVER end attempt_completion result with a question...
```

### Representative snippet — OBJECTIVE (`src/core/prompts/sections/objective.ts`)

```
OBJECTIVE

You accomplish a given task iteratively, breaking it down into clear steps and working through them methodically.
1. Analyze the user's task and set clear, achievable goals...
4. Once you've completed the user's task, you must use the attempt_completion tool to present the result of the task to the user.
```

### Built-in modes — `DEFAULT_MODES` in [`packages/types/src/mode.ts`](../../zoo-code/packages/types/src/mode.ts:174)

5 built-in modes: `architect`, `code`, `ask`, `debug`, `orchestrator`. Each is a `ModeConfig` with `slug`, `name`, `roleDefinition`, `whenToUse`, `description`, `groups` (tool groups), optional `customInstructions`. E.g.:

```ts
{ slug: "code", name: "💻 Code",
  roleDefinition: "You are Zoo, a highly skilled software engineer with extensive knowledge in many programming languages, frameworks, design patterns, and best practices.",
  groups: ["read", "edit", "command", "mcp"] }
```

The `ModeConfig` zod schema is at [`packages/types/src/mode.ts`](../../zoo-code/packages/types/src/mode.ts:96): `{ slug, name, roleDefinition, whenToUse?, description?, customInstructions?, groups, source?, allowedMcpServers? }`.

---

## 5. Tool definitions

### Mechanism

Tools are defined in **two layers**:

1. **API-facing schemas:** OpenAI `ChatCompletionTool` JSON objects (OpenAI-style function calling) in `src/core/prompts/tools/native-tools/*.ts`, each `{ type: "function", function: { name, description, strict: true, parameters: { type: "object", properties, required, additionalProperties: false } } }`. Assembled by `getNativeTools()` in [`native-tools/index.ts`](../../zoo-code/src/core/prompts/tools/native-tools/index.ts:42). Converters to Anthropic format exist in `native-tools/converters.ts` (OpenAI→Anthropic and tool_choice mapping) — meaning the canonical schema language is OpenAI's, and Anthropic is a derived format.

2. **Typed argument map:** `NativeToolArgs` in [`src/shared/tools.ts`](../../zoo-code/src/shared/tools.ts:92) is a TypeScript type map `{ toolName: {args} }` used by `NativeToolCallParser` and `BaseTool` for runtime typing. The `ToolName` union comes from `@roo-code/types` (`toolNames`).

Result formatting back to the model: tools push results via `pushToolResult(content)` which becomes an Anthropic `tool_result` block with `tool_use_id` + `is_error` flag (see §6). `formatResponse.toolError()`, `formatResponse.toolDenied()` etc. in [`responses.ts`](../../zoo-code/src/core/prompts/responses.ts:7) wrap failures as JSON `{status, message, error}` strings.

### Full tool list (canonical names)

From `getNativeTools()` + `NativeToolArgs` + `toolNames`:

`access_mcp_resource`, `apply_diff`, `apply_patch`, `ask_followup_question`, `attempt_completion`, `codebase_search`, `execute_command`, `generate_image`, `list_files`, `new_task`, `read_command_output`, `read_file`, `run_slash_command`, `skill`, `search_replace`, `edit_file`, `edit` (alias `search_and_replace`), `search_files`, `switch_mode`, `update_todo_list`, `use_mcp_tool`, `write_to_file`.

Tool groups (`TOOL_GROUPS` in `shared/tools.ts`): `read` = read_file, search_files, list_files, codebase_search; `edit` = apply_diff, write_to_file, generate_image (+custom: edit, search_replace, edit_file, apply_patch); `command` = execute_command, read_command_output; `mcp` = use_mcp_tool, access_mcp_resource; `modes` = switch_mode, new_task. Always-available: ask_followup_question, attempt_completion, switch_mode, new_task, update_todo_list, run_slash_command, skill. Aliases: `write_file`→`write_to_file`, `search_and_replace`→`edit`.

### Quoted definitions (4 core tools)

**read_file** — [`native-tools/read_file.ts`](../../zoo-code/src/core/prompts/tools/native-tools/read_file.ts:60) (schema) / [`tools/ReadFileTool.ts`](../../zoo-code/src/core/tools/ReadFileTool.ts:71) (impl, 816 lines; supports slice + indentation modes, PDF/DOCX/image extraction):

```ts
// schema (OpenAI ChatCompletionTool)
return {
	type: "function",
	function: {
		name: "read_file",
		description,
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path:        { type: "string", description: "Path to the file to read, relative to the workspace" },
				mode:        { type: "string", enum: ["slice", "indentation"], description: "..." },
				offset:      { type: "integer", description: "1-based line offset to start reading from (slice mode, default: 1)" },
				limit:       { type: "integer", description: "Maximum number of lines to return (slice mode, default: 2000)" },
				indentation: { type: "object", properties: { anchor_line, max_levels, include_siblings, include_header, max_lines }, required: [], additionalProperties: false },
			},
			required: ["path"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

Result format: pushed as text `File: <relPath>\n<content>` (with truncation banner `IMPORTANT: File content truncated. Status: Showing lines X-Y of Z total lines. To read more: Use the read_file tool with offset=N...`); images become Anthropic image blocks. Legacy multi-file format `{ files: [{path, line_ranges}] }` still supported.

**write_to_file** — [`native-tools/write_to_file.ts`](../../zoo-code/src/core/prompts/tools/native-tools/write_to_file.ts:18) (schema) / [`tools/WriteToFileTool.ts`](../../zoo-code/src/core/tools/WriteToFileTool.ts:26) (impl):

```ts
export default {
	type: "function",
	function: {
		name: "write_to_file",
		description: WRITE_TO_FILE_DESCRIPTION, // "...ALWAYS provide the COMPLETE file content... NON-NEGOTIABLE..."
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path:    { type: "string", description: "The path of the file to write to (relative to the current workspace directory)" },
				content: { type: "string", description: "The content to write to the file. ALWAYS provide the COMPLETE intended content..." },
			},
			required: ["path", "content"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

Result: a unified diff message from `diffViewProvider.pushToolWriteResult()` (wraps diff creation — this is the VS Code-coupled part), or a `formatResponse` status string on denial.

**execute_command** — [`native-tools/execute_command.ts`](../../zoo-code/src/core/prompts/tools/native-tools/execute_command.ts:28) (schema) / [`tools/ExecuteCommandTool.ts`](../../zoo-code/src/core/tools/ExecuteCommandTool.ts:72) (impl, 712 lines — most VS-Code-coupled tool, uses terminal/shell integration; note `process.env.ROO_CLI_RUNTIME === "1"` special-casing at line 69):

```ts
export default {
	type: "function",
	function: {
		name: "execute_command",
		description: EXECUTE_COMMAND_DESCRIPTION, // "Request to execute a CLI command on the system..."
		strict: true,
		parameters: {
			type: "object",
			properties: {
				command: { type: "string", description: "Shell command to execute" },
				cwd:     { type: ["string", "null"], description: "Optional working directory for the command, relative or absolute" },
				timeout: { type: ["number", "null"], description: "Timeout in seconds..." },
			},
			required: ["command", "cwd", "timeout"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

Result: command stdout/exit code string (truncated to preview size), or error JSON via `formatResponse.toolError()`.

**list_files** — [`native-tools/list_files.ts`](../../zoo-code/src/core/prompts/tools/native-tools/list_files.ts:19) (schema) / [`tools/ListFilesTool.ts`](../../zoo-code/src/core/tools/ListFilesTool.ts:19) (impl):

```ts
export default {
	type: "function",
	function: {
		name: "list_files",
		description: LIST_FILES_DESCRIPTION, // "Request to list files and directories within the specified directory..."
		strict: true,
		parameters: {
			type: "object",
			properties: {
				path:      { type: "string", description: "Directory path to inspect, relative to the workspace" },
				recursive: { type: "boolean", description: "Set true to list contents recursively; false to show only the top level" },
			},
			required: ["path", "recursive"],
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool
```

Result: sorted file listing (dirs first, numeric-aware) via `formatResponse.formatFilesList()` (`responses.ts:117`), with `(File list truncated. Use list_files on specific subdirectories...)` when hitting the 200-file limit, and `🔒`/`🛡️` markers for ignored/protected files.

---

## 6. Mode / rules loading

**Confirmed: it is essentially "read files, splice into prompt"**, with only modest extra logic (directory discovery order, symlink handling, cache-file filtering, fallback to legacy filenames).

### `.roomodes` (custom modes)

[`src/core/config/CustomModesManager.ts`](../../zoo-code/src/core/config/CustomModesManager.ts:47):

- Reads `<workspace>/.roomodes` (YAML; JSON fallback) via `loadModesFromFile()` → `parseYamlSafely()` (strips BOM, cleans invisible chars) → validates with zod `customModesSettingsSchema` (from `@roo-code/types`) → returns `ModeConfig[]`.
- Merges project modes (`.roomodes`, precedence) with global modes (settings file `~/.roo/...`) in `mergeCustomModes()`.
- Uses `vscode.workspace.createFileSystemWatcher` to watch both files and reload (VS Code-coupled; optional for headless).
- Key: the .roomodes YAML shape is `{ customModes: [ ModeConfig... ] }` where each `ModeConfig` is the same zod schema as built-ins. `getCustomModes()` is what the harness needs; the watcher/globalState parts are GUI-only.

### Rules splicing into the prompt

[`src/core/prompts/sections/custom-instructions.ts`](../../zoo-code/src/core/prompts/sections/custom-instructions.ts:393) — `addCustomInstructions()` is the splice point. In order:

1. **Mode-specific rules:** for each `.roo` dir (global `~/.roo` then project `<cwd>/.roo`; plus subfolders if enabled), read every file under `.roo/rules-<mode>/` → `# Rules from <relpath>:\n<content>` blocks. Fallback: `.roorules-<mode>` / `.clinerules-<mode>`.
2. Language preference line.
3. `Global Instructions:` + `Mode-specific Instructions:` (from customInstructions).
4. `.rooignore` instructions.
5. **AGENTS.md:** root `AGENTS.md`/`AGENT.md` (+ `AGENTS.local.md`), and subdirectories when subfolder rules enabled.
6. **Generic rules:** `.roo/rules/` directory (all files), fallback `.roorules` / `.clinerules`.

All under a `====\nUSER'S CUSTOM INSTRUCTIONS\n...` header. Directory discovery comes from `services/roo-config/index.ts` (`getGlobalRooDirectory()` → `os.homedir()/.roo`, `getProjectRooDirectoryForCwd(cwd)` → `<cwd>/.roo`, `discoverSubfolderRooDirectories`, `getAgentsDirectoriesForCwd`). Rule file scanning (`services/rules/rules.ts`) filters cache/system files (`.DS_Store`, `.pyc`, `*.log`, etc.) and validates filenames against `/^[a-z0-9_-]+(?:\.md)?$/`.

**Consequence for the harness:** reading the exact same `.roomodes` + `.roo/rules-<slug>/` + `.roo/rules/` files this repo's project already uses is a small, pure-fs, ~200-line port. No new config format needed. (`services/rules/rules.ts` is 409 lines but most of it is CRUD + path-traversal guards; the splice path only needs the scan+format pieces.)

---

## 7. Orchestration loop

### Where it lives

- **Entry/outer loop:** [`Task.ts`](../../zoo-code/src/core/task/Task.ts:2464) `initiateTaskLoop()` → `while (!this.abort) { didEndLoop = await this.recursivelyMakeClineRequests(nextUserContent, includeFileDetails) }`; if the model used no tools, it re-injects `formatResponse.noToolsUsed()` and continues.
- **Request cycle:** `recursivelyMakeClineRequests()` (a stack-based loop, lines 2489–3756) → `attemptApiRequest()` (line 4028) → `this.api.createMessage(systemPrompt, cleanConversationHistory, metadata)`.
- **Stream consumption:** chunks of type `reasoning | usage | grounding | tool_call_partial | tool_call | text` (lines 2822–3031).
- **Tool execution:** `presentAssistantMessage()` in `src/core/assistant-message/presentAssistantMessage.ts` dispatches each `tool_use` block to the matching `BaseTool` subclass via a big `switch (block.name)` and awaits sequentially.

### Tool-call parsing — OpenAI-style JSON function calling (NOT XML)

- Prompt explicitly says: "Use the provider-native tool-calling mechanism. Do not include XML markup."
- [`NativeToolCallParser.ts`](../../zoo-code/src/core/assistant-message/NativeToolCallParser.ts:671) `parseToolCall({ id, name, arguments })` does `JSON.parse(toolCall.arguments)` → validates name against `toolNames` (+ custom registry) → per-tool typed `nativeArgs` construction (coercing numbers/booleans, converting legacy `read_file` `files` format) → returns `ToolUse`. Throws if a core tool got no valid args (`Invalid arguments for tool 'X'...`), which surfaces as `formatResponse.toolError`.
- Streaming uses `partial-json` (`parseJSON`) to extract partial args during `tool_call_delta` chunks, then finalizes on `tool_call_end`.
- Unknown tool names → `parseToolCall` returns `null` (logged, dropped). XML-style tool use is explicitly rejected in `BaseTool.handle()` (`"XML tool calls are no longer supported. Use native tool calling (nativeArgs) instead."`).
- MCP tools are called natively as `mcp--serverName--toolName` and parsed into `McpToolUse`.

### Tool results fed back

- Each tool's `execute()` calls `pushToolResult(content)` (from `presentAssistantMessage`). The callback converts content to `{ type: "tool_result", tool_use_id, content, is_error? }` via `Task.pushToolResultToUserContent()` (dedupes by `tool_use_id`), accumulating into `userMessageContent`.
- After the assistant message (with `tool_use` blocks) is saved to `apiConversationHistory`, the accumulated user message with `tool_result` blocks is pushed too (ordering enforced; `flushPendingToolResultsToHistory()` guards the new_task delegation race).
- The next loop iteration sends the user message containing those `tool_result` blocks back to the API. This continues until the model emits `attempt_completion` (which ends the task) or stops using tools (then `noToolsUsed()` nudge).

### Error handling

- Tool execution errors: `handleError(action, error)` in `presentAssistantMessage` → `cline.say("error", ...)` + `pushToolResult(formatResponse.toolError(...))` (JSON `{status:"error", message:"The tool execution failed", error}`).
- Malformed tool call / missing params: `sayAndCreateMissingParamError(tool, param)` increments `consecutiveMistakeCount`; `missingToolParameterError()` reminder text fed back.
- API errors: `attemptApiRequest` is a generator that retries with `retryAttempt+1` (context-window-exceeded path at line 4387, generic error path around 4400–4426); on exhaustion it `throw`s and the outer catch ends the task (`return true`).
- No-assistant-message / no-tools-used: consecutive counters; auto-retry with backoff when `autoApprovalEnabled`, else prompts user (`api_req_failed` ask). `DEFAULT_CONSECUTIVE_MISTAKE_LIMIT = 3` (`packages/types/src/provider-settings.ts:46`). `MAX_REQUESTS_PER_TASK` referenced in comments (line 2475).
- `AskIgnoredError` is an internal control-flow signal silently swallowed.

### History truncation / context management

[`src/core/context-management/index.ts`](../../zoo-code/src/core/context-management/index.ts:291) `manageContext()` (called from `attemptApiRequest` before each request):

1. **Token estimation:** `apiHandler.countTokens()` on the conversation; computes `prevContextTokens = totalTokens + lastMessageTokens`.
2. If `autoCondenseContext` and usage % ≥ threshold → **condensation**: `summarizeConversation()` (in `src/core/condense/`) makes an API call to summarize prior messages (passing tools + environment details), replacing them with a summary. Non-destructive (messages tagged, not deleted).
3. **Fallback sliding-window truncation** (`truncateConversation`, index.ts:93): hides a fraction (0.5) of visible messages by tagging `truncationParent`, keeps the first message, inserts a marker `[Sliding window truncation: N messages hidden to reduce context]`.
4. Consecutive user messages are merged for the API call (`mergeConsecutiveApiMessages`), image blocks may be stripped for models without vision, and a `buildCleanConversationHistory` step runs before `createMessage`.

---

## 8. VS Code coupling assessment + portable-core size estimate

### `vscode.*` usage in the portable-relevant code (grep counts, non-test files)

| Area | Files with `vscode.` | Counts |
|---|---|---|
| `src/core/prompts/` | `system.ts` (3), `sections/modes.ts` (1) | 4 — **all prompt text is vscode-free**; only the builder needs an `ExtensionContext` (for settings/globalState + language) |
| `src/core/tools/` | ExecuteCommandTool (2), NewTaskTool (1), AttemptCompletionTool (1), CodebaseSearchTool (1), GenerateImageTool (1) | 6 — mostly for `vscode.workspace.getConfiguration` settings lookups |
| `src/core/assistant-message/` | none | 0 — parser + dispatcher are pure TS |
| `src/core/task/Task.ts` | 2 | 0 net — loop logic is portable; coupling comes via the `ClineProvider` (webview) object it receives |
| `src/core/context-management/` + `condense/` | none | 0 — truncation/condensing logic is pure |
| `src/core/config/CustomModesManager.ts` | heavy (file watchers, `showErrorMessage`, globalState) | watcher/UI parts GUI-only; parsing/merging portable |

### What is deeply VS Code-coupled (exclude from a clean port)

- `diffViewProvider` (WriteToFile/Edit/ApplyDiff tools use VS Code diff decorations; the *result* of write is "show diff" — headless needs to replace this with plain fs write + unified-diff string)
- `integrations/terminal/` (VS Code terminal + shell integration; `ExecuteCommandTool`'s 712 lines are mostly this) — headless must swap to `child_process`/`execa`
- `webview/` (ClineProvider, message handlers, checkpoints UI)
- `vscode.workspace` file watchers in CustomModesManager, `vscode.env.language`, `getConfiguration`
- `__mocks__/vscode.js` exists for tests

### Portable core (reusable almost verbatim)

| Component | File(s) | LOC (approx) |
|---|---|---|
| Prompt sections + response formatting | `core/prompts/sections/*`, `responses.ts`, `system.ts` (minus context plumbing) | ~1,000 |
| Native tool JSON schemas + converters + filtering | `core/prompts/tools/native-tools/*`, `converters.ts`, `filter-tools-for-mode.ts` | ~2,700 |
| Tool arg types + groups + aliases | `shared/tools.ts` | ~386 |
| Tool-call parser | `core/assistant-message/NativeToolCallParser.ts` | ~1,084 |
| Tool result dispatch harness | `presentAssistantMessage.ts` (switch + pushToolResult + handleError pattern) | ~300 (of 994) |
| Task loop core | `Task.ts` `initiateTaskLoop` + `recursivelyMakeClineRequests` + `attemptApiRequest` (minus webview/state plumbing) | ~1,500 (of 4,796) |
| Context management (truncate + condense) | `core/context-management/index.ts`, `core/condense/` | ~700 |
| Mode config + DEFAULT_MODES | `packages/types/src/mode.ts` | ~260 |
| Rules loading (splice) | `custom-instructions.ts` + `roo-config` + `services/rules/rules.ts` (scan parts) | ~900 |
| **Portable core total** | | **~8,800** |

Non-portable/VS Code-coupled layer: the rest of `src/` (~97,500 LOC total in src excl. tests/i18n), `webview-ui/` (~6,900), plus `apps/cli` (~12,500) and `vscode-shim` (~4,500) — i.e. ~115k+ LOC of GUI/extension machinery that a headless harness does not need.

### ⭐ Major finding: a headless CLI already exists in-tree

**`apps/cli/` (~12.5k LOC) + `packages/vscode-shim/` (~4.5k LOC) already run the full Roo Code agent headlessly from a terminal, with no VS Code.** Highlights from `apps/cli/README.md` and source:

- `roo "prompt" -w <workspace>` runs the agent in TUI mode; **`--print`** runs non-interactively and prints the result; **`--stdin-prompt-stream`** accepts NDJSON control commands over stdin (programmatic, multi-prompt, one process); **`--oneshot`** exits on completion; **`--ephemeral`** avoids persisted state.
- Providers include **`openrouter`** (default), anthropic, openai-native, gemini, vercel-ai-gateway — the exact provider the parent project plan wants for Phase 1. Default model `anthropic/claude-opus-4.6`, `--mode` selects starting mode, `--terminal-shell` for command execution, `--consecutive-mistake-limit`, `--require-approval`, `--output-format text|json|stream-json`.
- Architecture: `ExtensionHost` (`apps/cli/src/agent/extension-host.ts`) creates a VSCode API mock via `@roo-code/vscode-shim` (`createVSCodeAPI`), intercepts `require('vscode')`, loads the bundled extension, and drives it through `webviewMessage`/`extensionWebviewMessage` events. `ExtensionClient` is the single source of truth for agent state (`detectAgentState()`: RUNNING/STREAMING/WAITING_FOR_INPUT/IDLE/RESUMABLE); `AskDispatcher` auto-approves tools/commands by default (non-interactive), with `--require-approval` opt-in; `OutputManager` streams output to stdout; `AGENT_LOOP.md` documents the whole state machine.
- `ROO_CLI_RUNTIME === "1"` env var (set by the CLI) is special-cased in `ExecuteCommandTool.resolveAgentTimeoutMs()` to ignore model-specified background timeouts — evidence the extension is explicitly engineered to run under this CLI.

This materially changes the Phase 1 decision space: **the project may not need to reimplement the loop at all** — the shipped CLI is Apache-2.0 and headless already. It is, however, "the extension under a shim" (still boots the whole extension + webview provider machinery), whereas the parent project plan explicitly asks for a small purpose-built harness that reuses prompts/tool schema/rules format. Both options are viable and are weighed below.

---

## 9. Language / Phase 1 recommendation

**Recommendation: Node/TypeScript**, with a strong first sub-option to evaluate reusing the in-tree `apps/cli` directly.

Rationale:

1. **Everything portable is already TypeScript, and Apache-2.0 permits direct reuse** (no clean-room needed). The prompt sections, the 22 OpenAI `ChatCompletionTool` JSON schemas, `NativeToolCallParser`, `NativeToolArgs` type map, mode zod schemas, and rules-splicing functions are ~8.8k LOC that can be copied/imported nearly verbatim. A Python port would have to re-encode every prompt string and every schema (mechanical, error-prone, and it forfeits `packages/types` zod validation for `.roomodes`).
2. **OpenRouter function calling is OpenAI-format** — the exact format these tool schemas use (`strict: true`, `additionalProperties: false`, OpenAI SDK types). The tool-definition language needs no adaptation for the default OpenRouter route; the parent project's "does the tool-definition language need adapting?" open question answers itself: no, use the schemas as-is.
3. **Rules/mode loading is pure fs + yaml + zod** (`custom-instructions.ts`, `services/rules/rules.ts`, `CustomModesManager.loadModesFromFile`, `roo-config`) — small, dependency-light TS that ports to the harness without `vscode.*`.
4. **Python would only win if the team wanted zero TS tooling.** But the team already operates this exact toolchain in this repo, and the reuse argument (zod schemas, types, prompts, parser) is decisive for correctness parity.
5. **Sub-option A (least effort): drive the shipped CLI.** `apps/cli` with `--print --stdin-prompt-stream --output-format stream-json --oneshot --mode <slug>` is already a non-interactive, auto-approving, OpenRouter-capable harness with `.roomodes`/rules support (it runs the real extension). Phase 1 could be "validate the shipped CLI on issue #29/#38" before writing any harness code. Risks: it drags in the full extension bundle (heavier than a purpose-built loop), its tool execution still routes through the terminal-integration/diffView machinery under the shim, and upstream changes could shift it. It is the correct *validation* step but not the "small purpose-built harness" the plan describes.
6. **Sub-option B (matches the plan): build the small Node harness, reusing the portable core.** Copy/import: prompt sections + responses.ts, `native-tools/*` schemas + converters, `NativeToolCallParser`, `shared/tools.ts` types/groups/aliases, `packages/types` mode/tool zod schemas, rules-splicing from `custom-instructions.ts` (+ `roo-config` + `services/rules/rules.ts` scan), and the `initiateTaskLoop`/`attemptApiRequest`/context-management logic adapted to `fs`/`child_process` and an OpenRouter client. Replace: `diffViewProvider` (write = plain fs + unified-diff string via `formatResponse.createPrettyPatch`), terminal integration (execa), webview/ClineProvider (stdout/stderr + JSON event log), file watchers (poll or drop). Estimated effort: low-person-weeks for the 4 minimum tools (read_file, write_to_file, execute_command, list_files); medium for full tool parity.

### Bottom line for Phase 1

- **License:** Apache-2.0 — direct reuse of prompts/schemas permitted.
- **Tool-call protocol:** OpenAI-style JSON function calling (no XML); schemas are already OpenAI `ChatCompletionTool` with `strict: true` — OpenRouter-compatible as-is.
- **Mode/rules:** confirmed "read files + splice"; `.roomodes` is `customModes:` YAML validated by zod; rules live in `.roo/rules/` and `.roo/rules-<slug>/` (plus AGENTS.md fallbacks).
- **Portable core ≈ 8.8k LOC** of TS; VS Code-coupled machinery ≈ 115k+ LOC that can be excluded.
- **Recommendation:** Node/TypeScript. First validate the in-tree `apps/cli --print --stdin-prompt-stream` against a real issue; then (if the small-harness direction is retained) build the harness by directly reusing the portable TS core with `fs`/`subprocess`/OpenRouter replacements for the GUI-coupled seams.
