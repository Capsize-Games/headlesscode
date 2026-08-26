/**
 * `browser_action` handler: the session lifecycle + timeout enforcement.
 *
 * Every browser action runs under an overall wall-clock timeout
 * (DEFAULT_BROWSER_ACTION_TIMEOUT_MS) using Promise.race — a hung or crashed
 * browser action surfaces as a clear tool error and NEVER hangs the session.
 * The timeout kills (rather than backgrounds) the stuck action: unlike a
 * timed-out execute_command (which the model intentionally backgrounds to
 * keep a dev server running), a stuck browser action is never something the
 * model asked to keep running — it is a failure of the action itself.
 *
 * Session lifecycle mirrors the harness's non-fatal/cleanup idioms:
 *   - The browser is created lazily on the first launch and stays alive for
 *     the session (a dev server inspection span multiple calls).
 *   - ToolExecutor.dispose() calls BrowserSession.dispose() (via
 *     disposeBrowserSessions) so the browser is torn down at session end even
 *     if the model never calls close() — same discipline as the backgrounded
 *     execute_command children (see src/tools/executor.ts).
 *   - A launched browser is also hard-killed via the module-level process
 *     exit hook (installBrowserDisposeHook in service.ts), belt-and-suspenders
 *     for teardown paths that skip dispose().
 *
 * Screenshot results are written to `<workspaceRoot>/.headlesscode/
 * browser-screenshots/<timestamp>.png` and the PNG is immediately described by
 * the cloud vision captioner (src/vision/describe.ts), so the tool result
 * carries a real TEXT description the main model can act on — no raw image
 * ever reaches it. The file path stays in the result too, for callers that
 * want the raw PNG.
 */

import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { AuxLlmUsage, ToolContext, ToolResult } from "../../engine/types.js"
import { resolveWithinWorkspace } from "../executor.js"
import { describeImage, type DescribeImageResult } from "../../vision/describe.js"
import {
	BrowserSession,
	MAX_BROWSER_EVENT_ENTRIES,
	DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
	installBrowserDisposeHook,
} from "./service.js"
import { browserActionTool, BROWSER_ACTION_NAME } from "./tool.js"

export { browserActionTool, BROWSER_ACTION_NAME }

/** Subdirectory (under the workspace root) where screenshots are written. */
const SCREENSHOTS_SUBDIR = ".headlesscode/browser-screenshots"

// ─── Session registry ────────────────────────────────────────────────────────

/**
 * Active browser sessions, keyed by workspace root. One ToolExecutor serves
 * one session, and the browser may outlive a single tool call (that is the
 * point — an interactive inspection spans multiple browser_action calls), so
 * the session lives at module scope and ToolExecutor.dispose() tears it down
 * at true session end. Keying by workspace root keeps independent sessions
 * (e.g. a QA executor in the same process) from sharing a browser.
 */
const browserSessions = new Map<string, BrowserSession>()

function sessionFor(ctx: ToolContext): BrowserSession {
	let session = browserSessions.get(ctx.workspaceRoot)
	if (session === undefined) {
		session = new BrowserSession()
		browserSessions.set(ctx.workspaceRoot, session)
	}
	return session
}

/**
 * Session teardown for every known browser session: hard-close the browser
 * AND kill the residual Chromium process group (see BrowserSession.dispose).
 * Called from ToolExecutor.dispose(), so a launched browser never survives
 * its session even when the model never calls close().
 */
export function disposeBrowserSessions(): void {
	for (const session of browserSessions.values()) {
		void session.dispose()
	}
	browserSessions.clear()
}

// ─── Arg validation ──────────────────────────────────────────────────────────

export type BrowserAction =
	| "launch"
	| "screenshot"
	| "click"
	| "type"
	| "getConsoleLogs"
	| "getNetworkErrors"
	| "close"

function requireStringArg(args: Record<string, unknown>, key: string): string {
	const v = args[key]
	if (typeof v !== "string" || v.trim() === "") {
		throw new Error(`browser_action: missing or invalid string argument '${key}' (got ${JSON.stringify(v)})`)
	}
	return v
}

const VALID_ACTIONS: readonly BrowserAction[] = [
	"launch",
	"screenshot",
	"click",
	"type",
	"getConsoleLogs",
	"getNetworkErrors",
	"close",
]

