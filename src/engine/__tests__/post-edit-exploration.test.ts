import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HeadlessSession } from '../loop.js'
import type { ChatMessage, LlmClient, LlmRequest } from '../types.js'

type Call = { name: string, args: Record<string, unknown> }
const read = (i: number): Call => ({name:'read_file',args:{path:`f${i}.txt`}})
const write = (i: number): Call => ({name:'write_to_file',args:{path:`out${i}.txt`,content:`fixture ${i}`}})
const done: Call = {name:'attempt_completion',args:{result:'Fixture inspection complete'}}
const batch = (calls: Call[]): Call => ({name:'batch',args:{calls:calls.map(c=>({tool:c.name,args:c.args}))}})
const keys=['HEADLESSCODE_POST_EDIT_READ_ONLY_LIMIT','HEADLESSCODE_READ_ONLY_STALL_LIMIT','HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD'] as const
const saved=keys.map(k=>process.env[k]); process.env.HEADLESSCODE_READ_ONLY_STALL_LIMIT='100';process.env.HEADLESSCODE_READ_ONLY_NUDGE_THRESHOLD='100'
async function exercise(calls:Call[],limit='3') {
 if(limit==='unset')delete process.env.HEADLESSCODE_POST_EDIT_READ_ONLY_LIMIT
 else process.env.HEADLESSCODE_POST_EDIT_READ_ONLY_LIMIT=limit
 const workspace=await fs.mkdtemp(path.join(os.tmpdir(),'hc-post-edit-'))
 try {
  for(let i=0;i<9;i++)await fs.writeFile(path.join(workspace,`f${i}.txt`),`fixture ${i}`)
  const requests:LlmRequest[]=[]
  const client:LlmClient={async createChatCompletion(request){requests.push({...request,messages:request.messages.map(m=>({...m}))});const call=calls[requests.length-1];assert.ok(call,'unexpected extra model request');const message:ChatMessage={role:'assistant',content:null,tool_calls:[{id:`fixture-${requests.length}`,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]};return {message}}}
  const result=await new HeadlessSession({workspaceRoot:workspace,mode:'code',model:'fake-model',taskText:'Inspect fixture',llmClient:client,checkpoints:false,maxIterations:12,budget:null,consecutiveErrorLimit:30}).run()
  return {result,requests,output:await fs.readFile(path.join(workspace,'out0.txt'),'utf8').catch(()=>null)}
 }finally{await fs.rm(workspace,{recursive:true,force:true})}
}
const cases:Array<[string,()=>Promise<void>]>=[
 ['direct reads stop before another paid request',async()=>{const x=await exercise([write(0),read(0),read(1),read(2),done]);assert.equal(x.result.status,'error');assert.match(x.result.error??'',/post-edit.*stagnation/);assert.equal(x.requests.length,4);assert.equal(x.output,'fixture 0')}],
 ['disabled option preserves completion',async()=>{const x=await exercise([write(0),read(0),read(1),read(2),done],'0');assert.equal(x.result.status,'success');assert.equal(x.requests.length,5)}],
 ...['-1','3oops','9007199254740992'].map(value => [`invalid limit ${value} keeps option disabled`,async()=>{const x=await exercise([write(0),read(0),read(1),read(2),done],value);assert.equal(x.result.status,'success')}] as [string,()=>Promise<void>]),
 ['post-edit warning reaches the next request',async()=>{const x=await exercise([write(0),read(0),read(1),read(2),done]);assert.ok(x.requests[3]?.messages.some(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes('independent supervisor qualification')))}],
 ['absent option preserves default behavior',async()=>{const x=await exercise([write(0),read(0),read(1),read(2),done],'unset');assert.equal(x.result.status,'success')}],
 ['initial exploration never arms the post-edit cap',async()=>{const x=await exercise([read(0),read(1),read(2),read(3),done]);assert.equal(x.result.status,'success')}],
 ['successful batch edit arms the counter',async()=>{const x=await exercise([batch([write(0),read(0)]),batch([read(1)]),batch([read(2)]),batch([read(3)]),done]);assert.equal(x.result.status,'error');assert.equal(x.requests.length,4)}],
 ['indexed search cannot reset post-edit exploration',async()=>{const x=await exercise([write(0),read(0),{name:'codebase_search',args:{query:'fixture',path:'.'}},read(1),read(2),done]);assert.equal(x.result.status,'error');assert.ok(x.requests.length<=5)}],
 ['read-equivalent shell calls share the cap',async()=>{const x=await exercise([write(0),{name:'execute_command',args:{command:'cat f0.txt'}},{name:'execute_command',args:{command:'head f1.txt'}},{name:'execute_command',args:{command:'cat f2.txt'}},done]);assert.equal(x.result.status,'error');assert.equal(x.requests.length,4)}],
 ['successful write resets exploration',async()=>{const x=await exercise([write(0),read(0),read(1),write(1),read(2),read(3),done]);assert.equal(x.result.status,'success')}],
 ['successful test command resets exploration',async()=>{const x=await exercise([write(0),read(0),read(1),{name:'execute_command',args:{command:'node -e "process.exit(0)"'}},read(2),read(3),done]);assert.equal(x.result.status,'success')}],
 ['failed edit cannot arm the counter',async()=>{const x=await exercise([{name:'apply_diff',args:{path:'missing.js',diff:'invalid'}},read(0),read(1),read(2),done]);assert.equal(x.result.status,'success')}],
 ['failed edit cannot reset armed counter',async()=>{const x=await exercise([write(0),read(0),read(1),{name:'apply_diff',args:{path:'missing.js',diff:'invalid'}},read(2),done]);assert.equal(x.result.status,'error');assert.equal(x.requests.length,5)}],
 ['malformed batch cannot reset armed counter',async()=>{const x=await exercise([write(0),read(0),read(1),{name:'batch',args:{calls:[]}},read(2),done]);assert.equal(x.result.status,'error');assert.equal(x.requests.length,5)}],
 ['mixed successful productive batch resets',async()=>{const x=await exercise([write(0),read(0),read(1),batch([read(2),write(1)]),read(3),read(4),done]);assert.equal(x.result.status,'success')}],
]
let failures=0
try{for(const [name,fn]of cases){try{await fn();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e)}}}finally{keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i]})}
console.log(`Post-edit exploration: ${cases.length-failures} passed, ${failures} failed, 0 skipped`);assert.equal(failures,0)
