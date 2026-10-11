import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { chromium } from 'playwright'
import { setTimeout as delay } from 'node:timers/promises'

import * as api from '../executor.js'

try {
  const browser = await chromium.launch({ headless: true })
  await browser.close()
} catch (error) {
  if (error instanceof Error && /Executable doesn't exist/i.test(error.message)) {
    console.log('SKIP browser ownership: Chromium binary is not installed')
    process.exit(0)
  }
  throw error
}
const server = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(`<html><head><title>${req.url}</title></head><body><input id="message" /></body></html>`)
})
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert.ok(address && typeof address === 'object')
const baseUrl = `http://127.0.0.1:${address.port}`
const errors: unknown[] = []
try {
  for (const sameRoot of [false, true]) {
    const ws = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'hc-browser-owner-'))
    const otherWs = sameRoot ? ws : await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'hc-browser-other-'))
    const a = api.createHeadlessExecutor(ws)
    const b = api.createQaHeadlessExecutor(otherWs)
    try {
      const launched = await a.execute('browser_action', { action: 'launch', url: `${baseUrl}/alpha` })
      assert.equal(launched.isError, false, launched.content)
      assert.ok(launched.content.includes('/alpha'))
      if (sameRoot) {
        const other = await b.execute('browser_action', { action: 'launch', url: `${baseUrl}/beta` })
        assert.equal(other.isError, false, other.content)
        const owned = await a.execute('browser_action', { action: 'type', selector: '#message', text: 'alpha-owner' })
        assert.equal(owned.isError, false, owned.content)
        assert.ok(owned.content.includes('/alpha'), 'same-root executors must retain distinct browser pages')
        const closed = await b.execute('browser_action', { action: 'close' })
        assert.equal(closed.isError, false)
        const relaunched = await b.execute('browser_action', { action: 'launch', url: `${baseUrl}/gamma` })
        assert.equal(relaunched.isError, false, relaunched.content)
        assert.ok(relaunched.content.includes('/gamma'), 'closed owner can launch a fresh page')
      }
      b.dispose()
      await delay(150)
      const owned = await a.execute('browser_action', { action: 'type', selector: '#message', text: 'still-owned' })
      assert.equal(owned.isError, false, owned.content)
      assert.ok(owned.content.includes('/alpha'), 'unrelated executor disposal must preserve the owner browser')
      a.dispose()
      await delay(150)
      const ended = await a.execute('browser_action', { action: 'getConsoleLogs' })
      assert.match(ended.content, /no browser is open/, 'owner disposal closes its browser')
      console.log(`PASS browser ownership ${sameRoot ? 'same-root' : 'different-root'}`)
    } catch (error) {
      errors.push(error)
      console.log(`FAIL browser ownership ${sameRoot ? 'same-root' : 'different-root'}: ${String(error)}`)
    } finally {
      await a.execute('browser_action', { action: 'close' })
      await b.execute('browser_action', { action: 'close' })
      a.dispose()
      b.dispose()
      await rm(ws, { recursive: true, force: true })
      if (!sameRoot) await rm(otherWs, { recursive: true, force: true })
    }
  }
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
if (errors.length) throw new AggregateError(errors, 'Browser session isolation regressions failed')
