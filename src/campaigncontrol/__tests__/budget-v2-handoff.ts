import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { constants, readFileSync } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import type { Fixture } from "./budget-v2-fixtures.js"
import {
	bridgeBaseEnvironment, type BridgeFlags,
} from "./budget-v2-fixtures.js"

const pythonBridge = readFileSync(
	new URL("./budget-v2-bridge.py", import.meta.url), "utf8")
const pythonBridgeHandoff = readFileSync(
	new URL("./budget-v2-handoff.py", import.meta.url), "utf8")

type HandoffReply = (reply: Record<string, unknown>) => void | Promise<void>

interface HandoffExchange {
	child: ReturnType<typeof spawn>
	stdin: NodeJS.WritableStream
	onAdmitted: HandoffReply
	stdout: string
	admitted: boolean
	handling: boolean
	protocolError: boolean
}

interface HandoffPipes {
	child: ReturnType<typeof spawn>
	stdout: NodeJS.ReadableStream
	stdin: NodeJS.WritableStream
}

function failHandoff(exchange: HandoffExchange): void {
	exchange.protocolError = true
	exchange.child.kill("SIGKILL")
}

function readHandoffReply(
	exchange: HandoffExchange,
): Record<string, unknown> | null {
	const newline = exchange.stdout.indexOf("\n")
	if (newline < 0) return null
	if (newline !== exchange.stdout.length - 1) {
		failHandoff(exchange)
		return null
	}
	try {
		return JSON.parse(exchange.stdout.slice(0, newline)) as Record<
			string, unknown>
	} catch {
		failHandoff(exchange)
		return null
	}
}

function settleHandoffReply(
	exchange: HandoffExchange,
	reply: Record<string, unknown>,
): void {
	exchange.handling = true
	try {
		void Promise.resolve(exchange.onAdmitted(reply)).then(() => {
			exchange.admitted = true
			const started = reply.started === true ? "send-started\n" : "abort\n"
			exchange.stdin.write(started)
			exchange.stdin.end()
		}).catch(() => failHandoff(exchange))
	} catch {
		failHandoff(exchange)
	}
}

function noteHandoffData(
	exchange: HandoffExchange,
	chunk: Buffer,
): void {
	exchange.stdout += chunk.toString("utf8")
	if (Buffer.byteLength(exchange.stdout) > 64 * 1024) {
		return failHandoff(exchange)
	}
	if (exchange.admitted || exchange.handling) {
		return failHandoff(exchange)
	}
	const reply = readHandoffReply(exchange)
	if (reply === null) return
	settleHandoffReply(exchange, reply)
}

function handoffEnvironment(
	home: string,
	flags: BridgeFlags,
): Record<string, string> {
	return {
		...bridgeBaseEnvironment(home),
		HEADLESSCODE_CAMPAIGN_LOCK_FD: "3",
		...(flags.month ? { FLEET_TEST_MONTH: flags.month } : {}),
		...(flags.crashHandoff ? { FLEET_TEST_CRASH_AFTER_ADMIT: "1" } : {}),
	}
}

function openHandoffChild(
	lockFd: number,
	home: string,
	flags: BridgeFlags,
): HandoffPipes {
	const child = spawn("/usr/bin/python3", ["-c", pythonBridgeHandoff], {
		stdio: ["pipe", "pipe", "ignore", lockFd],
		env: handoffEnvironment(home, flags),
	})
	const { stdout, stdin } = child
	if (!stdout || !stdin) {
		child.kill("SIGKILL")
		throw new Error("fixture handoff pipes are unavailable")
	}
	return { child, stdout, stdin }
}

function watchHandoffClose(
	child: ReturnType<typeof spawn>,
	exchange: HandoffExchange,
	timer: NodeJS.Timeout,
	resolve: () => void,
	reject: (error: Error) => void,
): void {
	child.once("error", () => {
		exchange.protocolError = true
		reject(new Error("fixture handoff spawn failed"))
	})
	child.once("close", (code) => {
		clearTimeout(timer)
		if (code !== 0 || !exchange.admitted || exchange.protocolError) {
			reject(new Error("fixture request-start handoff failed"))
		} else {
			resolve()
		}
	})
}

