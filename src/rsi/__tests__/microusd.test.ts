import assert from "node:assert/strict"
import test from "node:test"
import { sumMicrousdAsUsd, usdEqualsMicrousd } from "../microusd.js"

test("PostgreSQL receipts aggregate rounded call costs as integer microUSD", () => {
	const callMicrousd = [2116, 90, 371, 932, 137, 865, 117, 192, 229, 210, 623, 133, 146, 186, 1497, 2939, 390, 122]
	const totalMicrousd = callMicrousd.reduce((sum, amount) => sum + amount, 0)
	assert.equal(totalMicrousd, 11_295)
	const costUsd = sumMicrousdAsUsd(callMicrousd)
	assert.equal(costUsd, totalMicrousd / 1_000_000)
	assert.equal(usdEqualsMicrousd(costUsd, totalMicrousd), true)
	assert.equal(usdEqualsMicrousd(costUsd, totalMicrousd + 1), false, "one microUSD of durable billing drift must be rejected")
})

test("microUSD receipt aggregation rejects invalid or unsafe amounts", () => {
	assert.throws(() => sumMicrousdAsUsd([1, -1]), /non-negative safe integer/)
	assert.throws(() => sumMicrousdAsUsd([Number.MAX_SAFE_INTEGER, 1]), /non-negative safe integer/)
	assert.equal(usdEqualsMicrousd(Number.NaN, 1), false)
})
