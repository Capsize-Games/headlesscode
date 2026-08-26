/**
 * `headlesscode index` subcommand — build/refresh the codebase-search index.
 *
 *   npx tsx src/cli.ts index --workspace <path> [--model <id>] [--embedding-backend <openrouter|ollama|airunner>]
 *
 * Walks the workspace's real source files (git-aware, .gitignore-respecting),
 * chunks them, embeds ONLY the chunks whose content hash changed since the
 * last index (incremental — the cost-control mechanism), and writes the index
 * into the CENTRAL per-project data store
 * (~/.local/share/headlesscode/projects/<key>/codesearch/index.jsonl — see
 * src/project-store.ts). Worktrees of a repo share that store automatically.
 *
 * Three embedding backends are supported:
 *   - openrouter (default) — cloud, `qwen/qwen3-embedding-4b`, costs real
 *     money (priced in src/budget/cost.ts);
 *   - ollama (opt-in) — local `qwen3-embedding:8b` via
 *     HEADLESSCODE_OLLAMA_URL (default http://localhost:11434). Free, no
 *     cost tracking; produces 4096-dim vectors, NOT interchangeable with the
 *     cloud model's 2560-dim vectors (a backend switch requires a full
 *     reindex — the build handles it automatically by treating every stored
 *     vector from the other backend as stale);
 *   - airunner (opt-in) — local intfloat/e5-large via the AIRunner server's
 *     native embedding endpoint (HEADLESSCODE_AIRUNNER_EMBED_URL, default
 *     http://localhost:8080). Free, no cost tracking; produces 1024-dim
 *     vectors, again NOT interchangeable with the other backends' vectors.
 *
 * Indexing is a SEPARATE, EXPLICIT step (it costs real money and takes real
 * time) — it is never auto-triggered mid-session. Sessions consume whatever
 * index already exists or tell the model to ask a human to build one.
 */

import * as path from "node:path"

import {
	createEmbedder,
	EMBEDDING_BACKEND_ENV,
	OPENROUTER_EMBEDDING_MODEL_ENV,
	resolveEmbeddingBackend,
	resolveEmbeddingModel,
} from "./embedder.js"
import { buildIndex, indexFilePath } from "./index.js"
import { estimateCost, priceFor } from "../budget/cost.js"
import { DEFAULT_AIRUNNER_EMBEDDING_MODEL, AIRUNNER_EMBEDDING_MODEL_ENV } from "./airunner-embedder.js"
import { DEFAULT_OLLAMA_EMBEDDING_MODEL, OLLAMA_EMBEDDING_MODEL_ENV } from "./ollama-embedder.js"

const INDEX_USAGE = `headlesscode index — build/refresh the codebase semantic-search index

Usage:
  headlesscode index --workspace <path> [--model <id>] [--embedding-backend <openrouter|ollama|airunner>]

Options:
  --workspace <path>      Workspace root to index (required)
  --model <id>            OpenRouter embedding model id (default:
                          $OPENROUTER_EMBEDDING_MODEL or ${resolveEmbeddingModel()})
  --embedding-backend <b> Embedding backend: openrouter (default), ollama
                          (local, opt-in), or airunner (local AIRunner
                          server, opt-in). Default: $HEADLESSCODE_EMBEDDING_BACKEND
                          or openrouter
  --help                  Show this help and exit

Environment:
  HEADLESSCODE_EMBEDDING_BACKEND          openrouter | ollama | airunner (default openrouter)
  HEADLESSCODE_EMBEDDING_MODEL            OpenRouter embedding model override
  HEADLESSCODE_OPENROUTER_EMBEDDING_MODEL OpenRouter embedding model override
                                          (preferred for clarity)
  HEADLESSCODE_OLLAMA_URL                 Ollama server URL (default http://localhost:11434)
  HEADLESSCODE_OLLAMA_EMBEDDING_MODEL     Ollama embedding model (default ${DEFAULT_OLLAMA_EMBEDDING_MODEL})
  HEADLESSCODE_AIRUNNER_EMBED_URL         AIRunner server URL (default http://localhost:8080)
  HEADLESSCODE_AIRUNNER_EMBED_MODEL       AIRunner embedding model (default ${DEFAULT_AIRUNNER_EMBEDDING_MODEL})

This builds (or incrementally refreshes) the codebase-search index used by the
codebase_search tool. The index is stored in the CENTRAL per-project data store
(~/.local/share/headlesscode/projects/<key>/codesearch/index.jsonl) — keyed by
the repo's git-common-dir, so every worktree of a repo shares one index with
zero per-directory setup. Chunks whose content hash is unchanged since the last
index are skipped without re-embedding, so re-running after a small change only
pays for the changed chunks.
`

interface IndexCliOptions {
	workspace?: string
	model?: string
	embeddingBackend?: string
	help: boolean
}

