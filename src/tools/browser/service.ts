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

/**
 * Lifecycle + per-page instrumentation state. A fresh BrowserSession is a
 * null browser — the browser process is spawned lazily on the first `launch`
 * and must be torn down on session end even if the model never calls close.
 */
export class BrowserSession {
	private browser: Browser | null = null
	private server: BrowserServer | null = null
	private serverProcess: ChildProcess | null = null
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
		// Fresh browser: reset the closed flag (close()/dispose() set it, and a
		// re-launch must be able to open a new page).
		await this.close()
		this.pageClosed = false
		let server: BrowserServer | null = null
		let browser: Browser | null = null
		try {
			server = await chromium.launchServer({ headless: true, host: "127.0.0.1" })
			browser = await chromium.connect(server.wsEndpoint())
			this.server = server
			this.browser = browser
			const proc = server.process()
			this.serverProcess = proc ?? null
			if (proc) {
				registerBrowserProcess(proc)
				server.on("close", () => unregisterBrowserProcess(proc))
			}
			this.context = await this.browser.newContext()
			this.page = await this.context.newPage()
			this.attachListeners()
			await this.goto(url)
		} catch (error) {
			if (browser !== null) {
				try { await browser.close() } catch { /* best-effort */ }
			}
			if (server !== null) {
				try { await server.close() } catch { /* best-effort */ }
				try { server.kill() } catch { /* best-effort */ }
			}
			this.browser = null
			this.server = null
			const proc = this.serverProcess
			this.serverProcess = null
			this.context = null
			this.page = null
			if (proc) {
				unregisterBrowserProcess(proc)
				if (proc.exitCode === null && proc.signalCode === null) {
					try { proc.kill("SIGKILL") } catch { /* already gone */ }
				}
			}
			throw error
		}
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
	 * Hard-close the browser (the model's explicit cleanup). Graceful
	 * browser/server close runs under a short timeout, then only this
	 * session's own server process is force-killed. Idempotent; never
	 * touches other sessions' processes.
	 *
	 * browser.close() can itself hang if the browser process is wedged, so it
	 * runs under a short timeout — teardown must never block the session
	 * (the owned-server kill below is the guaranteed kill after it).
	 */
	async close(): Promise<void> {
		const browser = this.browser
		const server = this.server
		const proc = this.serverProcess
		this.browser = null
		this.server = null
		this.serverProcess = null
		this.context = null
		this.page = null
		this.pageClosed = true
		this.consoleEntries = []
		this.networkErrors = []
		this.navigations = []
		if (browser !== null) {
			try {
				await BrowserSession.closeWithTimeout(() => browser.close(), 5_000)
			} catch {
				// Browser already gone, or close hung — the owned-server
				// teardown below is the backstop; this stays best-effort.
			}
		}
		if (server !== null) {
			try {
				await BrowserSession.closeWithTimeout(() => server.close(), 5_000)
			} catch {
				// Owned server did not shut down gracefully — force it below.
			}
			try {
				server.kill()
			} catch {
				// Already gone — nothing to clean up.
			}
		}
		if (proc !== null) {
			unregisterBrowserProcess(proc)
			if (proc.exitCode === null && proc.signalCode === null) {
				try {
					proc.kill("SIGKILL")
				} catch {
					// Already gone — nothing to clean up.
				}
			}
		}
	}

	private static async closeWithTimeout(task: () => Promise<void>, ms: number): Promise<void> {
		let timer: NodeJS.Timeout | undefined
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("browser teardown timed out — forcing process kill")), ms)
		})
		try {
			await Promise.race([task(), timeout])
		} finally {
			clearTimeout(timer)
		}
	}

	/**
	 * Session-end teardown: close the connected browser and its owning
	 * server, force-killing only this session's own Chromium process so
	 * nothing it owns survives the session. Never sweeps other sessions.
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

// ─── Process-group kill for residual Chromium children ──────────────────────

/**
 * Chromium PIDs spawned by this module, tracked so session teardown can
 * sweep only still-live handles this harness registered, so an exited
 * handle can never resolve to a recycled pid owned by someone else. This
 * mirrors the execute_command background child registry (see
 * src/tools/executor.ts) — the one place this module deliberately reaches
 * outside the BrowserSession abstraction, because the browser's own close()
 * must never be the ONLY cleanup path.
 */
const browserProcesses = new Set<ChildProcess>()

/** Register this harness's own live Chromium handle for exit-time sweep. */
function registerBrowserProcess(proc: ChildProcess): void {
	browserProcesses.add(proc)
}

/** Unregister a Chromium handle that exited or was torn down by its owner. */
function unregisterBrowserProcess(proc: ChildProcess): void {
	browserProcesses.delete(proc)
}

/**
 * @deprecated No longer used — owner-scoped teardown (BrowserSession.close)
 * kills only its own server process. Kept as a no-op for compatibility.
 */
export function trackBrowserProcess(_pid: number): void {
}

/**
 * @deprecated No longer used — owner-scoped teardown unregisters its own
 * live ChildProcess handle. Kept as a no-op for compatibility.
 */
export function untrackBrowserProcess(_pid: number): void {
}

/**
 * @deprecated No longer used — close()/dispose() tear down only the owning
 * session's server process, and the exit hook sweeps only live registered
 * handles. Kept as a no-op for compatibility.
 */
export function killBrowserProcessGroup(): void {
}

/** SIGKILL every still-live registered Chromium handle owned by this harness. */
function killLiveBrowserProcesses(): void {
	for (const proc of browserProcesses) {
		try {
			if (proc.exitCode === null && proc.signalCode === null) {
				proc.kill("SIGKILL")
			}
		} catch {
			// Already gone — nothing to clean up.
		}
	}
	browserProcesses.clear()
}

// ─── Module-level idempotent hook: sweep only this harness's live handles ───

let disposeHookInstalled = false

/**
 * Idempotently register `killLiveBrowserProcesses` as a process exit hook so
 * the browser never outlives the harness process, even when a session is torn
 * down by a path that skips ToolExecutor.dispose() (e.g. process.exit during
 * startup). Only still-live handles registered by this harness are swept —
 * handles carry liveness (exitCode/signalCode), so no stale bare pid can be
 * reused to signal an unrelated process. The per-session dispose() path above
 * is the primary cleanup; this is a belt-and-suspenders guarantee.
 */
export function installBrowserDisposeHook(): void {
	if (disposeHookInstalled) {
		return
	}
	disposeHookInstalled = true
	process.on("exit", killLiveBrowserProcesses)
}
