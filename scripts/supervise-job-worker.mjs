#!/usr/bin/env node
// Supervisor for one queued issue worker. This process owns the worker child,
// captures its actual exit status, and writes completion only after its
// process group is absent. It is launched as a detached process by run-worker.
import { spawn } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

const [worktree, receiptDir, attemptId, group, wrapperPath] = process.argv.slice(2)
if (!worktree || !receiptDir || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(attemptId ?? "") ||
	!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(group ?? "") || !wrapperPath) process.exit(2)

function procStat(pid) {
	const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
	const close = raw.lastIndexOf(")")
	if (close < 0) throw new Error("malformed proc stat")
	const fields = raw.slice(close + 1).trim().split(/\s+/)
	const result = { state: fields[0], pgrp: Number(fields[2]), session: Number(fields[3]), startTicks: fields[19] }
	if (!result.state || !Number.isSafeInteger(result.pgrp) || !Number.isSafeInteger(result.session) || !/^\d+$/.test(result.startTicks ?? "")) throw new Error("malformed proc identity")
	return result
}

function atomicReceipt(file, value) {
	const temporary = `${file}.${process.pid}.tmp`
	fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
	fs.renameSync(temporary, file)
}

function atomicText(file, value) {
	const temporary = `${file}.${process.pid}.tmp`
	fs.writeFileSync(temporary, value, { flag: "wx", mode: 0o600 })
	fs.renameSync(temporary, file)
}

function groupState(pgid, startTicks) {
	const entries = fs.readdirSync("/proc")
	let active = false
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue
		let stat
		try { stat = procStat(Number(entry)) }
		catch (error) {
			const code = error?.code
			if (code === "ENOENT" || code === "ESRCH") continue
			return "unknown"
		}
		if (Number(entry) === pgid && stat.startTicks !== startTicks) continue
		if (stat.pgrp === pgid && stat.session === pgid && stat.state !== "Z" && stat.state !== "X") active = true
	}
	return active ? "active" : "absent"
}

if (process.platform !== "linux") process.exit(2)
const logFd = fs.openSync(path.join(worktree, "harness.log"), "a")
const child = spawn("bash", [wrapperPath], { detached: true, stdio: ["ignore", logFd, logFd, "pipe"] })
if (!child.pid || !child.stdio[3]) process.exit(2)
const pid = child.pid
let identity
try {
	let stat
	for (let attempt = 0; attempt < 50; attempt++) {
		try { stat = procStat(pid) } catch { await new Promise((resolve) => setTimeout(resolve, 10)); continue }
		if (stat.pgrp === pid && stat.session === pid && stat.state !== "Z" && stat.state !== "X") break
		stat = undefined
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	if (!stat || stat.pgrp !== pid || stat.session !== pid || stat.state === "Z" || stat.state === "X") throw new Error("worker was not its process-group leader")
	identity = { version: 1, attemptId, group, pid, pgid: pid, startTicks: stat.startTicks }
	atomicText(path.join(worktree, ".harness.pid"), String(pid))
	// Publish the attempt-bound receipt last. run-worker treats its appearance
	// as the startup barrier and immediately checks the matching PID marker.
	atomicReceipt(path.join(receiptDir, `${group}.launch`), identity)
} catch {
	try { process.kill(-pid, "SIGKILL") } catch { /* best effort before any task code is released */ }
	child.stdio[3].destroy()
	process.exit(2)
}

// The wrapper blocks on this private pipe until its exact OS identity has been
// persisted. User task code cannot run before that boundary is established.
const closed = new Promise((resolve) => {
	child.once("close", (code, signal) => resolve({ code, signal }))
})
child.stdio[3].end("go\n")
const status = await closed
let teardown = "unknown"
while (teardown !== "absent") {
	try { teardown = groupState(identity.pgid, identity.startTicks) }
	catch { teardown = "unknown" }
	if (teardown !== "absent") await new Promise((resolve) => setTimeout(resolve, 100))
}

const signalNumber = status.signal ? ({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 }[status.signal] ?? 1) : 0
const exitCode = status.code ?? Math.min(255, 128 + signalNumber)
if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) process.exit(2)
atomicReceipt(path.join(receiptDir, `${group}.complete`), { ...identity, exitCode })
try { fs.unlinkSync(wrapperPath) } catch { /* stale private wrapper is harmless; receipt remains authoritative */ }
fs.closeSync(logFd)
