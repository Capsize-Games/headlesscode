/**
 * DECISION PROXY — plans/decision-proxy-agent.md.
 *
 * A small, OPT-IN (`HEADLESSCODE_DECISION_PROXY=1`, default OFF) stand-in for
 * the human on `ask_followup_question` (src/tools/executor.ts's
 * `escalateDecision`): watches a workspace for `.harness.needs-decision`,
 * answers the question by writing `.harness.decision-answer` — the EXACT file
 * a human writes via scripts/headlesscode-answer.sh — grounded in the
 * session's ORIGINAL, VERBATIM task text, and logs every decision it saw and
 * made. No change to `escalateDecision`/`ask_followup_question`: the proxy is
 * a NEW writer of an existing answer file, so the existing timeout fallback
 * stays untouched and remains the safety net.
 *
 * Three outcomes per question:
 *   1. answered — the task text grounds a specific answer → write
 *      `[decision-proxy] <answer>` to the answer file. The worker's next poll
 *      picks it up and the session continues with real input.
 *   2. uncertain — the model reports it cannot ground an answer (or no task
 *      text is available at all) → write NOTHING. `escalateDecision`'s poll
 *      loop keeps waiting and today's timeout → "must decide autonomously"
 *      fallback fires exactly as it does with no proxy running.
 *   3. errored — the LLM call failed/timed out or the response was malformed
 *      → write NOTHING. Fail closed on parse ambiguity: a malformed response
 *      is never license to fabricate an answer.
 *
 * Fail-open by construction: a broken or abstaining proxy degrades to exactly
 * today's behavior (the session's own timeout), mirroring the non-fatal idiom
 * of src/engine/local-explore.ts — an experimental subsystem must never break
 * a real session.
 *
 * Original task text resolution (per question — re-resolved so a worker that
 * spawns AFTER the proxy starts is still grounded correctly):
 *   1. `--task` (verbatim string);
 *   2. `--task-file` (read verbatim, relative to the workspace root);
 *   3. the orchestrator's group `task_file` content — read from
 *      <repo>/.worktrees/.orchestrator-state.json when the workspace is one
 *      of the round's worktrees (the task file sits in the main repo under
 *      plans/parallel-tasks/; see src/orchestrator/state.ts).
 *   None available → every question is treated as "uncertain" (never guess).
 */

import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { resolveModelForMode } from "../config/mode-models.js"
import { Logger } from "../engine/logger.js"
import type { ChatMessage, LlmClient, LlmResponse } from "../engine/types.js"
import { DEFAULT_MODEL } from "../llm/openrouter.js"
import { DECISION_ANSWER_FILENAME, NEEDS_DECISION_FILENAME } from "../tools/executor.js"

// ─── Configuration (env-var resolvable, mirroring local-explore.ts) ─────────

/** Gate env var — HEADLESSCODE_DECISION_PROXY=1 enables the proxy. */
export const DECISION_PROXY_ENV = "HEADLESSCODE_DECISION_PROXY"
/** mode-models.json extraKey consulted FIRST for the proxy's model (see src/config/mode-models.ts). */
export const DECISION_PROXY_MODEL_KEY = "_decision-proxy"
/** Poll interval, ms (matches escalateDecision's DEFAULT_DECISION_POLL_INTERVAL_MS). */
export const DECISION_PROXY_POLL_INTERVAL_ENV = "HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS"
export const DEFAULT_DECISION_PROXY_POLL_INTERVAL_MS = 5_000
/**
 * Per-call LLM abort timeout, ms. A single short completion (question in,
 * JSON out — no tool loop) should not take anywhere near the session's
 * 300s default; 60s is generous while keeping a hung request from blocking
 * the session (which is waiting on OUR answer, up to its own 30min timeout).
 */
export const DECISION_PROXY_LLM_TIMEOUT_ENV = "HEADLESSCODE_DECISION_PROXY_LLM_TIMEOUT_MS"
export const DEFAULT_DECISION_PROXY_LLM_TIMEOUT_MS = 60_000
/**
 * Max output tokens for the answer call. Raised twice after the live pilot:
 * deepseek-v4-flash (a reasoning model) intermittently returned HTTP 200 with
 * EMPTY final content — its reasoning trace can consume the whole output
 * budget (DeepSeek counts reasoning toward max_tokens), leaving no room for
 * the final `{"answer": ...}` / `{"uncertain": true}` payload. 4096 is still
 * a single short completion (~$0.0006 worst case) and keeps the answer call
 * comfortably inside the worker's decision window.
 */
