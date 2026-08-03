/**
 * System prompt construction for the headless harness.
 *
 * Wraps the vendored Zoo Code prompt builder (`SYSTEM_PROMPT` in
 * `src/vendor/zoo-code/src/core/prompts/system.ts`) with:
 *
 *  1. A headless `ExtensionContext` stand-in (the vendored builder only reads
 *     `globalState` for custom modes when building the MODES section).
 *  2. Project `.roomodes` loading from the workspace root (same zod schema the
 *     vendored `CustomModesManager` uses; the manager itself can't see the
 *     project dir because the headless `vscode` shim reports no workspace
 *     folders, so we load the file directly with `customModesSettingsSchema`).
 *  3. Tool selection: the vendored `SYSTEM_PROMPT` does NOT embed a tool
 *     catalog — tools are passed to the API separately. We filter
 *     `getNativeTools()` down to the tools the Phase 1 executor actually
 *     registers (read_file, write_to_file, execute_command, list_files,
 *     attempt_completion, ask_followup_question), intersected with the mode's
 *     allowed tool groups (via the vendored `getToolsForMode` helper).
 *
 * Note: `.roo/rules-<mode>/`, `.roo/rules/`, and AGENTS.md splicing happens
 * inside the vendored `SYSTEM_PROMPT` → `addCustomInstructions()`; we only
 * need to pass the workspace root as `cwd` plus the mode slug.
 */

import * as path from "node:path"
import * as os from "node:os"
import * as fsp from "node:fs/promises"
import * as yaml from "yaml"

// Side effect: installs String.prototype.toPosix() used by the prompt sections.
import "../vendor/zoo-code/src/utils/path.js"

import type { ExtensionContext } from "vscode"
import { SYSTEM_PROMPT } from "../vendor/zoo-code/src/core/prompts/system.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import { getGroupName, getModeBySlug, modes, getToolsForMode } from "../vendor/zoo-code/src/shared/modes.js"
import { TOOL_GROUPS } from "../vendor/zoo-code/src/shared/tools.js"
import { customModesSettingsSchema } from "../vendor/zoo-code/types/index.js"
import { browserActionTool } from "../tools/browser/tool.js"
import { describeImageTool } from "../vision/tool.js"
import { CODE_INTEL_TOOLS } from "../codeintel/tools.js"
import type { ModeConfig } from "@roo-code/types"

import type { ChatTool } from "./types.js"

export interface BuildSystemPromptOptions {
	workspaceRoot: string
	mode: string
	customModes?: ModeConfig[]
	globalCustomInstructions?: string
}

export interface BuiltPrompt {
	prompt: string
	modeConfig: ModeConfig
	customModes: ModeConfig[]
}

/**
 * The vendored tools the executor actually implements/registers. Used as the
 * final gate when filtering `getNativeTools()` in selectToolsForMode. Two
 * non-vendored tool sets are NOT in here because they never appear in
 * getNativeTools(): browser_action and the four code-intelligence tools
 * (outline / go_to_definition / find_references / import_graph) — callers
 * append those explicitly via appendBrowserActionTool / appendCodeIntelTools.
 */
export const EXECUTABLE_TOOL_NAMES = new Set([
	"read_file",
	"write_to_file",
	"apply_diff",
	"search_replace",
	"edit_file",
	"execute_command",
	"list_files",
	"codebase_search",
	"attempt_completion",
	"ask_followup_question",
	// The structured-planning aid (see src/vendor/zoo-code/.../update_todo_list.ts).
	// Vendored ALWAYS_AVAILABLE_TOOLS already includes it for every mode's
	// allowedNames; this is the final gate that makes it executable/advertised.
	"update_todo_list",
	// Recursive task decomposition: vendored modes' ALWAYS_AVAILABLE_TOOLS
	// already includes new_task for every mode (shared/tools.ts); this is the
	// final gate that makes it executable/advertised now that HeadlessSession
	// implements the handler (see src/engine/loop.ts).
	"new_task",
	// switch_mode (plans/switch-mode-headless.md): vendored modes'
	// ALWAYS_AVAILABLE_TOOLS already includes switch_mode for every mode
	// (shared/tools.ts, same as new_task); this is the final gate that makes
	// it executable/advertised now that HeadlessSession implements the
	// handler. NOTE: read-only executors (reviewer/QA/local explore) still
	// stub it — their tool lists never advertise it either (see the scope
	// boundary in plans/switch-mode-headless.md).
	"switch_mode",
])

// ─── custom modes loading (project .roomodes + global ~/.roo/custom_modes.yaml) ──

const PROBLEMATIC_CHARS_REGEX =
	// eslint-disable-next-line no-misleading-character-class
	/[\u00A0\u200B\u200C\u200D\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u2018\u2019\u201C\u201D]/g

function cleanInvisibleCharacters(content: string): string {
	return content.replace(PROBLEMATIC_CHARS_REGEX, (match) => {
		switch (match) {
			case "\u00A0":
				return " "
			case "\u200B":
			case "\u200C":
			case "\u200D":
				return ""
			case "\u2018":
			case "\u2019":
				return "'"
			case "\u201C":
			case "\u201D":
				return '"'
			default:
				return "-"
		}
	})
}

