import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomUUID } from "node:crypto"
import { EmergencyControl } from "./emergency-controller.js"
import type { EvidenceRuntimeConfig } from "../evidence/index.js"

export async function startSessionEmergencyControl(options: {
	workspaceRoot: string
	evidence?: EvidenceRuntimeConfig
	env?: NodeJS.ProcessEnv
}): Promise<EmergencyControl | undefined> {
	const env = options.env ?? process.env
	const identity = env.HEADLESSCODE_CONTROL_ID
	if (!identity) return undefined
	const workspace = fs.realpathSync(options.workspaceRoot)
	const stateDirectory = path.resolve(env.HEADLESSCODE_CONTROL_STATE_DIR ?? env.HEADLESSCODE_CONTROL_DIR ?? path.join(os.homedir(), ".local", "share", "headlesscode", "control"))
	const socketDirectory = path.resolve(env.HEADLESSCODE_CONTROL_SOCKET_DIR ?? stateDirectory)
	for (const directory of [stateDirectory, socketDirectory]) {
		if (directory === workspace || directory.startsWith(`${workspace}${path.sep}`) || workspace.startsWith(`${directory}${path.sep}`)) throw new Error("emergency control directories must be outside the task workspace")
		for (let cursor = directory; cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
			try {
				if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error("emergency control directories must not traverse symlinks")
			} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
		}
	}
	const evidence = options.evidence
	const control = await EmergencyControl.start({
		identity, stateDirectory, socketDirectory,
		...(evidence ? { recordControlEvent: async (record) => {
			await evidence.evidenceJournal.append({ sessionId: evidence.sessionId, requestId: randomUUID(), kind: "emergency_control", actor: "host-emergency-controller", origin: "cli-control", payload: record })
		} } : {}),
	})
	try { control.assertRunning(); return control } catch (error) { await control.close(); throw error }
}

export async function finishSessionEmergencyControl(control?: EmergencyControl): Promise<boolean> {
	if (!control) return true
	try {
		if (control.state === "running") {
			const stopped = await control.command("stop", "session finished")
			return stopped.accepted && stopped.record.state === "stopped"
		}
		return control.state !== "failed-to-stop"
	} finally { await control.close() }
}
