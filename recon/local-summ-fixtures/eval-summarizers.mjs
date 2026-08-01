/**
 * Manual evaluation harness for local-model output summarization.
 *
 * Reads the realistic large-output fixtures in recon/local-summ-fixtures/,
 * sends each to a local Ollama chat model for summarization, and writes:
 *   - recon/local-summ-eval/<model>/<fixture>.summary.txt  (model summary)
 *   - recon/local-summ-eval/<model>/<fixture>.meta.json    (timing/tokens)
 *
 * Run with: node recon/local-summ-fixtures/eval-summarizers.mjs
 * (plain Node 18+ fetch — no tsx needed, this is a one-off eval script.)
 */

import * as fs from "node:fs"
import * as path from "node:path"

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434"
const MODELS = ["qwen3:8b", "llama3.1:8b"]
const FIXTURES = ["test-log.txt", "grep-result.txt", "npm-install-log.txt"]
const OUT_ROOT = path.resolve(import.meta.dirname, "../local-summ-eval")

const SYSTEM_PROMPT =
	"Your job: compress LARGE command output for a software engineering agent. " +
	"Preserve anything that could matter for a coding decision: failures, errors, warnings, " +
	"exit codes, and exact error/warning messages (verbatim). Noise (progress lines, repeated " +
	"ok lines) may be dropped. Be concise and factual. Do not add analysis or advice."

const USER_PROMPT =
	"Summarize the following command output. Keep any errors/warnings/failures and their exact " +
	"messages. Stay under 400 words.\n\n=== OUTPUT BEGIN ===\n%s\n=== OUTPUT END ==="

async function summarize(model, text) {
	const url = `${OLLAMA_URL}/api/chat`
	const started = Date.now()
	const resp = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model,
			messages: [
				{ role: "system", content: SYSTEM_PROMPT },
				{ role: "user", content: USER_PROMPT.replace("%s", text) },
			],
			stream: false,
			...(model.startsWith("qwen3") ? { think: false } : {}),
			options: { num_predict: 600, temperature: 0 },
		}),
	})
	if (!resp.ok) {
		throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`)
	}
	const data = await resp.json()
	const elapsedMs = Date.now() - started
	const content = data?.message?.content
	if (typeof content !== "string" || content.trim() === "") {
		throw new Error(`no message.content in response: ${JSON.stringify(data).slice(0, 500)}`)
	}
	return { content, elapsedMs, totalDuration: data.total_duration, evalCount: data.eval_count, promptEvalCount: data.prompt_eval_count }
}

for (const model of MODELS) {
	const modelDir = path.join(OUT_ROOT, model.replace(":", "-"))
	fs.mkdirSync(modelDir, { recursive: true })
	for (const fixture of FIXTURES) {
		const text = fs.readFileSync(path.join(import.meta.dirname, fixture), "utf-8")
		try {
			const r = await summarize(model, text)
			fs.writeFileSync(path.join(modelDir, `${fixture}.summary.txt`), r.content)
			fs.writeFileSync(
				path.join(modelDir, `${fixture}.meta.json`),
				JSON.stringify(
					{
						model,
						fixture,
						originalChars: text.length,
						summaryChars: r.content.length,
						compressionRatio: (text.length / r.content.length).toFixed(1),
						elapsedMs: r.elapsedMs,
						totalDurationMs: Math.round((r.totalDuration ?? 0) / 1e6),
						evalTokens: r.evalCount,
						promptTokens: r.promptEvalCount,
					},
					null,
					2,
				),
			)
			console.log(`  ${model} ${fixture}: ${text.length} -> ${r.content.length} chars in ${r.elapsedMs}ms`)
		} catch (err) {
			console.error(`  ${model} ${fixture}: FAILED: ${err.message}`)
		}
	}
}
console.log("done")
