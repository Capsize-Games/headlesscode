import { spawn } from "node:child_process"
import {
	ensureCancelMarker,
} from "./repository-curl-repair-v2-evidence-store.js"

export interface BoundedStageProcessRequest {
	command: string[]
	cwd: string
	cancelPath: string
	signal: AbortSignal
	timeoutMs: number
	env: NodeJS.ProcessEnv
}

export async function runBoundedStageProcess(
	request: BoundedStageProcessRequest,
): Promise<void> {
	const child = spawn(request.command[0]!, request.command.slice(1), {
		cwd: request.cwd, env: request.env,
		stdio: "ignore", shell: false, detached: false,
	})
	await awaitChild(child, request)
}

async function awaitChild(
	child: ReturnType<typeof spawn>,
 request: BoundedStageProcessRequest,
): Promise<void> {
	const timers = armCancellation(child, request.cancelPath, request.signal,
		request.timeoutMs)
	try {
		const code = await waitForExit(child)
		if (request.signal.aborted || timers.requested()) {
			throw new Error("Curl v2 stage was cancelled")
		}
		if (code !== 0) throw new Error("Curl v2 fixed Fleet stage failed")
	} finally {
		timers.clear()
	}
}

function armCancellation(
	child: ReturnType<typeof spawn>,
	cancelPath: string,
	signal: AbortSignal,
	timeoutMs: number,
): { requested: () => boolean; clear: () => void } {
	let requested = false
	const request = () => {
		if (requested) return
		requested = true
		void ensureCancelMarker(cancelPath)
	}
	const onAbort = () => request()
	signal.addEventListener("abort", onAbort, { once: true })
	const timers = createTimers(child, timeoutMs, request)
	return cancellationState(() => requested, timers, signal, onAbort)
}

function cancellationState(
	isRequested: () => boolean,
	timers: ReturnType<typeof setTimeout>[],
	signal: AbortSignal,
	onAbort: () => void,
): { requested: () => boolean; clear: () => void } {
	return {
		requested: isRequested,
		clear: () => {
			timers.forEach(clearTimeout)
			signal.removeEventListener("abort", onAbort)
		},
	}
}

function createTimers(
	child: ReturnType<typeof spawn>,
	timeoutMs: number,
	request: () => void,
): ReturnType<typeof setTimeout>[] {
	return [
		setTimeout(request, timeoutMs),
		setTimeout(() => child.kill("SIGKILL"), timeoutMs + 30_000),
	]
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<number | null> {
	return new Promise((resolve, reject) => {
		child.once("error", () => {
			reject(new Error("Curl v2 Fleet stage could not start"))
		})
		child.once("close", (code) => resolve(code))
	})
}
