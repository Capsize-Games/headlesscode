import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { Agent, fetch as undiciFetch } from "undici"

function installedVersion(): string {
	const require = createRequire(import.meta.url)
	return require("undici/package.json").version as string
}

function assertSecurityFloor(version: string): void {
	const [major, minor, patch] = version.split(".").map(Number)
	assert.equal(major, 8, `Expected Undici 8.x, got ${version}`)
	assert.ok(
		minor > 12 || (minor === 12 && patch >= 2),
		`Undici ${version} is below the security floor`,
	)
}

async function verifyLocalAgentFetch(): Promise<void> {
	const server = createServer((_request, response) => response.end("ok"))
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	assert.ok(address && typeof address !== "string")
	const dispatcher = new Agent()
	try {
		const url = `http://127.0.0.1:${address.port}/health`
		const response = await undiciFetch(url, { dispatcher })
		assert.equal(response.status, 200)
		assert.equal(await response.text(), "ok")
	} finally {
		await dispatcher.close()
		await new Promise<void>((resolve, reject) => {
			server.close((error) => error ? reject(error) : resolve())
		})
	}
}

async function main(): Promise<void> {
	const version = installedVersion()
	assertSecurityFloor(version)
	await verifyLocalAgentFetch()
	console.log(`Undici ${version} security floor and Agent/fetch smoke passed`)
}

main().catch((error) => {
	console.error(error)
	process.exit(1)
})