export function parseIndexArgs(argv: string[]): { options: IndexCliOptions; error?: string } {
	const options: IndexCliOptions = { help: false }
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		const eq = arg.indexOf("=")
		const flag = eq === -1 ? arg : arg.slice(0, eq)
		const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1)
		const next = (): string | undefined => {
			if (inlineValue !== undefined) {
				return inlineValue
			}
			const v = argv[i + 1]
			if (v === undefined || v.startsWith("--")) {
				return undefined
			}
			i++
			return v
		}
		switch (flag) {
			case "--workspace":
			case "--model":
			case "--embedding-backend": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				if (flag === "--workspace") {
					options.workspace = value
				} else if (flag === "--model") {
					options.model = value
				} else {
					options.embeddingBackend = value
				}
				break
			}
			case "--help":
			case "-h":
				options.help = true
				break
			default:
				return { options, error: `Unknown argument: ${arg}` }
		}
	}
	return { options }
}

export async function indexMain(argv: string[]): Promise<number> {
	const { options, error } = parseIndexArgs(argv)
	if (error) {
		process.stderr.write(`headlesscode index: ${error}\n\n${INDEX_USAGE}`)
		return 2
	}
	if (options.help) {
		process.stdout.write(INDEX_USAGE)
		return 0
	}
	if (!options.workspace) {
		process.stderr.write(`headlesscode index: --workspace <path> is required\n\n${INDEX_USAGE}`)
		return 2
	}

	const workspaceRoot = path.resolve(options.workspace)
	const backend = resolveEmbeddingBackend(process.env, options.embeddingBackend)

	const embedder = createEmbedder(backend, { model: options.model }, process.env)
	const modelForEnv = options.model?.trim() || process.env[OPENROUTER_EMBEDDING_MODEL_ENV]?.trim()

	if (backend === "openrouter" && !process.env.HEADLESSCODE_OPENROUTER_API_KEY) {
		process.stderr.write("headlesscode index: HEADLESSCODE_OPENROUTER_API_KEY is not set (required for cloud embedding).\n")
		return 2
	}

	process.stdout.write(`Indexing workspace: ${workspaceRoot}\n`)
	process.stdout.write(`Embedding backend:  ${backend}\n`)
	process.stdout.write(`Embedding model:    ${embedder.model}\n`)
	if (backend === "ollama") {
		const ollamaModel = process.env[OLLAMA_EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_OLLAMA_EMBEDDING_MODEL
		process.stdout.write(`  (local, no embedding cost — model: ${ollamaModel})\n`)
	}
	if (backend === "airunner") {
		const airunnerModel = process.env[AIRUNNER_EMBEDDING_MODEL_ENV]?.trim() || DEFAULT_AIRUNNER_EMBEDDING_MODEL
		process.stdout.write(`  (local AIRunner server, no embedding cost — model: ${airunnerModel})\n`)
	}

	try {
		const result = await buildIndex(
			embedder,
			workspaceRoot,
			(scanned, total) => {
				process.stdout.write(`\r  scanned ${scanned}/${total} files`)
			},
			backend,
			(embedded, total) => {
				process.stdout.write(`\r  embedded ${embedded}/${total} chunks`)
			},
		)
		if (result.filesScanned > 0) {
			process.stdout.write(`\r  scanned ${result.filesScanned}/${result.filesScanned} files\n`)
		} else {
			process.stdout.write("\n")
		}
		// The embedding phase used to run fully silent (a large repo looked
		// "stalled" between the scan line and the summary — live report
		// 2026-08-16). Keep the final state of the per-batch progress visible.
		process.stdout.write(`  embedded ${result.chunksEmbedded}/${result.chunksEmbedded} chunks\n`)

		const indexFile = indexFilePath(workspaceRoot)
		const costLine =
			backend === "openrouter"
				? (() => {
						const price = priceFor(result.model)
						const estCostUsd = estimateCost({
							model: result.model,
							inputTokens: result.promptTokens,
							outputTokens: 0,
						})
						return `  estimated cost:       $${estCostUsd.toFixed(6)} (${result.model} @ $${price.input}/1M input)\n`
					})()
				: `  estimated cost:       $0.00 (local backend — no cloud spend)\n`
		process.stdout.write(
			`Index written: ${indexFile}\n` +
				`  files scanned:        ${result.filesScanned}\n` +
				`  chunks embedded:      ${result.chunksEmbedded}\n` +
				`  chunks skipped (unchanged): ${result.chunksSkipped}\n` +
				`  chunks removed:       ${result.chunksRemoved}\n` +
				`  total chunks:         ${result.totalChunks}\n` +
				`  embedding tokens:     ${result.promptTokens}\n` +
				costLine,
		)
		return 0
	} catch (err) {
		process.stderr.write(
			`headlesscode index: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}
}
