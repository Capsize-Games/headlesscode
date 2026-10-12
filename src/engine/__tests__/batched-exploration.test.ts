/** Independent end-to-end regressions for read-only batches; no network or model inference. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HeadlessSession } from '../loop.js'
import type { ChatMessage, LlmClient, LlmRequest } from '../types.js'

const envKeys = ['HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD', 'HEADLESSCODE_READ_ONLY_STALL_LIMIT'] as const
const saved = envKeys.map(key => process.env[key])
process.env.HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD = '2'
process.env.HEADLESSCODE_READ_ONLY_STALL_LIMIT = '4'
const read = (i: number) => ({ tool: 'read_file', args: { path: `f${i}.txt` } })
const batch = (calls: unknown[]) => ({ name: 'batch', args: { calls } })
const completion = { name: 'attempt_completion', args: { result: 'Fixture inspection complete' } }
type Call = { name: string, args: Record<string, unknown> }

async function exercise(calls: Call[]) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'hc-batch-exploration-'))
  try {
    for (let i = 0; i < 8; i++) await fs.writeFile(path.join(workspace, `f${i}.txt`), `fixture ${i}`)
    const requests: LlmRequest[] = []
    const client: LlmClient = { async createChatCompletion(request) {
      requests.push({ ...request, messages: request.messages.map(message => ({ ...message })) })
      const call = calls[requests.length - 1]
      assert.ok(call, 'Unexpected extra model request')
      const message: ChatMessage = { role: 'assistant', content: null, tool_calls: [{
        id: `fixture-${requests.length}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) }
      }] }
      return { message }
    } }
    const result = await new HeadlessSession({ workspaceRoot: workspace, mode: 'code', model: 'fake-model', taskText: 'Inspect fixture', llmClient: client, checkpoints: false, maxIterations: 8, budget: null, consecutiveErrorLimit: 20 }).run()
    const nudged = requests.map((request, index) => request.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes("You've made several read/exploration calls")) ? index : -1).filter(index => index >= 0)
    return { result, nudged }
  } finally { await fs.rm(workspace, { recursive: true, force: true }) }
}

const cases: Array<[string, () => Promise<void>]> = [
  ['direct reads remain the control', async () => {
    const result = await exercise([{ name: 'read_file', args: read(0).args }, { name: 'read_file', args: read(1).args }, completion])
    assert.deepEqual(result.nudged, [2]); assert.equal(result.result.status, 'success')
  }],
  ['batched reads receive the same nudge', async () => {
    const result = await exercise([batch([read(0)]), batch([read(1), read(2)]), completion])
    assert.deepEqual(result.nudged, [2]); assert.equal(result.result.status, 'success')
  }],
  ['read-equivalent shell calls inside batches count', async () => {
    const result = await exercise([batch([{ tool: 'execute_command', args: { command: 'cat f0.txt' } }]), batch([{ tool: 'execute_command', args: { command: 'head f1.txt' } }]), completion])
    assert.deepEqual(result.nudged, [2])
  }],
  ['omitted args follow the valid batch schema', async () => {
    const result = await exercise([batch([{ tool: 'list_files' }]), batch([{ tool: 'list_files', args: { path: '.' } }, read(0)]), completion])
    assert.deepEqual(result.nudged, [2])
  }],
  ['batched read stagnation stops at the same limit', async () => {
    const result = await exercise(Array.from({ length: 6 }, (_, i) => batch([read(i)])))
    assert.equal(result.result.status, 'error'); assert.match(result.result.error ?? '', /read-only stagnation/); assert.equal(result.result.iterations, 4)
  }],
  ['a mixed write batch resets the streak', async () => {
    const result = await exercise([batch([read(0)]), batch([read(1), { tool: 'write_to_file', args: { path: 'out.txt', content: 'written' } }]), batch([read(2)]), completion])
    assert.deepEqual(result.nudged, []); assert.equal(result.result.status, 'success')
  }],
  ['a mixed mutating shell batch resets the streak', async () => {
    const result = await exercise([batch([read(0)]), batch([read(1), { tool: 'execute_command', args: { command: 'printf changed > out.txt' } }]), batch([read(2)]), completion])
    assert.deepEqual(result.nudged, []); assert.equal(result.result.status, 'success')
  }],
  ...[
    ['empty', { calls: [] }],
    ['malformed member', { calls: [null] }],
    ['array args', { calls: [{ tool: 'read_file', args: [] }] }],
    ['oversized', { calls: Array.from({ length: 11 }, (_, i) => read(i % 8)) }],
    ['nested', { calls: [{ tool: 'batch', args: { calls: [read(0)] } }] }],
  ].map(([name, args]) => [`${name} batch is not counted as a valid read-only turn`, async () => {
    const result = await exercise([batch([read(0)]), { name: 'batch', args: args as Record<string, unknown> }, batch([read(1)]), completion])
    assert.deepEqual(result.nudged, [])
  }] as [string, () => Promise<void>]),
]
let failures = 0
try {
  for (const [name, check] of cases) {
    try { await check(); console.log(`PASS ${name}`) }
    catch (error) { failures++; console.error(`FAIL ${name}: ${String(error)}`) }
  }
} finally {
  envKeys.forEach((key, index) => { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index] })
}
console.log(`Batched exploration regressions: ${cases.length - failures} passed, ${failures} failed, 0 skipped`)
assert.equal(failures, 0)
