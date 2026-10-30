import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { runMain, type SuiteTest } from "../../test-runner.js"

async function testDeliveryFlockPersistsOnParentDescriptorUntilClosed(): Promise<void> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "hcl-curl-flock-"))
	const lockPath = path.join(root, "dedup.lock")
	const parent = await fs.open(lockPath, "w+")
	const acquire = (fd: number) => execFileSync("/usr/bin/flock", ["-n", "-x",
		"3"], {
		stdio: ["ignore", "ignore", "ignore", fd],
	})
	const contend = () => execFileSync("/usr/bin/flock", ["-n", "-x", lockPath,
		"/usr/bin/true"])
	try {
		acquire(parent.fd)
		assert.throws(() => contend(), /flock|status 1|exit code 1/i)
		await parent.close()
		contend()
	} finally {
		await parent.close().catch(() => undefined)
		await fs.rm(root, { recursive: true, force: true })
	}
}

const tests: readonly SuiteTest[] = [
	["delivery flock remains held by the parent descriptor until the transaction closes it", testDeliveryFlockPersistsOnParentDescriptorUntilClosed],
]

await runMain("repository-curl-delivery-lock", tests)
