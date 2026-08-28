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
 * need to pass the workspace root as `cwd` plus the mode slug. Stack-specific
 * rules (src/engine/stacks.ts) are spliced HERE, after the vendored build —
 * the vendored prompt sections have no hook for them.
 */

import * as path from "node:path"
import * as fsp from "node:fs/promises"
import * as yaml from "yaml"

import { ensureSharedInstructionsMigration, sharedInstructionsRoot } from "../project-store.js"

// Side effect: installs String.prototype.toPosix() used by the prompt sections.
import "../vendor/zoo-code/src/utils/path.js"

import type { ExtensionContext } from "../vendor/zoo-code/shim/vscode.js"
import { SYSTEM_PROMPT } from "../vendor/zoo-code/src/core/prompts/system.js"
import { addCustomInstructions } from "../vendor/zoo-code/src/core/prompts/sections/custom-instructions.js"
import { getSystemInfoSection } from "../vendor/zoo-code/src/core/prompts/sections/system-info.js"
import { getNativeTools } from "../vendor/zoo-code/src/core/prompts/tools/native-tools/index.js"
import { getGroupName, getModeBySlug, modes, getToolsForMode } from "../vendor/zoo-code/src/shared/modes.js"
import { TOOL_GROUPS } from "../vendor/zoo-code/src/shared/tools.js"
import { customModesSettingsSchema } from "../vendor/zoo-code/types/index.js"
import { browserActionTool } from "../tools/browser/tool.js"
import { describeImageTool } from "../vision/tool.js"
import { runTestsTool } from "../tools/run-tests.js"
import { setIndentationTool } from "../tools/set-indentation-tool.js"
import { CODE_INTEL_TOOLS, RENAME_SYMBOL_TOOL } from "../codeintel/tools.js"
import type { ModeConfig } from "../vendor/zoo-code/types/index.js"

import { appendStackRulesSection, loadStackRules } from "./stacks.js"
import type { ChatTool } from "./types.js"

/** Opt-in gate for buildLeanSystemPrompt — see its doc comment. Default OFF. */
export const LEAN_SYSTEM_PROMPT_ENV = "HEADLESSCODE_LEAN_SYSTEM_PROMPT"

export function isLeanSystemPromptEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[LEAN_SYSTEM_PROMPT_ENV]
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

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

/**
 * True when a mode's tool groups include the `edit` group — i.e. the mode is
 * expected to modify files (code, architect, …) as opposed to read-only
 * investigation/review roles. Uses the SAME group classification the vendored
 * prompt builder uses for MCP (`getGroupName(group) === "mcp"` in
 * src/vendor/zoo-code/src/core/prompts/system.ts), so custom modes from
 * .roomodes are classified exactly like the built-ins instead of by a
 * hand-maintained slug list. Used to scope edit-workflow guidance (commit
 * before finishing, targeted test runs) to modes that can actually edit.
 */
export function modeHasEditGroup(mode: string, customModes: ModeConfig[] = []): boolean {
	const modeConfig = getModeBySlug(mode, customModes) ?? modes.find((m) => m.slug === mode)
	if (modeConfig === undefined) {
		return false
	}
	return modeConfig.groups.some((group) => getGroupName(group) === "edit")
}

// ─── custom modes loading (project .roomodes + global shared modes.yaml) ─────
// The GLOBAL modes file lives at ~/.local/share/headlesscode/shared/modes.yaml
// (headlesscode-native location — src/project-store.ts) instead of the
// Zoo-Code-branded ~/.roo/custom_modes.yaml. The file FORMAT (YAML, schema)
// and the merge semantics are unchanged; only the lookup path moved.

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
 * @param source   "project" for `.roomodes`, "global" for `modes.yaml`
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
 * `.roomodes` first (project wins on slug collision), then the GLOBAL shared
 * modes file — `~/.local/share/headlesscode/shared/modes.yaml` (see
 * src/project-store.ts; the one-time ~/.roo/ migration is triggered here on
 * first use) — for any slug the project does NOT define. Same precedence
 * model as the vendored `CustomModesManager.mergeCustomModes`. A missing or
 * malformed global file degrades exactly like a missing/malformed `.roomodes`
 * (returns [] for that source, logs, never throws).
 */
