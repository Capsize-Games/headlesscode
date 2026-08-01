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
import * as fsp from "node:fs/promises"
import * as yaml from "yaml"

// Side effect: installs String.prototype.toPosix() used by the prompt sections.
import "../vendor/zoo-code/src/utils/path.js"

import type { ExtensionContext } from "vscode"
import { SYSTEM_PROMPT } from "../vendor/zoo-code/src/core/prompts/system.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import { getModeBySlug, modes, getToolsForMode } from "../vendor/zoo-code/src/shared/modes.js"
import { customModesSettingsSchema } from "../vendor/zoo-code/types/index.js"
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

/** The tools the Phase 1 executor actually implements/registers. */
export const EXECUTABLE_TOOL_NAMES = new Set([
	"read_file",
	"write_to_file",
	"execute_command",
	"list_files",
	"attempt_completion",
	"ask_followup_question",
])

// ─── .roomodes loading ───────────────────────────────────────────────────────

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
 * Load and validate `<workspaceRoot>/.roomodes` (YAML, JSON fallback), mirroring
 * the vendored `CustomModesManager.loadModesFromFile` behaviour but reading from
 * the headless workspace root directly. Returns [] when no file exists.
 */
export async function loadCustomModes(workspaceRoot: string): Promise<ModeConfig[]> {
	const roomodesPath = path.join(workspaceRoot, ".roomodes")
	let raw: string
	try {
		raw = await fsp.readFile(roomodesPath, "utf-8")
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
			console.error(`[headlesscode] Failed to parse .roomodes at ${roomodesPath}: ${String(yamlError)}`)
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
		console.error(`[headlesscode] .roomodes schema validation failed at ${roomodesPath}:\n${issues}`)
		return []
	}

	return result.data.customModes.map((mode) => ({ ...mode, source: "project" as const }))
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
 */
export function selectToolsForMode(mode: string, customModes: ModeConfig[] = []): ChatTool[] {
	const modeConfig = getModeBySlug(mode, customModes) ?? modes.find((m) => m.slug === mode) ?? modes[0]
	const allowedNames = new Set(getToolsForMode(modeConfig.groups))

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
