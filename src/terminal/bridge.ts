import { randomUUID } from "node:crypto"
import { main, type CliRuntimeHooks } from "../cli.js"
import type { ChatMessage, LlmClient, SessionResult } from "../engine/types.js"
import { buildHistoryContext } from "../sessions/context.js"
import type { SessionMessage } from "../sessions/types.js"
import type { ChatTurnRunner } from "./types.js"

function archiveMessage(message: ChatMessage): SessionMessage {
	return {
		role: message.role,
		content: message.content,
		...(message.tool_calls ? { toolCalls: message.tool_calls.map((call) => ({ id: call.id, name: call.function.name, arguments: call.function.arguments })) } : {}),
		...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
	}
}

export function createChatTurnRunner(options: { llmClient?: LlmClient; extraArgs?: string[] } = {}): ChatTurnRunner {
	return async (request) => {
		const history = buildHistoryContext(request.history)
		for (const warning of history.warnings) request.onEvent("history_warning", { warning })
		const messages: SessionMessage[] = [{ role: "user", content: request.prompt }]
		const diagnostics: string[] = []
		let result: SessionResult | undefined
		const runId = randomUUID()
		request.onEvent("turn_start", { archiveSessionId: request.sessionId, runSessionId: runId })
		const sink = { write(text: string): void {
			const bounded = text.slice(0, 8192)
			if (diagnostics.length < 20) diagnostics.push(bounded)
			request.onEvent("diagnostic", { text: bounded })
		} }
		const hooks: CliRuntimeHooks = {
			quiet: true, signal: request.signal, onEvent: request.onEvent,
			onMessage: (message) => { if (message.role !== "system") messages.push(archiveMessage(message)) },
			onResult: (outcome) => { result = outcome; if (outcome.budgetUsage) request.onEvent("budget", { ...outcome.budgetUsage }) },
			stdout: sink, stderr: sink, ...(options.llmClient ? { llmClient: options.llmClient } : {}),
		}
		const code = await main([
			"--workspace", request.workspaceRoot, "--mode", request.mode,
			"--session-id", runId, "--stream", "--task", history.text ? `${history.text}\nCurrent user request:\n${request.prompt}` : request.prompt,
			...(request.model ? ["--model", request.model] : []),
			...(options.extraArgs ?? []),
		], hooks)
		const outcome = result as SessionResult | undefined
		const answer = outcome?.result ?? ""
		if (answer && (messages.at(-1)?.role !== "assistant" || messages.at(-1)?.content !== answer)) messages.push({ role: "assistant", content: answer })
		const status = code === 0 && outcome?.status === "success" ? "success" : "error"
		request.onEvent("turn_complete", { status, runSessionId: runId })
		return { status, result: answer, messages, ...(status === "error" ? { error: outcome?.error ?? (diagnostics.join("").trim() || "Turn failed before producing a result.") } : {}) }
	}
}
