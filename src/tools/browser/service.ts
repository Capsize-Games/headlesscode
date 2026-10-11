/**
 * Playwright-backed browser session service for the `browser_action` native
 * tool (see src/tools/browser/tool.ts for the tool-facing contract).
 *
 * This is NEW design work — a browser-automation tool for the coding agent to
 * inspect a running dev server mid-session. It is NOT a port of any upstream
 * Zoo Code feature (verified: no browser tool exists in the vendored core or
 * the reference clone; `docs/gap-audit.md`'s "No browser tool" line is a real
 * absence). The QA-side Playwright runner in a sibling project is a different,
 * report-generation concern; only the Playwright dependency choice is shared.
 *
 * Design decisions, matching the harness's own idioms:
 *
 * - One BrowserSession lives for the whole session, created lazily on the
 *   first `launch` action. Playwright's Chromium launches ~1s; it is the one
 *   browser that is guaranteed present in this repo's dev environment (the
 *   sibling project's QA runner already uses it, and its browsers are
 *   cached), so it needs no per-machine install guesswork.
 * - `getConsoleLogs`/`getNetworkErrors` are polled by the executor: the
 *   session keeps a rolling buffer of page console entries / failed requests
 *   (console and requestfailed are capture-time events; Playwright exposes no
 *   "past events" API), and each call drains the buffer so repeated calls
 *   return only NEW entries. Network-error collection deliberately does NOT
 *   use Playwright's request interception (route()), which would abort real
 *   requests and change page behavior — see collectNetworkErrors.
 * - Each browser action runs under an overall wall-clock timeout
 *   (DEFAULT_BROWSER_ACTION_TIMEOUT_MS) that also covers the launch/browser
 *   teardown. A stuck browser action must surface a clear tool error, never
 *   hang the session.
 */

import { chromium, type Browser, type BrowserContext, type BrowserServer, type Page } from "playwright"
import type { ChildProcess } from "node:child_process"

/** Cap on the number of console/network entries returned per call. */
export const MAX_BROWSER_EVENT_ENTRIES = 200

/** Overall per-action timeout (ms) — see the file header. */
export const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 20_000

/**
 * Timeout for a single click/type actionability wait (ms). Kept BELOW the
 * overall action timeout so a missing selector surfaces Playwright's precise
 * "waiting for locator" error instead of the generic action-timeout message.
 */
export const BROWSER_INTERACTION_TIMEOUT_MS = 15_000

/** Cap on screenshot bytes so tool results stay bounded (see tool.ts). */
export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

/** Single shared graceful-close deadline for browser.close + server.close. */
const BROWSER_GRACE_CLOSE_MS = 5_000

/** Bounded wait for the forced server.kill path. Keeps total < ~6.5s. */
const BROWSER_FORCE_KILL_MS = 1_000

/** A single captured console entry (page console, incl. errors). */
export interface ConsoleEntry {
	type: "log" | "info" | "warn" | "error" | "debug" | "trace" | string
	text: string
	ts: number
}

/** A single captured network failure (page requestfailed events). */
export interface NetworkErrorEntry {
	url: string
	failure: string
	method: string
	ts: number
}

/** A single captured page navigation (page.on("framenavigated")). */
export interface NavigationEntry {
	url: string
	ts: number
}

/** Owned launch-server handle retained for owner-only teardown. */
interface OwnedBrowserHandle {
	server: BrowserServer
	proc: ChildProcess | null
}

/** Live owned handles; only the process-exit hook may sweep these globally. */
const liveBrowserHandles = new Set<OwnedBrowserHandle>()

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms))
}

function procAlive(proc: ChildProcess | null): boolean {
	if (proc === null) {
		return false
	}
	try {
		const p = proc as unknown as { exitCode?: number | null; signalCode?: unknown; killed?: boolean }
		if (typeof p.exitCode !== "undefined" || typeof p.signalCode !== "undefined") {
			return p.exitCode === null && (p.signalCode === null || typeof p.signalCode === "undefined")
		}
		if (typeof p.killed === "boolean") {
			return !p.killed
		}
		return true
	} catch {
		return true
	}
}

function killProcSync(proc: ChildProcess | null): void {
	if (proc === null || !procAlive(proc)) {
		return
	}
	try {
		proc.kill("SIGKILL")
	} catch {
		// Already gone — nothing to clean up.
	}
}

/**
 * Bounded owner-only teardown for one session's browser + server + process.
 * browser.close() and server.close() share ONE graceful deadline and are both
 * invoked even if one hangs or rejects; afterwards only the owned
 * server/process is forced. Never rejects and never touches other sessions.
 */