export async function loadCustomModes(workspaceRoot: string): Promise<ModeConfig[]> {
	ensureSharedInstructionsMigration()
	const projectModes = await loadModesFromFile(path.join(workspaceRoot, ".roomodes"), "project")
	const globalModes = await loadModesFromFile(path.join(sharedInstructionsRoot(), "modes.yaml"), "global")

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

	// Stack-specific rules (src/engine/stacks.ts): appended as a clearly
	// delimited section only when a detected stack actually has rules content
	// — zero stacks / no rules.md keeps the prompt byte-identical.
	const stackRules = await loadStackRules(workspaceRoot)
	const withStackRules = stackRules.content
		? appendStackRulesSection(prompt, stackRules.content, stackRules.stacks)
		: prompt

	// Headless harness workflow conventions, appended AFTER the vendored
	// builder's output (which is vendored code and must not be edited in
	// place). These are harness-level expectations that live outside any
	// single rules file: committing real work before finishing, running the
	// targeted test file(s) during the iterative edit-check loop, and
	// batching same-file diffs into one apply_diff. Edit-workflow guidance
	// only applies to modes that can actually edit files (modeHasEditGroup);
	// read-only reviewer/QA roles never see it.
	const conventions = buildHeadlessConventions(modeConfig.slug, customModes)
	const fullPrompt = conventions === undefined ? withStackRules : `${withStackRules}\n${conventions}`

	return { prompt: fullPrompt, modeConfig, customModes }
}

/**
 * A minimal alternative to buildSystemPrompt for small-context local models
 * (opt-in — see HEADLESSCODE_LEAN_SYSTEM_PROMPT in loop.ts). The vendored
 * SYSTEM_PROMPT (~9.5K tokens measured live 2026-08-19 for headlesscode's
 * own `code` mode) is GUI-oriented: a full modes-listing section, generic
 * tool-use-guidelines prose, and a capabilities section describing VS
 * Code-only features — all irrelevant to a native-tool-calling headless
 * session and a severe cost against a ~24K-token local context budget.
 *
 * This does NOT edit or reimplement the vendored prompt; it composes the
 * SAME exported section builders `buildSystemPrompt` uses, minus the
 * GUI-oriented ones (markdownFormattingSection, getSharedToolUseSection,
 * getToolUseGuidelinesSection, getCapabilitiesSection, getModesSection,
 * getSkillsSection). Critically, addCustomInstructions (this project's own
 * `.roo/rules/`, `.roo/rules-<mode>/`, AGENTS.md) is KEPT — that content is
 * project-specific behavioral guidance, not boilerplate, and dropping it
 * would silently change what the model is told it must/must not do.
 */
