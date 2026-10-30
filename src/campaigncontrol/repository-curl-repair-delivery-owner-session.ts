import * as fs from "node:fs"

export function resolveOwnerSessionBus(
	uid: number,
): { address: string; runtimeDir: string } | null {
	try {
		const runtimeDir = `/run/user/${uid}`
		if (!isPrivateOwnerDirectory(runtimeDir, uid) || !isSafeTmp())
			return null
		return uniqueOwnerSession(uid, runtimeDir)
	} catch {
		return null
	}
}

function uniqueOwnerSession(
	uid: number,
	runtimeDir: string,
): { address: string; runtimeDir: string } | null {
	const sessions = findOwnerSessions(uid, runtimeDir)
	return sessions.length === 1
		? { address: sessions[0]!.address, runtimeDir }
		: null
}

function findOwnerSessions(
	uid: number,
	runtimeDir: string,
): Array<{ pid: number; address: string }> {
	const sessions: Array<{ pid: number; address: string }> = []
	for (const entry of fs.readdirSync("/proc")) {
		const pid = parseProcessId(entry)
		if (pid === null) continue
		const address = verifiedSessionAddress(
			`/proc/${entry}`,
			pid,
			uid,
			runtimeDir,
		)
		if (address) sessions.push({ pid, address })
	}
	return sessions
}

function parseProcessId(entry: string): number | null {
	return /^[1-9][0-9]{0,8}$/.test(entry) ? Number(entry) : null
}

function isSafeTmp(): boolean {
	const stat = fs.statSync("/tmp")
	return stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0
}

function verifiedSessionAddress(
	proc: string,
	pid: number,
	uid: number,
	runtimeDir: string,
): string | null {
	try {
		if (!isOwnerXfceSession(proc, uid)) return null
		return validatedBusAddress(proc, pid, uid, runtimeDir)
	} catch {
		return null
	}
}

function isOwnerXfceSession(proc: string, uid: number): boolean {
	return (
		fs.statSync(proc).uid === uid &&
		fs.readFileSync(`${proc}/comm`, "utf8").trim() === "xfce4-session" &&
		fs.realpathSync(`${proc}/exe`) === "/usr/bin/xfce4-session"
	)
}

function validatedBusAddress(
	proc: string,
	pid: number,
	uid: number,
	runtimeDir: string,
): string | null {
	const variables = readProcEnvironment(proc)
	const address = variables.DBUS_SESSION_BUS_ADDRESS
	if (
		variables.XDG_RUNTIME_DIR !== runtimeDir ||
		!isOwnerDbusProcess(pid, uid, address)
	)
		return null
	return isOwnerSocketAddress(address, uid) ? address : null
}

function isOwnerSocketAddress(
	address: string | undefined,
	uid: number,
): boolean {
	const match = address?.match(
		/^unix:path=(\/tmp\/dbus-[A-Za-z0-9]{1,64}),guid=([a-f0-9]{32})$/,
	)
	if (!match) return false
	const socketStat = fs.lstatSync(match[1]!)
	return socketStat.isSocket() && socketStat.uid === uid
}

function readProcEnvironment(proc: string): Record<string, string> {
	const env: Record<string, string> = {}
	for (const item of fs
		.readFileSync(`${proc}/environ`)
		.toString("utf8")
		.split("\0")) {
		const equals = item.indexOf("=")
		if (equals < 0) continue
		const name = item.slice(0, equals)
		if (name === "DBUS_SESSION_BUS_ADDRESS" || name === "XDG_RUNTIME_DIR")
			env[name] = item.slice(equals + 1)
	}
	return env
}

export function isPrivateOwnerDirectory(
	directory: string,
	uid: number,
): boolean {
	const info = fs.lstatSync(directory)
	return (
		info.isDirectory() &&
		!info.isSymbolicLink() &&
		info.uid === uid &&
		(info.mode & 0o077) === 0 &&
		fs.realpathSync(directory) === directory
	)
}

function isOwnerDirectory(directory: string, uid: number): boolean {
	const info = fs.lstatSync(directory)
	return (
		info.isDirectory() &&
		!info.isSymbolicLink() &&
		info.uid === uid &&
		fs.realpathSync(directory) === directory
	)
}

function isOwnerDbusProcess(
	sessionPid: number,
	uid: number,
	address?: string,
): boolean {
	if (!address) return false
	for (const entry of fs.readdirSync("/proc")) {
		if (isVerifiedDbusProcess(entry, sessionPid, uid, address)) return true
	}
	return false
}

function isVerifiedDbusProcess(
	entry: string,
	sessionPid: number,
	uid: number,
	address: string,
): boolean {
	if (!/^[1-9][0-9]{0,8}$/.test(entry) || Number(entry) === sessionPid)
		return false
	return checkDbusProcess(`/proc/${entry}`, Number(entry), uid, address)
}

function checkDbusProcess(
	proc: string,
	pid: number,
	uid: number,
	address: string,
): boolean {
	try {
		if (!hasExpectedDbusIdentity(proc, uid, address)) return false
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function hasExpectedDbusIdentity(
	proc: string,
	uid: number,
	address: string,
): boolean {
	return (
		fs.statSync(proc).uid === uid &&
		["dbus-daemon", "dbus-broker"].includes(
			fs.readFileSync(`${proc}/comm`, "utf8").trim(),
		) &&
		readProcEnvironment(proc).DBUS_SESSION_BUS_ADDRESS === address
	)
}