export const DEFAULT_DECISION_PROXY_MAX_TOKENS = 4096
/**
 * Distinguishing prefix on a proxy-authored answer file — anyone reading
 * harness.log / the dashboard's decision_answered event can tell a human
 * never looked at this. (The worker trims the answer, so the prefix plus the
 * answer text is exactly what the session model sees.)
 */
export const DECISION_PROXY_ANSWER_PREFIX = "[decision-proxy] "
/** The proxy's own audit log, relative to the workspace root (.headlesscode is gitignored). */
export const DECISION_PROXY_LOG_FILE = ".headlesscode/decision-proxy.log"

// ─── Types ──────────────────────────────────────────────────────────────────

/** The `.harness.needs-decision` marker shape (see escalateDecision). */
export interface NeedsDecisionMarker {
	question: string
	suggestions?: string[]
	askedAt?: string
}

export interface DecisionProxyOptions {
	/** The worktree/workspace to watch. */
	workspaceRoot: string
	/** Original task text (verbatim). Falls back to --task-file / orchestrator state. */
	task?: string
	/** Task file path (relative to the workspace root), read verbatim. */
	taskFile?: string
	/** Model id (default: mode-models.json `_decision-proxy`, else mode/_default/OPENROUTER_MODEL/client default). */
	model?: string
	/** The LLM client (inject a fake in tests; OpenRouterClient in prod). */
	llmClient: LlmClient
	/** Poll interval, ms (default $HEADLESSCODE_DECISION_PROXY_POLL_INTERVAL_MS or 5000). */
	pollIntervalMs?: number
	/** Per-call LLM abort timeout, ms (default $HEADLESSCODE_DECISION_PROXY_LLM_TIMEOUT_MS or 60s). */
	llmTimeoutMs?: number
	/** Max output tokens for the answer call (default 400). */
	maxTokens?: number
	logger?: Logger
}

export type DecisionProxyOutcome = "answered" | "uncertain" | "errored"

export interface DecisionProxyQuestionResult {
	outcome: DecisionProxyOutcome
	/** Human-readable detail: the written answer, the abstention reason, or the error. */
	detail?: string
	/** Task text source, when one was resolved ("cli-task", "task-file:<path>", "orchestrator:<path>"). */
	taskSource?: string
	/** Wall-clock ms from marker read to the terminal decision. */
	latencyMs: number
}

export type ProxyResponseParse =
	| { kind: "answered"; answer: string }
	| { kind: "uncertain" }
	| { kind: "malformed"; detail: string }

export interface TaskTextResolution {
	source: string
	text: string
}

export class DecisionProxyError extends Error {}

// ─── Env resolution (mirrors local-explore.ts's pattern) ────────────────────

export function isDecisionProxyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = env[DECISION_PROXY_ENV]
	return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false"
}

export function resolveDecisionProxyPollInterval(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env[DECISION_PROXY_POLL_INTERVAL_ENV], DEFAULT_DECISION_PROXY_POLL_INTERVAL_MS, DECISION_PROXY_POLL_INTERVAL_ENV)
}

export function resolveDecisionProxyLlmTimeout(env: NodeJS.ProcessEnv = process.env): number {
	return parsePositiveInt(env[DECISION_PROXY_LLM_TIMEOUT_ENV], DEFAULT_DECISION_PROXY_LLM_TIMEOUT_MS, DECISION_PROXY_LLM_TIMEOUT_ENV)
}

function parsePositiveInt(raw: string | undefined, fallback: number, envName: string): number {
	if (raw === undefined || raw.trim() === "") {
		return fallback
	}
	const n = Number(raw)
	if (!Number.isInteger(n) || n <= 0) {
		throw new DecisionProxyError(`${envName} must be a positive integer, got "${raw}"`)
	}
	return n
}

