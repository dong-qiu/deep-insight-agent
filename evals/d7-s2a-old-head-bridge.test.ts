/** Fresh credential-free child processes; Git/dependency preparation never runs in a business child. */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, it } from "vitest";
import { OLD_HEAD, OLD_TREE } from "./d7-s2a-old-head-signatures.js";

const toolRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const evidence = process.env.S2A_BRIDGE_EVIDENCE_ROOT ?? mkdtempSync(join(tmpdir(), "s2a-bridge-evidence-"));
chmodSync(evidence, 0o700);
let candidate: string;
beforeAll(() => {
  candidate = process.env.S2A_OLD_HEAD_CANDIDATE ?? "";
  if (!candidate) {
    try { execFileSync("git", ["cat-file", "-e", `${OLD_HEAD}^{commit}`], { cwd: toolRoot, stdio: "ignore" }); }
    catch {
      // This is source preparation, before the empty-env child and before any model import.
      execFileSync("git", ["-c", "http.version=HTTP/1.1", "fetch", "--no-tags", "origin", "refs/pull/430/head"], { cwd: toolRoot, stdio: "pipe", timeout: 60_000 });
      expect(execFileSync("git", ["rev-parse", "FETCH_HEAD"], { cwd: toolRoot, encoding: "utf8" }).trim()).toBe(OLD_HEAD);
    }
    candidate = join(mkdtempSync(join(tmpdir(), "s2a-old-235-")), "candidate");
    execFileSync("git", ["worktree", "add", "--detach", candidate, OLD_HEAD], { cwd: toolRoot, stdio: "pipe" });
  }
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: candidate, encoding: "utf8" }).trim()).toBe(OLD_HEAD);
  expect(execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: candidate, encoding: "utf8" }).trim()).toBe(OLD_TREE);
  if (!existsSync(join(candidate, "node_modules/.package-lock.json"))) {
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: candidate, env: { PATH: process.env.PATH, NODE_ENV: "test" }, stdio: "pipe", timeout: 180_000 });
  }
}, 240_000);

