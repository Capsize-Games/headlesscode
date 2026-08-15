/**
 * Fixed-prefix cost measurement: system prompt + tool catalog.
 *
 * Task (round 3, "r3-prompt-measure"): measure the fixed prefix every main-loop
 * LLM call carries (src/engine/loop.ts:2222-2230 sends the system prompt as
 * messages[0] plus `tools: this.state.tools`) and feed a trim/no-trim
 * recommendation. Measurement ONLY — no production code is touched.
 *
 * Reuses the dry-run shape from src/cli.ts:745-757 (resolves model/effort and
 * builds the prompt without an LLM call) and the real session tool assembly
 * from src/engine/loop.ts:1165-1174.
 */

import {
	appendBrowserActionTool,
	appendCodeIntelEditTools,
	appendCodeIntelTools,
	appendDescribeImageTool,
	appendRunTestsTool,
	buildSystemPrompt,
	loadCustomModes,
	selectToolsForMode,
} from "../../src/engine/prompt.js"
import { isTypeScriptWorkspace } from "../../src/tools/language-detect.js"
import type { ChatTool } from "../../src/engine/types.js"

const CHARS_PER_TOKEN = 4

function estTokens(chars: number): number {
	return Math.round(chars / CHARS_PER_TOKEN)
}

function fmt(label: string, chars: number): string {
	return `${label.padEnd(58)} ${String(chars).padStart(7)} chars  ~${String(estTokens(chars)).padStart(6)} tok`
}

function toolWire(tool: ChatTool): string {
	return JSON.stringify(tool)
}

/** Split a prompt into sections on markdown heading lines (lines starting with '#'...). */
function sectionBreakdown(prompt: string): Array<{ label: string; chars: number }> {
	const sections: Array<{ label: string; chars: number }> = []
	const lines = prompt.split("\n")
	let label = "(preamble / role definition — no heading)"
	let sectionStart = 0
	let offset = 0
	for (const line of lines) {
		const m = /^#{1,6}\s+(.*)$/.exec(line)
		if (m && offset > sectionStart) {
			sections.push({ label, chars: offset - sectionStart })
			label = m[1]!.trim()
			sectionStart = offset
		}
		offset += line.length + 1 // +1 for the '\n'
	}
	if (offset > sectionStart) {
		sections.push({ label, chars: offset - sectionStart })
	}
	return sections
}

