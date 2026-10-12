import * as fs from "node:fs/promises"
import * as path from "node:path"
import { loadBenchmark } from "./runner.js"
import type { LoadedBenchmark } from "./runner.js"
import type { ProofBenchmarkFixtureBinding } from "../types.js"

export type { ProofBenchmarkFixtureBinding } from "../types.js"

export interface LoadedProofBenchmarkFixtures {
	binding: ProofBenchmarkFixtureBinding
	loaded: LoadedBenchmark
}

export async function loadProofBenchmarkFixtures(root: string, repoRoot: string): Promise<LoadedProofBenchmarkFixtures> {
	const requestedRoot = path.resolve(root)
	const stat = await fs.lstat(requestedRoot)
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("proof benchmark fixture root must be a regular directory")
	const canonicalRoot = await fs.realpath(requestedRoot)
	const loaded = await loadBenchmark(canonicalRoot, repoRoot)
	const snapshotPackage = loaded.manifest.snapshotPackage
	return {
		binding: {
			root: canonicalRoot,
			manifestSha256: loaded.manifestDigest,
			...(snapshotPackage ? { snapshotPackage: { path: snapshotPackage.path, digest: snapshotPackage.digest } } : {}),
		},
		loaded,
	}
}

export async function loadBoundProofBenchmarkFixtures(binding: ProofBenchmarkFixtureBinding, repoRoot: string): Promise<LoadedBenchmark> {
	if (!binding || !path.isAbsolute(binding.root) || path.resolve(binding.root) !== binding.root || !/^[a-f0-9]{64}$/.test(binding.manifestSha256)) throw new Error("frozen proof benchmark fixture binding is malformed")
	const keys = Object.keys(binding).sort()
	const expectedKeys = binding.snapshotPackage ? ["manifestSha256", "root", "snapshotPackage"] : ["manifestSha256", "root"]
	if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) throw new Error("frozen proof benchmark fixture binding has unexpected fields")
	if (binding.snapshotPackage && (Object.keys(binding.snapshotPackage).sort().join(",") !== "digest,path" || !binding.snapshotPackage.path || !/^[a-f0-9]{64}$/.test(binding.snapshotPackage.digest))) throw new Error("frozen proof benchmark package binding is malformed")
	const current = await loadProofBenchmarkFixtures(binding.root, repoRoot)
	if (current.binding.root !== binding.root) throw new Error("proof benchmark fixture root differs from its frozen binding")
	if (current.binding.manifestSha256 !== binding.manifestSha256) throw new Error("proof benchmark manifest differs from its frozen binding")
	if (current.binding.snapshotPackage?.path !== binding.snapshotPackage?.path || current.binding.snapshotPackage?.digest !== binding.snapshotPackage?.digest) throw new Error("proof benchmark snapshot package differs from its frozen binding")
	return current.loaded
}
