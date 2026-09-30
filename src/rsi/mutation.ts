import { runOpenShellMutation } from "./openshell.js"
import type { CandidateRecord, RsiConfig } from "./types.js"

export async function runMutation(candidate: CandidateRecord, config: RsiConfig) {
	try {
		return await runOpenShellMutation(candidate, config)
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (message.includes("RSI hidden evaluations are disabled")) return { ok: false, error: message }
		throw error
	}
}
