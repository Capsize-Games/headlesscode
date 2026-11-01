import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { CURL_PRIVATE_BOARD_CARD_ID, CURL_PRIVATE_BOARD_API_URL } from
	"./repository-curl-profile.js"
import type { CurlPrivateBoardTransport } from
	"./repository-curl-private-types.js"

const BOARD_CLI_PATH = "/home/joe/Projects/agent-board/cli/agent-board.mjs"
const BOARD_AUTHOR = "HeadlessCode"

export function fixedBoardTransport(): CurlPrivateBoardTransport {
	return { hasMarker: findBoardMarker, addComment: addBoardComment }
}

async function findBoardMarker(
	marker: string,
	lock: fs.promises.FileHandle,
): Promise<boolean> {
	let cursor: string | undefined
	for (let page = 0; page < 10; page++) {
		const exists = await findBoardMarkerPage(marker, cursor, lock)
		if (exists.found) return true
		if (!exists.cursor) return false
		cursor = exists.cursor
	}
	throw new
		Error("private board history exceeds the bounded reconciliation window")
}

async function findBoardMarkerPage(
	marker: string,
	cursor: string | undefined,
	lock: fs.promises.FileHandle,
): Promise<{ found: boolean; cursor?: string }> {
	const result = await readBoardPage(cursor, lock)
	if (pageHasMarker(result, marker)) return { found: true }
	return { found: false, cursor: nextHistoryCursor(result) }
}

async function readBoardPage(
	cursor: string | undefined,
	lock: fs.promises.FileHandle,
): Promise<Record<string, unknown>> {
	const args = boardHistoryArgs(cursor)
	return parseCliJson(await runBoardCli(args, lock))
}

function boardHistoryArgs(cursor: string | undefined): string[] {
	return [
		BOARD_CLI_PATH, "card", CURL_PRIVATE_BOARD_CARD_ID, "--json",
		"--visao", "historico", "--limite", "200", "--url",
		CURL_PRIVATE_BOARD_API_URL,
		...(cursor ? ["--cursor", cursor] : []),
	]
}

function pageHasMarker(page: Record<string, unknown>, marker: string): boolean {
	const events = Array.isArray(page.eventos) ? page.eventos : []
	return events.some((item) => hasEventMarker(item, marker))
}

function hasEventMarker(item: unknown, marker: string): boolean {
	if (!item || typeof item !== "object") return false
	const detail = (item as Record<string, unknown>).detalhe
	return typeof detail === "string" && detail.includes(marker)
}

function nextHistoryCursor(page: Record<string, unknown>): string | undefined {
	const next = page.proximo_cursor
	if (!next) return undefined
	if (typeof next !== "string" || next.length > 512) {
		throw new Error("private board history cursor is invalid")
	}
	return next
}

async function addBoardComment(
	comment: string,
	lock: fs.promises.FileHandle,
): Promise<void> {
	const args = [
		BOARD_CLI_PATH, "comentar", CURL_PRIVATE_BOARD_CARD_ID, comment,
		"--autor", BOARD_AUTHOR, "--url", CURL_PRIVATE_BOARD_API_URL,
	]
	await runBoardCli(args, lock)
}

async function runBoardCli(
	args: string[],
	lock: fs.promises.FileHandle,
): Promise<string> {
	const child = spawnBoardCli(args, lock)
	return await collectBoardCliOutput(child)
}

function spawnBoardCli(
	args: string[],
	lock: fs.promises.FileHandle,
): ChildProcess {
	return spawn(process.execPath, args, {
		cwd: path.dirname(BOARD_CLI_PATH),
		shell: false,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "ignore", lock.fd],
		env: boardCliEnvironment(),
	})
}

function boardCliEnvironment(): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: os.homedir(),
		...(process.env.AGENT_BOARD_KEY
			? { AGENT_BOARD_KEY: process.env.AGENT_BOARD_KEY }
			: {}),
		AGENT_BOARD_URL: CURL_PRIVATE_BOARD_API_URL,
		AGENT_BOARD_AUTHOR: BOARD_AUTHOR,
	}
}

interface BoardCliOutputState {
	output: string
	bytes: number
	settled: boolean
	timer?: NodeJS.Timeout
}

async function collectBoardCliOutput(child: ChildProcess): Promise<string> {
	return await new Promise((resolve, reject) => {
		const state: BoardCliOutputState = { output: "", bytes: 0, settled: false }
		const finish = (
			error?: Error,
			code?: number | null,
			signal?: NodeJS.Signals,
		): void => {
			finishBoardCli({ child, state, error, code, signal, resolve, reject })
		}
		state.timer = setTimeout(
			() => finish(new Error("private board CLI timed out")), 20_000,
		)
		state.timer.unref()
		attachBoardCliListeners(child, state, finish)
	})
}

function attachBoardCliListeners(
	child: ChildProcess,
	state: BoardCliOutputState,
	finish: (
		error?: Error,
		code?: number | null,
		signal?: NodeJS.Signals,
	) => void,
): void {
	child.stdout?.on("data", (chunk: Buffer) =>
		collectBoardChunk(chunk, state, finish))
	child.once("error", () =>
		finish(new Error("private board CLI could not start")))
	child.once("close", (code) => finish(undefined, code))
}

function collectBoardChunk(
	chunk: Buffer,
	state: BoardCliOutputState,
	finish: (
		error?: Error,
		code?: number | null,
		signal?: NodeJS.Signals,
	) => void,
): void {
	state.bytes += chunk.length
	if (state.bytes > 64 * 1024) {
		return finish(new Error("private board response exceeds its bound"),
			undefined, "SIGKILL")
	}
	state.output += chunk.toString("utf8")
}

function finishBoardCli(input: {
	child: ChildProcess
	state: BoardCliOutputState
	error?: Error
	code?: number | null
	signal?: NodeJS.Signals
	resolve: (value: string) => void
	reject: (error: Error) => void
}): void {
	if (input.state.settled) return
	input.state.settled = true
	if (input.state.timer) clearTimeout(input.state.timer)
	if (input.error) stopBoardCli(input.child, input.signal ?? "SIGTERM")
	settleBoardCliResult(input)
}

function settleBoardCliResult(input: {
	state: BoardCliOutputState
	error?: Error
	code?: number | null
	resolve: (value: string) => void
	reject: (error: Error) => void
}): void {
	if (input.error) input.reject(input.error)
	else if (input.code === 0) input.resolve(input.state.output)
	else input.reject(new Error("private board CLI failed"))
}

function stopBoardCli(child: ChildProcess, signal: NodeJS.Signals): void {
	try {
		if (child.pid) process.kill(-child.pid, signal)
	} catch {
		// The process group may already have exited.
	}
}


function parseCliJson(value: string): Record<string, unknown> {
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch {
		throw new Error("private board response is invalid JSON")
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("private board response has an invalid shape")
	}
	return parsed as Record<string, unknown>
}