/**
 * Parse + validate a custom-modes settings file (YAML, JSON fallback), mirroring
 * the vendored `CustomModesManager.loadModesFromFile` behaviour. Non-fatal:
 * a missing file returns [], a malformed/unparseable file logs an error and
 * returns [] (never throws). Used for both the project `.roomodes` and the
 * global `~/.roo/custom_modes.yaml`.
 *
 * @param filePath absolute path of the modes file to read
 * @param source   "project" for `.roomodes`, "global" for `custom_modes.yaml`
 */
async function loadModesFromFile(filePath: string, source: "project" | "global"): Promise<ModeConfig[]> {
	let raw: string
	try {
		raw = await fsp.readFile(filePath, "utf-8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}

	// Strip BOM, then clean invisible/problematic chars exactly like vendored.
	let cleaned = raw.replace(/^\uFEFF/, "")
	cleaned = cleanInvisibleCharacters(cleaned)

	let parsed: unknown
	try {
		parsed = yaml.parse(cleaned) ?? {}
	} catch (yamlError) {
		// JSON fallback for .roomodes.
		try {
			parsed = JSON.parse(raw) ?? {}
		} catch {
			console.error(`[headlesscode] Failed to parse ${path.basename(filePath)} at ${filePath}: ${String(yamlError)}`)
			return []
		}
	}

	if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { customModes?: unknown }).customModes)) {
		return []
	}

	const result = customModesSettingsSchema.safeParse(parsed)
	if (!result.success) {
		const issues = result.error.issues
			.map((issue) => `• ${issue.path.join(".")}: ${issue.message}`)
			.join("\n")
		console.error(`[headlesscode] ${path.basename(filePath)} schema validation failed at ${filePath}:\n${issues}`)
		return []
	}

	return result.data.customModes.map((mode) => ({ ...mode, source }))
}

/**
 * Load the merged set of custom modes for a workspace: the project's own
 * `.roomodes` first (project wins on slug collision), then the global
 * `~/.roo/custom_modes.yaml` for any slug the project does NOT define —
 * the same precedence model as the vendored
 * `CustomModesManager.mergeCustomModes`. A missing or malformed global file
 * degrades exactly like a missing/malformed `.roomodes` (returns [] for that
 * source, logs, never throws).
 */
export async function loadCustomModes(workspaceRoot: string): Promise<ModeConfig[]> {
	const projectModes = await loadModesFromFile(path.join(workspaceRoot, ".roomodes"), "project")
	const globalModes = await loadModesFromFile(path.join(os.homedir(), ".roo", "custom_modes.yaml"), "global")

	const slugs = new Set<string>()
	const merged: ModeConfig[] = []

	// Project modes first — they take precedence over same-slug global modes.
	for (const mode of projectModes) {
		if (!slugs.has(mode.slug)) {
			slugs.add(mode.slug)
			merged.push(mode)
		}
	}

	// Global modes fill in everything the project does not define.
	for (const mode of globalModes) {
		if (!slugs.has(mode.slug)) {
			slugs.add(mode.slug)
			merged.push(mode)
		}
	}

	return merged
}

// ─── Context stand-in ────────────────────────────────────────────────────────

/**
 * Minimal `vscode.ExtensionContext` stand-in for the vendored builder. The
 * builder only reads `globalState.get("customModes")` (MODES section) and
 * `vscode.env.language` (from the shim). Everything else is unused headlessly.
 */
export function createHeadlessContext(customModes: ModeConfig[]): ExtensionContext {
	const state = new Map<string, unknown>([["customModes", customModes]])
	return {
		globalState: {
			get: async <T>(key: string): Promise<T | undefined> => state.get(key) as T | undefined,
			update: async (key: string, value: unknown): Promise<void> => {
				state.set(key, value)
			},
		},
		globalStorageUri: { fsPath: process.cwd() },
		subscriptions: [],
	} as unknown as ExtensionContext
}

// ─── Prompt builder ──────────────────────────────────────────────────────────