export async function buildLeanSystemPrompt(options: BuildSystemPromptOptions): Promise<BuiltPrompt> {
	const { workspaceRoot, mode, globalCustomInstructions } = options
	const customModes = options.customModes ?? (await loadCustomModes(workspaceRoot))
	const modeConfig =
		getModeBySlug(mode, customModes) ?? modes.find((m) => m.slug === mode) ?? modes[0]

	// Strengthened 2026-08-19 after a live failure: Qwen2.5-Coder-14B
	// reasoned correctly about which tool to call, then wrote
	// `{"name": "edit_file", "arguments": {...}}` as PROSE TEXT (sometimes
	// in a ```json fence) instead of issuing a real tool_calls entry — the
	// harness now has a best-effort recovery for this specific shape (see
	// extractEmbeddedToolCall in parser.ts), but recovery only fires for a
	// name that matches a real tool and is not a substitute for calling
	// correctly the first time: it costs a wasted turn, and anything that
	// doesn't match a known tool name gets no recovery at all.
	const toolUseNote =
		"Tool calls are native — call a tool directly through the tool-calling " +
		"mechanism, never describe an action in prose instead of calling it. " +
		"Concretely: if your response's text content contains something that " +
		"LOOKS like a tool call — a JSON object with \"name\" and \"arguments\" " +
		"keys, with or without a ```json fence — that is a MISTAKE, not a way " +
		"to invoke a tool. It will not run. Writing out what a tool call would " +
		"look like is never itself progress; only an actual tool_calls entry " +
		"executes anything. Never fabricate file contents or command output " +
		"you have not actually seen."
	// Verified live 2026-08-27: a local session correctly diagnosed a fix in
	// its own reasoning text ("the error message says X, which means it's
	// expecting Y instead") — genuinely correct — and then, instead of
	// calling edit_file to apply that exact fix, just repeated the same
	// diagnosis as plain text for 6 consecutive turns until it hit the
	// session's mistake limit and lost the work entirely. In the same
	// transcript, one of those repeats was a text-only tool call for a tool
	// that was on a short cooldown from an earlier repeated call — a
	// different, uncooled tool (edit_file) was available the whole time but
	// never attempted. Reasoning correctly about a fix is not the same as
	// applying it — the moment you know what change to make, make it with a
	// real tool call (edit_file/write_to_file) in that same turn, don't
	// restate the diagnosis first. If your last attempted action didn't run
	// (a tool was blocked, on cooldown, or errored), the fix is to try a
	// DIFFERENT tool that is actually available right now, not to explain
	// the same conclusion again and wait.
	const stalledRetryNote =
		"When you've figured out what change to make, make it immediately with " +
		"a real tool call (edit_file/write_to_file) in the same turn — restating " +
		"your diagnosis in plain text first is not progress and will not retry " +
		"itself. If a tool call didn't go through (blocked, on cooldown, or " +
		"errored), pick a different tool that IS available right now instead of " +
		"repeating the same reasoning or the same blocked call again."
	const verificationNote =
		"Only call attempt_completion after you have verified the change actually " +
		"works (typecheck/tests as applicable) — a plausible-looking but " +
		"unverified change is not done. Call attempt_completion ALONE, never in " +
		"the same turn as other tool calls — a bundled attempt_completion is " +
		"refused and your other calls are wasted."
	// GitHub issue #137: local sessions were observed calling
	// ask_followup_question for routine implementation decisions they
	// should just make themselves, even when the task text explicitly
	// said not to — a per-task instruction alone is not enough, because
	// it competes with whatever baseline tendency this prompt otherwise
	// leaves unaddressed. Stated once, here, so it applies regardless of
	// what any individual task file does or doesn't say.
	const followupQuestionNote =
		"Prefer making a reasonable, reversible decision yourself and stating " +
		"your reasoning over calling ask_followup_question. Reserve that tool " +
		"for choices that are genuinely destructive or ambiguous enough that " +
		"guessing wrong would be costly — not for routine implementation " +
		"decisions you can just make and adjust later if wrong."
	// Replaces the vendored getObjectiveSection() (buildSystemPrompt uses that
	// one): it references an "environment_details" file that does not exist
	// in this headless harness (verified live 2026-08-19 — a local session
	// tried to read_file a literal file named "environment_details" after
	// reading that section) and describes GUI-chat framing ("the user may
	// provide feedback") that does not apply to a one-shot headless task.
	// Also states the one concrete literalism trap that broke a real local
	// session that same night: a tool description's [bracketed] example is a
	// placeholder to replace with a real value, not text to copy verbatim.
	const objectiveNote =
		"Work through the task step by step: read what you need, make the " +
		"edit, then verify it before finishing. There is no separate " +
		"'environment_details' file — file listings and tool results appear " +
		"directly in this conversation as they happen. When a tool's own " +
		"description shows an example value inside [square brackets] (e.g. " +
		"[line_number], [path]), that is a placeholder: replace the WHOLE " +
		"bracketed expression with a real value — never include the literal " +
		"brackets or the word inside them in an actual tool call."

	// Added 2026-08-21 after a live failure pattern reproduced identically
	// across two separate trials: the model completed the FIRST step of a
	// two-step task (edit a file) correctly, then — instead of proceeding to
	// the second step (write the test file) — called list_files repeatedly
	// until the identical-call guardrail ended the session. `update_todo_list`
	// is registered and offered every turn, but the vendored system prompt's
	// todo-list guidance is disabled for this harness (`todoListEnabled:
	// false` in buildSystemPrompt, kept off deliberately — Phase 1 scope, and
	// this note is scoped to local sessions only). A smaller local model
	// plausibly needs the EXTERNAL scaffolding of a written-out plan more
	// than a larger cloud model does, since it has less working "attention"
	// left over after a growing tool-result-heavy context to track what it
	// still needs to do implicitly. Strengthened again same day: a trial
	// wrote its FIRST update_todo_list call with all three steps already
	// marked [x] done, before doing any of the actual work — a premature,
	// theatrical completion-marking pattern that defeats the whole point
	// (it also meant the identical-call nudge's "next pending step" lookup,
	// see identicalCallNudgeMessage in loop.ts, found nothing to point at).
	const planningNote =
		"For any task with more than one concrete step (e.g. edit a file AND write a test for it), call " +
		"update_todo_list ONCE near the start to write out every step as PENDING [ ] — not already checked off; " +
		"you have not done any of it yet at that point. Only mark a step done [x] AFTER you have actually " +
		"performed it and, where applicable, verified it. Then check the list again before deciding what to do " +
		"next: your next action should come from the first step still marked pending, not a fresh look around " +
		"the workspace. If a step fails (a tool error, a failing command), your next action is to read that " +
		"error and address it specifically — not to fall back on list_files or another unrelated exploration call."

	// Added 2026-08-21 after a live failure pattern reproduced across THREE
	// separate trials: asked to write a new test file "following the
	// existing plain-assert test style used elsewhere," the model instead
	// defaulted to generic Jest syntax (describe/test/expect — not used
	// anywhere in this codebase) every time, then got a tsc error pointing
	// at exactly that mismatch. The task text already SAID to match the
	// existing style; the model never actually looked at an existing file
	// to see what that style was before writing its own. (The one trial
	// that recovered did so only after an ask_followup_question forced a
	// human to say "go read an existing file first" explicitly — this note
	// makes that the DEFAULT behavior instead of something that only
	// happens after a wasted round trip.)
	// 2026-08-22 addendum, same failure family: a trial that DID avoid the
	// Jest mistake above still skipped the read_file step entirely and wrote
	// a NEW test file using `console.assert(...)` — plausible-looking (it
	// even has the word "assert" in it), but `console.assert` never throws
	// on failure, so a genuinely wrong implementation (verified live:
	// truncateMiddle producing length 33 instead of the required 30) still
	// printed as a clean pass. Calling out the exact trap by name, since
	// "read an example first" alone did not stop the model from guessing.
	// 2026-08-20 addendum, same failure family, now with the describe/it
	// example promoted from a passing "e.g." to its own explicit trap:
	// despite the "generic default... is not correct" line already above,
	// separate live trials against Qwen3-14B STILL wrote `describe(...)` /
	// `it(...)` test files every time (verified live, repeated across
	// several trials the same day) — the assertion-library part of the
	// note (node:assert vs console.assert) was being followed correctly,
	// but the test-STRUCTURE convention (no test-runner globals at all;
	// flat top-level functions) was not landing from the "e.g." mention
	// alone. tsc's own error for `describe`/`it` suggests installing
	// `@types/jest` or `@types/mocha` — which reads as a legitimate fix
	// to a model that hasn't internalized this project has no test
	// runner, producing an ask_followup_question instead of a self-
	// correction. Naming the concrete pattern by name, same reasoning as
	// the console.assert addendum below: a soft "e.g." was not enough to
	// stop a strong prior toward the generic default.
	const testStructureNote =
		"This codebase has NO test runner (no Jest, no Mocha, no Vitest) — never write `describe(...)`, `it(...)`, " +
		"`test(...)`, or `expect(...)`, and never suggest installing `@types/jest` or `@types/mocha` even if a tsc " +
		"error recommends it; that error means the test file itself is wrong, not that a dependency is missing. " +
		"The real convention is flat top-level functions (e.g. `function testSomething(): void { ... }` or " +
		"`async function testSomething(): Promise<void> { ... }`), each containing plain assert calls, collected " +
		"into an array of `[name, fn]` pairs and run by a `main()` that calls each one and reports pass/fail — " +
		"read an existing `*.test.ts` file in the same directory to copy the exact shape before writing a new one."

	// 2026-08-20 addendum, tool-call JSON specifically: verified live
	// against Qwen3-14B — asked to edit_file a line of source that itself
	// contains double-quoted string literals (e.g. a TypeScript file full
	// of `"..."` text), the model wrapped its `old_string` JSON value in
	// SINGLE quotes instead ('...') to dodge escaping the embedded double
	// quotes, escaping only the occasional literal apostrophe inside
	// (`\'`) — this produces invalid JSON (JSON strings are ALWAYS
	// double-quoted; single quotes are never valid), the tool call fails
	// to parse, and the same broken JSON then repeats verbatim across
	// every retry because the model doesn't recognize single-quoting as
	// the actual defect. Naming it explicitly since escaping quotes
	// correctly is exactly the kind of mechanical detail a general "write
	// valid JSON" instruction doesn't reliably cover for code containing
	// its own quote-heavy string literals.
	const jsonEscapingNote =
		"Tool call arguments are JSON: every string value MUST be wrapped in double quotes, never single quotes " +
		"— JSON has no single-quoted string syntax at all, so a single-quoted value is not a formatting choice, " +
		"it is invalid JSON that will fail to parse. When the text you are copying into an argument (e.g. " +
		"edit_file's old_string/new_string) itself contains double-quote characters — common when editing code " +
		"that has string literals — keep the outer JSON string double-quoted and escape each embedded `\"` as " +
		"`\\\"`. Do not switch the outer quote character to avoid escaping; that is the mistake, not a workaround."

	// 2026-08-27 addendum, execute_command specifically: verified live
	// against Qwen3.5-9B — asked to verify an edit it had already made
	// correctly, the model wrote a multi-line `python3 -c "with open(...) as
	// f: ..."` verification command whose JSON argument had the exact
	// single/double-quote-nesting defect jsonEscapingNote describes above,
	// which errored through the tool (the identical command ran fine when
	// re-run by hand outside the harness, confirming the JSON encoding —
	// not the shell command itself — was the defect). Because
	// attempt_completion had ALREADY been deferred once by that point (a
	// prior command had failed), the model was one mistake from the
	// session's hard stop and used its last one narrating in prose instead
	// of retrying — see execute_command_recovery_note below for that half
	// of the failure.
	const executeCommandQuotingNote =
		"For verification commands specifically (checking a file's contents, confirming a string appears " +
		"somewhere), prefer the simplest command that answers the question — grep, cat, wc, test — over a " +
		"multi-line python3/node one-liner. A simple command has far less quoting for you to get right in the " +
		"JSON argument; a one-liner that mixes single quotes, double quotes, and embedded code is exactly where " +
		"the jsonEscapingNote mistake above tends to happen, and a failure there costs you a mistake strike for " +
		"no benefit over the simpler command."
	// 2026-08-27 addendum, the other half of the same live failure: after
	// attempt_completion was deferred, the model's recovery attempts
	// (execute_command retries, then prose) never included just re-issuing
	// attempt_completion once it believed — correctly, per the read_file
	// re-check it had already done — that the task was actually finished.
	// Three non-recovering turns in a row (two failed execute_command
	// retries, one prose-only reply) hit the session's hard stop on a task
	// that was already done. The deferral message already names the exact
	// fix; this states the general rule so it's not the model's first time
	// seeing this pattern.
	const executeCommandRecoveryNote =
		"If attempt_completion is deferred (a system message will say so and name the reason), your NEXT reply " +
		"must be a real tool call, not prose — either fix the specific thing the message names and re-verify with " +
		"a command that actually succeeds, or, if you already have real evidence the work is correct, simply call " +
		"attempt_completion again. A text-only reply explaining why you think you're done does not end the " +
		"session and counts against your mistake budget the same as a failed command — it is never the right " +
		"response to a deferral."

	// 2026-08-27 addendum, general case (executeCommandRecoveryNote above
	// only covers the narrower attempt_completion-deferral scenario):
	// verified live against Qwen3.5-9B with the lean prompt active — a
	// read_file call errored on a malformed path, and the model's next SIX
	// replies in a row were short text-only acknowledgments ("I see the
	// issue - I need to read from line 601 correctly. Let me continue
	// reading the file:") with NO tool call attached, nearly identical
	// each time, until the session hit its bounded-failure limit. This
	// was not a fabricated/malformed tool call (extractEmbeddedToolCall's
	// recovery does not apply here) and not task drift — the model
	// correctly identified the fix in its own words but never issued the
	// corrected call itself. The harness's reactive per-turn nudge
	// ("[System: a text reply alone does not end the session...]") did
	// not break the pattern. Independent evidence (a practitioner test
	// against Qwen3:14b hitting the same "narrate instead of retry"
	// pattern after a shell error) found that stating the rule as a
	// standing directive IN THE SYSTEM PROMPT, rather than only as a
	// reactive after-the-fact correction, was what actually fixed it —
	// taking that model from <20% to 100% success on the same task. This
	// note is the same intervention, generalized from execute_command to
	// every tool.
	const toolErrorRecoveryNote =
		"When any tool call returns an error, your NEXT reply must be the actual corrected tool call itself — " +
		"never a sentence describing that you will retry, are about to fix the path, or see the issue. Narrating " +
		"an intended retry is not progress and does not get executed; only a real tool call does. If you catch " +
		"yourself about to write something like 'let me try again' or 'I need to correct the path', stop and " +
		"put the corrected call in that same reply instead of describing it."

	const conventionNote =
		"Before writing a NEW file of a kind that likely already has examples in this codebase (a test file, a " +
		"config file, a module following an established pattern), actually read_file an existing example FIRST " +
		"and match its real conventions — imports, style, framework/assertion library, naming. Do not assume a " +
		"generic default (e.g. Jest-style describe/test/expect) is correct just because it is common elsewhere; " +
		"this project may use something else entirely, and a task that says 'follow the existing style' means " +
		"look at the existing style, not guess at it. This specifically includes the assertion call itself: this " +
		"codebase's 'plain assert' style is Node's own `assert` module (`import assert from \"node:assert/strict\"`, " +
		"then `assert.equal(...)` / `assert.match(...)`), which THROWS on failure — never `console.assert(...)`, " +
		"which only prints a warning and lets execution continue, so a real bug would print as a clean pass. " +
		testStructureNote +
		" " +
		jsonEscapingNote +
		" " +
		executeCommandQuotingNote

	const basePrompt = [
		modeConfig.roleDefinition,
		toolUseNote,
		stalledRetryNote,
		verificationNote,
		followupQuestionNote,
		objectiveNote,
		planningNote,
		conventionNote,
		executeCommandRecoveryNote,
		toolErrorRecoveryNote,
		getSystemInfoSection(workspaceRoot),
		await addCustomInstructions(modeConfig.customInstructions ?? "", globalCustomInstructions ?? "", workspaceRoot, modeConfig.slug, {}),
	]
		.filter((section) => section.trim().length > 0)
		.join("\n\n")

	const stackRules = await loadStackRules(workspaceRoot)
	const withStackRules = stackRules.content
		? appendStackRulesSection(basePrompt, stackRules.content, stackRules.stacks)
		: basePrompt

	const conventions = buildHeadlessConventions(modeConfig.slug, customModes)
	const fullPrompt = conventions === undefined ? withStackRules : `${withStackRules}\n${conventions}`

	return { prompt: fullPrompt, modeConfig, customModes }
}