/**
 * Resolve the proxy's model via mode-models.json, consulting the
 * `_decision-proxy` extraKey FIRST (same indirection pattern as
 * `_condensation` — src/config/mode-models.ts). Falls through to the "code"
 * mode entry → `_default` → OPENROUTER_MODEL → undefined (client default).
 */
export function resolveDecisionProxyModel(
	workspaceRoot: string,
	env: NodeJS.ProcessEnv = process.env,
	explicitModel?: string,
): string | undefined {
	return resolveModelForMode({
		workspaceRoot,
		mode: "code",
		explicitModel,
		extraKeys: [DECISION_PROXY_MODEL_KEY],
		env,
	})
}

// ─── Marker reading ─────────────────────────────────────────────────────────

export async function readNeedsDecisionMarker(workspaceRoot: string): Promise<NeedsDecisionMarker | null> {
	const p = path.join(workspaceRoot, NEEDS_DECISION_FILENAME)
	let raw: string
	try {
		raw = await fsp.readFile(p, "utf-8")
	} catch {
		return null
	}
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>
		if (typeof parsed.question !== "string" || parsed.question.trim() === "") {
			return null
		}
		const marker: NeedsDecisionMarker = { question: parsed.question }
		if (Array.isArray(parsed.suggestions)) {
			const texts = parsed.suggestions.filter((s): s is string => typeof s === "string" && s.length > 0)
			if (texts.length > 0) {
				marker.suggestions = texts
			}
		}
		if (typeof parsed.askedAt === "string") {
			marker.askedAt = parsed.askedAt
		}
		return marker
	} catch {
		return null
	}
}

/** Stable identity for one escalation instance (askedAt is unique per escalateDecision). */
export function markerKey(marker: NeedsDecisionMarker): string {
	return `${marker.askedAt ?? ""}\u0000${marker.question}`
}

/**
 * True when the marker we read is STILL the current one on disk (same
 * question + askedAt). The worker deletes the marker when it consumes an
 * answer AND when its wait times out; a stale answer file written after the
 * worker moved on would be read instantly by the NEXT escalation (the poll
 * loop does not clear a pre-existing answer file), so we never write for a
 * marker that is no longer current.
 */
async function markerStillCurrent(workspaceRoot: string, marker: NeedsDecisionMarker): Promise<boolean> {
	const current = await readNeedsDecisionMarker(workspaceRoot)
	if (current === null) {
		return false
	}
	return current.question === marker.question && current.askedAt === marker.askedAt
}

async function safeUnlink(p: string): Promise<void> {
	try {
		await fsp.unlink(p)
	} catch {
		// Already gone / never existed — fine either way.
	}
}

// ─── Original task text resolution ──────────────────────────────────────────

export function resolveTaskText(workspaceRoot: string, opts: { task?: string; taskFile?: string }): TaskTextResolution | null {
	if (opts.task !== undefined && opts.task.trim() !== "") {
		return { source: "cli-task", text: opts.task }
	}
	if (opts.taskFile !== undefined && opts.taskFile.trim() !== "") {
		const p = path.resolve(workspaceRoot, opts.taskFile)
		try {
			const text = fs.readFileSync(p, "utf-8")
			if (text.trim() !== "") {
				return { source: `task-file:${p}`, text }
			}
		} catch {
			// Fall through to the orchestrator-state lookup.
		}
	}
	return resolveTaskTextFromOrchestratorState(workspaceRoot)
}

