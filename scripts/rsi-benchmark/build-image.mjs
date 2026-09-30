import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { materializeBenchmarkSnapshot } from "../../src/rsi/benchmark/runner.ts"
import { assertImageBuildInputsUnchanged } from "../../src/rsi/benchmark/build-inputs.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const requested = process.argv[2]
const commitContext = process.argv[3] === "--commit-context"
if (!requested || !/^[a-f0-9]{40}$/.test(requested) || (process.argv.length > 3 && !commitContext)) throw new Error("usage: build-image.mjs <full-harness-commit> [--commit-context]")

function git(args) {
	return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

const head = git(["rev-parse", "HEAD"])
if (!commitContext && head !== requested) throw new Error(`requested harness ${requested} is not the checkout HEAD ${head}`)
const dirty = git(["status", "--porcelain", "--untracked-files=all"])
if (dirty) throw new Error("refusing to build benchmark images from a dirty checkout")
execFileSync("git", ["cat-file", "-e", `${requested}^{commit}`], { cwd: root, stdio: "ignore" })
assertImageBuildInputsUnchanged(root, requested)

const context = await fs.mkdtemp(path.join(os.tmpdir(), "headlesscode-benchmark-image-"))
try {
	await fs.rmdir(context)
	await materializeBenchmarkSnapshot({ id: "benchmark-image", startCommit: requested }, root, context)
	// Docker recipes are supervisor-owned inputs. Never execute a Dockerfile
	// carried by the candidate commit while creating its matching runtime image.
	for (const relative of [".dockerignore", "docker/OpenShell.Dockerfile", "docker/OpenShell-RSI.Dockerfile"]) {
		const source = path.join(root, relative)
		const target = path.join(context, relative)
		await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
		await fs.copyFile(source, target)
	}
	const suffix = commitContext ? requested : "local"
	const baseImage = `headlesscode-openshell:${suffix}`
	const agentImage = `headlesscode-openshell-rsi:${suffix}`
	execFileSync("docker", ["build", "-f", "docker/OpenShell.Dockerfile", "--build-arg", `HEADLESSCODE_HARNESS_COMMIT=${requested}`, "-t", baseImage, "."], { cwd: context, stdio: "inherit" })
	execFileSync("docker", ["build", "-f", "docker/OpenShell-RSI.Dockerfile", "--build-arg", `HEADLESSCODE_BASE_IMAGE=${baseImage}`, "-t", agentImage, "."], { cwd: context, stdio: "inherit" })
	const inspect = (image) => {
		const marker = execFileSync("docker", ["run", "--rm", "--entrypoint", "/bin/cat", image, "/opt/headlesscode/.headlesscode-harness-commit"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (marker !== requested) throw new Error(`${image} contains harness marker ${marker}, expected ${requested}`)
		const digest = execFileSync("docker", ["image", "inspect", "--format={{.Id}}", image], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error(`Docker returned an invalid image digest for ${image}`)
		return { name: image, digest, harnessCommit: marker }
	}
	process.stdout.write(`${JSON.stringify({ harnessCommit: requested, baseImage: inspect(baseImage), agentImage: inspect(agentImage) }, null, 2)}\n`)
} finally {
	await fs.rm(context, { recursive: true, force: true })
}
