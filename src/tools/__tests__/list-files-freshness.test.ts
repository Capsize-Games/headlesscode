/**
 * Covers issue #81 with the real list_files handler and mutation/collision cases.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import { createHeadlessExecutor } from "../executor.js"

function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

async function testListingRefreshesAfterMutations(): Promise<void> {
  for (const recursive of [false, true]) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hc-list-freshness-"))
    const executor = createHeadlessExecutor(workspace)
    const parent = recursive ? path.join(workspace, "nested") : workspace
    const prefix = recursive ? "nested/" : ""
    try {
      if (recursive) await fs.mkdir(parent)
      await fs.writeFile(path.join(parent, "before.txt"), "before\n", "utf8")
      const args = { path: ".", recursive }

      const first = await executor.execute("list_files", args)
      assert.equal(first.isError, false)
      assert.ok(first.content.includes(`${prefix}before.txt`), `recursive=${recursive}: initial listing contains seed`)

      const unchangedRepeat = await executor.execute("list_files", args)
      assert.equal(unchangedRepeat.isError, false)
      assert.match(unchangedRepeat.content, /^\[cache\]/, `recursive=${recursive}: unchanged repeat gets one notice`)
      const unchangedRelist = await executor.execute("list_files", args)
      assert.ok(unchangedRelist.content.includes(`${prefix}before.txt`), `recursive=${recursive}: next repeat really lists again`)

      // The supported write tool creates a new visible entry after a listing.
      const afterWrite = `${prefix}after-write.txt`
      const write = await executor.execute("write_to_file", { path: afterWrite, content: "written by tool\n" })
      assert.equal(write.isError, false, `write_to_file succeeds: ${write.content}`)
      const afterWriteListing = await executor.execute("list_files", args)
      assert.equal(afterWriteListing.isError, false)
      assert.ok(afterWriteListing.content.includes(afterWrite), `recursive=${recursive}: listing sees write_to_file addition`)
      assert.doesNotMatch(afterWriteListing.content, /^\[cache\]/, "a changed directory snapshot must not be masked by the repeat notice")

      // execute_command's Node subprocess renames an entry without a tool-level
      // listing invalidation hook; freshness must come from the current tree.
      const renamed = `${prefix}renamed-by-node.txt`
      const renameCode = `require("node:fs").renameSync(${JSON.stringify(path.join(workspace, afterWrite))}, ${JSON.stringify(path.join(workspace, renamed))})`
      const command = "node -e " + shellQuote(renameCode)
      const rename = await executor.execute("execute_command", { command, timeout: 10 })
      assert.equal(rename.isError, false, `Node rename succeeds: ${rename.content}`)
      const afterRenameListing = await executor.execute("list_files", args)
      assert.equal(afterRenameListing.isError, false)
      assert.ok(afterRenameListing.content.includes(renamed), `recursive=${recursive}: listing sees Node rename target`)
      assert.ok(!afterRenameListing.content.includes(afterWrite), `recursive=${recursive}: listing drops Node rename source`)

      // An out-of-band filesystem removal tests the same stale-snapshot risk
      // without going through either executor write path.
      await fs.rm(path.join(workspace, renamed))
      const afterRemovalListing = await executor.execute("list_files", args)
      assert.equal(afterRemovalListing.isError, false)
      assert.doesNotMatch(afterRemovalListing.content, /^\[cache\]/, "external removal requires a fresh listing")
      assert.ok(afterRemovalListing.content.includes(`${prefix}before.txt`), "unchanged seed remains visible after removal")
      assert.ok(!afterRemovalListing.content.includes(renamed), `recursive=${recursive}: listing no longer shows externally removed entry`)

      const missingArgs = { path: "missing-directory", recursive }
      const missingFirst = await executor.execute("list_files", missingArgs)
      const missingRetry = await executor.execute("list_files", missingArgs)
      assert.equal(missingFirst.isError, true)
      assert.equal(missingRetry.isError, true, "failed paths stay retryable with the real error")
      assert.doesNotMatch(missingRetry.content, /^\[cache\]/, "repeat guard never hides a failed listing")
    } finally {
      executor.dispose()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }
}

async function testCollisionRenameIsNotReportedUnchanged(): Promise<void> {
  // These fixed names are a known FNV-1a collision in the current signature.
  // Keep the test deterministic instead of searching for collisions at runtime.
  const oldName = "entry-2fa74d342cde.txt"
  const newName = "entry-a4223892437d.txt"
  for (const recursive of [false, true]) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hc-list-collision-"))
    const executor = createHeadlessExecutor(workspace)
    const parent = recursive ? path.join(workspace, "nested") : workspace
    const prefix = recursive ? "nested/" : ""
    try {
      if (recursive) await fs.mkdir(parent)
      await fs.writeFile(path.join(parent, oldName), "collision seed\n", "utf8")
      const args = { path: ".", recursive }
      const initial = await executor.execute("list_files", args)
      assert.equal(initial.isError, false)
      assert.ok(initial.content.includes(`${prefix}${oldName}`), `recursive=${recursive}: initial listing sees source`)

      await fs.rename(path.join(parent, oldName), path.join(parent, newName))
      const refreshed = await executor.execute("list_files", args)
      assert.equal(refreshed.isError, false)
      assert.doesNotMatch(refreshed.content, /^\[cache\]/, `recursive=${recursive}: colliding signature cannot hide rename`)
      assert.ok(refreshed.content.includes(`${prefix}${newName}`), `recursive=${recursive}: listing sees renamed target`)
      assert.ok(!refreshed.content.includes(`${prefix}${oldName}`), `recursive=${recursive}: listing drops renamed source`)
    } finally {
      executor.dispose()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }
}

await testListingRefreshesAfterMutations()
await testCollisionRenameIsNotReportedUnchanged()
console.log("PASS list_files freshness after tool, subprocess, external, and colliding-name mutations")