function resolveTaskTextFromOrchestratorState(workspaceRoot: string): TaskTextResolution | null {
	const absWorkspace = path.resolve(workspaceRoot)
	// A worktree lives at <repo>/.worktrees/<name>; the round's durable state
	// file sits next to the worktrees dir: <repo>/.worktrees/.orchestrator-state.json.
	const statePath = path.join(path.dirname(absWorkspace), ".orchestrator-state.json")
	let state: unknown
	try {
		state = JSON.parse(fs.readFileSync(statePath, "utf-8"))
	} catch {
		return null
	}
	if (state === null || typeof state !== "object") {
		return null
	}
	const groups = (state as Record<string, unknown>).groups
	if (!Array.isArray(groups)) {
		return null
	}
	const repoRoot = path.dirname(path.dirname(statePath))
	for (const g of groups) {
		if (g === null || typeof g !== "object") {
			continue
		}
		const group = g as Record<string, unknown>
		if (typeof group.worktree !== "string" || typeof group.task_file !== "string") {
			continue
		}
		if (path.resolve(repoRoot, group.worktree) !== absWorkspace) {
			continue
		}
		const taskPath = path.resolve(repoRoot, group.task_file)
		try {
			const text = fs.readFileSync(taskPath, "utf-8")
			if (text.trim() !== "") {
				return { source: `orchestrator:${taskPath}`, text }
			}
		} catch {
			return null
		}
	}
	return null
}

// ─── LLM call ───────────────────────────────────────────────────────────────

/**
 * Max attempts for ONE question's LLM call. A reasoning model (e.g. the
 * default deepseek/deepseek-v4-flash-0731) sometimes returns HTTP 200 with EMPTY
 * content on the first completion (observed live in the decision-proxy pilot);
 * the retry re-issues the SAME one-shot prompt — still a single question, no
 * tools, no loop. The caller still fails open (writes nothing) if every
 * attempt is unusable.
 */
export const MAX_PROXY_LLM_ATTEMPTS = 2

export const DECISION_PROXY_SYSTEM_PROMPT = `You are the DECISION PROXY for a headless coding agent. The agent was given a task and, during the session, asked a question that would normally go to a human. You answer on the human's behalf — but ONLY when the agent's ORIGINAL TASK TEXT genuinely grounds a specific answer.

You will be given:
- The agent's original task text (verbatim).
- The question the agent asked.
- Optional suggested answers.

Rules:
- If the original task text gives you enough information to answer the question DIRECTLY and SPECIFICALLY, answer it. When one of the suggested answers clearly matches what the task requires, choose it. Be concise and concrete — your answer is fed back to the agent verbatim.
- If the question is a MODE-SWITCH approval (its suggested answers are exactly "approve"/"deny"), your answer must be exactly "approve" or "deny": approve only when the original task text supports the switch (e.g. the task says the work should be handed to another mode), otherwise deny.
- If the original task text does NOT answer the question (it is silent on the matter, or the question is a genuine choice the task left open), you MUST respond with the uncertain sentinel.
- NEVER guess, invent, or extrapolate beyond what the task text supports. A fabricated answer actively misdirects the agent; an abstention merely falls back to the existing no-answer behavior.

Respond with STRICT JSON ONLY, exactly one of:
  {"answer": "<your answer text>"}
  {"uncertain": true}

No prose outside the JSON.`

export function buildProxyUserPrompt(taskText: string, question: string, suggestions?: string[]): string {
	let out = `ORIGINAL TASK TEXT (verbatim):\n${taskText}\n\nQUESTION ASKED:\n${question}`
	if (suggestions && suggestions.length > 0) {
		out += `\n\nSUGGESTED ANSWERS:\n${suggestions.map((s, i) => `${i + 1}. ${s}`).join("\n")}`
	}
	return out
}

