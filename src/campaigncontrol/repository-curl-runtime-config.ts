import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
	CONTAINED_RUNTIME_ROOT, CURL_RUNTIME_CONFIG_PATH, EVIDENCE_STORAGE_DIR,
	EVIDENCE_CONFIG_DIR, EVIDENCE_SOCKET_PATH, PROFILE_PATH, CONTROL_STATE_DIR,
	CONTROL_SOCKET_DIR, OPEN_SHELL_XDG_CONFIG_HOME, OPEN_SHELL_XDG_STATE_HOME,
} from "./repository-curl-profile.js"

export interface CurlRuntimeConfig {
	schemaVersion: 1
	profilePath: string
	profileSha256: string
	evidenceStorageDir: string
	evidenceConfigDir: string
	evidenceSocketPath: string
	controlStateDir: string
	controlSocketDir: string
	brokerBindHost: "127.0.0.1"
	openshellXdgConfigHome: string
	openshellXdgStateHome: string
}


export function readCurlRuntimeConfig(): CurlRuntimeConfig {
	const absolute = path.resolve(CURL_RUNTIME_CONFIG_PATH)
	assertOwnerOnlyDirectory(CONTAINED_RUNTIME_ROOT)
	assertNoSymlinkAncestors(path.dirname(absolute))
	const handle = openRuntimeConfigFile(absolute)
	try {
		return validateCurlRuntimeConfig(parseRuntimeConfig(handle))
	} finally { fs.closeSync(handle) }
}

function openRuntimeConfigFile(absolute: string): number {
	const before = fs.lstatSync(absolute)
	assertPrivateRuntimeConfigStat(before)
	const handle = fs.openSync(absolute,
		fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
	try {
		assertRuntimeConfigUnchanged(before, fs.fstatSync(handle))
		return handle
	} catch (error) {
		fs.closeSync(handle)
		throw error
	}
}

function assertPrivateRuntimeConfigStat(info: fs.Stats): void {
	if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 ||
		(info.mode & 0o077) !== 0 || info.size < 1 || info.size > 16 * 1024 ||
		(typeof process.getuid === "function" && info.uid !== process.getuid())) {
		throw new Error(
			"private Curl runtime configuration must be an owner-only regular file",
		)
	}
}

function assertRuntimeConfigUnchanged(before: fs.Stats, after: fs.Stats): void {
	if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() ||
		after.nlink !== 1 || (after.mode & 0o077) !== 0 || after.size > 16 * 1024) {
		throw new
			Error("private Curl runtime configuration changed while being opened")
	}
}

function parseRuntimeConfig(handle: number): unknown {
	try {
		return JSON.parse(fs.readFileSync(handle, "utf8"))
	} catch {
		throw new Error("private Curl runtime configuration is invalid JSON")
	}
}

export function validateCurlRuntimeConfig(value: unknown): CurlRuntimeConfig {
	const config = runtimeConfigObject(value)
	const expected = expectedRuntimeConfig()
	assertConfiguredPaths(config, expected)
	assertRuntimeProfileDigest(config.profileSha256)
	expected.profileSha256 = config.profileSha256 as string
	assertOwnerOnlyDirectory(config.openshellXdgConfigHome as string)
	assertOwnerOnlyDirectory(config.openshellXdgStateHome as string)
	return expected
}

function runtimeConfigObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("private Curl runtime configuration must be an object")
	}
	const config = value as Record<string, unknown>
	const keys = ["schemaVersion", "profilePath", "profileSha256",
		"evidenceStorageDir", "evidenceConfigDir", "evidenceSocketPath",
		"controlStateDir", "controlSocketDir", "brokerBindHost",
			"openshellXdgConfigHome", "openshellXdgStateHome"]
	if (!hasExactKeys(config, keys)) {
		throw new Error(
			"private Curl runtime configuration contains unknown or missing fields",
		)
	}
	return config
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actual = Object.keys(value)
	return actual.length === keys.length &&
		actual.every((key) => keys.includes(key))
}

function expectedRuntimeConfig(): CurlRuntimeConfig {
	return {
		schemaVersion: 1, profilePath: PROFILE_PATH, profileSha256: "",
		evidenceStorageDir: EVIDENCE_STORAGE_DIR,
			evidenceConfigDir: EVIDENCE_CONFIG_DIR,
				evidenceSocketPath: EVIDENCE_SOCKET_PATH,
		controlStateDir: CONTROL_STATE_DIR, controlSocketDir: CONTROL_SOCKET_DIR,
			brokerBindHost: "127.0.0.1",
		openshellXdgConfigHome: OPEN_SHELL_XDG_CONFIG_HOME,
			openshellXdgStateHome: OPEN_SHELL_XDG_STATE_HOME,
	}

}

function assertConfiguredPaths(config: Record<string, unknown>,
	expected: CurlRuntimeConfig): void {
	const keys = Object.keys(expected) as (keyof CurlRuntimeConfig)[]
	for (const key of keys) {
		if (key === "profileSha256") continue
		if (config[key] !== expected[key]) {
			throw new Error(
				`private Curl runtime configuration ${key} differs from ` +
					"the code-owned profile",
			)
		}
	}
}

function assertRuntimeProfileDigest(value: unknown): asserts value is string {
	if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
		throw new Error("private Curl runtime profile digest is invalid")
	}
}

export function buildContainedHostEnvironment(config: CurlRuntimeConfig):
	NodeJS.ProcessEnv {
	return {
		XDG_CONFIG_HOME: config.openshellXdgConfigHome,
			XDG_STATE_HOME: config.openshellXdgStateHome,
		HEADLESSCODE_CONTAINED_PROFILE: config.profilePath,
			HEADLESSCODE_CONTAINED_PROFILE_SHA256: config.profileSha256,
		HEADLESSCODE_CONTAINED_EVIDENCE_CONFIG_DIR: config.evidenceConfigDir,
		HEADLESSCODE_CONTROL_STATE_DIR: config.controlStateDir,
			HEADLESSCODE_CONTROL_SOCKET_DIR: config.controlSocketDir,
		HEADLESSCODE_OPENSHELL_SCRATCH_ROOT: path.join(os.homedir(), ".local",
			"share", "headlesscode", "openshell-sessions"),
		HEADLESSCODE_RSI_BROKER_BIND_HOST: config.brokerBindHost,
	}
}

export function probeOpenShell(
	args: string[],
	timeoutMs: number,
	env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string; error?: Error } {
	const result = spawnSync("openshell", args, { env: { HOME: os.homedir(),
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin", ...env },
		encoding: "utf8", timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 })
	return { status: result.status, stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
			...(result.error ? { error: result.error } : {}) }
}

function assertOwnerOnlyDirectory(value: string): void {
	assertNoSymlinkAncestors(value)
	const resolved = path.resolve(value)
	const stat = fs.lstatSync(resolved)
	if (!stat.isDirectory() || stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
			fs.realpathSync(resolved) !== resolved) {
		throw new
			Error("private OpenShell XDG directory must be an owner-only real directory")
	}
}

function assertNoSymlinkAncestors(value: string): void {
	let cursor = path.resolve(value)
	while (cursor !== path.dirname(cursor)) {
		try { if (fs.lstatSync(cursor).isSymbolicLink()) throw new
			Error("private Curl runtime path contains a symbolic link") }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw error }
		cursor = path.dirname(cursor)
	}
}


function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex")
}