function parseAction(args: Record<string, unknown>): BrowserAction {
	const raw = args.action
	const action = typeof raw === "string" ? raw : ""
	if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
		throw new Error(
			`browser_action: invalid action '${raw}'. Valid actions: ${VALID_ACTIONS.join(", ")}`,
		)
	}
	return action as BrowserAction
}

// ─── Timeout enforcement ─────────────────────────────────────────────────────

/**
 * Run a browser action under an overall wall-clock timeout. The action's
 * Playwright internals already carry per-step timeouts; this is the outer
 * bound that catches the "whole browser hung" case (e.g. the page never
 * settles, the browser crashed mid-action). We KILL on timeout rather than
 * background: unlike execute_command, nothing about a stuck browser action is
 * legitimately long-running work the model asked for.
 */
async function withActionTimeout<T>(fn: () => Promise<T>): Promise<T> {
	// Env override so tests can exercise the timeout fast; production default
	// is DEFAULT_BROWSER_ACTION_TIMEOUT_MS.
	const timeoutMs = Number(process.env.BROWSER_ACTION_TIMEOUT_MS ?? "") || DEFAULT_BROWSER_ACTION_TIMEOUT_MS
	let timer: NodeJS.Timeout | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(
				new Error(
					`browser_action: action timed out after ${timeoutMs / 1000}s — ` +
						`the browser or page appears hung. Call close() (or let the session end) to reset.`,
				),
			)
		}, timeoutMs)
	})
	try {
		return await Promise.race([fn(), timeout])
	} finally {
		clearTimeout(timer)
	}
}

// ─── Formatting helpers ──────────────────────────────────────────────────────

function formatConsoleEntries(entries: Array<{ type: string; text: string }>): string {
	if (entries.length === 0) {
		return "no console messages captured since the last check"
	}
	const lines = entries.map((e) => `[${e.type}] ${e.text}`)
	return lines.join("\n")
}

function formatNetworkErrors(entries: Array<{ url: string; failure: string; method: string }>): string {
	if (entries.length === 0) {
		return "no failed network requests captured since the last check"
	}
	const lines = entries.map((e) => `${e.method} ${e.url} — ${e.failure}`)
	return lines.join("\n")
}

function ok(content: string): ToolResult {
	return { content, isError: false }
}

function err(content: string): ToolResult {
	return { content: `[Error] ${content}`, isError: true }
}

/**
 * Resolve a screenshot target path inside the workspace and ensure the
 * screenshots directory exists.
 */