async function teardownOwned(
	browser: Browser | null,
	server: BrowserServer | null,
	proc: ChildProcess | null,
): Promise<void> {
	if (browser === null && server === null && proc === null) {
		return
	}
	const graceful: Array<Promise<unknown>> = []
	if (browser !== null) {
		try {
			graceful.push(
				Promise.resolve()
					.then(() => browser.close())
					.then(
						() => undefined,
						() => undefined,
					),
			)
		} catch {
			graceful.push(Promise.resolve())
		}
	}
	if (server !== null) {
		try {
			graceful.push(
				Promise.resolve()
					.then(() => server.close())
					.then(
						() => undefined,
						() => undefined,
					),
			)
		} catch {
			graceful.push(Promise.resolve())
		}
	}
	try {
		await Promise.race([Promise.all(graceful), delay(BROWSER_GRACE_CLOSE_MS)])
	} catch {
		// Graceful path is fully observed above; a timeout simply moves to force.
	}
	if (server !== null) {
		try {
			await Promise.race([
				Promise.resolve()
					.then(() => server.kill())
					.then(
						() => undefined,
						() => undefined,
					),
				delay(BROWSER_FORCE_KILL_MS),
			])
		} catch {
			// server.kill rejection is observed above; force falls back to proc.
		}
	}
	killProcSync(proc)
}

/** Synchronous exit-hook sweep of still-live owned handles (no async work). */
function sweepLiveHandlesSync(): void {
	for (const handle of liveBrowserHandles) {
		killProcSync(handle.proc)
	}
	liveBrowserHandles.clear()
	// Deprecated bare-PID set below is never signaled; drop any stale entries.
	browserProcessPids.clear()
}

/**
 * Lifecycle + per-page instrumentation state. A fresh BrowserSession is a
 * null browser — the browser process is spawned lazily on the first `launch`
 * and must be torn down on session end even if the model never calls close.
 */
export class BrowserSession {
	private browser: Browser | null = null
	private server: BrowserServer | null = null
	private serverProcess: ChildProcess | null = null
	private ownedHandle: OwnedBrowserHandle | null = null
	private context: BrowserContext | null = null
	private page: Page | null = null
	private consoleEntries: ConsoleEntry[] = []
	private networkErrors: NetworkErrorEntry[] = []
	private navigations: NavigationEntry[] = []
	private pageClosed = false
	private lastUrl: string | null = null

	/** True once launch() created the browser; false before that / after close(). */
	get isLaunched(): boolean {
		return this.browser !== null
	}

	/** The current page URL (null before launch or after the page was closed). */
	get currentUrl(): string | null {
		return this.lastUrl
	}

	/** Total console entries captured since launch (drained per getConsoleLogs call). */
	get consoleCount(): number {
		return this.consoleEntries.length
	}

	/** Total network errors captured since launch (drained per getNetworkErrors call). */
	get networkErrorCount(): number {
		return this.networkErrors.length
	}

	/**
	 * Launch a headless browser and navigate to `url`. Multiple launch calls
	 * are allowed: a subsequent launch closes the previous browser (with all
	 * its state) and starts fresh — the model's explicit reset path.
	 */
	async launch(url: string): Promise<void> {
		// Relaunch: bounded owner-only cleanup of any previous browser first.
		await this.close()
		// Fresh browser: reset the closed flag (close()/dispose() set it, and a
		// re-launch must be able to open a new page).
		this.pageClosed = false
		let server: BrowserServer | null = null
		let proc: ChildProcess | null = null
		let handle: OwnedBrowserHandle | null = null
		let browser: Browser | null = null
		try {
			server = await chromium.launchServer({ headless: true, host: "127.0.0.1" })
			// Retain the owned server/process BEFORE connect so a connect
			// failure still has a cleanup path.
			this.server = server
			try {
				proc = server.process()
			} catch {
				proc = null
			}
			this.serverProcess = proc
			handle = { server, proc }
			this.ownedHandle = handle
			liveBrowserHandles.add(handle)
			const owned = handle
			try {
				server.on("close", () => {
					liveBrowserHandles.delete(owned)
				})
			} catch {
				// Listener registration is best-effort only.
			}
			browser = await chromium.connect(server.wsEndpoint())
			this.browser = browser
			this.context = await browser.newContext()
			this.page = await this.context.newPage()
			this.attachListeners()
		} catch (error) {
			// Partial-init failure: same bounded owner-only cleanup as close().
			const ownedBrowser = this.browser ?? browser
			const ownedServer = this.server ?? server
			const ownedProc = this.serverProcess ?? proc
			const ownedHandle = this.ownedHandle ?? handle
			this.browser = null
			this.server = null
			this.serverProcess = null
			this.ownedHandle = null
			this.context = null
			this.page = null
			this.pageClosed = true
			this.consoleEntries = []
			this.networkErrors = []
			this.navigations = []
			if (ownedHandle !== null) {
				liveBrowserHandles.delete(ownedHandle)
			}
			await teardownOwned(ownedBrowser, ownedServer, ownedProc)
			throw error
		}
		await this.goto(url)
	}

