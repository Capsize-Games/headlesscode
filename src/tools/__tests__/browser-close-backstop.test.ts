import assert from "node:assert/strict"
import { access, mkdtemp, readFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { chromium, type Browser, type BrowserServer } from "playwright"
import type { ToolContext } from "../../engine/types.js"
import { BrowserSession } from "../browser/service.js"
import { browserActionHandler } from "../browser/handler.js"

type Identity = { pid: number; start: string; state: string; depth: number; command: string }
type BrowserSessionState = { browser: Browser | null; server: import("playwright").BrowserServer | null }
type LaunchOptions = { args?: string[]; [key: string]: unknown }
type BrowserTypeWithServer = {
	launch: (options?: LaunchOptions) => Promise<Browser>
	launchServer: (options?: LaunchOptions) => Promise<BrowserServer>
	connect: (wsEndpoint: string, options?: Record<string, unknown>) => Promise<Browser>
}

const skip = (reason: string): never => {
	console.log(`SKIP browser close backstop: ${reason}`)
	process.exit(0)
}

if (process.platform !== "linux") skip(`Linux /proc is required for PID birth-identity checks (current platform: ${process.platform})`)
try {
	await readFile("/proc/self/stat", "utf8")
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") skip("Linux /proc/self/stat is absent; exact PID birth-identity checks cannot run")
	throw error
}
try {
	await access(chromium.executablePath(), constants.X_OK)
} catch (error) {
	if ((error as NodeJS.ErrnoException).code === "ENOENT") skip(`Playwright Chromium executable is absent at ${chromium.executablePath()}`)
	throw error
}

process.env.LIBGL_ALWAYS_SOFTWARE = "1"
const browserType = chromium as unknown as BrowserTypeWithServer
const originalLaunch = browserType.launch.bind(chromium)
const originalLaunchServer = browserType.launchServer.bind(chromium)
const originalConnect = browserType.connect.bind(chromium)
const appendSoftwareArgs = (options: LaunchOptions = {}): LaunchOptions => ({
	...options,
	args: [...(options.args ?? []), "--disable-gpu"],
})
const launchCaptures: Identity[][] = []
const launchServerClosers: Array<() => Promise<void>> = []
let rejectNextNewContext = false
let rejectNextConnect = false
let rejectNextServerKill = false
let injectedServerKillCount = 0
let nextLaunchUsesConnect = false
let holdBrowserClose = false
let holdServerClose = false
let closeGate: Promise<void> | null = null
let releaseCloseGate: (() => void) | null = null

function armCloseGate(): void {
	closeGate = new Promise<void>(resolve => { releaseCloseGate = resolve })
}

function releaseFaultGates(): void {
	holdBrowserClose = false
	holdServerClose = false
	releaseCloseGate?.()
	releaseCloseGate = null
	closeGate = null
}

function instrumentBrowser(browser: Browser): Browser {
	const originalNewContext = browser.newContext.bind(browser)
	const originalClose = browser.close.bind(browser)
	browser.newContext = async (...args) => {
		if (rejectNextNewContext) {
			rejectNextNewContext = false
			throw new Error("test injection: Browser.newContext failure")
		}
		return originalNewContext(...args)
	}
	browser.close = async () => {
		if (holdBrowserClose && closeGate) await closeGate
		return originalClose()
	}
	return browser
}

async function readIdentity(pid: number, depth: number): Promise<Identity | undefined> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8")
		const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)
		let command = ""
		try {
			command = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ").trim()
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		const state = fields[0]
		const start = fields[19]
		assert.ok(state && start, `stat record for pid ${pid} is incomplete`)
		return { pid, state, start, depth, command }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		return undefined
	}
}