/**
 * Build the system prompt for a mode using the vendored builder.
 *
 * @param options.workspaceRoot  project root used as `cwd` (rules discovery)
 * @param options.mode           mode slug (built-in or from .roomodes)
 * @param options.customModes    pre-loaded custom modes (default: load from .roomodes)
 * @param options.globalCustomInstructions  optional global instructions text
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<BuiltPrompt> {
	const { workspaceRoot, mode, globalCustomInstructions } = options
	const customModes = options.customModes ?? (await loadCustomModes(workspaceRoot))

	const modeConfig =
		getModeBySlug(mode, customModes) ?? modes.find((m) => m.slug === mode) ?? modes[0]

	const context = createHeadlessContext(customModes)

	// settings: disable the todo list prompt & subfolder rules (Phase 1 keeps it
	// simple); keep useAgentRules on so AGENTS.md/rules files are honored.
	const settings = {
		todoListEnabled: false,
		useAgentRules: true,
		enableSubfolderRules: false,
		newTaskRequireTodos: false,
	}

	const prompt = await SYSTEM_PROMPT(
		context,
		workspaceRoot,
		false, // supportsComputerUse
		undefined, // mcpHub
		undefined, // diffStrategy
		modeConfig.slug,
		undefined, // customModePrompts
		customModes,
		globalCustomInstructions,
		undefined, // experiments
		undefined, // language (shim default "en")
		undefined, // rooIgnoreInstructions
		settings,
	)

	return { prompt, modeConfig, customModes }
}

// ─── Tool selection ──────────────────────────────────────────────────────────

/**
 * Select the OpenAI-format tool schemas to expose to the model for a mode.
 *
 * Decision (Phase 1): intersect the mode's allowed tools (vendored
 * `getToolsForMode(modeConfig.groups)` — group tools + ALWAYS_AVAILABLE_TOOLS)
 * with the tools the executor actually registers
 * (`EXECUTABLE_TOOL_NAMES`). Stub-only tools (apply_diff, search_files, …) are
 * NOT advertised to the model, so it doesn't waste turns calling unimplemented
 * tools; they remain registered in the executor purely as a safety net.
 *
 * NOTE (browser_action): this tool is NOT part of the vendored tool set, so
 * it can't be selected here — callers append it explicitly via
 * appendBrowserActionTool (see below).
 */
export function selectToolsForMode(mode: string, customModes: ModeConfig[] = []): ChatTool[] {
	const modeConfig = getModeBySlug(mode, customModes) ?? modes.find((m) => m.slug === mode) ?? modes[0]
	const allowedNames = new Set(getToolsForMode(modeConfig.groups))

	// The vendored `getToolsForMode` only includes a group's standard `tools`,
	// not its opt-in `customTools` (e.g. `search_replace` / `edit_file` in the
	// `edit` group — in VS Code they're enabled via a settings checkbox).
	// Headless has no UI to opt in, so we surface a group's customTools too —
	// BUT only those the executor actually implements (the EXECUTABLE_TOOL_NAMES
	// intersection below is still the final gate), so a stub like `edit` or
	// `apply_patch` never leaks to the model.
	for (const group of modeConfig.groups) {
		const groupName = getGroupName(group)
		const customTools = TOOL_GROUPS[groupName]?.customTools ?? []
		for (const customName of customTools) {
			allowedNames.add(customName)
		}
	}

	const nativeTools = getNativeTools()
	const selected: ChatTool[] = []

	for (const tool of nativeTools) {
		if (tool.type !== "function") {
			continue
		}
		const name = tool.function.name
		if (allowedNames.has(name) && EXECUTABLE_TOOL_NAMES.has(name)) {
			selected.push(tool as unknown as ChatTool)
		}
	}

	return selected
}

/**
	* Append the `browser_action` tool schema to a tool list if it isn't already
	* present. `browser_action` is NOT a vendored Zoo Code tool (it's new work —
	* see src/tools/browser/tool.ts), so it never appears in getNativeTools() and
	* selectToolsForMode() can't pick it up; callers that want the model to be
	* able to launch a browser (headless + QA sessions) append it explicitly.
	* Appending rather than replacing keeps the mode's own tool filtering intact.
	*/
export function appendBrowserActionTool(tools: ChatTool[]): ChatTool[] {
	if (tools.some((t) => t.type === "function" && t.function.name === browserActionTool.function.name)) {
		return tools
	}
	return [...tools, browserActionTool as unknown as ChatTool]
}

/**
 * Append the describe_image tool schema (cloud vision captioning — see
 * src/vision/) to a tool list if it isn't already present. Like
 * browser_action, it is a NEW tool with no vendored Zoo Code upstream, so
 * selectToolsForMode can't pick it up from getNativeTools(); callers that
 * want the model to inspect images append it explicitly. Only wired where a
 * real accounting session exists (onAuxLlmUsage) — read-only reviewer/QA
 * executors deliberately don't advertise it (their executors don't register
 * the handler, and calls there would be untracked spend).
 */
export function appendDescribeImageTool(tools: ChatTool[]): ChatTool[] {
	if (tools.some((t) => t.type === "function" && t.function.name === describeImageTool.function.name)) {
		return tools
	}
	return [...tools, describeImageTool as unknown as ChatTool]
}

/**
 * Append the four code-intelligence tool schemas (outline, go_to_definition,
 * find_references, import_graph) to a tool list if they aren't already
 * present. Like browser_action, these are NEW tools with no vendored Zoo Code
 * upstream (see src/codeintel/tools.ts), so selectToolsForMode can't pick
 * them up from getNativeTools(); callers that want the model to navigate
 * source code append them explicitly. Read-only, so they are appended for
 * every mode including the reviewer/QA executors.
 */
export function appendCodeIntelTools(tools: ChatTool[]): ChatTool[] {
	const present = new Set(
		tools.filter((t) => t.type === "function").map((t) => (t.function as { name: string }).name),
	)
	const missing = CODE_INTEL_TOOLS.filter((t) => t.type === "function" && !present.has(t.function.name))
	if (missing.length === 0) {
		return tools
	}
	return [...tools, ...(missing as unknown as ChatTool[])]
}