async function callProxyLlm(options: DecisionProxyOptions, taskText: string, marker: NeedsDecisionMarker): Promise<string> {
	// Concrete model always: _decision-proxy key → mode/_default/OPENROUTER_MODEL
	// → the client's own DEFAULT_MODEL (same final fallback as the main loop).
	const model = options.model ?? resolveDecisionProxyModel(options.workspaceRoot, process.env) ?? DEFAULT_MODEL
	const timeoutMs = options.llmTimeoutMs ?? resolveDecisionProxyLlmTimeout(process.env)
	const messages: ChatMessage[] = [
		{ role: "system", content: DECISION_PROXY_SYSTEM_PROMPT },
		{ role: "user", content: buildProxyUserPrompt(taskText, marker.question, marker.suggestions) },
	]
	let lastError: unknown
	for (let attempt = 1; attempt <= MAX_PROXY_LLM_ATTEMPTS; attempt++) {
		const controller = new AbortController()
		const timer = setTimeout(() => controller.abort(), timeoutMs)
		try {
			const response: LlmResponse = await options.llmClient.createChatCompletion({
				model,
				messages,
				temperature: 0,
				maxTokens: options.maxTokens ?? DEFAULT_DECISION_PROXY_MAX_TOKENS,
				signal: controller.signal,
			})
			const content = response.message.content
			if (typeof content === "string" && content.trim() !== "") {
				return content
			}
			// Diagnose the empty response for the audit trail: was the completion
			// cut mid-reasoning (DeepSeek counts reasoning toward max_tokens), or
			// did the model emit a reasoning block with no final content at all?
			const reasoning = typeof response.message.reasoning === "string" && response.message.reasoning.length > 0
			lastError = new DecisionProxyError(
				`empty LLM response (attempt ${attempt}/${MAX_PROXY_LLM_ATTEMPTS})` +
					(reasoning ? ` — model emitted ${response.message.reasoning!.length} chars of reasoning but no final content` : " — no content and no reasoning"),
			)
		} catch (err) {
			lastError = err
		} finally {
			clearTimeout(timer)
		}
	}
	throw lastError instanceof Error ? lastError : new DecisionProxyError(String(lastError))
}

// ─── Sentinel parsing ───────────────────────────────────────────────────────

/**
 * Parse the proxy LLM's response. STRICT by design: `{"uncertain": true}`
 * abstains, `{"answer": "<non-empty>"}` answers, and ANYTHING else is
 * malformed — the caller treats malformed exactly like uncertain (write
 * nothing) but logs it separately so a broken proxy/model is visible in the
 * audit trail instead of masquerading as a legitimate abstention.
 */
export function parseProxyResponse(content: string): ProxyResponseParse {
	const trimmed = content.trim()
	if (trimmed === "") {
		return { kind: "malformed", detail: "empty response" }
	}
	const parsed = tryParseJson(trimmed)
	if (parsed === undefined) {
		return { kind: "malformed", detail: "response is not valid JSON" }
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { kind: "malformed", detail: "response is not a JSON object" }
	}
	const obj = parsed as Record<string, unknown>
	if (obj.uncertain === true) {
		return { kind: "uncertain" }
	}
	if (typeof obj.answer === "string" && obj.answer.trim() !== "") {
		return { kind: "answered", answer: obj.answer.trim() }
	}
	return { kind: "malformed", detail: "response has neither a non-empty string 'answer' nor 'uncertain': true" }
}

/** JSON.parse with a single markdown-fence retry (models sometimes wrap JSON). */
function tryParseJson(text: string): unknown | undefined {
	try {
		return JSON.parse(text)
	} catch {
		const fenceMatch = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/.exec(text)
		if (fenceMatch) {
			try {
				return JSON.parse(fenceMatch[1])
			} catch {
				return undefined
			}
		}
		return undefined
	}
}

// ─── One question ───────────────────────────────────────────────────────────

