import assert from "node:assert/strict"
import { selectUniqueNamedEntries } from "../verifier-selection.mjs"

const selected = ["wanted", () => {}] as const
assert.deepEqual(selectUniqueNamedEntries([["other", () => {}], selected], "wanted"), [selected])
assert.throws(() => selectUniqueNamedEntries([["other", () => {}]], "wanted"), /found 0/)
assert.throws(() => selectUniqueNamedEntries([selected, selected], "wanted"), /found 2/)
console.log("RSI benchmark verifier selection assertions passed")