async function resolveScreenshotPath(workspaceRoot: string): Promise<string> {
	const dir = resolveWithinWorkspace(workspaceRoot, SCREENSHOTS_SUBDIR)
	await fsp.mkdir(dir, { recursive: true })
	const stamp = new Date().toISOString().replace(/[:.]/g, "-")
	return path.join(dir, `screenshot-${stamp}.png`)
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/**
 * The screenshot action's captioner, injectable for tests. Real sessions
 * always use describeImage (src/vision/describe.ts); browser-action.test.ts
 * swaps in a fake so the suite needs no network/API key.
 */
let visionCaptioner: (imagePath: string) => Promise<DescribeImageResult> = (imagePath) => describeImage(imagePath)

/** Test seam: replace the screenshot captioner (see browser-action.test.ts). */
export function setVisionCaptionerForTest(
	captioner: (imagePath: string) => Promise<DescribeImageResult>,
): void {
	visionCaptioner = captioner
}

export async function browserActionHandler(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	const action = parseAction(args)

	// A closed browser is not a hard error — it is the session's normal
	// "explicitly cleaned up" state, so a model that calls close() then
	// re-launches gets a clean result, not an error that counts as a mistake.
	if (action !== "launch") {
		const session = browserSessions.get(ctx.workspaceRoot)
		if (session === undefined || !session.isLaunched) {
			return ok("browser: no browser is open — call launch(url) first to start one")
		}
	}

	// Module-level process-exit cleanup, idempotent; ensures the browser never
	// outlives the harness process even on teardown paths that skip dispose().
	installBrowserDisposeHook()

	try {
		return await withActionTimeout(async () => {
			switch (action) {
				case "launch": {
					const url = requireStringArg(args, "url")
					const session = sessionFor(ctx)
					// Re-launch is an explicit reset: close the previous browser
					// first so its state never leaks into the fresh session.
					await session.dispose()
					await session.launch(url)
					// Let the page settle so capture-time console/network events
					// are recorded before the model drains them.
					await session.waitForIdle()
					return ok(await session.describe())
				}

				case "screenshot": {
					const session = sessionFor(ctx)
					const base64 = await session.screenshot()
					const target = await resolveScreenshotPath(ctx.workspaceRoot)
					await fsp.writeFile(target, Buffer.from(base64, "base64"))
					const desc = await session.describe()
					// Cloud vision captioning: the PNG never reaches the main
					// model (deepseek-v4-flash is text-only), so describe it
					// here and put a real text description in the result. Only
					// when a real accounting session wired onAuxLlmUsage (cost
					// flows through BudgetTracker); bare/read-only executors
					// skip the call and keep the path so the model can still
					// invoke describe_image explicitly.
					let captionNote = ""
					if (ctx.onAuxLlmUsage !== undefined) {
						try {
							const { description, usage } = await visionCaptioner(target)
							ctx.onAuxLlmUsage(usage)
							captionNote = `\nimage description: ${description}`
						} catch (err) {
							// Captioning is a bonus on top of the screenshot —
							// a vision failure must never fail the screenshot
							// itself, just say so and keep the file path.
							captionNote = `\n[image description failed: ${err instanceof Error ? err.message : String(err)}]`
						}
					}
					return ok(
						`${desc}\nscreenshot saved to ${path.relative(ctx.workspaceRoot, target).toPosix()} (${target})${captionNote}`,
					)
				}

				case "click": {
					const selector = requireStringArg(args, "selector")
					const session = sessionFor(ctx)
					await session.click(selector)
					// Interaction may have triggered a navigation or console
					// errors — settle, then report the current state.
					await session.waitForIdle()
					const navigations = await session.getNavigations()
					const navNote =
						navigations.length > 0
							? `\npage navigated to: ${navigations.map((n) => n.url).join(", ")}`
							: ""
					return ok(`${await session.describe()}\nclicked ${selector}${navNote}`)
				}

				case "type": {
					const selector = requireStringArg(args, "selector")
					const text = requireStringArg(args, "text")
					const session = sessionFor(ctx)
					await session.type(selector, text)
					return ok(`${await session.describe()}\ntyped text into ${selector}`)
				}

				case "getConsoleLogs": {
					const session = sessionFor(ctx)
					const entries = await session.getConsoleLogs()
					const shown = entries.slice(0, MAX_BROWSER_EVENT_ENTRIES)
					const truncated =
						entries.length > MAX_BROWSER_EVENT_ENTRIES
							? `\n…${entries.length - MAX_BROWSER_EVENT_ENTRIES} more entries (capped at ${MAX_BROWSER_EVENT_ENTRIES})`
							: ""
					return ok(formatConsoleEntries(shown) + truncated)
				}

				case "getNetworkErrors": {
					const session = sessionFor(ctx)
					const entries = await session.getNetworkErrors()
					const shown = entries.slice(0, MAX_BROWSER_EVENT_ENTRIES)
					const truncated =
						entries.length > MAX_BROWSER_EVENT_ENTRIES
							? `\n…${entries.length - MAX_BROWSER_EVENT_ENTRIES} more entries (capped at ${MAX_BROWSER_EVENT_ENTRIES})`
							: ""
					return ok(formatNetworkErrors(shown) + truncated)
				}

				case "close": {
					const session = sessionFor(ctx)
					await session.close()
					return ok("browser: closed")
				}
			}
		})
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		// A crashed/hung browser must never take the whole session down with
		// it: tear it down (awaiting, so a subsequent launch starts from a
		// deterministic closed state) so the model can recover with a fresh
		// launch.
		try {
			await browserSessions.get(ctx.workspaceRoot)?.dispose()
		} catch {
			// Best-effort teardown — the original error is the one to report.
		}
		return err(message)
	}
}

// Reference the schema export so bundlers/type-checkers keep it reachable
// from this module (it is also re-exported above).
void browserActionTool
