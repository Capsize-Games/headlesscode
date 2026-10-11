export type SessionProvider = "headlesscode" | "claude" | "codex" | "muse"

export interface ArchivedToolCall {
	id: string
	name: string
	arguments: string
}

export interface SessionMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool"
	content: string | null
	timestamp?: string
	toolCalls?: ArchivedToolCall[]
	toolCallId?: string
	/** Foreign content retained for inspection; never replayed as runtime state. */
	opaque?: { type: string; value: unknown }[]
}

export interface SessionProvenance {
	provider: SessionProvider
	sessionId?: string
	sourcePath?: string
	sha256?: string
	importedAt?: string
	parentSessionId?: string
}

export interface SessionArchive {
	version: 1
	id: string
	revision: number
	workspaceRoot: string
	title: string
	createdAt: string
	updatedAt: string
	messages: SessionMessage[]
	provenance?: SessionProvenance
	warnings: string[]
}

export interface CreateSessionInput {
	title?: string
	messages?: SessionMessage[]
	provenance?: SessionProvenance
	warnings?: string[]
}

export interface SessionSummary {
	id: string
	title: string
	workspaceRoot: string
	createdAt: string
	updatedAt: string
	messageCount: number
	provider: SessionProvider
}
