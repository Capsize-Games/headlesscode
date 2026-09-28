import assert from "node:assert/strict"

import { feasibilityGate, stallLabels, type PreflightTurn } from "../../../scripts/monitor-pilot/preflight.js"

const op = (name: string, isError = false) => ({ name, args: { path: "virtual.json" }, isError, result: isError ? "[Error]" : "ok" })
const turns: PreflightTurn[] = [
	{ iteration: 1, operations: [op("read_file")], milestone: 1 },
	{ iteration: 2, operations: [op("read_file")], milestone: 1 },
	{ iteration: 3, operations: [op("read_file")], milestone: 1 },
	{ iteration: 4, operations: [op("read_file")], milestone: 1 },
]

assert.deepEqual(stallLabels([2, 3, 4], turns), [1, null, null], "only complete three-turn windows are labeled")
assert.deepEqual(stallLabels([2], [...turns.slice(0, 3), { ...turns[3], milestone: 2 }]), [0], "independent progress clears the label")
assert.deepEqual(stallLabels([2], [...turns.slice(0, 3), { ...turns[3], operations: [] }]), [null], "terminal tool-free turn is masked")
assert.equal(feasibilityGate(3, 3), true)
assert.equal(feasibilityGate(10, 3), false)
assert.equal(feasibilityGate(3, 2), false)
console.log("preflight label and gate tests passed")