async function child(name: string, body: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const root = join(evidence, name), source = join(evidence, `${name}.mts`);
  const script = `import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {installOldHeadBridge,FAKE_KEY,RESPONSES_LOGICAL_URL,REQUEST_LIMIT,RESPONSE_LIMIT} from ${JSON.stringify(join(toolRoot, "evals/d7-s2a-old-head-bridge.ts"))};
import {oldPromptStrings} from ${JSON.stringify(join(toolRoot, "evals/d7-s2a-old-head-signatures.ts"))};
const candidate=${JSON.stringify(candidate)}, root=${JSON.stringify(root)};
let received=[]; let mode='normal'; let ordinal=0;
const quote='Fact is supported.';
const coverage={verdicts:[{index:1,kind:'factual',supports:true,citation_indexes:[1],evidence_spans:[{citation_index:1,quote_start:0,quote_end:quote.length,evidence_excerpt:quote}]}]};
const generated={no_significant_event:false,insights:[{statement:quote,statement_citation_index:1,headline:'',type:'aggregation',importance:3,importance_facts:[],importance_reason:'research_tracking',importance_reason_claim_indexes:[1],confidence:null,event_id:null,is_followup:false,entities:[],tags:[],citations:[{content_item_id:'ci',quote,claim:quote}]}]};
function answer(body){const schema=body.tools[0].input_schema??body.tools[0].parameters; const properties=schema.properties; if(properties.no_significant_event)return mode==='pipeline'?generated:{no_significant_event:true,insights:[]};if(properties.statement)return {statement:quote};if(properties.judgments)return {judgments:[{index:1,consistency:'support',consistency_reason:'ok',rationale:'synthetic'}]};if(properties.consistency)return {consistency:'support',consistency_reason:'ok',rationale:'synthetic'};if(properties.verdicts.items.properties.kind)return coverage;return {verdicts:[{index:1,supports:true}]};}
function sse(data){return ['message_start','content_block_start','content_block_stop','message_delta','message_stop'].map(type=>{const v=type==='message_start'?{type,message:{id:'msg_synthetic',type:'message',role:'assistant',model:'synthetic',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}:type==='content_block_start'?{type,index:0,content_block:{type:'tool_use',id:'tool_synthetic',name:'respond_with_structured_output',input:data}}:type==='content_block_stop'?{type,index:0}:type==='message_delta'?{type,delta:{stop_reason:'tool_use',stop_sequence:null},usage:{output_tokens:1}}:{type};return 'event: '+type+'\\ndata: '+JSON.stringify(v)+'\\n\\n';}).join('');}
let sentinelCount=0;const sentinel=createServer((req,res)=>{sentinelCount++;res.end('unexpected');});await new Promise(r=>sentinel.listen(0,'127.0.0.1',r));
const server=createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk; const parsed=JSON.parse(text); received.push({url:req.url,body:parsed});ordinal++;
 if(mode==='429'&&ordinal===1){res.writeHead(429,{'content-type':'application/json','retry-after':'0'});res.end(JSON.stringify({type:'error',error:{type:'rate_limit_error',message:'synthetic'}}));return;}
 if(mode==='redirect'){res.writeHead(307,{location:'http://127.0.0.1:'+sentinel.address().port+'/'});res.end();return;}
 res.writeHead(200,{'content-type':'text/event-stream'});
 if(mode==='oversize'){res.end('x'.repeat(RESPONSE_LIMIT+1));return;}
 if(mode==='two-bytes'){res.end('AB');return;}
 if(mode==='capacity'){res.end('x'.repeat(RESPONSE_LIMIT));return;}
 if(mode==='hang'){res.write('data: never-finish\\n\\n');return;}
 if(mode==='sdk-hang'){res.write(sse(answer(parsed)).split('\\n\\n')[0]+'\\n\\n');return;}
 if(req.url==='/responses'){if(mode==='eof'&&ordinal===1){res.end('data: '+JSON.stringify({type:'response.created',response:{status:'in_progress'}})+'\\n\\n');return;}
 res.end('data: '+JSON.stringify({type:'response.function_call_arguments.done',name:'respond_with_structured_output',arguments:JSON.stringify(answer(parsed))})+'\\n\\ndata: '+JSON.stringify({type:'response.completed',response:{status:'completed',output:[],usage:{input_tokens:1,output_tokens:1}}})+'\\n\\ndata: [DONE]\\n\\n');return;}
 res.end(sse(answer(parsed)));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin='http://127.0.0.1:'+server.address().port;
process.env.ANTHROPIC_BASE_URL=origin;
const prompts=oldPromptStrings(candidate);
const schemas=await import(pathToFileURL(join(candidate,'src/lib/types.ts')).href);
const {z}=await import(pathToFileURL(join(candidate,'node_modules/zod/v4/index.js')).href);
const validBody=()=>JSON.stringify({model:'synthetic-analyzer',max_tokens:12000,system:[{type:'text',text:prompts.ANALYZER_SYSTEM}],messages:[{role:'user',content:'synthetic'}],tools:[{name:'respond_with_structured_output',description:'Return the structured result strictly matching the input_schema. Do not include any text outside the tool call.',input_schema:z.toJSONSchema(schemas.AnalyzerOutputSchema)}],tool_choice:{type:'tool',name:'respond_with_structured_output'},stream:true});
const send=(body=validBody())=>fetch(origin+'/v1/messages',{method:'POST',body,headers:{'x-api-key':FAKE_KEY}});
let bridge;
try { ${body} }
finally{bridge?.dispose();server.closeAllConnections();sentinel.closeAllConnections();await Promise.all([new Promise(r=>server.close(r)),new Promise(r=>sentinel.close(r))]);}
console.log(JSON.stringify({received:received.length,sentinelCount,snapshot:bridge?.snapshot()}));`;
  writeFileSync(source, script, { flag: "wx", mode: 0o600 });
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, NODE_ENV: "test", LLM_API_KEY: "s2a-isolated-fake-key", ANTHROPIC_API_KEY: "s2a-isolated-fake-key",
    DB_PATH: join(root, "isolated.sqlite"), DATA_DIR: join(root, "isolated-data"),
    ANALYZER_MODEL: "synthetic-analyzer", VALIDATOR_MODEL: "synthetic-validator", COVERAGE_MODEL: "synthetic-coverage",
    VALIDATOR_THINKING: "0", COVERAGE_THINKING: "0", LLM_MAX_RETRIES: "2", LLM_TRANSIENT_RETRIES: "1", LLM_TRANSIENT_RETRY_BACKOFF_MS: "0",
    VALIDATOR_RETRY_BACKOFF_MS: "0", LLM_TIMEOUT_MS: "2000", LLM_PROVIDER: "anthropic" };
  return new Promise((done, reject) => {
    const ownChild = spawn(globalThis.process.execPath, ["--import", "tsx", source], { cwd: candidate, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    const settle = (code: number | null, signal: NodeJS.Signals | null, localTerminal: "closed" | "unknown"): void => {
      if (settled) return; settled = true;
      clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(terminalTimer);
      // Killing this newly-created local PID proves no remote provider terminal state.
      if (timedOut) stderr += "\nparent_child_timeout: local process outcome " + localTerminal + "; transport outcome unknown";
      writeFileSync(join(evidence, `${name}-result.json`), JSON.stringify({ pid: ownChild.pid, code, signal, timedOut, localTerminal, stdout, stderr }), { flag: "wx", mode: 0o600 });
      done({ code: timedOut ? -1 : code, stdout, stderr });
    };
    const timeout = setTimeout(() => {
      timedOut = true; ownChild.kill("SIGTERM");
      killTimer = setTimeout(() => {
        ownChild.kill("SIGKILL");
        // A kernel/IO stall must not turn this fixture into an unlimited parent wait.
        terminalTimer = setTimeout(() => { ownChild.stdout.destroy(); ownChild.stderr.destroy(); ownChild.unref(); settle(null, null, "unknown"); }, 1000);
      }, 1000);
    }, 65_000);
    ownChild.stdout.on("data", value => { stdout += value; }); ownChild.stderr.on("data", value => { stderr += value; });
    ownChild.on("error", error => { clearTimeout(timeout); clearTimeout(killTimer); clearTimeout(terminalTimer); reject(error); });
    ownChild.on("close", (code, signal) => { settle(code, signal, "closed"); });
  });
}
const install = (admissions = 30, retries = 20, windowMs = 15_000) => `bridge=await installOldHeadBridge({candidate,root,loopbackOrigin:origin,syntheticLimits:{admissions:${admissions},retries:${retries},windowMs:${windowMs}}});`;
async function pass(name: string, script: string): Promise<string> { const result = await child(name, script); expect(result.code, result.stderr).toBe(0); return result.stdout; }

it("exact old production analyze→dual coverage→validator classify actual bytes without old observer", async () => {
  const output = await pass("pipeline", `${install()}mode='pipeline';const {analyze}=await bridge.load('analyzer'),{validateBatch}=await bridge.load('validator');
 const item={id:'ci',source_id:'src_feed_abcd',url:'https://example.test',title:'T',author:null,published_at:null,fetched_at:'2026-09-09T00:00:00.000Z',language:'en',topic_ids:['t'],tags:[],body:quote,body_kind:'article',raw_ref:'',content_hash:'h',fetch_status:'ok'};
 const batch=await analyze({id:'t',name:'T',keywords:[],language:'en',brief_schedule:'daily',enabled:true},[item],{start:'2026-09-09',end:'2026-09-09'});
 assert.equal(batch.insights.length,1);const v=await validateBatch(batch.insights,[item]);assert.equal(v.report.errored,0);bridge.finish();
 assert.deepEqual(bridge.snapshot().attempts.map(a=>a.operation),['analysis_generation','display_quote_primary','display_quote_countercheck','citation_consistency_single']); assert.equal(received.length,4);`);
  expect(output).toContain('"quality_pass":false');
}, 30_000);

it("all seven old operations plus primary translation use exact old SDK and source signatures", async () => {
  await pass("operations", `${install()}const {callStructured}=await bridge.load('llm');const entries=[
 ['analyzer','analysis_generation',prompts.ANALYZER_SYSTEM,schemas.AnalyzerOutputSchema],['validator','display_quote_primary',prompts.QUOTE_COVERAGE_SYSTEM,schemas.QuoteCoverageSchema],
 ['coverage','display_quote_countercheck',prompts.QUOTE_COVERAGE_COUNTERCHECK_SYSTEM,schemas.QuoteCoverageSchema],['analyzer','reader_language_repair',prompts.READER_LANGUAGE_REPAIR_SYSTEM,z.object({statement:z.string().min(1).max(2000)}).strict()],
 ['validator','citation_repair_candidates',prompts.COVERAGE_VERIFY_SYSTEM,schemas.CoverageRepairSchema],['validator','citation_consistency_single',prompts.CONSISTENCY_SYSTEM,schemas.ConsistencyJudgeSchema],['validator','citation_consistency_batch',prompts.CONSISTENCY_BATCH_SYSTEM,schemas.ConsistencyBatchJudgeSchema],
 ['validator','display_quote_primary',prompts.QUOTE_COVERAGE_SYSTEM+prompts.READER_LANGUAGE_EQUIVALENCE_RULE,schemas.QuoteCoverageSchema]];
 for(const [role,operation,system,schema] of entries)await callStructured({role,telemetryOperation:operation,system,schema,user:'synthetic',maxTokens:2048});bridge.finish();assert.deepEqual(bridge.snapshot().attempts.map(a=>a.operation),entries.map(e=>e[1]));assert.equal(received.length,8);`);
}, 30_000);

it("actual old Anthropic SDK hidden 429 retry crosses the same guarded fetch twice", async () => {
  await pass("sdk-retry", `${install()}mode='429';const {callStructured}=await bridge.load('llm');await callStructured({role:'analyzer',system:prompts.ANALYZER_SYSTEM,user:'synthetic',schema:schemas.AnalyzerOutputSchema,maxTokens:12000});bridge.finish();assert.equal(received.length,2);assert.deepEqual(bridge.snapshot().attempts.map(a=>a.retry),[false,true]);`);
}, 30_000);

it("old Responses official URL precheck maps only its exact logical URL; real EOF retry is counted", async () => {
  await pass("responses-eof", `process.env.LLM_PROVIDER='volcengine-responses';process.env.LLM_BASE_URL='https://ark.cn-beijing.volces.com/api/coding/v3';${install()}mode='eof';const {callStructured}=await bridge.load('llm');await callStructured({role:'analyzer',system:prompts.ANALYZER_SYSTEM,user:'synthetic',schema:schemas.AnalyzerOutputSchema,maxTokens:12000});bridge.finish();assert.equal(received.length,2);assert.deepEqual(bridge.snapshot().attempts.map(a=>a.retry),[false,true]);assert.ok(received.every(r=>r.url==='/responses'));`);
}, 30_000);

it.each([
  ["zero", `bridge=await installOldHeadBridge({candidate,root,loopbackOrigin:origin});await assert.rejects(send(),/s2a_admission_limit/);`],
  ["unknown-operation", `${install()}const body=JSON.parse(validBody());body.system[0].text='unknown';await assert.rejects(send(JSON.stringify(body)),/s2a_unknown_or_ambiguous_operation/);`],
  ["unknown-envelope", `${install()}const body=JSON.parse(validBody());body.extra='x';await assert.rejects(send(JSON.stringify(body)),/s2a_unknown_envelope/);`],
  ["wrong-model", `${install()}const body=JSON.parse(validBody());body.model='other';await assert.rejects(send(JSON.stringify(body)),/s2a_unknown_or_ambiguous_operation/);`],
  ["body-size", `${install()}const body=JSON.parse(validBody());body.messages[0].content='x'.repeat(REQUEST_LIMIT);await assert.rejects(send(JSON.stringify(body)),/s2a_request_size_limit/);`],
  ["request-object", `${install()}await assert.rejects(fetch(new Request(origin+'/v1/messages',{method:'POST',body:'x'})),/s2a_unknown_request/);`],
  ["body-stream", `${install()}let reads=0;const body=new ReadableStream({pull(){reads++;}} ,{highWaterMark:0});await assert.rejects(fetch(origin+'/v1/messages',{method:'POST',body,duplex:'half'}),/s2a_unknown_request/);assert.equal(reads,0);`],
  ["sdk-default", `${install()}delete process.env.ANTHROPIC_BASE_URL;const {callStructured}=await bridge.load('llm');await assert.rejects(callStructured({role:'analyzer',system:prompts.ANALYZER_SYSTEM,user:'synthetic',schema:schemas.AnalyzerOutputSchema,maxTokens:12000}));`],
  ["gateway", `${install()}await assert.rejects(fetch('https://fake.apigateway-cn-beijing.volceapi.com/v1/responses',{method:'POST',body:validBody(),headers:{'x-api-key':FAKE_KEY}}),/s2a_unknown_destination/);`],
  ["dispose", `${install()}bridge.dispose();await assert.rejects(send(),/s2a_bridge_missing_or_stopped/);await assert.rejects(bridge.load('llm'),/s2a_bridge_stopped/);`],
])("%s fails closed before any local HTTP and never restores default SDK", async (name, script) => {
  await pass(name, `${script}assert.equal(received.length,0);if(!bridge.snapshot().disposed)assert.throws(()=>bridge.finish());`);
}, 30_000);

it("failed old head identity installation permanently denies fetch", async () => {
  await pass("bad-head", `await assert.rejects(installOldHeadBridge({candidate:${JSON.stringify(toolRoot)},root,loopbackOrigin:origin}),/s2a_old_identity_mismatch/);await assert.rejects(send(),/s2a_bridge_missing_or_stopped/);assert.equal(received.length,0);`);
}, 30_000);

it("actual 307 cannot follow to a second loopback destination", async () => {
  await pass("redirect", `${install()}mode='redirect';await assert.rejects(send());assert.equal(received.length,1);assert.equal(sentinelCount,0);assert.throws(()=>bridge.finish());`);
}, 30_000);

it("actual oversized response and no EOF stay incomplete, preserve first cause, and reject late finish", async () => {
  await pass("oversize-response", `${install()}mode='oversize';await assert.rejects((await send()).text(),/s2a_response_size_limit/);assert.equal(received.length,1);assert.throws(()=>bridge.finish(),/s2a_response_size_limit/);assert.ok(bridge.snapshot().attempts[0].response_bytes<=RESPONSE_LIMIT);`);
  await pass("no-eof", `${install(3, 2, 500)}mode='hang';const response=await send();await assert.rejects(response.text(),/s2a_deadline/);assert.throws(()=>bridge.finish(),/s2a_deadline/);assert.equal(received.length,1);assert.equal(bridge.snapshot().attempts[0].segment,'setup');`);
}, 30_000);

it("100 conservative admissions stop the 101st actual fetch; 20 retries stop the 21st retry", async () => {
  await pass("admission-101", `${install(100, 20)}for(let i=0;i<100;i++){bridge.segment('s'+i);await(await send()).text();}await assert.rejects(send(),/s2a_admission_limit/);assert.equal(received.length,100);assert.equal(bridge.snapshot().attempts.length,100);`);
  await pass("retry-21", `${install(100, 20)}for(let i=0;i<21;i++)await(await send()).text();await assert.rejects(send(),/s2a_retry_limit/);assert.equal(received.length,21);assert.equal(bridge.snapshot().attempts.filter(a=>a.retry).length,20);`);
}, 30_000);

it("unknown getter is never read; classified body cannot change at native spread", async () => {
  await pass("getter", `${install()}let reads=0;const init={method:'POST',headers:{'x-api-key':FAKE_KEY},get body(){reads++;return validBody();}};await assert.rejects(fetch(origin+'/v1/messages',init),/s2a_unknown_request/);assert.equal(reads,0);assert.equal(received.length,0);assert.throws(()=>bridge.finish(),/s2a_unknown_request/);`);
}, 30_000);

it("in-flight finish and segment rejection are sticky through late native completion", async () => {
  await pass("late-finish", `${install()}const response=await send();assert.throws(()=>bridge.finish(),/s2a_attempts_incomplete/);await assert.rejects(response.text(),/s2a_attempts_incomplete/);assert.throws(()=>bridge.finish(),/s2a_attempts_incomplete/);assert.equal(bridge.snapshot().failure,'s2a_attempts_incomplete');`);
  await pass("late-segment", `${install()}const response=await send();assert.throws(()=>bridge.segment('late'),/s2a_segment_inflight_or_invalid/);await assert.rejects(response.text(),/s2a_segment_inflight_or_invalid/);assert.throws(()=>bridge.finish(),/s2a_segment_inflight_or_invalid/);assert.equal(bridge.snapshot().attempts[0].segment,'setup');`);
}, 30_000);

it("actual partial write cannot deliver unpreserved bytes or pass finish", async () => {
  await pass("partial-write", `${install()}mode='two-bytes';const fs=(await import('node:fs')).default;const {syncBuiltinESMExports}=await import('node:module');const original=fs.writeSync;fs.writeSync=(fd,value,...args)=>value instanceof Uint8Array&&value.byteLength===2?original(fd,value.subarray(0,1)):original(fd,value,...args);syncBuiltinESMExports();try{await assert.rejects((await send()).text(),/s2a_partial_write/);assert.throws(()=>bridge.finish(),/s2a_partial_write/);assert.equal(bridge.snapshot().attempts[0].response_bytes,1);assert.equal(readFileSync(join(root,'response-1.bin')).length,1);}finally{fs.writeSync=original;syncBuiltinESMExports();}`);
}, 30_000);

it("failed evidence and STOP writes remain sticky in memory with unknown durable failure", async () => {
  await pass("disk-full", `${install()}const fs=(await import('node:fs')).default;const {syncBuiltinESMExports}=await import('node:module');const original=fs.writeFileSync;fs.writeFileSync=()=>{const e=new Error('synthetic diskfull');e.code='ENOSPC';throw e;};syncBuiltinESMExports();try{await assert.rejects(send(),/s2a_transport_failed/);assert.equal(received.length,0);assert.equal(bridge.snapshot().failure_persisted,false);assert.equal(bridge.snapshot().attempts[0].transport,'not_sent');assert.throws(()=>bridge.finish(),/s2a_transport_failed/);}finally{fs.writeFileSync=original;syncBuiltinESMExports();}await assert.rejects(send());assert.equal(received.length,0);`);
}, 30_000);

it("first explicit cancellation survives a later deadline and late finish", async () => {
  await pass("first-cancel", `const controller=new AbortController();bridge=await installOldHeadBridge({candidate,root,loopbackOrigin:origin,signal:controller.signal,syntheticLimits:{admissions:3,retries:2,windowMs:1000}});mode='hang';const response=await send();controller.abort(new Error('private reason'));await assert.rejects(response.text(),/s2a_cancelled/);await new Promise(r=>setTimeout(r,1100));assert.throws(()=>bridge.finish(),/s2a_cancelled/);assert.equal(received.length,1);`);
}, 30_000);

it("the exact old callStructured preserves its caller reason through the bridge", async () => {
  await pass("old-caller-cancel", `${install()}mode='sdk-hang';const {callStructured}=await bridge.load('llm');const controller=new AbortController(),reason=new Error('synthetic caller cancellation');const pending=callStructured({role:'analyzer',system:prompts.ANALYZER_SYSTEM,user:'synthetic',schema:schemas.AnalyzerOutputSchema,maxTokens:12000,signal:controller.signal});const result=assert.rejects(pending,error=>error===reason);while(received.length===0)await new Promise(r=>setTimeout(r,1));controller.abort(reason);await result;assert.equal(received.length,1);assert.throws(()=>bridge.finish());assert.ok(bridge.snapshot().failure);`);
}, 30_000);

it("completed transport keeps its success facts when idle or its old signal aborts", async () => {
  await pass("finished-idle", `const controller=new AbortController();bridge=await installOldHeadBridge({candidate,root,loopbackOrigin:origin,signal:controller.signal,syntheticLimits:{admissions:3,retries:2,windowMs:15000}});await(await send()).text();bridge.finish();controller.abort();await new Promise(r=>setTimeout(r,50));assert.equal(bridge.snapshot().failure,null);assert.equal(bridge.snapshot().attempts[0].complete,true);await assert.rejects(send(),/s2a_bridge_stopped/);assert.equal(received.length,1);`);
}, 30_000);

it("a 1MiB exact request is preserved; the next byte refuses before another send", async () => {
  await pass("request-boundary", `${install()}const body=JSON.parse(validBody());body.messages[0].content='';body.messages[0].content='x'.repeat(REQUEST_LIMIT-Buffer.byteLength(JSON.stringify(body)));let bytes=JSON.stringify(body);assert.equal(Buffer.byteLength(bytes),REQUEST_LIMIT);await(await send(bytes)).text();body.messages[0].content+='x';await assert.rejects(send(JSON.stringify(body)),/s2a_request_size_limit/);assert.equal(received.length,1);`);
}, 30_000);

it("the real task evidence directory cannot exceed 512MiB; capacity failure preserves partial facts", async () => {
  // Capacity instrumentation only: real HTTP/writes/file sizes/counter, fsync no-op.
  // Other cases retain real fsync; this case makes no durable-crash guarantee.
  await pass("task-capacity", `const fs=(await import('node:fs')).default;const {syncBuiltinESMExports}=await import('node:module');const original=fs.fsyncSync;fs.fsyncSync=()=>{};syncBuiltinESMExports();try{${install(100, 20, 60_000)}mode='capacity';const body=JSON.parse(validBody());body.messages[0].content='';body.messages[0].content='x'.repeat(REQUEST_LIMIT-Buffer.byteLength(JSON.stringify(body)));let failed=false;for(let i=0;i<100;i++){bridge.segment('s'+i);try{await(await send(JSON.stringify(body))).text();}catch(e){assert.match(e.message,/s2a_task_space_limit/);failed=true;break;}}assert.equal(failed,true);assert.throws(()=>bridge.finish(),/s2a_task_space_limit/);const total=readdirSync(root).reduce((sum,name)=>sum+fs.statSync(join(root,name)).size,0);assert.ok(total<=536870912);assert.equal(total,bridge.snapshot().file_bytes);assert.ok(received.length<100);}finally{fs.fsyncSync=original;syncBuiltinESMExports();}`);
}, 90_000);
