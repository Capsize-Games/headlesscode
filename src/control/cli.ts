import { EmergencyControl, requestEmergencyControl, type EmergencyAction } from "./emergency-controller.js"
import * as path from "node:path"

function usage(): string {
	return "Usage: headlesscode-control <identity> <status|pause|resume|stop> [--session <id>] [--reason <text>]"
}

export async function controlMain(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [identity, rawAction, ...rest] = args
	if (!identity || !rawAction || !["status", "pause", "resume", "stop"].includes(rawAction)) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	let reason = ""
	let session: string | undefined
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] === "--reason" && rest[index + 1]) { reason = rest[index + 1]!; index += 1; continue }
		if (rest[index] === "--session" && rest[index + 1] && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(rest[index + 1]!)) { session = rest[index + 1]!; index += 1; continue }
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	const stateRoot = env.HEADLESSCODE_CONTROL_STATE_DIR ?? env.HEADLESSCODE_CONTROL_DIR
	const socketRoot = env.HEADLESSCODE_CONTROL_SOCKET_DIR ?? stateRoot
	const stateDirectory = session && stateRoot ? path.join(stateRoot, session) : stateRoot
	const socketDirectory = session && socketRoot ? socketRoot.includes("{session}") ? socketRoot.replaceAll("{session}", session) : path.join(socketRoot, session) : socketRoot
	try {
		let result
		try {
			result = await requestEmergencyControl({ identity, action: rawAction as EmergencyAction, reason, stateDirectory, socketDirectory })
		} catch {
			const control = await EmergencyControl.start({ identity, stateDirectory, socketDirectory })
			try { result = await control.command(rawAction as EmergencyAction, reason) } finally { await control.close() }
		}
		process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`)
		return result.accepted ? 0 : 1
	} catch (error) {
		process.stderr.write(`headlesscode-control: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
	void controlMain().then((code) => { process.exitCode = code })
}
