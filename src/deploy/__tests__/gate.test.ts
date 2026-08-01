/**
 * Unit tests for src/deploy/gate.ts — the pure approval decision logic.
 * No git, no network, no deploy script is ever touched: `decideApproval` is a
 * pure function over resolved inputs. Run via `npm test`.
 */

import assert from "node:assert/strict"

import { decideApproval, type ApprovalInputs } from "../gate.js"

function inputs(over: Partial<ApprovalInputs>): ApprovalInputs {
	return { interactive: false, approvalFileExists: false, ...over }
}

// ─── Interactive mode ────────────────────────────────────────────────────────

async function testInteractiveExplicitYesApproves(): Promise<void> {
	for (const yes of ["y", "Y", "yes", "YES", " y ", "Yes"]) {
		const result = decideApproval(inputs({ interactive: true, interactiveInput: yes }))
		assert.equal(result.approved, true, `'${yes}' should approve`)
	}
}

async function testInteractiveAnythingElseDenies(): Promise<void> {
	for (const no of ["", "n", "N", "no", "maybe", "  ", "0"]) {
		const result = decideApproval(inputs({ interactive: true, interactiveInput: no }))
		assert.equal(result.approved, false, `'${JSON.stringify(no)}' should deny`)
	}
}

async function testInteractiveMissingInputDenies(): Promise<void> {
	const result = decideApproval(inputs({ interactive: true, interactiveInput: undefined }))
	assert.equal(result.approved, false)
	assert.match(result.reason, /DENIED/)
}

// ─── Non-interactive token mode ──────────────────────────────────────────────

async function testTokenMatchApproves(): Promise<void> {
	const result = decideApproval(
		inputs({ approvalToken: "deploy-token-123", tokenFileContent: "deploy-token-123" }),
	)
	assert.equal(result.approved, true)
	assert.match(result.reason, /matched the token file/)
}

async function testTokenMismatchDenies(): Promise<void> {
	const result = decideApproval(
		inputs({ approvalToken: "wrong-token", tokenFileContent: "deploy-token-123" }),
	)
	assert.equal(result.approved, false)
	assert.match(result.reason, /does not match/)
}

async function testTokenWithEmptyFileContentDenies(): Promise<void> {
	const result = decideApproval(inputs({ approvalToken: "x", tokenFileContent: "   " }))
	assert.equal(result.approved, false, "whitespace-only token file content must not match")
}

async function testTokenSetButNoTokenFileDenies(): Promise<void> {
	const result = decideApproval(inputs({ approvalToken: "x", tokenFileContent: undefined }))
	assert.equal(result.approved, false)
	assert.match(result.reason, /no token file/)
}

async function testTokenFileButNoEnvTokenDenies(): Promise<void> {
	const result = decideApproval(inputs({ approvalToken: undefined, tokenFileContent: "x" }))
	assert.equal(result.approved, false)
	assert.match(result.reason, /DEPLOY_APPROVAL_TOKEN is not set/)
}

// ─── Non-interactive one-time approval file ──────────────────────────────────

async function testApprovalFilePresenceApproves(): Promise<void> {
	const result = decideApproval(inputs({ approvalFileExists: true }))
	assert.equal(result.approved, true)
	assert.match(result.reason, /one-time approval file/)
}

// ─── Never auto-approve ──────────────────────────────────────────────────────

async function testNonInteractiveWithoutAnyApprovalDenies(): Promise<void> {
	const result = decideApproval(inputs({}))
	assert.equal(result.approved, false)
	assert.match(result.reason, /never auto-approve/)
}

async function testNonInteractiveEverythingEmptyDenies(): Promise<void> {
	const result = decideApproval(
		inputs({ approvalToken: undefined, tokenFileContent: undefined, approvalFileExists: false }),
	)
	assert.equal(result.approved, false)
}

// ─── Runner ──────────────────────────────────────────────────────────────────

const tests: Array<[string, () => Promise<void>]> = [
	["interactive explicit yes approves", testInteractiveExplicitYesApproves],
	["interactive anything-but-yes denies", testInteractiveAnythingElseDenies],
	["interactive missing input denies", testInteractiveMissingInputDenies],
	["token match approves", testTokenMatchApproves],
	["token mismatch denies", testTokenMismatchDenies],
	["empty token file content denies", testTokenWithEmptyFileContentDenies],
	["token set but no token file denies", testTokenSetButNoTokenFileDenies],
	["token file but no env token denies", testTokenFileButNoEnvTokenDenies],
	["one-time approval file presence approves", testApprovalFilePresenceApproves],
	["non-interactive without any approval denies (never auto-approve)", testNonInteractiveWithoutAnyApprovalDenies],
	["all inputs empty denies", testNonInteractiveEverythingEmptyDenies],
]

async function main(): Promise<void> {
	let failed = 0
	for (const [name, fn] of tests) {
		try {
			await fn()
			console.log(`  ok   ${name}`)
		} catch (err) {
			failed++
			console.error(`  FAIL ${name}`)
			console.error(err instanceof Error ? err.stack ?? err.message : String(err))
		}
	}
	if (failed > 0) {
		console.error(`\n${failed} test(s) failed`)
		process.exit(1)
	}
	console.log(`\nAll ${tests.length} deploy-gate decision tests passed`)
}

main().catch((err) => {
	console.error("Test runner crashed:", err)
	process.exit(1)
})
