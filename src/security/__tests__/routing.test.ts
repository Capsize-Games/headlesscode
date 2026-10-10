import assert from "node:assert/strict"
import { main, parseArgs as parseCliArgs } from "../../cli.js"
import { parseOrchestrateArgs } from "../../orchestrator/cli.js"
import { parseWatchArgs } from "../../watcher/cli.js"

const prior = process.env.HEADLESSCODE_SECURITY_PROFILE
delete process.env.HEADLESSCODE_SECURITY_PROFILE
try {
	assert.equal(parseCliArgs(["--task", "test", "--dry-run"]).options.securityProfile, "local")
	assert.equal(parseCliArgs(["--security-profile", "contained", "--task", "test", "--dry-run"]).options.securityProfile, "contained")
	assert.match(parseCliArgs(["--security-profile", "unknown"]).error ?? "", /must be local or contained/)

	const orchestrator = parseOrchestrateArgs(["--security-profile", "contained", "--issue", "35"])
	assert.equal(orchestrator.error, undefined)
	assert.equal(orchestrator.options.executionProvider, "openshell")
	assert.equal(parseOrchestrateArgs(["--security-profile", "contained", "--execution-provider", "local"]).error, "contained security profile cannot use the local execution provider")
	assert.equal(parseOrchestrateArgs(["--security-profile", "local", "--execution-provider", "local"]).options.executionProvider, "local")

	const watcher = parseWatchArgs(["--security-profile", "contained", "--owner", "capsize"])
	assert.equal(watcher.error, undefined)
	assert.equal(watcher.options.executionProvider, "openshell")
	assert.equal(parseWatchArgs(["--security-profile", "contained", "--execution-provider", "local"]).error, "contained security profile cannot use the local execution provider")
	assert.equal(parseWatchArgs(["--security-profile", "local", "--execution-provider", "local"]).options.executionProvider, "local")
} finally {
	if (prior === undefined) delete process.env.HEADLESSCODE_SECURITY_PROFILE
	else process.env.HEADLESSCODE_SECURITY_PROFILE = prior
}

const originalConsoleError = console.error
console.error = () => undefined
try {
	assert.equal(await main(["evidence", "verify", "missing-bundle.json", "missing-key.json", "missing-head.json"]), 1, "the public evidence subcommand routes to verification and reports missing files")
} finally {
	console.error = originalConsoleError
}

console.log("Security profile CLI routing tests passed")
