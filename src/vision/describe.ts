import { readFile } from "node:fs/promises"
import path from "node:path"
import type { AuxLlmUsage } from "../engine/types.js"

/**
 * Cloud vision captioning for images — the ONLY image path through this
 * harness. This is a deliberate, narrow, standalone client (same pattern as
 * OllamaLocalChatClient in src/engine/local-explore.ts): the main agent loop
 * and every LlmClient are typed around the text-only ChatMessage shape, so a
 * multimodal request cannot flow through them. Instead this module makes its
 * OWN OpenAI-compatible chat-completions call against OpenRouter with an
 * `image_url` content part, gets back a text description, and that text is
 * all that ever touches the rest of the system (ToolResult content is
 * string-only).
 *
 * Cost is real and tracked: each call returns the provider's token counts in
 * AuxLlmUsage, which the executor's onAuxLlmUsage hook forwards to the
 * session's BudgetTracker + running totals (see recordAuxLlmUsage in
 * src/engine/loop.ts) — captioning a screenshot shows up in the session's
 * budget/usage accounting exactly like a regular LLM call.
 *
 * Model default (google/gemma-3-12b-it) is the result of the real model
 * evaluation documented in the imgsupport plan: the cheapest candidate that
 * produced descriptions with genuinely useful detail (correctly diagnosed a
 * broken-page screenshot) and no material quality regression vs. the
 * gemma-3-27b-it quality anchor — which hallucinated detail on the same
 * image. Override via HEADLESSCODE_VISION_MODEL.
 */

export const DEFAULT_VISION_MODEL = "google/gemma-3-12b-it"

export const DEFAULT_VISION_TIMEOUT_MS = 60_000

/** Default resolution of the base URL: same OpenRouter endpoint the main
 *  client uses, overridable via OPENROUTER_BASE_URL like the main client. */
export function visionBaseUrl(): string {
	return (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai").replace(/\/+$/, "")
}

export const VISION_SYSTEM_PROMPT = [
	"You are an image captioning system for a coding agent. Describe the image in concrete, factual",
	"detail a software engineer can act on. Include:",
	"- All visible text verbatim where readable: error messages, button labels, headings, URLs, console output.",
	"- The overall layout and every UI element present (buttons, inputs, dialogs, tables, toggles, images) and their state (disabled, checked, highlighted, empty).",
	"- Anything that looks wrong: error states, missing content, layout breakage, misalignment, blank areas where content should be.",
	"- Colors only when they carry meaning (red error text, green success, amber warnings).",
	"Do not write a vague generic caption, do not speculate about what the image is 'probably' from, and do not invent text you cannot actually read",
	"- if text is illegible, say it is illegible rather than guessing.",
].join("\n")

/** Failure from the vision captioning call. Mirrors OpenRouterError's shape
 *  (message + optional HTTP status + raw body excerpt) so callers can
 *  distinguish an auth/rate-limit failure from a malformed response. */
export class VisionError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly body?: string,
	) {
		super(message)
		this.name = "VisionError"
	}
}

export interface DescribeImageResult {
	description: string
	/** Real token counts from the provider, for budget/usage accounting. */
	usage: AuxLlmUsage
}

export interface DescribeImageOptions {
	/** Model id. Default: HEADLESSCODE_VISION_MODEL, then DEFAULT_VISION_MODEL. */
	model?: string
	/** Reuses HEADLESSCODE_OPENROUTER_API_KEY when omitted. */
	apiKey?: string
	/** Reuses OPENROUTER_BASE_URL when omitted. */
	baseUrl?: string
	/** Injectable fetch (tests). Defaults to global fetch. */
	fetchImpl?: typeof fetch
	timeoutMs?: number
	/** External abort (e.g. a tool-level deadline). */
	signal?: AbortSignal
	systemPrompt?: string
	maxTokens?: number
}

function mimeTypeFor(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase()
	switch (ext) {
		case ".jpg":
		case ".jpeg":
			return "image/jpeg"
		case ".webp":
			return "image/webp"
		case ".gif":
			return "image/gif"
		default:
			return "image/png"
	}
}

/** Caption one image file via OpenRouter's multimodal chat-completions
 *  endpoint. Reads the file, base64-encodes it into a standard OpenAI-
 *  compatible `image_url` content part, and returns the description plus the
 *  real usage. Throws VisionError on any failure (missing file, network,
 *  HTTP error, malformed response). */
