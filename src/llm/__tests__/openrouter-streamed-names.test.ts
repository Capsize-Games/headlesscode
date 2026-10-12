// Exercise name fragments through the actual client with synthetic SSE responses.
import assert from 'node:assert/strict';
import {OpenRouterClient} from '../openrouter.js';
const tc=(index:number,name:string,args='')=>({index,id:`call-${index}`,type:'function',function:{name,arguments:args}});
const cases=[
 {name:'whole name',deltas:[[tc(0,'read_file','{}')],[tc(0,'','')]],expected:['read_file']},
 {name:'fragmented name',deltas:[[tc(0,'read_','{')],[tc(0,'file','}')]],expected:['read_file']},
 {name:'interleaved indexes',deltas:[[tc(1,'write_','{'),tc(0,'read_','{')],[tc(0,'file','}'),tc(1,'to_file','}')]],expected:['read_file','write_to_file']},
 {name:'one-character fragments',deltas:[...('read_file')].map((ch,i)=>[tc(0,ch,i===0?'{}':'')]),expected:['read_file']},
];
let failures=0;
for(const fixture of cases){
 const chunks=fixture.deltas.map(tool_calls=>({choices:[{delta:{tool_calls}}]}));
 const wire=[...chunks,{choices:[{delta:{},finish_reason:'tool_calls'}]},{usage:{prompt_tokens:30,completion_tokens:10,total_tokens:40,cost:.000001}},'[DONE]'].map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join('');
 const previous=globalThis.fetch;globalThis.fetch=(async()=>new Response(wire,{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
 try{
  const client=new OpenRouterClient({apiKey:'synthetic-only',baseUrl:'http://synthetic',disableTranscriptCapture:true});
  const result=await client.createChatCompletion({model:'meta/muse-spark-1.3-contributor',messages:[{role:'user',content:'synthetic fixture'}],stream:true});
  assert.deepEqual(result.message.tool_calls?.map(c=>c.function.name),fixture.expected);assert.ok(result.message.tool_calls?.every(c=>c.function.arguments==='{}'));
  console.log('PASS '+fixture.name);
 }catch(error){failures++;console.log('FAIL '+fixture.name+': '+(error as Error).message);}finally{globalThis.fetch=previous;}
}
console.log(JSON.stringify({checks:cases.length,passed:cases.length-failures,failures,skipped:0}));assert.equal(failures,0);
