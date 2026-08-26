/**
 * `run_tests` — run the SPECIFIC test file(s) relevant to a set of changed
 * files, instead of always paying the full `npm test` cost (~70 files,
 * measured 111s live) during the iterative edit-check-edit loop.
 *
 * Selection is the heuristic in src/tools/test-selection.ts (direct
 * `src/foo/bar.ts` → `src/foo/__tests__/bar.test.ts` match, then reverse
 * dependency via the REAL import graph — the same resolution the
 * `import_graph` tool uses), and the matched files run through the SAME
 * `tsx` invocation `npm test` uses per-file, sequentially, stopping at the
 * first failure exactly like `npm test`'s `&&` chain.
 *
 * SECURITY: the selected test paths come from an untrusted workspace (they
 * are file names that can contain shell metacharacters), so they are passed
 * to `spawn` as ARGV with `shell: false` — never interpolated into a shell
 * command string. See issue #62 (the old `shellQuote` allowed command
 * substitution via `$()`/backticks in a hostile test file name).
 *
 * IMPORTANT (this is the tool's whole point, stated to the model): a
 * passing selective run is NOT full-suite green. The FULL `npm test` is
 * still what gates a merge/PR and is still required once before
 * `attempt_completion`. This tool exists to make the per-edit loop cheap,
 * not to replace the final confidence run.
 */

import { execFileSync, spawn } from "node:child_process"
import type OpenAI from "openai"

import type { ToolContext, ToolResult } from "../engine/types.js"
import { getCodeIntelCache } from "../codeintel/program.js"
import { selectTestsForChangedFiles } from "./test-selection.js"

export const RUN_TESTS_NAME = "run_tests"

/** Default per-test-file timeout, seconds (a single tsx-invoked suite). */
const DEFAULT_TEST_TIMEOUT_S = 180

const RUN_TESTS_DESCRIPTION = `Run the SPECIFIC test file(s) relevant to one or more changed files, instead of always paying the full npm test cost during the iterative edit-check-edit loop. Selection is automatic: for each changed file it looks for a direct test (src/foo/bar.ts → src/foo/__tests__/bar.test.ts), then for test files that import the changed file (via the real import graph, 1-2 hops). Matched files run through the same tsx invocation npm test uses per-file, sequentially, stopping at the first failure.

Use this after editing a file to quickly verify you didn't break its tests — NOT as a replacement for the full suite. A passing selective run does NOT prove the whole project is green: run the full npm test once right before attempt_completion.

When no specific test matches (e.g. you changed package.json or a script), the tool reports "no specific tests matched — consider running the full suite" honestly rather than silently running nothing.

Parameters:
- paths: (optional) The changed file path(s), relative to the workspace root. Omit to infer from the session's baseline checkpoint (or the workspace's git status when no checkpoint service is active).
- timeout: (optional) Per-test-file timeout in seconds (default 180).

Example: { "paths": ["src/tools/executor.ts"], "timeout": 120 }`

const RT_PATHS_PARAMETER_DESCRIPTION = `Changed file path(s), relative to the workspace root. Omit to infer from the session's baseline checkpoint (or the workspace's git status).`
const RT_TIMEOUT_PARAMETER_DESCRIPTION = `Per-test-file timeout in seconds (default 180).`

export const runTestsTool = {
	type: "function",
	function: {
		name: RUN_TESTS_NAME,
		description: RUN_TESTS_DESCRIPTION,
		// Note: strict mode is intentionally disabled for this tool (mirrors
		// read_command_output.ts's precedent). With strict: true, every
		// property must be in `required`, which forces nullable-union types
		// (`type: ["array", "null"]`) for genuinely optional params so the
		// model can omit them — DeepSeek's OpenRouter endpoint rejects that
		// union-type syntax outright ("unknown variant `array`, expected one
		// of `string`, `number`, `integer`, `boolean`, `null`"), breaking
		// EVERY session's very first request since the tool list itself is
		// sent up front. Plain, non-strict optional properties avoid this
		// entirely and match how ask_followup_question's `follow_up`
		// (required) array param is already declared elsewhere.
		parameters: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: RT_PATHS_PARAMETER_DESCRIPTION,
				},
				timeout: {
					type: "integer",
					description: RT_TIMEOUT_PARAMETER_DESCRIPTION,
				},
			},
			additionalProperties: false,
		},
	},
} satisfies OpenAI.Chat.ChatCompletionTool

