import assert from "node:assert/strict"
import { protectedPathReport, protectedPathViolations } from "../sandbox.js"

function testEvaluatorPathsAreProtected(): void {
	const files = ["src/rsi/fitness.ts", "scripts/eval-suite/check.sh", "src/engine/loop.ts"]
	const violations = protectedPathViolations(files, ["src/rsi/", "scripts/", "**/*.test.ts"])
	assert.deepEqual(violations, ["src/rsi/fitness.ts", "scripts/eval-suite/check.sh"])
	assert.equal(protectedPathReport(files, ["src/rsi/", "scripts/"]), "src/rsi/fitness.ts, scripts/eval-suite/check.sh")
}

function testNormalSourceChangeIsAllowed(): void {
	assert.deepEqual(protectedPathViolations(["src/engine/loop.ts"], ["src/rsi/", "scripts/"]), [])
}

testEvaluatorPathsAreProtected()
testNormalSourceChangeIsAllowed()
console.log("All 2 RSI sandbox tests passed")
