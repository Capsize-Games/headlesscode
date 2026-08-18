/**
 * THROWAWAY SMOKE TEST — proves the vendored prompt builder can be imported
 * and called headlessly (no VS Code), and that the native tool schemas assemble.
 *
 * Run with: npm run smoke  (i.e. tsx src/vendor/tests/smoke.ts)
 */

import type { ExtensionContext } from "../zoo-code/shim/vscode.js"

// Side effect: installs String.prototype.toPosix() used by prompt sections.
import "../zoo-code/src/utils/path.js"

import { SYSTEM_PROMPT } from "../zoo-code/src/core/prompts/system.js"
import {
	getNativeTools,
	convertOpenAIToolsToAnthropic,
} from "../zoo-code/src/core/prompts/tools/native-tools/index.js"
import { customModesSettingsSchema } from "../zoo-code/types/index.js"

async function main(): Promise<void> {
	// Minimal ExtensionContext stand-in (the vendored builder only reads
	// globalState.get("customModes"/"customModePrompts") when building MODES).
	const context = {
		globalState: {
			get: async () => undefined,
			update: async () => {},
		},
		globalStorageUri: { fsPath: process.cwd() },
		subscriptions: [],
	} as unknown as ExtensionContext

	// 1. Build a system prompt for the built-in "code" mode, with custom
	//    instructions text spliced in (the acceptance-criteria shape).
	const customInstructions = "This is throwaway smoke-test global instructions text."
	const prompt = await SYSTEM_PROMPT(
		context,
		process.cwd(),
		false,
		undefined,
		undefined,
		"code",
		undefined,
		undefined,
		customInstructions,
	)

	for (const needle of [
		"TOOL USE",
		"OBJECTIVE",
		"RULES",
		"MODES",
		"CAPABILITIES",
		"SYSTEM INFORMATION",
		"You are Zoo, a highly skilled software engineer",
		"USER'S CUSTOM INSTRUCTIONS",
		`Global Instructions:\n${customInstructions}`,
	]) {
		if (!prompt.includes(needle)) {
			throw new Error(`System prompt missing expected section: "${needle}"`)
		}
	}

	// 2. Assemble the native (OpenAI-format) tool schemas.
	const tools = getNativeTools()
	if (tools.length < 20) {
		throw new Error(`Expected >= 20 native tools, got ${tools.length}`)
	}
	const names = tools.map((t) => (t.type === "function" ? t.function.name : t.type))
	if (!names.includes("read_file") || !names.includes("execute_command") || !names.includes("write_to_file")) {
		throw new Error(`Native tools missing core tools: ${names.join(", ")}`)
	}

	// 3. Convert to Anthropic format.
	const anthropicTools = convertOpenAIToolsToAnthropic(tools)
	if (anthropicTools.length !== tools.length) {
		throw new Error("Anthropic conversion count mismatch")
	}

	// 4. The .roomodes zod schema parses a minimal customModes YAML document.
	const parsed = customModesSettingsSchema.safeParse({
		customModes: [
			{
				slug: "smoke",
				name: "Smoke",
				roleDefinition: "You are a smoke test mode.",
				groups: ["read"],
			},
		],
	})
	if (!parsed.success) {
		throw new Error(`customModesSettingsSchema rejected a valid config: ${JSON.stringify(parsed.error)}`)
	}

	console.log(
		`[smoke] system prompt built (${prompt.length} chars); native tools: ${tools.length}; anthropic tools: ${anthropicTools.length}; roomodes schema: ok`,
	)
	console.log("[smoke] OK")
}

main().catch((err) => {
	console.error("[smoke] FAILED:", err)
	process.exit(1)
})
