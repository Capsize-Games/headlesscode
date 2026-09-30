import { execFileSync } from "node:child_process"

export const PROTECTED_IMAGE_BUILD_INPUTS = ["package.json", "package-lock.json", "tsconfig.json", ".dockerignore", "docker/", "scripts/"] as const

export function changedImageBuildInputs(repoRoot: string, reference: string, base = "HEAD"): string[] {
	const output = execFileSync("git", ["diff", "--name-only", "-z", "--no-renames", base, reference, "--", ...PROTECTED_IMAGE_BUILD_INPUTS], {
		cwd: repoRoot,
		encoding: "buffer",
		stdio: ["ignore", "pipe", "pipe"],
	}) as Buffer
	return output.toString("utf8").split("\0").filter(Boolean)
}

export function assertImageBuildInputsUnchanged(repoRoot: string, reference: string, base = "HEAD"): void {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", base, reference], { cwd: repoRoot, stdio: "ignore" })
	} catch {
		throw new Error(`benchmark commit ${reference} is not descended from supervisor base ${base}`)
	}
	const changed = changedImageBuildInputs(repoRoot, reference, base)
	if (changed.length > 0) throw new Error(`benchmark commit changes protected image build inputs: ${changed.join(", ")}`)
}
