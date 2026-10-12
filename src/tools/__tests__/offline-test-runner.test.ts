/** Independent process/argv/offline regressions for issue #91. */
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer } from 'node:http'
import { runOneTestFile } from '../run-tests.js'

const keys=['HEADLESSCODE_TEST_TSX_PATH','npm_config_cache','npm_config_registry','npm_config_fetch_retries','npm_config_update_notifier'] as const
const saved=keys.map(k=>process.env[k])
const root=await fs.mkdtemp(path.join(os.tmpdir(),'hc-offline-runner-'))
const workspace=path.join(root,'workspace');await fs.mkdir(workspace)
const fakeRunner=path.join(root,'runner with spaces')
await fs.writeFile(fakeRunner,`#!/usr/bin/env node
const name=process.argv[2];
if(name==='exit-seven'){console.error('fixture failure');process.exit(7)}
if(name==='hang'){setInterval(()=>{},1000)}else{console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))}
`);await fs.chmod(fakeRunner,0o755)
let registryRequests=0
const server=createServer((_request,response)=>{registryRequests++;response.writeHead(404);response.end('{}')})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr!=='string')
process.env.npm_config_cache=path.join(root,'empty-cache');process.env.npm_config_registry=`http://127.0.0.1:${addr.port}`;process.env.npm_config_fetch_retries='0';process.env.npm_config_update_notifier='false'
const runner=path.resolve('node_modules/.bin/tsx')
const cases:Array<[string,()=>Promise<void>]>=[
 ['missing runner makes no registry requests',async()=>{delete process.env.HEADLESSCODE_TEST_TSX_PATH;const x=await runOneTestFile(workspace,'fixture.test.ts',2);assert.equal(x.exitCode,null);assert.match(x.output,/tsx runner not usable/);assert.equal(registryRequests,0);assert.equal(x.timedOut,false)}],
 ['absolute override executes a real TypeScript fixture',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=runner;await fs.writeFile(path.join(workspace,'fixture.test.ts'),"const value: number=17; console.log('fixture passed '+value)");const x=await runOneTestFile(workspace,'fixture.test.ts',3);assert.equal(x.exitCode,0);assert.match(x.output,/fixture passed 17/);assert.equal(registryRequests,0)}],
 ['literal hostile filename is exactly one argv item',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=fakeRunner;const rel='$(touch SHOULD_NOT_EXIST); `echo bad` & file with spaces.test.ts';const x=await runOneTestFile(workspace,rel,2);assert.equal(x.exitCode,0);const printed=JSON.parse(x.output);assert.deepEqual(printed.args,[rel]);assert.equal(printed.cwd,workspace);await assert.rejects(fs.stat(path.join(workspace,'SHOULD_NOT_EXIST')))}],
 ['override filename trailing whitespace is literal',async()=>{const file=path.join(root,'runner trailing ');await fs.copyFile(fakeRunner,file);await fs.chmod(file,0o755);process.env.HEADLESSCODE_TEST_TSX_PATH=file;const x=await runOneTestFile(workspace,'fixture',2);assert.equal(x.exitCode,0)}],
 ['nonzero status and stderr are retained',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=fakeRunner;const x=await runOneTestFile(workspace,'exit-seven',2);assert.equal(x.exitCode,7);assert.match(x.output,/fixture failure/);assert.equal(x.timedOut,false)}],
 ['timeout kills the child and reports failure',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=fakeRunner;const x=await runOneTestFile(workspace,'hang',0.05);assert.equal(x.timedOut,true);assert.equal(x.exitCode,null)}],
 ['relative override fails without a fallback or registry',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH='runner';const x=await runOneTestFile(workspace,'fixture.test.ts',2);assert.equal(x.exitCode,null);assert.match(x.output,/must be an absolute path/);assert.equal(registryRequests,0)}],
 ['missing explicit override fails without registry',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=path.join(root,'missing');const x=await runOneTestFile(workspace,'fixture.test.ts',2);assert.equal(x.exitCode,null);assert.match(x.output,/missing or not executable/);assert.equal(registryRequests,0)}],
 ['non-executable override fails promptly',async()=>{const file=path.join(root,'not-executable');await fs.writeFile(file,'fixture');await fs.chmod(file,0o600);process.env.HEADLESSCODE_TEST_TSX_PATH=file;const x=await runOneTestFile(workspace,'fixture.test.ts',2);assert.equal(x.exitCode,null);assert.equal(x.timedOut,false);assert.match(x.output,/not executable/)}],
 ['workspace runner works without override',async()=>{const dir=path.join(workspace,'node_modules/.bin');await fs.mkdir(dir,{recursive:true});await fs.symlink(fakeRunner,path.join(dir,'tsx'));delete process.env.HEADLESSCODE_TEST_TSX_PATH;const x=await runOneTestFile(workspace,'local fixture',2);assert.equal(x.exitCode,0);assert.deepEqual(JSON.parse(x.output).args,['local fixture'])}],
 ['invalid explicit override never silently uses local runner',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=path.join(root,'missing');const x=await runOneTestFile(workspace,'local fixture',2);assert.equal(x.exitCode,null);assert.match(x.output,/missing or not executable/)}],
 ['explicit override takes precedence over a local runner',async()=>{process.env.HEADLESSCODE_TEST_TSX_PATH=runner;const x=await runOneTestFile(workspace,'fixture.test.ts',3);assert.equal(x.exitCode,0);assert.match(x.output,/fixture passed 17/)}],
]
let failures=0
try{for(const[name,check]of cases){try{await check();console.log('PASS '+name)}catch(e){failures++;console.error('FAIL '+name+': '+e)}}}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));await fs.rm(root,{recursive:true,force:true});keys.forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i]})}
console.log(`Offline test runner: ${cases.length-failures} passed, ${failures} failed, 0 skipped`);assert.equal(failures,0)