async function descendantTree(rootPid: number): Promise<Identity[]> {
	const records: Identity[] = []
	const pending: Array<{ pid: number; depth: number }> = [{ pid: rootPid, depth: 0 }]
	const visited = new Set<number>()
	while (pending.length > 0) {
		const current = pending.pop()
		if (!current) continue
		if (visited.has(current.pid)) continue
		visited.add(current.pid)
		const record = await readIdentity(current.pid, current.depth)
		if (!record) continue
		records.push(record)
		try {
			const children = await readFile(`/proc/${current.pid}/task/${current.pid}/children`, "utf8")
			for (const entry of children.trim().split(/\s+/)) {
				const pid = Number(entry)
				if (Number.isSafeInteger(pid) && pid > 0 && !visited.has(pid)) pending.push({ pid, depth: current.depth + 1 })
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
	}
	return records
}

function chromiumRecords(records: Identity[]): Identity[] {
	return records.filter(record => /(?:chrome|chromium)/i.test(record.command))
}

function isBrowserLeader(record: Identity): boolean {
	return !record.command.includes("--type=") && /--remote-debugging-(?:pipe|port)(?:=|\s|$)/.test(record.command)
}

async function captureNewChromiumProcesses(run: () => Promise<unknown>): Promise<unknown> {
	const before = new Set(chromiumRecords(await descendantTree(process.pid)).map(record => record.pid))
	const result = await run()
	await delay(40)
	const after = chromiumRecords(await descendantTree(process.pid))
	const owned = after.filter(record => !before.has(record.pid))
	launchCaptures.push(owned)
	const leader = owned.find(isBrowserLeader)
	if (!leader) {
		console.log(JSON.stringify({ capturedCommands: owned.map(record => ({ pid: record.pid, command: record.command })) }))
		throw new Error("capture the browser leader from the probe's descendant tree")
	}
	assert.ok(leader.command.includes("--disable-gpu"), "every Chromium launch path must explicitly disable GPU use")
	return result
}

browserType.launch = (options = {}) => captureNewChromiumProcesses(async () => {
	if (!nextLaunchUsesConnect) return instrumentBrowser(await originalLaunch(appendSoftwareArgs(options)))
	nextLaunchUsesConnect = false
	const server = await originalLaunchServer(appendSoftwareArgs(options))
	launchServerClosers.push(() => server.close())
	return browserType.connect(server.wsEndpoint())
}) as Promise<Browser>
browserType.launchServer = (options = {}) => captureNewChromiumProcesses(async () => {
	const server = await originalLaunchServer(appendSoftwareArgs(options))
	const originalClose = server.close.bind(server)
	const originalKill = server.kill.bind(server)
	server.close = async () => {
		if (holdServerClose && closeGate) await closeGate
		return originalClose()
	}
	server.kill = () => {
		if (rejectNextServerKill) {
			rejectNextServerKill = false
			injectedServerKillCount += 1
			return Promise.reject(new Error("test injection: BrowserServer.kill rejection"))
		}
		return originalKill()
	}
	return server
}) as ReturnType<BrowserTypeWithServer["launchServer"]>
browserType.connect = async (wsEndpoint, options = {}) => {
	if (rejectNextConnect) {
		rejectNextConnect = false
		throw new Error("test injection: chromium.connect failure")
	}
	return instrumentBrowser(await originalConnect(wsEndpoint, options))
}

function browserLeader(records: Identity[]): Identity {
	const leader = records.find(isBrowserLeader)
	assert.ok(leader, "browser leader identity was captured")
	return leader
}

function capturedLaunch(index: number): Identity[] {
	const records = launchCaptures[index]
	assert.ok(records, `expected Chromium launch capture at index ${index}`)
	return records
}

function activeTimeoutCount(): number {
	return process.getActiveResourcesInfo().filter(resource => resource === "Timeout").length
}

async function alive(record: Identity): Promise<boolean> {
	const current = await readIdentity(record.pid, record.depth)
	return current?.start === record.start && current.state !== "Z" && current.state !== "X"
}

async function allGone(records: Identity[], timeoutMs = 5000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		let anyAlive = false
		for (const record of records) anyAlive ||= await alive(record)
		if (!anyAlive) return true
		await delay(40)
	}
	return false
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}

async function targetedCleanup(records: Identity[]): Promise<void> {
	const unique = new Map(records.map(record => [record.pid, record]))
	for (const record of [...unique.values()].sort((a, b) => b.depth - a.depth)) {
		if (!(await alive(record))) continue
		const current = await readIdentity(record.pid, record.depth)
		if (!current || current.start !== record.start || current.state === "Z" || current.state === "X") continue
		try { process.kill(record.pid, "SIGKILL") } catch { /* already gone */ }
	}
	assert.equal(await allGone([...unique.values()], 4000), true, "probe-owned Chromium PIDs must exit after identity-checked cleanup")
}

const failures: string[] = []
const sessions: BrowserSession[] = []
const closeOverrides: Array<{ browser: Browser; original: () => Promise<void> }> = []
const server = createServer((_req, res) => {
	res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
	res.end("<!doctype html><title>browser ownership probe</title><main>probe page</main>")
})
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert.ok(address && typeof address === "object")
const goodUrl = `http://127.0.0.1:${address.port}/`

async function unusedLocalPort(): Promise<number> {
	const reservation = createServer()
	await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve))
	const reservedAddress = reservation.address()
	assert.ok(reservedAddress && typeof reservedAddress === "object")
	await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
	return reservedAddress.port
}

