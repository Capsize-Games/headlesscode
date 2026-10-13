/**
 * Shared shutdown-wait for the local dashboard CLIs (`dashboard`, `trend`).
 * Keeps the process alive until SIGINT/SIGTERM, then releases the port so
 * the process can exit. Extracted so the two thin CLI dispatches do not
 * each carry an identical copy of this block.
 */

import type { Server } from "node:http"

export function waitForShutdownSignal(
	server: Server,
	label: string,
): Promise<number> {
	return new Promise<number>((resolve) => {
		let shuttingDown = false
		const onSignal = (): void => {
			// Only the first signal shuts down; a second Ctrl-C while the
			// server is mid-close is ignored (the process exits on its own
			// once the listening handle is gone).
			if (shuttingDown) {
				return
			}
			shuttingDown = true
			process.stdout.write(`\n[${label}] shutting down\n`)
			process.removeListener("SIGINT", onSignal)
			process.removeListener("SIGTERM", onSignal)
			// Release the port: stop accepting new connections and drop
			// keep-alive sockets so the process can exit. Without close the
			// listening handle keeps the event loop alive and the port bound.
			server.close()
			server.closeAllConnections?.()
			resolve(0)
		}
		process.on("SIGINT", onSignal)
		process.on("SIGTERM", onSignal)
	})
}
