import { requestEmergencyControl, type EmergencyAction } from "./emergency-controller.js"

function usage(): string {
	return "Usage: headlesscode-control <identity> <status|pause|resume|stop> [--reason <text>]"
}

export async function controlMain(args = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const [identity, rawAction, ...rest] = args
	if (!identity || !rawAction || !["status", "pause", "resume", "stop"].includes(rawAction)) {
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	let reason = ""
	for (let index = 0; index < rest.length; index += 1) {
		if (rest[index] === "--reason" && rest[index + 1]) { reason = rest[index + 1]!; index += 1; continue }
		process.stderr.write(`${usage()}\n`)
		return 2
	}
	try {
		const result = await requestEmergencyControl({ identity, action: rawAction as EmergencyAction, reason, stateDirectory: env.HEADLESSCODE_CONTROL_DIR, socketDirectory: env.HEADLESSCODE_CONTROL_SOCKET_DIR })
		process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`)
		return 0
	} catch (error) {
		process.stderr.write(`headlesscode-control: ${error instanceof Error ? error.message : String(error)}\n`)
		return 1
	}
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
	void controlMain().then((code) => { process.exitCode = code })
}