async function main(): Promise<void> {
	const workspaceRoot = process.cwd()
	const customModes = await loadCustomModes(workspaceRoot)
	const built = await buildSystemPrompt({ workspaceRoot, mode: "code", customModes })
	const prompt = built.prompt

	const isTs = isTypeScriptWorkspace(workspaceRoot)

	// ── Tool assembly variants ────────────────────────────────────────────────
	const base = selectToolsForMode("code", customModes)
	// Dry-run shape (src/cli.ts:755-757): code-intel + describe_image only —
	// browser_action/run_tests/rename_symbol deliberately omitted.
	const dryRunTools = appendCodeIntelTools(appendDescribeImageTool(base))
	// Real headless session on a TS workspace (src/engine/loop.ts:1165-1174):
	// everything, incl. the TS-gated code-intel tools, rename_symbol, run_tests.
	const tsSessionTools = appendRunTestsTool(
		appendCodeIntelEditTools(appendCodeIntelTools(appendDescribeImageTool(appendBrowserActionTool(base)))),
	)
	// Real headless session on a NON-TS workspace: code-intel/rename/run_tests
	// are not registered (src/tools/executor.ts:1777-1799), so not advertised.
	const nonTsSessionTools = appendDescribeImageTool(appendBrowserActionTool(base))

	const variants = {
		"dry-run (cli.ts shape)": dryRunTools,
		"session, TS workspace (full loop.ts shape)": tsSessionTools,
		"session, non-TS workspace": nonTsSessionTools,
	}

	console.log(`workspace:            ${workspaceRoot}`)
	console.log(`mode:                 code (${customModes.length} custom modes)`)
	console.log(`TS workspace (code-intel/run_tests gated on this): ${isTs}`)
	console.log("")

	// ── System prompt ─────────────────────────────────────────────────────────
	console.log("═ SYSTEM PROMPT ═".padEnd(60) + "chars     ~tok")
	console.log(fmt("total system prompt", prompt.length))
	console.log("")

	// Buckets: vendored build vs the two headless-appended sections.
	const stackMarker = "\n\n====\n\nSTACK-SPECIFIC INSTRUCTIONS\n"
	const conventionsMarker = "\n# Headless harness workflow conventions\n"
	const stackIdx = prompt.indexOf(stackMarker)
	const convIdx = prompt.indexOf(conventionsMarker)
	const vendored = stackIdx >= 0 ? prompt.slice(0, stackIdx) : prompt
	const stackPart = stackIdx >= 0 ? prompt.slice(stackIdx, convIdx >= 0 ? convIdx : undefined) : ""
	const conventions = convIdx >= 0 ? prompt.slice(convIdx) : ""
	console.log("── provenance buckets ──")
	console.log(fmt("vendored SYSTEM_PROMPT build (incl. .roo/rules splicing)", vendored.length))
	if (stackPart) console.log(fmt("appended: stack-specific rules (src/engine/stacks.ts)", stackPart.length))
	if (conventions) console.log(fmt("appended: headless workflow conventions (src/engine/prompt.ts)", conventions.length))
	console.log("")

	console.log("── section breakdown (markdown headings) ──")
	for (const s of sectionBreakdown(prompt)) {
		console.log(fmt(`  ${s.label}`, s.chars))
	}
	console.log("")

	// Top-level `====`-delimited blocks of the VENDORED build (before the
	// headless-appended stack/conventions sections). The vendored builder joins
	// its sections with `====` separators (system.ts); the block header is the
	// line right after the first `====` of the block (e.g. MODES, OBJECTIVE).
	console.log("── vendored `====`-delimited blocks (vendored portion only) ──")
	const vendoredEnd = stackIdx >= 0 ? stackIdx : convIdx >= 0 ? convIdx : prompt.length
	const vendoredOnly = prompt.slice(0, vendoredEnd)
	const blockStarts: Array<{ name: string; start: number }> = [{ name: "(lead-in)", start: 0 }]
	for (const m of vendoredOnly.matchAll(/^====\n\n([A-Z][A-Z0-9 /-]{1,40})\n/gm)) {
		blockStarts.push({ name: m[1]!, start: m.index! + m[0].length })
	}
	// Blocks between `====` dividers: measure from one header's end to the next header's start.
	for (let i = 0; i < blockStarts.length; i++) {
		const end = i + 1 < blockStarts.length ? blockStarts[i + 1]!.start - 8 : vendoredOnly.length // -8: strip trailing '====\n\n'
		// Trim the trailing separator if this is the last block.
		const chars = Math.max(0, end - blockStarts[i]!.start)
		console.log(fmt(`  ${blockStarts[i]!.name}`, chars))
	}
	console.log("")

	// ── Tool catalog ──────────────────────────────────────────────────────────
	console.log("═ TOOL CATALOG (JSON.stringify wire bytes) ═")
	for (const [label, tools] of Object.entries(variants)) {
		const total = tools.reduce((acc, t) => acc + toolWire(t).length, 0)
		console.log(`\n── ${label} (${tools.length} tools, ${total} chars, ~${estTokens(total)} tok) ──`)
		const rows = tools.map((t) => {
			const name = t.type === "function" ? t.function.name : String(t.type)
			return { name, chars: toolWire(t).length }
		})
		rows.sort((a, b) => b.chars - a.chars)
		for (const r of rows) {
			console.log(fmt(`  ${r.name}`, r.chars))
		}
	}
	console.log("")

	// ── Combined fixed prefix ─────────────────────────────────────────────────
	console.log("═ COMBINED FIXED PREFIX (system prompt + tools) ═")
	for (const [label, tools] of Object.entries(variants)) {
		const toolChars = tools.reduce((acc, t) => acc + toolWire(t).length, 0)
		const combined = prompt.length + toolChars
		console.log(fmt(`${label}`, combined))
	}
	console.log("")
	console.log(
		`Token estimate uses ~${CHARS_PER_TOKEN} chars/token (a rough mid-range heuristic; real tokenizers vary by model — treat as ±20%).`,
	)
	console.log(
		`Note: the vendored builder embeds .roo/rules/, .roo/rules-<mode>/ and AGENTS.md content into the system prompt — that is part of this measurement (it IS sent every call).`,
	)
}

main().catch((err) => {
	console.error("measurement failed:", err)
	process.exit(1)
})