/**
 * The headless-specific workflow section spliced onto the end of the system
 * prompt for edit-capable modes (see buildSystemPrompt). Keep it SHORT and
 * scannable — it is one block of prose among the vendored sections, not a
 * replacement for the tools' own descriptions or the rules files.
 */
export function buildHeadlessConventions(mode: string, customModes: ModeConfig[] = []): string | undefined {
	if (!modeHasEditGroup(mode, customModes)) {
		return undefined
	}
	return `# Headless harness workflow conventions

- Commit before finishing: real, working changes must be committed via \`git add\` + \`git commit\` BEFORE calling attempt_completion. Use one commit per logical change with a descriptive message, matching this repo's normal style (run \`git log --oneline\` for examples). If you genuinely have no changes to commit (e.g. a read-only investigation), finish without committing.
- Test selection during iterative work: after editing a file, run the SPECIFIC test file(s) for what you changed (the \`run_tests\` tool, or \`npx tsx <test-file>\` directly) instead of the full suite on every edit. The full \`npm test\` is still required once, right before attempt_completion, for real confidence.
- Batch same-file diffs: when several changes target the SAME file, include them as separate SEARCH/REPLACE blocks in ONE apply_diff call — and after any successful edit, re-read the file before composing further diffs, because its content has changed.
- Waiting on an external check (CI run, registry, live service) is legitimate verification work, but every wait call still counts against your iteration budget: prefer ONE long-running command with an explicit \`timeout\` — e.g. \`gh run watch <id> --interval 30 --exit-status\` — over repeated \`sleep N && gh run list\` polls. (Issue #119: polling burns iterations with no token spend.)`
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

/**
 * Append the EDIT-capable code-intelligence tool schema (`rename_symbol`) to
 * a tool list if it isn't already present. Unlike appendCodeIntelTools (the
 * four read-only tools, safe for every mode), rename_symbol WRITES files, so
 * callers must gate this on the executor actually registering it (the
 * headless executor does; the read-only reviewer/QA executors do not — see
 * src/tools/executor.ts) — otherwise a read-only session would advertise a
 * tool whose handler is missing.
 */
export function appendCodeIntelEditTools(tools: ChatTool[]): ChatTool[] {
	if (tools.some((t) => t.type === "function" && t.function.name === RENAME_SYMBOL_TOOL.function.name)) {
		return tools
	}
	return [...tools, RENAME_SYMBOL_TOOL as unknown as ChatTool]
}

/**
 * Append the `run_tests` tool schema if it isn't already present. Like
 * rename_symbol, run_tests RUNS the test suite (side-effectful) and is only
 * meaningful to edit-capable sessions, so callers gate this on the executor
 * actually registering it (the headless executor does; read-only reviewer/QA
 * executors do not — see src/tools/executor.ts).
 */
export function appendRunTestsTool(tools: ChatTool[]): ChatTool[] {
	if (tools.some((t) => t.type === "function" && t.function.name === runTestsTool.function.name)) {
		return tools
	}
	return [...tools, runTestsTool as unknown as ChatTool]
}

/**
 * Append the `set_indentation` tool schema if it isn't already present
 * (issue #141). Only meaningful to edit-capable sessions — gated on the
 * executor actually registering it, same as run_tests above (the headless
 * executor does; read-only reviewer/QA executors do not).
 */
export function appendSetIndentationTool(tools: ChatTool[]): ChatTool[] {
	if (tools.some((t) => t.type === "function" && t.function.name === setIndentationTool.function.name)) {
		return tools
	}
	return [...tools, setIndentationTool as unknown as ChatTool]
}

/**
 * Patch `edit_file`'s schema for local GGUF sessions: move
 * `expected_replacements` from optional into `required` (the model must
 * always supply it, e.g. 1 — the executor already defaults to 1 when it's
 * absent, so behavior is unchanged either way — see
 * src/tools/executor.ts's `toNonNegativeInt(args.expected_replacements, 1)`).
 *
 * Root cause this works around: llama.cpp/llama-cpp-python constrain tool
 * calls by converting each tool's JSON schema to a GBNF grammar. A known bug
 * in that conversion corrupts structured decoding whenever a multi-parameter
 * tool has ANY optional parameter — the model omits/duplicates/blanks a
 * field instead of completing the call (ggml-org/llama.cpp#20164, confirmed
 * against Qwen3.5/Qwen3-Coder; the reporter's own fix was moving the
 * optional param to required). Verified live 2026-08-20 against
 * Qwen2.5-Coder-14B: `edit_file` (3 required + 1 optional param) failed 3/3
 * calls on an existing file in three different malformed shapes (empty
 * old_string, identical old_string/new_string, missing file_path), while
 * `write_to_file` (2 required params, zero optional) succeeded on the first
 * try every time in the same session — exactly the schema-shape signature
 * from the upstream bug report, not a reasoning failure.
 *
 * Cloud sessions are untouched (OpenRouter models aren't grammar-constrained
 * this way), so this is applied only for the local backend, never to the
 * vendored schema itself.
 */
export function patchEditFileToolForLocalModels(tools: ChatTool[]): ChatTool[] {
	return tools.map((tool) => {
		if (tool.type !== "function" || tool.function.name !== "edit_file") {
			return tool
		}
		const params = tool.function.parameters as {
			required?: string[]
			[key: string]: unknown
		}
		if (params.required?.includes("expected_replacements")) {
			return tool
		}
		return {
			...tool,
			function: {
				...tool.function,
				parameters: {
					...params,
					required: [...(params.required ?? []), "expected_replacements"],
				},
			},
		}
	})
}