/** Infer changed files from the workspace's own git status (fallback). */
function changedFilesFromGit(workspaceRoot: string): string[] {
	try {
		const out = execFileSync("git", ["status", "--short", "--untracked-files=all"], {
			cwd: workspaceRoot,
			encoding: "utf-8",
			timeout: 15_000,
		})
		const files: string[] = []
		for (const line of out.split("\n")) {
			const trimmed = line.trim()
			if (trimmed === "") {
				continue
			}
			// Format: "<XY> <path>" (2 status chars + space); renames are
			// "R  old -> new" — the current path is the rename target.
			const m = trimmed.match(/^.{1,2}\s+(.+)$/)
			if (m === null) {
				continue
			}
			let p = m[1]!.trim()
			const arrow = p.indexOf(" -> ")
			if (arrow !== -1) {
				p = p.slice(arrow + 4)
			}
			files.push(p)
		}
		return files
	} catch {
		return []
	}
}

function ok(content: string): ToolResult {
	return { content, isError: false }
}

function err(content: string): ToolResult {
	return { content: `[Error] ${content}`, isError: true }
}

/** Cap on the combined test output fed back to the model. */
const MAX_TEST_OUTPUT_CHARS = 30_000

function truncateOutput(text: string): { text: string; truncated: boolean } {
	if (text.length <= MAX_TEST_OUTPUT_CHARS) {
		return { text, truncated: false }
	}
	return { text: `${text.slice(0, MAX_TEST_OUTPUT_CHARS)}\n…[output truncated]`, truncated: true }
}

interface OneFileResult {
	rel: string
	exitCode: number | null
	output: string
	timedOut: boolean
}

/**
 * Run one test file via `npx --no-install tsx <file>` (the npm-test
 * invocation). The test path is treated as UNTRUSTED input (it comes from a
 * workspace's file names): it is passed as a separate argv element with
 * `shell: false`, so no shell metacharacter in it — `$()`, backticks, `;`,
 * `&`, spaces, quotes — can ever be interpreted (issue #62). `npx
 * --no-install` avoids any network fetch if the local tsx is missing.
 */
export function runOneTestFile(workspaceRoot: string, rel: string, timeoutS: number): Promise<OneFileResult> {
	return new Promise((resolve) => {
		let stdout = ""
		let stderr = ""
		let settled = false
		let timedOut = false

		const finish = (exitCode: number | null): void => {
			if (!settled) {
				settled = true
				resolve({ rel, exitCode, output: `${stdout}${stderr}`, timedOut })
			}
		}

		let child
		try {
			child = spawn("npx", ["--no-install", "tsx", rel], {
				cwd: workspaceRoot,
				// `shell: false` (default) — argv is passed verbatim, never
				// re-parsed by a shell. This is the actual security boundary.
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8" },
			})
		} catch (error) {
			resolve({ rel, exitCode: null, output: `spawn error: ${error instanceof Error ? error.message : String(error)}`, timedOut: false })
			return
		}

		const timer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, timeoutS * 1000)

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString()
		})
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString()
		})
		child.on("error", (error) => {
			clearTimeout(timer)
			stdout += `spawn error: ${error.message}\n`
			finish(null)
		})
		child.on("close", (code) => {
			clearTimeout(timer)
			finish(code)
		})
	})
}

/**
 * Run the `run_tests` tool. `getSessionChangedFiles` is the session-provided
 * inference hook (checkpoint-diff based — see HeadlessSession); when absent
 * or returning undefined the handler falls back to the workspace git status.
 */
