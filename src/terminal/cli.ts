import * as path from "node:path"
import type { Readable, Writable } from "node:stream"
import type { LlmClient } from "../engine/types.js"
import { loadCustomModes } from "../engine/prompt.js"
import { getModeBySlug, modes } from "../vendor/zoo-code/src/shared/modes.js"
import { discoverSkills, type SkillRegistry } from "../skills/registry.js"
import { readEnabledSkillRoots } from "../skills/store.js"
import { importFile } from "../sessions/importers/index.js"
import { SessionStore } from "../sessions/store.js"
import { chatMain, chatUsage, parseChatArgs } from "./chat.js"
import { createChatTurnRunner } from "./bridge.js"
import { sanitizeTerminalText } from "./renderer.js"

export interface TerminalRuntimeOptions {
	llmClient?: LlmClient
	skillRegistry?: SkillRegistry
	input?: Readable
	output?: Writable
	errorOutput?: Writable
	signal?: AbortSignal
	extraArgs?: string[]
}

export async function terminalMain(argv: string[], runtime: TerminalRuntimeOptions = {}): Promise<number> {
	const output = runtime.output ?? process.stdout
	const errorOutput = runtime.errorOutput ?? process.stderr
	let options: ReturnType<typeof parseChatArgs>
	try { options = parseChatArgs(argv) }
	catch (error) {
		errorOutput.write(`${sanitizeTerminalText(String(error))}\n${chatUsage()}\n`)
		return 2
	}
	if (options.help) { output.write(`${chatUsage()}\n`); return 0 }
	const controller = new AbortController()
	const signal = runtime.signal ? AbortSignal.any([runtime.signal, controller.signal]) : controller.signal
	const stop = (): void => { controller.abort(new Error("chat stopped by SIGTERM")) }
	process.on("SIGTERM", stop)
	try {
		signal.throwIfAborted()
		let registry = runtime.skillRegistry
		if (!registry) {
			let enabledRoots: string[] = []
			try { enabledRoots = await readEnabledSkillRoots() }
			catch (error) { errorOutput.write(`skills: ${sanitizeTerminalText(String(error))}\n`) }
			registry = await discoverSkills(options.workspaceRoot, {
				enabledRoots,
				includeProjectRoot: enabledRoots.includes(path.resolve(options.workspaceRoot, ".agents", "skills")),
			})
		}
		for (const problem of registry.problems) errorOutput.write(`skills: ${sanitizeTerminalText(`${problem.path}: ${problem.message}`)}\n`)
		const frozenRegistry = registry
		const runTurn = createChatTurnRunner({ llmClient: runtime.llmClient, skillRegistry: frozenRegistry, extraArgs: runtime.extraArgs })
		return await chatMain(argv, {
			runTurn, createStore: (workspace) => new SessionStore(workspace),
			input: runtime.input, output, errorOutput, signal,
			validateMode: async (mode) => Boolean(getModeBySlug(mode, await loadCustomModes(options.workspaceRoot)) ?? modes.find((entry) => entry.slug === mode)),
			skills: { list: async () => frozenRegistry.skills, activate: async (name) => frozenRegistry.activate(name) },
			imports: { importFile: async (provider, file, workspace) => {
				if (provider === "headlesscode") throw new Error("Use /resume for native HeadlessCode sessions")
				return importFile(provider, path.resolve(workspace, file), workspace, signal)
			} },
		})
	} catch (error) {
		errorOutput.write(`chat: ${sanitizeTerminalText(String(error))}\n`)
		return 1
	} finally { process.removeListener("SIGTERM", stop) }
}