export async function processQuestion(
	options: DecisionProxyOptions,
	marker: NeedsDecisionMarker,
): Promise<DecisionProxyQuestionResult> {
	const startedAt = Date.now()
	const answerPath = path.join(options.workspaceRoot, DECISION_ANSWER_FILENAME)

	// Re-resolved per question (cheap file reads) so a worker that spawns after
	// the proxy starts — or an orchestrator state file written late — is still
	// grounded correctly.
	const task = resolveTaskText(options.workspaceRoot, { task: options.task, taskFile: options.taskFile })
	if (task === null) {
		return { outcome: "uncertain", detail: "no original task text available — cannot ground an answer", latencyMs: Date.now() - startedAt }
	}

	let content: string
	try {
		content = await callProxyLlm(options, task.text, marker)
	} catch (err) {
		return { outcome: "errored", detail: errorMessage(err), latencyMs: Date.now() - startedAt }
	}

	const parsed = parseProxyResponse(content)
	if (parsed.kind === "uncertain") {
		return { outcome: "uncertain", detail: "model reported uncertain — task text cannot ground an answer", taskSource: task.source, latencyMs: Date.now() - startedAt }
	}
	if (parsed.kind === "malformed") {
		return { outcome: "errored", detail: `malformed proxy response: ${parsed.detail}`, taskSource: task.source, latencyMs: Date.now() - startedAt }
	}

	// Pre-write guard: only answer the question that is STILL the current one.
	// If the marker disappeared while we were thinking, the worker already
	// moved on (answered or timed out) — writing now could poison the NEXT
	// escalation with a stale answer (escalateDecision reads an existing
	// answer file instantly and never clears a stale one).
	if (!(await markerStillCurrent(options.workspaceRoot, marker))) {
		return { outcome: "errored", detail: "marker disappeared before the answer could be written — skipped", taskSource: task.source, latencyMs: Date.now() - startedAt }
	}

	await fsp.writeFile(answerPath, `${DECISION_PROXY_ANSWER_PREFIX}${parsed.answer}`, "utf-8")

	// Post-write guard: if the marker is gone/changed right after the write,
	// remove the answer we just wrote. Either the worker already consumed it
	// (its read happens before its marker unlink — deleting the file is
	// harmless) or the worker timed out at the same instant (the file is
	// stale and would poison the next escalation — deleting is REQUIRED).
	if (!(await markerStillCurrent(options.workspaceRoot, marker))) {
		await safeUnlink(answerPath)
		return { outcome: "answered", detail: `${parsed.answer} (answer removed post-write — marker already gone, consumed or stale)`, taskSource: task.source, latencyMs: Date.now() - startedAt }
	}

	return { outcome: "answered", detail: parsed.answer, taskSource: task.source, latencyMs: Date.now() - startedAt }
}

// ─── The poll loop ──────────────────────────────────────────────────────────

/**
 * Run the decision proxy until `signal` aborts (SIGINT/SIGTERM in the CLI;
 * an injected controller in tests). Never throws out of the loop: a question
 * that fails to process is logged and the loop keeps watching.
 */
export async function runDecisionProxy(options: DecisionProxyOptions, signal?: AbortSignal): Promise<void> {
	const logger = options.logger ?? new Logger()
	const pollIntervalMs = options.pollIntervalMs ?? resolveDecisionProxyPollInterval(process.env)
	const resolvedModel = options.model ?? resolveDecisionProxyModel(options.workspaceRoot, process.env)

	logger.info("decision-proxy started", {
		workspaceRoot: options.workspaceRoot,
		model: resolvedModel ?? "(client default)",
		pollIntervalMs,
		llmTimeoutMs: options.llmTimeoutMs ?? resolveDecisionProxyLlmTimeout(process.env),
	})

	// The last escalation instance handled. The marker STAYS while the worker
	// waits (up to its decision timeout), so without this we would re-call the
	// LLM on the same question every poll. A new escalation always has a fresh
	// askedAt, so the key never collides across questions.
	let lastHandledKey: string | undefined

	for (;;) {
		if (signal?.aborted) {
			logger.info("decision-proxy stopped")
			return
		}
		const marker = await readNeedsDecisionMarker(options.workspaceRoot)
		if (marker !== null) {
			const key = markerKey(marker)
			if (key !== lastHandledKey) {
				lastHandledKey = key
				let result: DecisionProxyQuestionResult
				try {
					result = await processQuestion({ ...options, logger }, marker)
				} catch (err) {
					// Never let a processing failure reject the loop — fail open
					// to today's behavior (the worker's own timeout).
					logger.error("decision-proxy question — ERRORED, wrote nothing", {
						askedAt: marker.askedAt,
						question: marker.question,
						outcome: "errored",
						detail: errorMessage(err),
					})
					continue
				}
				const meta = {
					askedAt: marker.askedAt,
					question: marker.question,
					outcome: result.outcome,
					latencyMs: result.latencyMs,
					...(result.taskSource ? { taskSource: result.taskSource } : {}),
					...(result.detail ? { detail: result.detail } : {}),
				}
				if (result.outcome === "answered") {
					logger.info("decision-proxy question", meta)
				} else if (result.outcome === "uncertain") {
					logger.warn("decision-proxy question — UNCERTAIN, wrote nothing", meta)
				} else {
					logger.error("decision-proxy question — ERRORED, wrote nothing", meta)
				}
			}
		}
		await sleep(pollIntervalMs)
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
