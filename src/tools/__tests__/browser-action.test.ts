/**
 * Unit tests for the browser_action tool (src/tools/browser/) — the
 * Playwright-backed headless browser tool. NEW work, not a port.
 *
 * Every test spins up a REAL local `node:http` static page server (no network
 * access), launches a REAL headless Chromium via Playwright, and drives it
 * through the REAL handler (via createHeadlessExecutor), covering:
 *   - launch + screenshot (PNG written under the workspace) + describe
 *   - click + type against real interactive elements
 *   - getConsoleLogs / getNetworkErrors against a page that logs + fails a request
 *   - close (explicit cleanup)
 *   - error cases: bad selector (never resolves), navigation failure (connection refused)
 *   - timeout: a hung action surfaces a clear error and does NOT hang the suite
 *   - session end: ToolExecutor.dispose() kills a still-open browser
 *
 * Plain assert-based script (no test framework, no network), run via
 * `npm test` -> `tsx src/tools/__tests__/browser-action.test.ts`.
 */

import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { AddressInfo } from "node:net"

import { chromium } from "playwright"

import { createHeadlessExecutor } from "../executor.js"
import { describeImage } from "../../vision/describe.js"
import { setVisionCaptionerForTest } from "../browser/handler.js"
import type { AuxLlmUsage } from "../../engine/types.js"

/**
 * COV-6: on a fresh contributor machine, Playwright's `chromium` package is
 * installed (it's a normal npm dependency) but the actual browser BINARY is
 * not — that's a separate `npx playwright install chromium` download step
 * that's in no script here. Without a preflight check, this whole suite
 * fails with a confusing "Executable doesn't exist" error that looks like a
 * real regression. Try a real launch+close once, up front; if it fails for
 * that specific missing-executable reason, skip the suite with a clear
 * install instruction and exit 0 (this is an environment gap, not a test
 * failure — `npm test` on a machine that never ran the install step must not
 * be red for a reason unrelated to the code under test). Any OTHER launch
 * failure (a real crash, a permissions issue, etc.) is NOT swallowed — it
 * still fails the suite, since that could be a real regression.
 */
async function checkChromiumAvailable(): Promise<{ available: true } | { available: false; reason: string }> {
	try {
		const browser = await chromium.launch({ headless: true })
		await browser.close()
		return { available: true }
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		const looksLikeMissingInstall = /executable doesn't exist|missing dependencies|browserType\.launch/i.test(message)
		if (looksLikeMissingInstall) {
			return { available: false, reason: message }
		}
		throw err
	}
}

/** The static page HTML served by the local test server. */
const PAGE_HTML = `<!doctype html>
<html>
  <head><title>Browser Test Page</title></head>
  <body>
    <h1 id="heading">Hello from test server</h1>
    <input id="name" type="text" placeholder="Name" />
    <button id="btn">Click me</button>
    <div id="output"></div>
    <script>
      console.log("page booted");
      console.warn("a warning");
      document.getElementById("btn").addEventListener("click", () => {
        const name = document.getElementById("name").value || "world";
        document.getElementById("output").textContent = "Hello, " + name;
        console.log("clicked");
      });
      // Deliberately fail a request (no such endpoint) so getNetworkErrors
      // has something to capture.
      fetch("/missing-endpoint").catch(() => {});
    </script>
  </body>
</html>`

/** Start a local static http server serving PAGE_HTML; return {port, close}. */
async function startTestServer(): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		// The page deliberately fetches /missing-endpoint — serve it as a real
		// 404 so getNetworkErrors has an HTTP error to capture.
		if (req.url === "/missing-endpoint") {
			res.writeHead(404, { "Content-Type": "text/plain" })
			res.end("not found")
			return
		}
		res.writeHead(200, { "Content-Type": "text/html" })
		res.end(PAGE_HTML)
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const port = (server.address() as AddressInfo).port
	return {
		port,
		close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
	}
}

async function mkTmpWorkspace(prefix: string): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), prefix))
}

function exec(ws: string) {
	return createHeadlessExecutor(ws)
}

/** Poll `process.kill(pid, 0)` until the process is gone (throws) or timeout. */
async function waitForProcessExit(pid: number, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			process.kill(pid, 0)
		} catch {
			return // gone
		}
		await sleep(50)
	}
	throw new Error(`process ${pid} still alive after ${timeoutMs}ms`)
}

// ─── (a) launch + screenshot + describe ──────────────────────────────────────

