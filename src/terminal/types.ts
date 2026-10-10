import type { SessionMessage } from "../sessions/types.js"

export interface ChatTurnRequest {
	prompt: string
	history: SessionMessage[]
	workspaceRoot: string
	sessionId: string
	mode: string
	model?: string
	signal: AbortSignal
	onEvent: (type: string, fields: Record<string, unknown>) => void
}

export interface ChatTurnResult {
	status: "success" | "error"
	result: string
	/** Only this turn's messages, excluding the historical context and system prompt. */
	messages: SessionMessage[]
	error?: string
}

export type ChatTurnRunner = (request: ChatTurnRequest) => Promise<ChatTurnResult>
