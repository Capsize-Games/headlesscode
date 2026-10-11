import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import * as api from '../executor.js'

if (process.platform !== 'linux') {
  console.log('SKIP command ownership: Linux process identity fixture')
  process.exit(0)
}

async function processIdentity(pid: number): Promise<string | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return fields[0] === 'Z' ? undefined : fields[19]
  } catch { return undefined }
}

for (const [ownerFactory, otherFactory, sameRoot] of [
  ['createHeadlessExecutor', 'createQaHeadlessExecutor', true],
  ['createReadOnlyHeadlessExecutor', 'createHeadlessExecutor', false],
  ['createQaHeadlessExecutor', 'createReadOnlyHeadlessExecutor', true],
] as const) {
  const ws = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'hc-command-owner-'))
  const otherWs = sameRoot ? ws : await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'hc-command-other-'))
  const owner = api[ownerFactory](ws)
  const other = api[otherFactory](otherWs)
  let pid: number | undefined
  let identity: string | undefined
  try {
    const result = await owner.execute('execute_command', {
      command: `node -e 'console.log("owned_pid=" + process.pid); setInterval(() => {}, 1000)'`,
      timeout: 1,
    })
    assert.equal(result.isError, false)
    assert.match(result.content, /still running in the background/)
    pid = Number(result.content.match(/owned_pid=(\d+)/)?.[1])
    assert.ok(Number.isSafeInteger(pid) && pid! > 0, 'child PID captured')
    identity = await processIdentity(pid!)
    assert.ok(identity, 'owner child is alive after timeout')
    other.dispose()
    await delay(150)
    assert.equal(await processIdentity(pid!), identity,
      `${otherFactory}.dispose must preserve ${ownerFactory}'s background child`)
    owner.dispose()
    const deadline = Date.now() + 5000
    while (Date.now() < deadline && await processIdentity(pid!) === identity) await delay(25)
    assert.notEqual(await processIdentity(pid!), identity, 'owner dispose terminates its own child')
    console.log(`PASS ${ownerFactory} child ownership versus ${otherFactory}`)
  } finally {
    owner.dispose()
    other.dispose()
    if (pid && identity && await processIdentity(pid) === identity) {
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
    await rm(ws, { recursive: true, force: true })
    if (!sameRoot) await rm(otherWs, { recursive: true, force: true })
  }
}