	/** Navigate to `url` and wait for the page to load (default 30s). */
	async goto(url: string): Promise<void> {
		if (this.page === null || this.pageClosed) {
			throw new Error("browser_action: no open page — call launch(url) first")
		}
		this.lastUrl = url
		try {
			// waitUntil: "load" matches the QA runner's default and the vendored
			// ChromeDevTools "navigate" semantics (page fully loaded). Network
			// failures (DNS, refused) reject with an ERR_* error.
			await this.page.goto(url, { waitUntil: "load", timeout: 30_000 })
		} catch (error) {
			// Capture-time navigation (see the "page navigated to X" result) is
			// only pushed on success; a failed navigation must not mislead the
			// model into thinking the page is showing. Let the error propagate —
			// the executor wraps it in a clear tool error.
			throw error
		}
	}

	/**
	 * Screenshot the current page as base64 PNG. The executor converts this to
	 * a PNG file written inside the workspace, because tool results here are
	 * text-only (ToolResult.content is a string — no image content part exists
	 * in this harness's ChatMessage plumbing; see the report).
	 */
	async screenshot(): Promise<string> {
		if (this.page === null || this.pageClosed) {
			throw new Error("browser_action: no open page — call launch(url) first")
		}
		const buffer = await this.page.screenshot({ type: "png", fullPage: true })
		if (buffer.length > MAX_SCREENSHOT_BYTES) {
			throw new Error(`browser_action: screenshot is ${buffer.length} bytes — above the ${MAX_SCREENSHOT_BYTES}-byte cap`)
		}
		return buffer.toString("base64")
	}

	/**
	 * Click the first element matching `selector`. The candidate is queued for
	 * up to 30 seconds (the Playwright default actionability wait): a dev
	 * server may still be mounting when the model clicks. If no match appears,
	 * this rejects with a clear "selector did not resolve" error.
	 */
	async click(selector: string): Promise<void> {
		await this.withPage(async (page) => {
			const locator = page.locator(selector).first()
			await locator.click({ timeout: BROWSER_INTERACTION_TIMEOUT_MS })
		})
	}

	/** Type `text` into the first element matching `selector` (must be focusable). */
	async type(selector: string, text: string): Promise<void> {
		await this.withPage(async (page) => {
			const locator = page.locator(selector).first()
			await locator.fill(text, { timeout: BROWSER_INTERACTION_TIMEOUT_MS })
		})
	}

	/**
	 * Drain captured console entries since the last call (capture-time events —
	 * there is no "past events" API in Playwright). Returns the NEW entries.
	 */
	async getConsoleLogs(): Promise<ConsoleEntry[]> {
		const entries = this.consoleEntries
		this.consoleEntries = []
		return entries
	}

	/** Drain captured network failures since the last call (see file header). */
	async getNetworkErrors(): Promise<NetworkErrorEntry[]> {
		const errors = this.networkErrors
		this.networkErrors = []
		return errors
	}

	/**
	 * Drain captured navigations since the last call. Used to surface the
	 * landing URL / link navigation results to the model.
	 */
	async getNavigations(): Promise<NavigationEntry[]> {
		const navigations = this.navigations
		this.navigations = []
		return navigations
	}

	/** Current page state summary — what the model sees after every action. */
	async describe(): Promise<string> {
		if (this.page === null || this.pageClosed) {
			return "browser: no open page"
		}
		const title = await this.page.title()
		const url = this.page.url()
		this.lastUrl = url
		return `browser: ${title} — ${url}`
	}

	/**
	 * Wait for the current page to be quiet (no pending network requests for
	 * 300ms). Used by navigation/screenshot/click/type to surface the settled
	 * URL after the action, and by the dev-server smoke test.
	 */
	async waitForIdle(timeoutMs = 5_000): Promise<void> {
		if (this.page === null || this.pageClosed) {
			return
		}
		const idleTimeout = 300
		try {
			await this.page.waitForLoadState("networkidle", { timeout: timeoutMs })
		} catch {
			// Timeout: treat as "still some polling traffic", NOT a failure —
			// a live dev server may legitimately keep a websocket open.
		}
		// Extra settle beat so capture-time events (console, failures) land
		// before the caller drains them.
		await new Promise((r) => setTimeout(r, idleTimeout))
	}

