import { readdirSync, readFileSync } from "node:fs"

// Shared process-group probes for tests.
//
// Background: the RSI eval sandbox denies group signaling (killpg
// persistently returns EPERM even for same-UID callers), while raw
// docker, host, and CI allow it. Tests that assert process-group
// state must therefore verify via /proc on Linux instead of trusting
// kill() errnos. See muse-executor and package-worker-runtime tests,
// which failed baselines on EPERM/ESRCH confusion before this module.

export function procState(pid: number): { pgrp: number; state: string } | null {
	let text: string
	try {
		text = readFileSync(`/proc/${pid}/stat`, "utf8")
	} catch {
		return null
	}
	const afterComm = text.slice(text.lastIndexOf(")") + 2).split(" ")
	return { pgrp: Number(afterComm[2]), state: afterComm[0] ?? "" }
}

// True when at least one member of pgid is still running (not zombie,
// not already reaped). Unreadable /proc conservatively counts as live.
export function groupHasLiveMember(pgid: number): boolean {
	let entries: string[]
	try {
		entries = readdirSync("/proc")
	} catch {
		return true
	}
	for (const entry of entries) {
		if (!/^[0-9]+$/.test(entry)) continue
		const stat = procState(Number(entry))
		if (!stat || stat.pgrp !== pgid) continue
		if (stat.state !== "Z" && stat.state !== "X") return true
	}
	return false
}

// True when no member of pgid is still running. Uses procfs on Linux
// (immune to group-signal policy); falls back to the classic ESRCH
// probe elsewhere.
export function processGroupGone(pgid: number): boolean {
	if (process.platform !== "linux") {
		try {
			process.kill(-pgid, 0)
			return false
		} catch (error) {
			return (error as NodeJS.ErrnoException).code === "ESRCH"
		}
	}
	return !groupHasLiveMember(pgid)
}