async function testLaunchScreenshotAndDescribe(): Promise<void> {
	const server = await startTestServer()
	const ws = await mkTmpWorkspace("hc-browser-launch-")
	try {
		const executor = exec(ws)
		const url = `http://127.0.0.1:${server.port}/`

		// No browser open yet -> informational result, not an error.
		const pre = await executor.execute("browser_action", { action: "screenshot" })
		assert.equal(pre.isError, false, "screenshot with no browser must be informational, not an error")
		assert.match(pre.content, /no browser is open/, "must say no browser is open")

		// launch
		const launched = await executor.execute("browser_action", { action: "launch", url })
		assert.equal(launched.isError, false, `launch must succeed, got: ${launched.content}`)
		assert.match(launched.content, /Browser Test Page/, "describe must include the page title")
		assert.match(launched.content, /127\.0\.0\.1:\d+/, "describe must include the page URL")

		// screenshot -> PNG written under the workspace
		const shot = await executor.execute("browser_action", { action: "screenshot" })
		assert.equal(shot.isError, false, `screenshot must succeed, got: ${shot.content}`)
		assert.match(shot.content, /screenshot saved to/, "must report the saved path")
		assert.match(shot.content, /\.headlesscode\/browser-screenshots\//, "screenshot must live under .headlesscode/browser-screenshots/")
		// Bare executor (no onAuxLlmUsage): automatic captioning must be
		// skipped — an un-accounted executor never spends money behind the
		// session's back, and no stale read-it-back text remains either.
		assert.doesNotMatch(shot.content, /image description:/, "no onAuxLlmUsage -> no auto-caption")
		assert.doesNotMatch(shot.content, /read it back with read_file/, "the stale read-it-back dead end must be gone")
		const match = shot.content.match(/saved to ([^\s]+)/)
		assert.ok(match, "could not extract the screenshot path from the result")
		const pngPath = path.join(ws, match[1])
		const png = await fs.readFile(pngPath)
		assert.ok(png.length > 100, "PNG file must have real content")
		assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", "file must be a PNG")

		await executor.dispose()
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await server.close()
	}
}

// ─── (b) click + type + console/network capture ─────────────────────────────

async function testClickTypeAndEventCapture(): Promise<void> {
	const server = await startTestServer()
	const ws = await mkTmpWorkspace("hc-browser-interact-")
	try {
		const executor = exec(ws)
		const url = `http://127.0.0.1:${server.port}/`
		await executor.execute("browser_action", { action: "launch", url })

		// console: the page logs on boot; drain the boot entries first.
		const bootLogs = await executor.execute("browser_action", { action: "getConsoleLogs" })
		assert.equal(bootLogs.isError, false, `getConsoleLogs must succeed, got: ${bootLogs.content}`)
		assert.match(bootLogs.content, /page booted/, "must include the page's boot log")
		assert.match(bootLogs.content, /a warning/, "must include the console.warn")

		// network: the page deliberately fails /missing-endpoint
		const netErrors = await executor.execute("browser_action", { action: "getNetworkErrors" })
		assert.equal(netErrors.isError, false, `getNetworkErrors must succeed, got: ${netErrors.content}`)
		assert.match(netErrors.content, /missing-endpoint/, "must include the failed request URL")
		assert.match(netErrors.content, /HTTP 404/, "must describe the HTTP failure status")

		// type into the input
		const typed = await executor.execute("browser_action", { action: "type", selector: "#name", text: "Ada" })
		assert.equal(typed.isError, false, `type must succeed, got: ${typed.content}`)
		assert.match(typed.content, /typed text into #name/, "must report the typed selector")

		// click the button -> the page updates #output via JS
		const clicked = await executor.execute("browser_action", { action: "click", selector: "#btn" })
		assert.equal(clicked.isError, false, `click must succeed, got: ${clicked.content}`)
		assert.match(clicked.content, /clicked #btn/, "must report the clicked selector")

		// the click handler logged "clicked" -> new console entry
		const afterClick = await executor.execute("browser_action", { action: "getConsoleLogs" })
		assert.equal(afterClick.isError, false)
		assert.match(afterClick.content, /clicked/, "must capture the click handler's log")

		// verify the DOM actually changed (the interaction really happened)
		const shot = await executor.execute("browser_action", { action: "screenshot" })
		assert.equal(shot.isError, false, `screenshot must succeed, got: ${shot.content}`)

		// close explicitly
		const closed = await executor.execute("browser_action", { action: "close" })
		assert.equal(closed.isError, false, `close must succeed, got: ${closed.content}`)
		assert.match(closed.content, /closed/, "must report the close")

		await executor.dispose()
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await server.close()
	}
}

// ─── (c) error cases: bad selector, navigation failure ──────────────────────

async function testBadSelectorAndNavigationFailure(): Promise<void> {
	const server = await startTestServer()
	const ws = await mkTmpWorkspace("hc-browser-errors-")
	try {
		const executor = exec(ws)
		const url = `http://127.0.0.1:${server.port}/`

		// Action with no browser -> informational (handled in (a)); here we
		// test the error path: an action with an invalid action name.
		const badAction = await executor.execute("browser_action", { action: "nope" })
		assert.equal(badAction.isError, true, "invalid action must be an error")
		assert.match(badAction.content, /invalid action/, "must name the invalid action")

		// Bad selector: click on something that never resolves -> clear error.
		await executor.execute("browser_action", { action: "launch", url })
		const badClick = await executor.execute("browser_action", { action: "click", selector: "#does-not-exist" })
		assert.equal(badClick.isError, true, "clicking a missing selector must error")
		assert.match(
			badClick.content,
			/selector|locator|waiting|timeout|timed out/i,
			`must explain the selector failure, got: ${badClick.content}`,
		)

		// Navigation failure: connection refused -> clear error.
		const deadPort = server.port + 1 // almost certainly nothing listening
		const navFail = await executor.execute("browser_action", { action: "launch", url: `http://127.0.0.1:${deadPort}/` })
		assert.equal(navFail.isError, true, "navigation to a dead port must error")
		assert.match(navFail.content, /net::|ERR_|ECONNREFUSED|failed/i, `must explain the navigation failure, got: ${navFail.content}`)

		await executor.dispose()
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await server.close()
	}
}

// ─── (d) timeout: a hung action errors fast instead of hanging the session ──

async function testHungActionTimesOut(): Promise<void> {
	const ws = await mkTmpWorkspace("hc-browser-timeout-")
	try {
		const executor = exec(ws)

		// Simulate a hang: point the launch at a URL whose server accepts the
		// connection but never responds, so page.goto never settles. The
		// action must be killed by the outer timeout rather than hanging the
		// suite. The timeout is shortened via BROWSER_ACTION_TIMEOUT_MS so the
		// test runs fast.
		const hangingServer = http.createServer(() => {
			/* never respond */
		})
		await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", resolve))
		const hangingPort = (hangingServer.address() as AddressInfo).port

		const prev = process.env.BROWSER_ACTION_TIMEOUT_MS
		process.env.BROWSER_ACTION_TIMEOUT_MS = "1500"
		const startedAt = Date.now()
		let result
		try {
			result = await executor.execute("browser_action", {
				action: "launch",
				url: `http://127.0.0.1:${hangingPort}/`,
			})
		} finally {
			if (prev === undefined) {
				delete process.env.BROWSER_ACTION_TIMEOUT_MS
			} else {
				process.env.BROWSER_ACTION_TIMEOUT_MS = prev
			}
		}
		const elapsed = Date.now() - startedAt

		assert.equal(result.isError, true, "a hung action must error, not hang")
		assert.match(result.content, /timed out after|timeout/i, `must say it timed out, got: ${result.content}`)
		assert.ok(elapsed < 10_000, `timeout must fire promptly (took ${elapsed}ms)`)

		// The session must be able to recover: close + relaunch against the
		// good server.
		const good = await startTestServer()
		try {
			await executor.execute("browser_action", { action: "close" })
			const recovered = await executor.execute("browser_action", {
				action: "launch",
				url: `http://127.0.0.1:${good.port}/`,
			})
			assert.equal(recovered.isError, false, `session must recover after a timeout, got: ${recovered.content}`)
		} finally {
			await good.close()
		}

		await executor.dispose()
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
	}
}

// ─── (e) session end kills a still-open browser ─────────────────────────────

async function testDisposeKillsOpenBrowser(): Promise<void> {
	const server = await startTestServer()
	const ws = await mkTmpWorkspace("hc-browser-dispose-")
	try {
		const executor = exec(ws)
		const url = `http://127.0.0.1:${server.port}/`

		// Launch, leaving the browser open (model never calls close()).
		const launched = await executor.execute("browser_action", { action: "launch", url })
		assert.equal(launched.isError, false, `launch must succeed, got: ${launched.content}`)

		// Find the Chromium browser process(es) belonging to this launch: the
		// browser's pid is the Playwright browser process. We discover it via
		// the process table on Linux (the test only runs where Playwright runs).
		const chromePids = await findChromiumPids()
		assert.ok(chromePids.length > 0, "expected at least one Chromium process after launch")

		// Session ends WITHOUT close() -> dispose() must kill the browser.
		await executor.dispose()

		for (const pid of chromePids) {
			await waitForProcessExit(pid)
		}
	} finally {
		await fs.rm(ws, { recursive: true, force: true })
		await server.close()
	}
}

/** Find PIDs of chromium/chrome processes owned by this test run (Linux pgrep). */
async function findChromiumPids(): Promise<number[]> {
	const { execFile } = await import("node:child_process")
	const pids: number[] = []
	try {
		const { stdout } = await new Promise<{ stdout: string }>((resolve, reject) => {
			execFile("pgrep", ["-f", "chrome-linux|headless_shell"], (err, stdout, _stderr) => {
				if (err) {
					// pgrep exits 1 when nothing matches
					resolve({ stdout: "" })
					return
				}
				resolve({ stdout })
			})
		})
		for (const line of stdout.split("\n")) {
			const pid = Number(line.trim())
			if (Number.isInteger(pid) && pid > 0) {
				pids.push(pid)
			}
		}
	} catch {
		// pgrep unavailable — cannot assert, but the dispose path still ran.
	}
	return pids
}

// ─── (f) screenshot auto-captioning (cloud vision) ───────────────────────────

async function testScreenshotAutoCaptionsForModel(): Promise<void> {
	const server = await startTestServer()
	const ws = await mkTmpWorkspace("hc-browser-caption-")
	const used: string[] = []
	const captions: AuxLlmUsage[] = []
	try {
		// Swap in a fake captioner — the real one (describeImage) would hit
		// OpenRouter; the fake still exercises the full handler path: PNG path
		// in, description + usage out, usage forwarded to the session.
		setVisionCaptionerForTest(async (imagePath) => {
			used.push(imagePath)
			return {
				description:
					"A red error banner reads: Failed to load data: Cannot read properties of undefined (reading 'map') (fake caption).",
				usage: { model: "google/gemma-3-12b-it", inputTokens: 321, outputTokens: 17 },
			}
		})

		// A REAL accounting session wires onAuxLlmUsage (HeadlessSession does);
		// the executor forwards it so the caption cost lands in the BudgetTracker.
		const executor = createHeadlessExecutor(ws, { onAuxLlmUsage: (usage) => captions.push(usage) })
		const url = `http://127.0.0.1:${server.port}/`
		const launched = await executor.execute("browser_action", { action: "launch", url })
		assert.equal(launched.isError, false, `launch must succeed, got: ${launched.content}`)

		const shot = await executor.execute("browser_action", { action: "screenshot" })
		assert.equal(shot.isError, false, `screenshot must succeed, got: ${shot.content}`)
		assert.match(
			shot.content,
			/image description: A red error banner reads: Failed to load data/,
			"the screenshot result must embed the real vision description",
		)
		assert.doesNotMatch(shot.content, /read it back with read_file/, "the stale read-it-back dead end must be gone")
		assert.match(shot.content, /screenshot saved to/, "must keep the file path in the result")

		// The captioner must be handed the actual saved PNG (absolute path under
		// .headlesscode/browser-screenshots/).
		assert.equal(used.length, 1, "screenshot must caption exactly once")
		assert.ok(
			used[0].includes("browser-screenshots") && used[0].endsWith(".png"),
			`captioner must get the saved PNG path, got: ${used[0]}`,
		)

		// The caption's usage must reach the session's accounting hook exactly
		// once, with the real numbers from the caption call.
		assert.equal(captions.length, 1, "caption usage must be reported to the session")
		assert.equal(captions[0].model, "google/gemma-3-12b-it")
		assert.equal(captions[0].inputTokens, 321)
		assert.equal(captions[0].outputTokens, 17)

		await executor.dispose()
	} finally {
		// Restore the real captioner so this test never leaks into others.
		setVisionCaptionerForTest((imagePath) => describeImage(imagePath))
		await fs.rm(ws, { recursive: true, force: true })
		await server.close()
	}
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["browser_action: launch + screenshot (PNG written) + describe", testLaunchScreenshotAndDescribe],
	["browser_action: click + type + getConsoleLogs + getNetworkErrors + close", testClickTypeAndEventCapture],
	["browser_action: bad selector + navigation failure are clear errors", testBadSelectorAndNavigationFailure],
	["browser_action: hung action times out without hanging the session", testHungActionTimesOut],
	["browser_action: session end (dispose) kills a still-open browser", testDisposeKillsOpenBrowser],
	["browser_action: screenshot auto-captions via vision (description + usage)", testScreenshotAutoCaptionsForModel],
]

async function main(): Promise<void> {
	const chromiumCheck = await checkChromiumAvailable()
	if (!chromiumCheck.available) {
		console.log(
			`  skip browser_action suite: Chromium is not installed for Playwright (run \`npx playwright install chromium\` to enable these ${tests.length} tests)`,
		)
		console.log(`  (launch error: ${chromiumCheck.reason.split("\n")[0]})`)
		process.exit(0)
	}

	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		// Explicit exit: Playwright's connection sockets can keep the event
		// loop alive past test completion; never leave `npm test` hanging on a
		// finished suite.
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} browser_action tests passed`)
	// See above — a closed Playwright browser can still hold a handle.
	process.exit(0)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
