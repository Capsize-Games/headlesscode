import * as fs from "node:fs"
import * as path from "node:path"

import { FileEvidenceCollector } from "../evidence/collector.js"

export interface ContainedEvidenceService {
	readonly collector: FileEvidenceCollector
	readonly sessions: readonly string[]
	readonly configDirectory: string
	close(): Promise<void>
}

export async function startContainedEvidenceService(options: {
	storageDir: string
	socketPath: string
	configDirectory: string
	sessionIds: string[]
	repoRoot?: string
}): Promise<ContainedEvidenceService> {
	const sessions = [...new Set(options.sessionIds)]
	if (!sessions.length || sessions.length !== options.sessionIds.length) throw new Error("provide one or more unique per-worker session IDs")
	for (const sessionId of sessions) if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error(`invalid evidence session ID: ${sessionId}`)
	const storagePath = path.resolve(options.storageDir)
	const configPath = path.resolve(options.configDirectory)
	const socketPath = path.resolve(options.socketPath)
	const repoPath = options.repoRoot ? fs.realpathSync(path.resolve(options.repoRoot)) : undefined
	assertNoSymlinkAncestors(storagePath)
	assertNoSymlinkAncestors(configPath)
	assertNoSymlinkAncestors(path.dirname(socketPath))
	const requestedRoots = [storagePath, configPath, socketPath, ...(repoPath ? [repoPath] : [])]
	for (let i = 0; i < requestedRoots.length; i++) {
		for (let j = i + 1; j < requestedRoots.length; j++) if (overlaps(requestedRoots[i]!, requestedRoots[j]!)) throw new Error("evidence storage, config, socket, and repository paths must be separate")
	}
	const storageDir = preparePrivateDirectory(options.storageDir)
	const configDirectory = preparePrivateDirectory(options.configDirectory)
	if (Buffer.byteLength(socketPath) > 100) throw new Error("Unix evidence socket path is too long for the local runtime; choose a shorter protected path")
	assertNoSymlinkAncestors(path.dirname(socketPath))
	if (fs.existsSync(socketPath)) throw new Error("refusing to replace an existing evidence socket path")
	const roots = [storageDir, configDirectory, socketPath, ...(repoPath ? [repoPath] : [])]
	for (let i = 0; i < roots.length; i++) {
		for (let j = i + 1; j < roots.length; j++) if (overlaps(roots[i]!, roots[j]!)) throw new Error("evidence storage, config, socket, and repository paths must be separate")
	}
	const configFiles = sessions.map((id) => path.join(configDirectory, `${id}.json`))
	if (configFiles.some((file) => fs.existsSync(file))) throw new Error("a per-session evidence runtime config already exists; choose new worker session IDs")
	const collector = await FileEvidenceCollector.start({ storageDir, socketPath })
	const authorized: string[] = []
	try {
		for (const sessionId of sessions) {
			const capability = await collector.authorizeSession(sessionId)
			authorized.push(sessionId)
			const config: EvidenceRuntimeConfigFile = {
				sessionId,
				socketPath,
				capability,
				pinnedPublicKey: collector.publicKey,
				evidenceRequired: true,
			}
			writePrivateConfig(path.join(configDirectory, `${sessionId}.json`), config)
		}
	} catch (error) {
		for (const sessionId of authorized) await collector.revokeSession(sessionId).catch(() => undefined)
		await collector.close().catch(() => undefined)
		for (const configPath of configFiles) fs.rmSync(configPath, { force: true })
		throw error
	}
	let closed = false
	return {
		collector,
		sessions: Object.freeze(sessions),
		configDirectory,
		async close() {
			if (closed) return
			closed = true
			let firstError: unknown
			for (const sessionId of sessions) {
				try { await collector.revokeSession(sessionId) } catch (error) { firstError ??= error }
			}
			try { await collector.close() } catch (error) { firstError ??= error }
			for (const configPath of configFiles) fs.rmSync(configPath, { force: true })
			if (firstError) throw firstError
		},
	}
}

interface EvidenceRuntimeConfigFile {
	sessionId: string
	socketPath: string
	capability: string
	pinnedPublicKey: { keyId: string; publicKeyPem: string }
	evidenceRequired: true
}

function writePrivateConfig(file: string, value: EvidenceRuntimeConfigFile): void {
	const temporary = `${file}.${process.pid}.tmp`
	const fd = fs.openSync(temporary, "wx", 0o400)
	try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
	fs.renameSync(temporary, file)
	fs.chmodSync(file, 0o400)
}

function preparePrivateDirectory(value: string): string {
	const absolute = path.resolve(value)
	assertNoSymlinkAncestors(path.dirname(absolute))
	fs.mkdirSync(absolute, { recursive: true, mode: 0o700 })
	fs.chmodSync(absolute, 0o700)
	assertNoSymlinkAncestors(absolute)
	const real = fs.realpathSync(absolute)
	const stat = fs.lstatSync(real)
	if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error("evidence storage and runtime config directories must be private real directories")
	return real
}

function assertNoSymlinkAncestors(value: string): void {
	let cursor = path.resolve(value)
	while (cursor !== path.dirname(cursor)) {
		try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`evidence runtime path traverses a symbolic link: ${cursor}`) }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
		cursor = path.dirname(cursor)
	}
}

function overlaps(a: string, b: string): boolean {
	const left = path.resolve(a)
	const right = path.resolve(b)
	return left === right || left.startsWith(`${right}${path.sep}`) || right.startsWith(`${left}${path.sep}`)
}
