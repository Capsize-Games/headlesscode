// Fixture for the cross-process-lock regression test (issue #43): a small,
// standalone worker that patches many NEW group entries into a shared state
// file via the real patchGroup(). Two instances of this script are spawned
// as SEPARATE OS processes against the SAME state file, racing each other —
// without a real cross-process lock, one process's group-creation write can
// be silently discarded by the other's stale-read-based save (the exact
// class of bug patchGroup's in-process lock already prevents WITHIN one
// process; this proves it also holds ACROSS processes).
//
// argv: <statePath> <namePrefix> <count>
import { patchGroup } from "../../state.js"

const [statePath, namePrefix, countStr] = process.argv.slice(2)
const count = Number(countStr)

for (let i = 0; i < count; i++) {
	await patchGroup(statePath, `${namePrefix}-${i}`, {
		status: "done",
		last_activity: { note: `written by ${namePrefix}` },
	})
}
