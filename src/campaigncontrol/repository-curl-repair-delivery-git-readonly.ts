import * as os from "node:os"
import * as path from "node:path"
import type {
	CurlRepairGitAdapter,
} from "./repository-curl-repair-delivery-model.js"
import {
	FixedCurlGitAdapter,
} from "./repository-curl-repair-delivery-git.js"
import {
	ensurePrivateDirectory,
} from "./repository-curl-repair-delivery-store.js"

export type FixedCurlReadOnlyGit = Pick<
	CurlRepairGitAdapter,
	"inspectTarget" | "candidateIsAncestor"
>

/** Return fixed, read-only evidence for the compiled private Curl pins. */
export function createFixedCurlReadOnlyGitAdapter(): FixedCurlReadOnlyGit {
	const stateRoot = path.join(
		os.homedir(),
		".local",
		"share",
		"headlesscode",
		"curl-repair-readonly",
	)
	const adapter = new FixedCurlGitAdapter(stateRoot)
	return Object.freeze({
		inspectTarget: () => inspectFixedTarget(adapter, stateRoot),
		candidateIsAncestor: (candidate: string, target: string) =>
			checkFixedAncestry(adapter, stateRoot, candidate, target),
	})
}

async function inspectFixedTarget(
	adapter: FixedCurlGitAdapter,
	stateRoot: string,
): ReturnType<FixedCurlGitAdapter["inspectTarget"]> {
	await ensurePrivateDirectory(stateRoot)
	return adapter.inspectTarget()
}

async function checkFixedAncestry(
	adapter: FixedCurlGitAdapter,
	stateRoot: string,
	candidate: string,
	target: string,
): Promise<boolean> {
	await ensurePrivateDirectory(stateRoot)
	return adapter.candidateIsAncestor(candidate, target)
}
