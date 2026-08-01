/**
 * `headlesscode index` subcommand — build/refresh the codebase-search index.
 *
 *   npx tsx src/cli.ts index --workspace <path> [--model <id>]
 *
 * Walks the workspace's real source files (git-aware, .gitignore-respecting),
 * chunks them, embeds ONLY the chunks whose content hash changed since the
 * last index (incremental — the cost-control mechanism), and writes
 * <workspace>/.headlesscode/codesearch/index.jsonl.
 *
 * Indexing is a SEPARATE, EXPLICIT step (it costs real money and takes real
 * time) — it is never auto-triggered mid-session. Sessions consume whatever
 * index already exists or tell the model to ask a human to build one.
 */

import * as path from "node:path"

import { OpenRouterEmbedder, resolveEmbeddingModel } from "./embedder.js"
import { buildIndex, indexFilePath } from "./index.js"
import { estimateCost, priceFor } from "../budget/cost.js"

const INDEX_USAGE = `headlesscode index — build/refresh the codebase semantic-search index

Usage:
  headlesscode index --workspace <path> [--model <id>]

Options:
  --workspace <path>   Workspace root to index (required)
  --model <id>         Embedding model id (default: $HEADLESSCODE_EMBEDDING_MODEL
                       or ${resolveEmbeddingModel()})
  --help               Show this help and exit

This builds (or incrementally refreshes) the codebase-search index at
<workspace>/.headlesscode/codesearch/index.jsonl used by the codebase_search
tool. Chunks whose content hash is unchanged since the last index are skipped
without re-embedding, so re-running after a small change only pays for the
changed chunks.
`

interface IndexCliOptions {
	workspace?: string
	model?: string
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
			case "--model": {
				const value = next()
				if (value === undefined) {
					return { options, error: `Missing value for ${flag}` }
				}
				if (flag === "--workspace") {
					options.workspace = value
				} else {
					options.model = value
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
	const model = resolveEmbeddingModel(process.env, options.model)

	if (!process.env.OPENROUTER_API_KEY) {
		process.stderr.write("headlesscode index: OPENROUTER_API_KEY is not set (required for cloud embedding).\n")
		return 2
	}

	const embedder = new OpenRouterEmbedder(model)
	process.stdout.write(`Indexing workspace: ${workspaceRoot}\n`)
	process.stdout.write(`Embedding model:    ${embedder.model}\n`)

	try {
		const result = await buildIndex(embedder, workspaceRoot, (scanned, total) => {
			process.stdout.write(`\r  scanned ${scanned}/${total} files`)
		})
		if (result.filesScanned > 0) {
			process.stdout.write(`\r  scanned ${result.filesScanned}/${result.filesScanned} files\n`)
		} else {
			process.stdout.write("\n")
		}

		const price = priceFor(result.model)
		const estCostUsd = estimateCost({
			model: result.model,
			inputTokens: result.promptTokens,
			outputTokens: 0,
		})
		const indexFile = indexFilePath(workspaceRoot)
		process.stdout.write(
			`Index written: ${indexFile}\n` +
				`  files scanned:        ${result.filesScanned}\n` +
				`  chunks embedded:      ${result.chunksEmbedded}\n` +
				`  chunks skipped (unchanged): ${result.chunksSkipped}\n` +
				`  chunks removed:       ${result.chunksRemoved}\n` +
				`  total chunks:         ${result.totalChunks}\n` +
				`  embedding tokens:     ${result.promptTokens}\n` +
				`  estimated cost:       $${estCostUsd.toFixed(6)} (${result.model} @ $${price.input}/1M input)\n`,
		)
		return 0
	} catch (err) {
		process.stderr.write(
			`headlesscode index: ${err instanceof Error ? err.message : String(err)}\n`,
		)
		return 1
	}
}