export async function describeImage(
	imagePath: string,
	options: DescribeImageOptions = {},
): Promise<DescribeImageResult> {
	const apiKey = options.apiKey ?? process.env.HEADLESSCODE_OPENROUTER_API_KEY
	if (!apiKey) {
		throw new VisionError(
			"HEADLESSCODE_OPENROUTER_API_KEY is not set. Set the environment variable HEADLESSCODE_OPENROUTER_API_KEY to use describeImage (vision captioning).",
		)
	}
	const model = options.model ?? process.env.HEADLESSCODE_VISION_MODEL ?? DEFAULT_VISION_MODEL
	const baseUrl = (options.baseUrl ?? visionBaseUrl()).replace(/\/+$/, "")
	const timeoutMs = options.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS
	const fetchImpl = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
	const maxTokens = options.maxTokens ?? 1024

	let imageBuffer: Buffer
	try {
		imageBuffer = await readFile(imagePath)
	} catch (err) {
		throw new VisionError(
			`describeImage: cannot read image file ${imagePath}: ${err instanceof Error ? err.message : String(err)}`,
		)
	}
	if (imageBuffer.length === 0) {
		throw new VisionError(`describeImage: image file ${imagePath} is empty (0 bytes)`)
	}

	const imageUrl = `data:${mimeTypeFor(imagePath)};base64,${imageBuffer.toString("base64")}`
	const body = {
		model,
		max_tokens: maxTokens,
		temperature: 0.2,
		messages: [
			{ role: "system", content: options.systemPrompt ?? VISION_SYSTEM_PROMPT },
			{
				role: "user",
				content: [
					{ type: "text", text: "Describe this image in the detail requested." },
					{ type: "image_url", image_url: { url: imageUrl } },
				],
			},
		],
	}

	const controller = new AbortController()
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	const onExternalAbort = () => controller.abort()
	options.signal?.addEventListener("abort", onExternalAbort, { once: true })

	let response: Response
	try {
		response = await fetchImpl(`${baseUrl}/api/v1/chat/completions`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"content-type": "application/json",
			},
			signal: controller.signal,
			body: JSON.stringify(body),
		})
	} catch (err) {
		if (timedOut) {
			throw new VisionError(`Vision request to OpenRouter timed out after ${timeoutMs}ms`)
		}
		if (err instanceof Error && err.name === "AbortError") {
			throw err // caller-managed external abort
		}
		throw new VisionError(
			`Network error calling OpenRouter vision endpoint: ${err instanceof Error ? err.message : String(err)}`,
		)
	} finally {
		clearTimeout(timer)
		options.signal?.removeEventListener("abort", onExternalAbort)
	}

	if (!response.ok) {
		const rawBody = await response.text().catch(() => "")
		const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
		throw new VisionError(
			`OpenRouter vision request returned HTTP ${response.status}: ${excerpt || "(empty)"}`,
			response.status,
			excerpt,
		)
	}

	// Same raw-body-first discipline as the main OpenRouter client: 200 does
	// not guarantee a well-formed choices[] payload.
	const rawBody = await response.text()
	let data:
		| {
				model?: string
				choices?: Array<{ message?: { content?: string | null }; finish_reason?: string }>
				usage?: {
					prompt_tokens?: number
					completion_tokens?: number
					prompt_tokens_details?: { cached_tokens?: number }
				}
				error?: { message?: string; code?: unknown }
		  }
		| undefined
	try {
		data = JSON.parse(rawBody)
	} catch {
		const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
		throw new VisionError(`OpenRouter vision request returned HTTP 200 with a non-JSON/unparseable body: ${excerpt || "(empty)"}`)
	}
	if (data?.error) {
		throw new VisionError(
			`OpenRouter vision request returned HTTP 200 with an error envelope: ${data.error.message ?? JSON.stringify(data.error)}`,
		)
	}
	const description = data?.choices?.[0]?.message?.content
	if (!data || typeof description !== "string" || description.trim() === "") {
		const finishReason = data?.choices?.[0]?.finish_reason
		const excerpt = rawBody.length > 500 ? `${rawBody.slice(0, 500)}…` : rawBody
		throw new VisionError(
			`OpenRouter vision response contained no choices[0].message.content` +
				(finishReason ? ` (finish_reason: ${finishReason})` : "") +
				`. Raw body: ${excerpt || "(empty)"}`,
		)
	}

	const usage: AuxLlmUsage = {
		model: data.model ?? model,
		inputTokens: data.usage?.prompt_tokens ?? 0,
		outputTokens: data.usage?.completion_tokens ?? 0,
		cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens,
	}

	return { description, usage }
}
