import * as fs from "node:fs/promises"
import * as path from "node:path"

/** Provide a private policy file while test hooks substitute the real evaluator runtime. */
export async function withSyntheticEvaluatorPolicy<T>(run: () => Promise<T>): Promise<T> {
	const scratch = path.resolve(".headlesscode/scratch")
	await fs.mkdir(scratch, { recursive: true, mode: 0o700 })
	const directory = await fs.mkdtemp(path.join(scratch, "synthetic-evaluator-policy-"))
	const policyPath = path.join(directory, "policy.yaml")
	await fs.writeFile(policyPath, "sandbox:\n  network: disabled\n", { mode: 0o600 })
	await fs.chmod(policyPath, 0o600)
	const previous = process.env.HEADLESSCODE_OPENSHELL_POLICY
	process.env.HEADLESSCODE_OPENSHELL_POLICY = policyPath
	try {
		return await run()
	} finally {
		if (previous === undefined) delete process.env.HEADLESSCODE_OPENSHELL_POLICY
		else process.env.HEADLESSCODE_OPENSHELL_POLICY = previous
		await fs.rm(directory, { recursive: true, force: true })
	}
}
