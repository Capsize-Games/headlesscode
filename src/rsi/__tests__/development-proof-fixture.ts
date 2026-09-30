import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { freezeDevelopmentProofProtocol } from "../development-proof.js"
import type { DevelopmentProofProtocol } from "../development-proof.js"
import type { BenchmarkAttempt, BenchmarkManifest } from "../benchmark/types.js"

export async function fixtureDevelopmentProofProtocol(model = "fixture-model"): Promise<DevelopmentProofProtocol> {
	const fixtureRoot = path.resolve("fixtures/rsi-benchmark")
	const raw = await fs.readFile(path.join(fixtureRoot, "manifest.json"), "utf8")
	const manifest = JSON.parse(raw) as BenchmarkManifest
	return freezeDevelopmentProofProtocol(manifest, createHash("sha256").update(raw).digest("hex"), {
		provider: "openshell-ollama", id: model,
		sampling: { temperature: 0, think: false, seed: "provider-default" },
	})
}

export function fakeDevelopmentBenchmarkHook(
	calls: Array<{ harnessCommit: string; outputRoot: string }> = [],
	options: { proofQualified?: boolean; succeeds?: (harnessCommit: string, taskId: string) => boolean } = {},
) {
	return async ({ harnessCommit, model, outputRoot, protocol }: { harnessCommit: string; model: string; outputRoot: string; protocol: DevelopmentProofProtocol }): Promise<BenchmarkAttempt[]> => {
		calls.push({ harnessCommit, outputRoot })
		return protocol.taskIdentities.map((task) => ({
			schemaVersion: 1,
			manifestDigest: protocol.manifestDigest,
			taskId: task.id,
			split: "development",
			attemptId: `${harnessCommit.slice(0, 8)}-${task.id}`,
			harnessCommit,
			agentImage: { name: `headlesscode-openshell-rsi:${harnessCommit}`, digest: `sha256:${harnessCommit.slice(0, 1).repeat(64)}`, harnessCommit },
			model: { provider: protocol.model.provider, id: model, sampling: protocol.model.sampling },
			seed: task.seed,
			family: task.family,
			startDigest: task.startDigest,
			ceilings: task.ceilings,
			verifiedSuccess: options.succeeds?.(harnessCommit, task.id) ?? false,
			proofQualified: options.proofQualified ?? false,
			resourceAccounting: options.proofQualified ? "supervisor-enforced" : "guest-reported",
			validity: "valid",
			calls: 1,
			tokens: 1,
			wallTimeMs: 1,
			stopReason: "fixture",
			patchDigest: "a".repeat(64),
			evaluatorDigest: task.verifierDigest,
			artifactRefs: { patch: "a".repeat(64), stdout: "b".repeat(64), stderr: "c".repeat(64) },
		}))
	}
}
