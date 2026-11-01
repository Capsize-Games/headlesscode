import { randomUUID } from "node:crypto"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import * as path from "node:path"
import { CURL_REPAIR_TARGET_REPOSITORY } from "./repository-curl-repair.js"
import {
	DEFAULT_BRANCH,
	GIT_URL,
	HISTORICAL_BASE_TREE,
	TARGET_PATH,
	VERIFIED_TARGET_TIP,
	VERIFIED_TARGET_TREE,
} from "./repository-curl-repair-delivery-model.js"
import {
	isPrivateOwnerDirectory,
	gitValue,
	run,
} from "./repository-curl-repair-delivery-runtime.js"
import { isSha } from "./repository-curl-repair-delivery-store.js"

export class FixedCurlGitCheckout {
	readonly path: string
	constructor(private readonly stateRoot: string) {
		this.path = path.join(stateRoot, "private-checkout")
	}
	async ensure(): Promise<void> {
		try {
			await this.validateExisting()
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
		}
		await this.verifyReference()
		await this.clone()
	}
	private async validateExisting(): Promise<void> {
		const info = await fsp.lstat(this.path)
		if (!isPrivateCheckoutDirectory(info))
			throw new Error(
				"private Curl checkout is not an owner-only directory",
			)
		const gitInfo = await fsp.lstat(path.join(this.path, ".git"))
		if (!isOwnerGitDirectory(gitInfo))
			throw new Error("private Curl checkout Git metadata is invalid")
		const origin = await gitValue(
			"git-read-origin",
			this.path,
			"remote",
			"get-url",
			"origin",
		)
		if (origin !== GIT_URL)
			throw new Error("private Curl checkout origin is invalid")
	}
	private async clone(): Promise<void> {
		await fsp.mkdir(this.stateRoot, { recursive: true, mode: 0o700 })
		const temporary = temporaryCheckoutPath(this.stateRoot)
		try {
			await cloneCheckout(temporary)
			await validateClone(temporary)
			await activateClone(temporary, this.path)
		} catch (error) {
			await fsp.rm(temporary, { recursive: true, force: true })
			throw error
		}
	}
	private async verifyReference(): Promise<void> {
		const uid = typeof process.getuid === "function" ? process.getuid() : -1
		if (uid < 0 || !isPrivateOwnerDirectory(TARGET_PATH, uid))
			throw new Error(
				"private Curl checkout reference is not owner-private",
			)
		const pin = await readReferencePin()
		if (
			pin.origin !== GIT_URL ||
			pin.tip !== VERIFIED_TARGET_TIP ||
			pin.tree !== VERIFIED_TARGET_TREE ||
			pin.hasAlternates
		)
			throw new Error(
				"private Curl checkout reference does not match its verified pin",
			)
	}
}

async function validateClone(temporary: string): Promise<void> {
	const clonedOrigin = await readCloneOrigin(temporary)
	const clonedBranch = await readCloneBranch(temporary)
	const alternatesPath = await readCloneAlternates(temporary)
	if (
		clonedOrigin !== GIT_URL ||
		!isSha(clonedBranch) ||
		hasAlternates(temporary, alternatesPath)
	)
		throw new Error("private Curl checkout reference validation failed")
}

function temporaryCheckoutPath(stateRoot: string): string {
	return path.join(
		stateRoot,
		`.private-checkout-${process.pid}-${randomUUID()}`,
	)
}

async function cloneCheckout(temporary: string): Promise<void> {
	await run("git-clone-target", [
		"clone",
		"--reference-if-able",
		TARGET_PATH,
		"--dissociate",
		"--no-checkout",
		"--no-tags",
		"--single-branch",
		"--branch",
		DEFAULT_BRANCH,
		GIT_URL,
		temporary,
	])
}

async function activateClone(
	temporary: string,
	checkout: string,
): Promise<void> {
	await fsp.chmod(temporary, 0o700)
	await fsp.rename(temporary, checkout)
}

async function readCloneOrigin(temporary: string): Promise<string> {
	return gitValue(
		"git-verify-clone-origin",
		temporary,
		"remote",
		"get-url",
		"origin",
	)
}

async function readCloneBranch(temporary: string): Promise<string> {
	return gitValue(
		"git-verify-clone-branch",
		temporary,
		"rev-parse",
		"--verify",
		`refs/remotes/origin/${DEFAULT_BRANCH}^{commit}`,
	)
}

async function readCloneAlternates(temporary: string): Promise<string> {
	return gitValue(
		"git-read-reference-alternates",
		temporary,
		"rev-parse",
		"--git-path",
		"objects/info/alternates",
	)
}

async function readReferencePin(): Promise<{
	origin: string
	tip: string
	tree: string
	hasAlternates: boolean
}> {
	const origin = await readReferenceOrigin()
	const tip = await readReferenceTip()
	const tree = await readReferenceTree(tip)
	const alternatesPath = await readReferenceAlternates()
	return {
		origin,
		tip,
		tree,
		hasAlternates: hasAlternates(TARGET_PATH, alternatesPath),
	}
}

async function readReferenceOrigin(): Promise<string> {
	return gitValue(
		"git-verify-reference-origin",
		TARGET_PATH,
		"remote",
		"get-url",
		"origin",
	)
}

async function readReferenceTip(): Promise<string> {
	return gitValue(
		"git-verify-reference-tip",
		TARGET_PATH,
		"rev-parse",
		"--verify",
		`refs/remotes/origin/${DEFAULT_BRANCH}^{commit}`,
	)
}

async function readReferenceTree(tip: string): Promise<string> {
	return gitValue(
		"git-verify-reference-tree",
		TARGET_PATH,
		"rev-parse",
		"--verify",
		`${tip}^{tree}`,
	)
}

async function readReferenceAlternates(): Promise<string> {
	return gitValue(
		"git-read-reference-alternates",
		TARGET_PATH,
		"rev-parse",
		"--git-path",
		"objects/info/alternates",
	)
}

function hasAlternates(root: string, alternatesPath: string): boolean {
	return fs.existsSync(
		path.isAbsolute(alternatesPath)
			? alternatesPath
			: path.resolve(root, alternatesPath),
	)
}

function isPrivateCheckoutDirectory(info: fs.Stats): boolean {
	return (
		info.isDirectory() &&
		!info.isSymbolicLink() &&
		(info.mode & 0o077) === 0 &&
		(typeof process.getuid !== "function" || info.uid === process.getuid())
	)
}

function isOwnerGitDirectory(info: fs.Stats): boolean {
	return (
		info.isDirectory() &&
		!info.isSymbolicLink() &&
		(typeof process.getuid !== "function" || info.uid === process.getuid())
	)
}