	/**
	 * Hard-close the browser (the model's explicit cleanup). The owned
	 * launch-server and its process are reaped too; only this session's own
	 * handles are touched. Idempotent.
	 *
	 * browser.close() and server.close() share ONE graceful deadline so a
	 * wedged browser can never stall teardown past ~5s; the owned
	 * server/process is then force-killed under a short bound.
	 */
	async close(): Promise<void> {
		const browser = this.browser
		const server = this.server
		const proc = this.serverProcess
		const handle = this.ownedHandle
		this.browser = null
		this.server = null
		this.serverProcess = null
		this.ownedHandle = null
		this.context = null
		this.page = null
		this.pageClosed = true
		this.consoleEntries = []
		this.networkErrors = []
		this.navigations = []
		if (handle !== null) {
			liveBrowserHandles.delete(handle)
		}
		await teardownOwned(browser, server, proc)
	}

	/**
	 * Session-end teardown: bounded owner-only close of this session's browser
	 * (see close()). Global sweeping is reserved for the process-exit hook so
	 * one session can never reap another live session's browser.
	 */
	async dispose(): Promise<void> {
		await this.close()
	}

	/** Run `fn` against the live page, rejecting cleanly when none is open. */
	private async withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
		if (this.page === null || this.pageClosed) {
			throw new Error("browser_action: no open page — call launch(url) first")
		}
		const page = this.page
		try {
			return await fn(page)
		} catch (error) {
			// Map a navigation-triggering click to a "page navigated" info
			// instead of an error, then rethrow genuine action failures.
			if (error instanceof Error && /navigation|navigated|target closed|net::/i.test(error.message) && this.browser !== null) {
				throw new Error(`browser_action: the action caused a navigation or the page closed (${error.message})`)
			}
			throw error
		}
	}

	/** Wire capture-time listeners to the current page. */
	private attachListeners(): void {
		const page = this.page
		if (page === null) {
			return
		}
		page.on("console", (msg) => {
			this.consoleEntries.push({ type: msg.type(), text: msg.text(), ts: Date.now() })
		})
		page.on("requestfailed", (request) => {
			const failure = request.failure()
			this.networkErrors.push({
				url: request.url(),
				failure: failure?.errorText ?? "unknown failure",
				method: request.method(),
				ts: Date.now(),
			})
		})
		// HTTP >= 400 responses are failures for the model's purposes (a 404
		// asset, a 500 API) even though the request itself "succeeded" on the
		// wire, and Playwright only emits `requestfailed` for network-level
		// failures. Track request/response so we can surface both.
		page.on("response", (response) => {
			const status = response.status()
			if (status >= 400) {
				this.networkErrors.push({
					url: response.url(),
					failure: `HTTP ${status}`,
					method: response.request().method(),
					ts: Date.now(),
				})
			}
		})
		page.on("framenavigated", (frame) => {
			if (frame === page.mainFrame()) {
				this.navigations.push({ url: frame.url(), ts: Date.now() })
			}
		})
		page.on("close", () => {
			this.pageClosed = true
		})
	}
}

// ─── Deprecated bare-PID registry (issue #79) ────────────────────────────────

/**
 * Deprecated: Chromium PIDs were once tracked here for group-kill cleanup,
 * but bare PIDs are never the actual owned process and signaling them can hit
 * stale or unrelated processes. Retained as a no-op registry for backwards
 * compatibility; owner-only teardown above plus the process-exit sweep of live
 * owned handles are the only cleanup paths. Do not use in new code.
 */
const browserProcessPids = new Set<number>()

/** @deprecated No-op: bare-PID tracking is superseded by owned-handle teardown. */
export function trackBrowserProcess(pid: number): void {
	browserProcessPids.add(pid)
}

/** @deprecated No-op: bare-PID tracking is superseded by owned-handle teardown. */
export function untrackBrowserProcess(pid: number): void {
	browserProcessPids.delete(pid)
}

/**
 * @deprecated No-op: ordinary dispose/close must only reap its own owned
 * browser. Global sweeping is reserved for the process-exit hook
 * (sweepLiveHandlesSync). Clears stale entries without signaling.
 */
export function killBrowserProcessGroup(): void {
	browserProcessPids.clear()
}

// ─── Module-level idempotent hook: reap owned browsers on process exit ───────

let disposeHookInstalled = false

/**
 * Idempotently register the owned-handle sweep as a process exit hook so the
 * browser never outlives the harness process, even when a session is torn
 * down by a path that skips ToolExecutor.dispose() (e.g. process.exit during
 * startup). The per-session dispose() path above is the primary cleanup; this
 * is a belt-and-suspenders guarantee.
 */
export function installBrowserDisposeHook(): void {
	if (disposeHookInstalled) {
		return
	}
	disposeHookInstalled = true
	process.on("exit", sweepLiveHandlesSync)
}