async function check(name: string, test: () => Promise<void>): Promise<void> {
	try {
		await test()
		console.log(`PASS ${name}`)
	} catch (error) {
		failures.push(`${name}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
		console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
	}
}

async function createSession(): Promise<BrowserSession> {
	const session = new BrowserSession()
	sessions.push(session)
	return session
}

const selectedCase = process.env.PROBE_CASE ?? "all"
assert.ok(["all", "close-relaunch", "close-timeout-isolation", "initialization-failure", "initialization-close-hangs", "initialization-server-close-hangs", "connect-failure-server-close-hangs", "server-kill-rejection", "combined-close-deadline", "normal-close-timers", "navigation-failure"].includes(selectedCase), "unknown PROBE_CASE")

try {
if (selectedCase === "all" || selectedCase === "close-relaunch") {
	await check("explicit close and relaunch", async () => {
		const session = await createSession()
		const firstIndex = launchCaptures.length
		await session.launch(goodUrl)
		const first = capturedLaunch(firstIndex)
		assert.ok((await session.screenshot()).length > 100)
		await session.close()
		assert.equal(await allGone(first), true, "close terminates its Chromium process tree")
		await session.launch(goodUrl)
		const relaunched = capturedLaunch(firstIndex + 1)
		assert.ok((await session.screenshot()).length > 100, "session works after close + relaunch")
		await session.close()
		assert.equal(await allGone(relaunched), true, "relaunched browser closes too")
	})
}

if (selectedCase === "all" || selectedCase === "close-timeout-isolation") {
	await check("close timeout cleans only owner and preserves unrelated browser", async () => {
		const owner = await createSession()
		const unrelated = await createSession()
		const firstIndex = launchCaptures.length
		await owner.launch(goodUrl)
		const ownerTree = capturedLaunch(firstIndex)
		const ownerLeader = browserLeader(ownerTree)
		await unrelated.launch(goodUrl)
		const unrelatedTree = capturedLaunch(firstIndex + 1)
		const unrelatedLeader = browserLeader(unrelatedTree)
		assert.notEqual(ownerLeader.pid, unrelatedLeader.pid)

		const browser = (owner as unknown as BrowserSessionState).browser
		assert.ok(browser)
		const original = browser.close.bind(browser)
		closeOverrides.push({ browser, original })
		Object.defineProperty(browser, "close", { configurable: true, writable: true, value: () => new Promise<void>(() => {}) })
		const started = Date.now()
		await owner.dispose()
		assert.ok(Date.now() - started < 6500, "close-timeout disposal remains bounded")
		const ownerExited = await allGone(ownerTree)
		let unrelatedUsable = false
		try { unrelatedUsable = (await unrelated.screenshot()).length > 100 } catch { /* assertion below reports failure */ }
		console.log(JSON.stringify({ probe: "close-timeout-isolation", ownerPid: ownerLeader.pid, ownerStart: ownerLeader.start, ownerExited, unrelatedPid: unrelatedLeader.pid, unrelatedUsable }))
		assert.equal(ownerExited, true, "hard-kill backstop must terminate the owned browser when Browser.close hangs")
		assert.equal(unrelatedUsable, true, "closing one session must leave the unrelated browser usable")
	})
}

if (selectedCase === "all" || selectedCase === "initialization-failure") {
	for (const connectionMode of ["launch", "connect"] as const) {
		await check(`newContext initialization failure cleans only its ${connectionMode} browser`, async () => {
		const unrelated = await createSession()
		const failed = await createSession()
		const unrelatedIndex = launchCaptures.length
		await unrelated.launch(goodUrl)
		const unrelatedTree = capturedLaunch(unrelatedIndex)
		const unrelatedLeader = browserLeader(unrelatedTree)
		const failureIndex = launchCaptures.length
		rejectNextNewContext = true
		nextLaunchUsesConnect = connectionMode === "connect"
		await assert.rejects(failed.launch(goodUrl), /test injection: Browser\.newContext failure/)
		const failedTree = launchCaptures.slice(failureIndex).flat()
		assert.ok(failedTree.length > 0, "faulting session launched an owned Chromium process before newContext failed")
		const failedLeader = browserLeader(failedTree)
		let failedExited = false
		let unrelatedUsable = false
		try { failedExited = await allGone(failedTree) } catch { /* assertions below report identity-read errors */ }
		try { unrelatedUsable = (await unrelated.screenshot()).length > 100 } catch { /* assertion below reports failure */ }
		console.log(JSON.stringify({ probe: "newContext-initialization-failure", failedPid: failedLeader.pid, failedStart: failedLeader.start, failedExited, unrelatedPid: unrelatedLeader.pid, unrelatedUsable }))
		assert.equal(failedExited, true, "failed initialization must not leave its Chromium tree running")
		assert.equal(unrelatedUsable, true, "failed initialization must not close the unrelated browser")
		})
	}
}

for (const [caseName, closeTarget] of [
	["initialization-close-hangs", "browser"],
	["initialization-server-close-hangs", "server"],
] as const) {
	if (selectedCase === "all" || selectedCase === caseName) {
		await check(`partial initialization remains bounded when ${closeTarget}.close hangs`, async () => {
			const failed = await createSession()
			const failureIndex = launchCaptures.length
			armCloseGate()
			holdBrowserClose = closeTarget === "browser"
			holdServerClose = closeTarget === "server"
			rejectNextNewContext = true
			const rejectionObserved = failed.launch(goodUrl).then(() => false, () => true)
			try {
				const timely = await Promise.race([rejectionObserved, delay(6500).then(() => false)])
				const owned = launchCaptures.slice(failureIndex).flat()
				assert.ok(owned.length > 0, "the failed initialization launched its own browser")
				console.log(JSON.stringify({ probe: caseName, rejectedWithinBound: timely, leaderPid: browserLeader(owned).pid }))
				assert.equal(timely, true, "launch failure cleanup must reject promptly even if one close operation hangs")
			} finally {
				releaseFaultGates()
				await bounded(rejectionObserved, 5000, "faulted launch cleanup after gate release")
			}
		})
	}
}

if (selectedCase === "all" || selectedCase === "connect-failure-server-close-hangs") {
	await check("connect failure with hanging server.close remains bounded", async () => {
		const failed = await createSession()
		const failureIndex = launchCaptures.length
		armCloseGate()
		holdServerClose = true
		rejectNextConnect = true
		const rejectionObserved = failed.launch(goodUrl).then(() => false, () => true)
		try {
			const timely = await Promise.race([rejectionObserved, delay(6500).then(() => false)])
			const owned = launchCaptures.slice(failureIndex).flat()
			assert.ok(owned.length > 0, "launchServer created a process before connect failed")
			console.log(JSON.stringify({ probe: "connect-failure-server-close-hangs", rejectedWithinBound: timely, leaderPid: browserLeader(owned).pid }))
			assert.equal(timely, true, "connect failure cleanup must not await an unbounded server.close")
		} finally {
			releaseFaultGates()
			await bounded(rejectionObserved, 5000, "connect-failure cleanup after gate release")
		}
	})
}

if (selectedCase === "all" || selectedCase === "server-kill-rejection") {
	await check("BrowserServer.kill rejection is observed", async () => {
		const observed: unknown[] = []
		const onUnhandled = (reason: unknown) => observed.push(reason)
		process.on("unhandledRejection", onUnhandled)
		const unrelated = await createSession()
		const failed = await createSession()
		const unrelatedIndex = launchCaptures.length
		await unrelated.launch(goodUrl)
		const unrelatedTree = capturedLaunch(unrelatedIndex)
		const failureIndex = launchCaptures.length
		const killCountBefore = injectedServerKillCount
		armCloseGate()
		holdBrowserClose = true
		holdServerClose = true
		rejectNextNewContext = true
		rejectNextServerKill = true
		const rejectionObserved = failed.launch(goodUrl).then(() => false, () => true)
		let timely = false
		let owned: Identity[] = []
		let unrelatedUsable = false
		try {
			timely = await Promise.race([rejectionObserved, delay(6500).then(() => false)])
			owned = launchCaptures.slice(failureIndex).flat()
			unrelatedUsable = (await unrelated.screenshot()).length > 100
		} finally {
			releaseFaultGates()
			try {
				await bounded(rejectionObserved, 5000, "forced cleanup after gate release")
				await delay(50)
			} finally {
				process.off("unhandledRejection", onUnhandled)
			}
		}
		assert.ok(owned.length > 0, "the failed initialization created a browser server")
		console.log(JSON.stringify({ probe: "server-kill-rejection", rejectedWithinBound: timely, killCalls: injectedServerKillCount - killCountBefore, unhandledRejections: observed.length, leaderPid: browserLeader(owned).pid, unrelatedUsable }))
		assert.equal(timely, true, "forced cleanup must reject within the launch cleanup deadline")
		assert.ok(injectedServerKillCount > killCountBefore, "the test must reach the force-cleanup server.kill path")
		assert.equal(observed.length, 0, "cleanup must observe the asynchronous BrowserServer.kill rejection")
		assert.equal(unrelatedUsable, true, "cleanup must preserve the unrelated browser")
		const failedTree = owned
		assert.equal(await allGone(failedTree), true, "the force-cleanup path must terminate its owned Chromium tree")
	})
}

if (selectedCase === "all" || selectedCase === "combined-close-deadline") {
	await check("browser and server close share one bounded teardown window", async () => {
		const owner = await createSession()
		const captureIndex = launchCaptures.length
		await owner.launch(goodUrl)
		const owned = capturedLaunch(captureIndex)
		const leader = browserLeader(owned)
		const session = owner as unknown as BrowserSessionState
		assert.ok(session.browser && session.server)
		armCloseGate()
		holdBrowserClose = true
		holdServerClose = true
		const started = Date.now()
		const disposal = owner.dispose()
		let rejectedPromptly = false
		rejectedPromptly = await Promise.race([disposal.then(() => true), delay(6500).then(() => false)])
		const elapsedMs = Date.now() - started
		const exited = await allGone(owned)
		console.log(JSON.stringify({ probe: "combined-close-deadline", rejectedPromptly, elapsedMs, leaderPid: leader.pid, leaderStart: leader.start, exited }))
		releaseFaultGates()
		if (!rejectedPromptly) await bounded(disposal, 1000, "teardown completion after close-gate release")
		assert.equal(exited, true, "teardown force-kills only the owned server process")
		assert.equal(rejectedPromptly, true, "both close operations must fit within one teardown deadline")
		assert.ok(elapsedMs <= 6500, "combined close deadline should not stack two 5s waits")
	})
}

if (selectedCase === "all" || selectedCase === "normal-close-timers") {
	await check("ordinary close does not retain teardown timers", async () => {
		const session = await createSession()
		await session.launch(goodUrl)
		await new Promise<void>(resolve => setImmediate(resolve))
		const before = activeTimeoutCount()
		await session.close()
		await new Promise<void>(resolve => setImmediate(resolve))
		const after = activeTimeoutCount()
		console.log(JSON.stringify({ probe: "normal-close-timers", before, after, retained: after - before }))
		assert.ok(after <= before, `successful close added ${after - before} referenced timeout resource(s)`)
	})
}

if (selectedCase === "all" || selectedCase === "navigation-failure") {
	await check("navigation failure closes partially initialized browser", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "hc-browser-nav-failure-"))
		const owner = {}
		const ctx = { workspaceRoot: workspace, browserSessionOwner: owner } as unknown as ToolContext
		try {
			const captureIndex = launchCaptures.length
			const refusedPort = await unusedLocalPort()
			const result = await browserActionHandler({ action: "launch", url: `http://127.0.0.1:${refusedPort}/` }, ctx)
			assert.equal(result.isError, true, "unavailable local port should produce a navigation error")
			const failedLaunch = capturedLaunch(captureIndex)
			assert.ok(failedLaunch.length > 0, "Chromium launched before navigation failed")
			assert.equal(await allGone(failedLaunch), true, "handler failure cleanup terminates the partially initialized browser")
		} finally {
			// If an assertion interrupted the handler's catch path, clean only this owner.
			const { disposeBrowserSessions } = await import("../browser/handler.js")
			disposeBrowserSessions(owner)
			await rm(workspace, { recursive: true, force: true })
		}
	})
}

} finally {
	releaseFaultGates()
	rejectNextConnect = false
	rejectNextNewContext = false
	rejectNextServerKill = false
	for (const item of closeOverrides) {
		Object.defineProperty(item.browser, "close", { configurable: true, writable: true, value: item.original })
		try { await bounded(item.original(), 3500, "original Browser.close cleanup") } catch { /* identity-checked cleanup below */ }
	}
	for (const session of sessions) {
		try { await bounded(session.dispose(), 7000, "BrowserSession.dispose cleanup") } catch { /* identity-checked cleanup below */ }
	}
	for (const closeServer of launchServerClosers) {
		try { await bounded(closeServer(), 3500, "launchServer cleanup") } catch { /* identity-checked cleanup below */ }
	}
	const owned = launchCaptures.flat()
	if (owned.length > 0 && !(await allGone(owned, 2500))) await targetedCleanup(owned)
	await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
	;(browserType as unknown as { launch: BrowserTypeWithServer["launch"]; launchServer: BrowserTypeWithServer["launchServer"] }).launch = originalLaunch
	;(browserType as unknown as { launch: BrowserTypeWithServer["launch"]; launchServer: BrowserTypeWithServer["launchServer"] }).launchServer = originalLaunchServer
	;(browserType as unknown as { launch: BrowserTypeWithServer["launch"]; launchServer: BrowserTypeWithServer["launchServer"]; connect: BrowserTypeWithServer["connect"] }).connect = originalConnect
}

if (failures.length > 0) throw new AggregateError(failures.map(message => new Error(message)), "Browser close backstop checks failed")