export async function runTestsHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
	getSessionChangedFiles?: () => Promise<string[] | undefined>,
): Promise<ToolResult> {
	const rawPaths = args.paths
	const timeoutS =
		typeof args.timeout === "number" && args.timeout > 0
			? args.timeout
			: typeof args.timeout === "string" && Number(args.timeout) > 0
				? Number(args.timeout)
				: DEFAULT_TEST_TIMEOUT_S

	let changedFiles: string[] | undefined
	if (Array.isArray(rawPaths) && rawPaths.length > 0) {
		changedFiles = rawPaths
			.filter((p): p is string => typeof p === "string" && p.trim() !== "")
			.map((p) => p.trim())
		if (changedFiles.length === 0) {
			return err("run_tests: 'paths' must be a non-empty array of file path strings")
		}
	}

	if (changedFiles === undefined) {
		// Session-baseline inference first (checkpoint diff), then git status.
		try {
			changedFiles = (await getSessionChangedFiles?.()) ?? changedFilesFromGit(ctx.workspaceRoot)
		} catch {
			changedFiles = changedFilesFromGit(ctx.workspaceRoot)
		}
	}
	if (changedFiles === undefined || changedFiles.length === 0) {
		return err(
			"run_tests: no changed files could be determined (no 'paths' given, no session baseline, and the workspace has no git status to read). Pass explicit 'paths', or run the full suite (npm test).",
		)
	}

	const intel = getCodeIntelCache(ctx.workspaceRoot).get()
	const { tests, notes } = selectTestsForChangedFiles(intel, ctx.workspaceRoot, changedFiles)

	if (tests.length === 0) {
		// Fail-safe: never report a silent pass of zero tests.
		return err(
			`run_tests: no specific tests matched for the changed file(s). ${notes.join("; ")} — consider running the full suite (npm test) instead of treating this as a pass.`,
		)
	}

	const header = `run_tests: ${tests.length} test file(s) matched for ${changedFiles.length} changed file(s):\n${tests
		.map((t) => `  ${t}`)
		.join("\n")}`
	const noteLine = notes.length > 0 ? `Selection notes:\n${notes.map((n) => `  - ${n}`).join("\n")}` : ""

	// Run each file sequentially, stopping at the first failure (mirrors
	// `npm test`'s `&&` chain). Failures and passes are both reported with
	// their real output — the model must not mistake a selective pass for a
	// full-suite green (the trailer says so explicitly).
	const blocks: string[] = [header, noteLine, ""]
	for (const rel of tests) {
		// Defense-in-depth (the argv spawn in runOneTestFile is the primary
		// boundary): reject paths containing newlines outright — they cannot
		// be legitimate test files, and they would let a workspace smuggle
		// forged "test result" content (a fake pass/fail line) into the tool
		// result. Nothing is run for such a path.
		if (/\r?\n/.test(rel)) {
			blocks.push(`── ${rel} ─ (skipped: path contains a newline — not a legitimate test file)`)
			blocks.push("[run_tests] FAILED: test path contains a newline (potential output-injection attempt)")
			return err(blocks.join("\n"))
		}
		const result = await runOneTestFile(ctx.workspaceRoot, rel, timeoutS)
		const { text: output, truncated } = truncateOutput(result.output)
		blocks.push(`── ${rel} ─${truncated ? " (output truncated)" : ""}`)
		blocks.push(output.trim() === "" ? "(no output)" : output)
		if (result.timedOut) {
			blocks.push(`[run_tests] ${rel} timed out after ${timeoutS}s (killed)`)
			return err(blocks.join("\n"))
		}
		if (result.exitCode !== 0) {
			blocks.push(`[run_tests] FAILED at ${rel} (exit ${result.exitCode ?? "spawn error"}) — remaining files not run (same as npm test's && chain)`)
			return err(blocks.join("\n"))
		}
		blocks.push(`[run_tests] ${rel} exited 0`)
	}

	blocks.push(
		"",
		"[run_tests] all matched test file(s) passed.",
		"NOTE: a passing selective run is NOT full-suite green — run the full `npm test` once before attempt_completion.",
	)
	return ok(blocks.join("\n"))
}

/** Exported for tests: the pure git-status fallback inference. */
export { changedFilesFromGit }
