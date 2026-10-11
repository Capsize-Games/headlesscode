/**
 * Covers issue #80 through real executor factories, not mocked handlers.
 */
import assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"

import {
  createHeadlessExecutor,
  createReadOnlyHeadlessExecutor,
  createQaHeadlessExecutor,
} from "../executor.js"

const factories = [
  ["headless", createHeadlessExecutor],
  ["read-only", createReadOnlyHeadlessExecutor],
  ["QA", createQaHeadlessExecutor],
] as const

async function testIndentationAnchorsAndEffectiveArgs(): Promise<void> {
  for (const [label, createExecutor] of factories) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "hc-anchor-cache-"))
    const executor = createExecutor(workspace)
    try {
      const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`)
      await fs.writeFile(path.join(workspace, "data.txt"), lines.join("\n") + "\n", "utf8")

      const lineTwo = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { anchor_line: 2, max_lines: 1 },
      })
      assert.equal(lineTwo.isError, false, `${label}: first anchored read succeeds`)
      assert.match(lineTwo.content, /2 \| line-2/, `${label}: explicit anchor 2 is honored`)

      const lineFive = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { anchor_line: 5, max_lines: 1 },
      })
      assert.equal(lineFive.isError, false, `${label}: changing only anchor remains a successful real read`)
      assert.match(lineFive.content, /5 \| line-5/, `${label}: changed anchor returns its requested window, not a stale cache notice`)

      const repeatedLineFive = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { anchor_line: 5, max_lines: 1 },
      })
      assert.match(repeatedLineFive.content, /^\[cache\]/, `${label}: an identical effective window still gets the one-shot cache notice`)

      const widerWindow = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { anchor_line: 5, max_lines: 2 },
      })
      assert.equal(widerWindow.isError, false)
      assert.doesNotMatch(widerWindow.content, /^\[cache\]/, `${label}: changing max_lines changes the effective cache key`)
      assert.match(widerWindow.content, /5 \| line-5[\s\S]*6 \| line-6/, `${label}: explicit max_lines returns the wider window`)

      const repeatedWiderWindow = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { anchor_line: 5, max_lines: 2 },
      })
      assert.match(repeatedWiderWindow.content, /^\[cache\]/, `${label}: the same wider window remains cacheable`)

      const defaultAnchorFromOffset = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", offset: 8, indentation: { max_lines: 2 },
      })
      assert.equal(defaultAnchorFromOffset.isError, false)
      assert.match(defaultAnchorFromOffset.content, /8 \| line-8[\s\S]*9 \| line-9/, `${label}: omitted anchor uses the effective offset default`)

      const defaultAnchor = await executor.execute("read_file", {
        path: "data.txt", mode: "indentation", indentation: { max_lines: 1 },
      })
      assert.equal(defaultAnchor.isError, false)
      assert.match(defaultAnchor.content, /1 \| line-1/, `${label}: omitted anchor and offset default to line 1`)
    } finally {
      executor.dispose()
      await fs.rm(workspace, { recursive: true, force: true })
    }
  }
}

await testIndentationAnchorsAndEffectiveArgs()
console.log("PASS read_file indentation anchor cache behavior for headless/read-only/QA executors")