function driveHandoffReply(
	pipes: HandoffPipes,
	onAdmitted: HandoffReply,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const exchange: HandoffExchange = {
			child: pipes.child,
			stdin: pipes.stdin,
			onAdmitted,
			stdout: "",
			admitted: false,
			handling: false,
			protocolError: false,
		}
		const timer = setTimeout(() => failHandoff(exchange), 10_000)
		pipes.stdout.on("data", (chunk: Buffer) => noteHandoffData(exchange, chunk))
		watchHandoffClose(pipes.child, exchange, timer, resolve, reject)
	})
}

async function openDispatchLock(controlDir: string): Promise<FileHandle> {
	const lock = await fs.open(path.join(controlDir, "campaign-dispatch.lock"),
		constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600)
	await lock.chmod(0o600)
	return lock
}

export function makeRequestStartHandoff(
	home: string,
	controlDir: string,
	flags: BridgeFlags,
): Fixture["requestStartHandoff"] {
	return async (message, onAdmitted) => {
		const lock = await openDispatchLock(controlDir)
		try {
			const pipes = openHandoffChild(lock.fd, home, flags)
			const delivery = driveHandoffReply(pipes, onAdmitted)
			pipes.stdin.write(JSON.stringify(message) + "\n")
			await delivery
		} finally {
			await lock.close()
		}
	}
}

function invokeEnvironment(
	home: string,
	flags: BridgeFlags,
): Record<string, string> {
	return {
		...bridgeBaseEnvironment(home),
		...(flags.fault ? { FLEET_TEST_FAULT: flags.fault } : {}),
		...(flags.month ? { FLEET_TEST_MONTH: flags.month } : {}),
	}
}

export function makeInvoke(
	home: string,
	flags: BridgeFlags,
): Fixture["invoke"] {
	return async (message) => {
		const child = spawnSync("/usr/bin/python3", ["-c", pythonBridge], {
			input: JSON.stringify(message), encoding: "utf8",
			timeout: 10_000,
			env: invokeEnvironment(home, flags),
		})
		flags.fault = undefined
		const detail = (child.stderr ?? "").slice(0, 1200)
		const cause = child.status ?? child.error?.message ?? "spawn-error"
		if (child.error || child.status !== 0) {
			throw new Error("offline Fleet v2 bridge call failed closed (" +
				`${cause}): ${detail}`)
		}
		return JSON.parse(child.stdout.trim()) as Record<string, unknown>
	}
}

const lockProgram = "import fcntl,os,sys; " +
	"fd=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600); " +
	"exec('try:\\n fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\\n" +
	"except BlockingIOError:\\n sys.exit(1)')"

export function tryDispatchLockFile(controlDir: string): boolean {
	const child = spawnSync("/usr/bin/python3",
		["-c", lockProgram, path.join(controlDir, "campaign-dispatch.lock")],
		{ encoding: "utf8", timeout: 2_000 })
	return child.status === 0
}

export function grantDbPath(f: Fixture): string {
	return path.join(f.home, ".local/state/fleet-security-watch",
		"automation/campaign/rsi-budget-bridge.sqlite3")
}

export function expireGrantRow(bridgeDb: string, jobId: string): void {
	const program = "import sqlite3,sys,time; " +
		"db=sqlite3.connect(sys.argv[1]); " +
		"db.execute('UPDATE grants SET issued_at_ms=?,deadline_at_ms=? " +
		"WHERE job_id=?',(int(time.time()*1000)-120000," +
		"int(time.time()*1000)-60000,sys.argv[2])); " +
		"db.commit(); db.close()"
	const expired = spawnSync("/usr/bin/python3",
		["-c", program, bridgeDb, jobId],
		{ encoding: "utf8", timeout: 5_000 })
	assert.equal(expired.status, 0)
}
