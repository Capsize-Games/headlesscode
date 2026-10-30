import { spawn, type ChildProcess } from "node:child_process"
import type * as fs from "node:fs"

export async function acquirePrivateDeliveryLock(
	lock: fs.promises.FileHandle,
): Promise<void> {
	const child = spawn("/usr/bin/flock", ["-n", "-x", "3"], {
		shell: false,
		stdio: ["ignore", "ignore", "ignore", lock.fd],
	})
	await waitForLockHelper(child)
}

async function waitForLockHelper(child: ChildProcess): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		child.once("error", () => rejectLockStart(reject))
		child.once("close", (code) => settleLockResult(code, resolve, reject))
	})
}

function rejectLockStart(reject: (error: Error) => void): void {
	reject(new Error("private Curl delivery lock helper could not start"))
}

function settleLockResult(
	code: number | null,
	resolve: () => void,
	reject: (error: Error) => void,
): void {
	if (code === 0) resolve()
	else reject(new Error("private Curl delivery is pending another reconciler"))
}
