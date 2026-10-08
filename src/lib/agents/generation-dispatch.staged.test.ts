import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialize, openLedger } from "../../../ops/maintenance/ledger.mjs";
import { initializeWriters, openWriters } from "../../../ops/maintenance/writers.mjs";
import { initializeStagedTerminal } from "../../../ops/maintenance/staged-terminal.mjs";
import { openDb, type DB } from "../db/index.js";
import { applyProvenanceMigrations } from "../db/provenance-migrations.js";
import { createDeepDiveTraceRequest } from "../db/provenance.js";
import * as provenance from "../db/provenance.js";
import { finishRun, insertRun, insertTopic } from "../db/repos.js";
import { beginModelUsageAttempt, observeModelUsage } from "../db/model-usage.js";
import { appendGenerationEvent } from "../db/provenance-facts.js";
import { openTerminalDispatchDriver } from "../runtime/terminal-dispatch-driver.js";
import { TaskCancellationError } from "../runtime/cancellation.js";
import { TaskBudgetError } from "../runtime/task-budget.js";
import type { FixedTerminalDispatchDriver, StagedTerminalWriterAdmission } from "../runtime/writer-admission.js";
import { runGenerationDispatchOnce } from "./generation-dispatch.js";

describe("explicit staged terminal consumes real core claim and keeps old profiles separate", () => {
 let root: string, db: DB, driver: FixedTerminalDispatchDriver, writers: ReturnType<typeof openWriters>, admission: StagedTerminalWriterAdmission;
 let target: { region: string; instanceId: string; volumeId: string; dataPath: string; serviceSet: string[] };
 beforeEach(() => {
  vi.stubEnv("COST_LIMIT_TASK", undefined);
  root=realpathSync(mkdtempSync(join(tmpdir(), "insight-a3-staged-core-")));chmodSync(root,0o700);
  const { publicKey }=generateKeyPairSync("ed25519");target={region:"isolated",instanceId:"fixture-app",volumeId:"fixture-data",dataPath:root,serviceSet:["app"]};
  initialize(root,{target,approverId:"fixture-reviewer",publicKey:publicKey.export({type:"spki",format:"pem"})});initializeWriters(root);
  const path=join(root,"fixture-business.sqlite"),seed=openDb(path);chmodSync(path,0o600);applyProvenanceMigrations(seed);
  insertTopic(seed,{id:"topic_a",name:"Topic A",keywords:[],language:"en",brief_schedule:"daily",enabled:true,archetype:"deep_vertical",facets:[]});
  createDeepDiveTraceRequest(seed,{topicId:"topic_a",idempotencyKeyHash:"a".repeat(64),planning:true});seed.pragma("wal_checkpoint(TRUNCATE)");seed.close();
  driver=openTerminalDispatchDriver(root);db=driver.db;initializeStagedTerminal(root);writers=openWriters(root);admission=writers.registerStagedTerminal("core-stage",db,driver).admission;
 });
 afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();if(db.open)driver.close();writers.close();rmSync(root,{recursive:true});});
 const facts=()=>["generation_dispatch","generation_lease","run","generation_event"].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
 function revoke() {
  const control=writers.stagedTerminalControl();let token=control.closeAdmission(control.inspect().token!);
  const ledger=openLedger(root);
  try { const held=ledger.hold(ledger.acquire({operationId:"op-stage",ownerId:"controller",kind:"backup",target,executionIdentity:"fixture-controller"}),"writer_drain_coverage_unknown");token=control.bindDrain(token,held);control.revoke(token,held,"staged_terminal_manual_block"); }
  finally {ledger.close();}
 }
 function published(runDb: DB, traceId: string, rootRunId: string) {
  runDb.prepare("UPDATE run SET status='done' WHERE id=?").run(rootRunId);
  appendGenerationEvent(runDb,{trace_id:traceId,stage:"select",event_type:"completed"});
  appendGenerationEvent(runDb,{trace_id:traceId,run_id:rootRunId,stage:"analyze",event_type:"started",version_context:{analyzer_model:"test-analyzer",analyzer_prompt_hash:"a".repeat(64),analyzer_output_version:"v1",analyzer_cache_mode:"off"},context_completeness:"complete"});
  appendGenerationEvent(runDb,{trace_id:traceId,run_id:rootRunId,stage:"analyze",event_type:"completed"});
  for(const [id,kind,stage] of [["validate_run","validate","validate"],["report_run","report-gen","generate_report"]] as const) {
   insertRun(runDb,{id,kind,target:{},status:"running",started_at:new Date().toISOString(),ended_at:null,duration_ms:null,cost:null,error:null,retry_of:null,trace_id:traceId});
   appendGenerationEvent(runDb,{trace_id:traceId,run_id:id,stage,event_type:"completed"});finishRun(runDb,id,{status:"done",duration_ms:1});
  }
 }
 it("real immutable claim bound before execute and admit precedes root run creation",async()=>{
  const bind=vi.fn(admission.bindClaim);
  const result=await runGenerationDispatchOnce(db,async(_d,_t,opts)=>{expect(bind).toHaveBeenCalledOnce();expect(bind.mock.calls[0][1]).toMatchObject({traceId:opts.traceId,rootRunId:opts.rootRunId});expect(writers.stagedTerminalControl().inspect().tasks).toHaveLength(1);throw new Error("controlled failure");},{stagedTerminalWriterAdmission:{...admission,bindClaim:bind}});
  expect(result).toMatchObject({status:"failed",stagedTerminalCommit:{kind:"committed",businessCommit:"committed"}});expect(result).not.toHaveProperty("terminalCommit");
  expect(writers.stagedTerminalControl().inspect()).toMatchObject({completions:[{outcome:"failed"}],writer_quiescence:false,drain_ready:false,production_permitted:false});
 });
 it.each(["done","failed"])("cooperative close permits late %s; strict profile remains independently tested",async mode=>{
  const result=await runGenerationDispatchOnce(db,async(d,_t,opts)=>{const control=writers.stagedTerminalControl();control.closeAdmission(control.inspect().token!);if(mode==="failed")throw new Error("controlled failure");published(d,opts.traceId!,opts.rootRunId!);},{stagedTerminalWriterAdmission:admission});
  expect(result).toMatchObject({status:mode,stagedTerminalCommit:{kind:"committed",businessCommit:"committed"}});expect(db.prepare("SELECT state FROM generation_lease").get()).toEqual({state:"released"});
 });
 it.each(["done","failed"])("explicit durable revoke refuses late %s and leaves actual business facts unchanged",async mode=>{
  let before: ReturnType<typeof facts>;
  const result=await runGenerationDispatchOnce(db,async()=>{revoke();before=facts();if(mode==="failed")throw new Error("controlled failure");},{stagedTerminalWriterAdmission:admission});
  expect(result).toMatchObject({status:"failed",stagedTerminalCommit:{kind:"not_committed",code:"staged_terminal_revoked"}});expect(facts()).toEqual(before!);expect(writers.stagedTerminalControl().inspect().stage.terminal).toBe("revoked");
 });
 it("actual ATTACH after factory/admission construction refuses before tasks, claim, execute",async()=>{
  const before=facts(),execute=vi.fn();db.exec("ATTACH ':memory:' AS extra");await expect(runGenerationDispatchOnce(db,execute,{stagedTerminalWriterAdmission:admission})).rejects.toThrow("staged_terminal_business_mismatch");expect(execute).not.toHaveBeenCalled();expect(writers.stagedTerminalControl().inspect().tasks).toEqual([]);expect(facts()).toEqual(before);expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({state:"queued"});
 });
 it("foreign core connection, absent bridge, wrong profile and mixed profiles fail before admission",async()=>{
  const foreign=openDb(":memory:"),execute=vi.fn();try{await expect(runGenerationDispatchOnce(foreign,execute,{stagedTerminalWriterAdmission:admission})).rejects.toThrow("staged_terminal_business_mismatch");}finally{foreign.close();}
  for(const bad of [{...admission,version:"wrong"},{...admission,[Symbol.for("insight-agent.a3-staged-terminal-admission-v1")]:undefined}])await expect(runGenerationDispatchOnce(db,execute,{stagedTerminalWriterAdmission:bad as StagedTerminalWriterAdmission})).rejects.toThrow("staged_terminal_business_mismatch");
  const legacy=writers.admissionFor(writers.register("legacy","generation-dispatch"));await expect(runGenerationDispatchOnce(db,execute,{writerAdmission:legacy,stagedTerminalWriterAdmission:admission})).rejects.toThrow("staged_terminal_business_mismatch");expect(execute).not.toHaveBeenCalled();expect(writers.inspect().tasks).toEqual([]);
 });
 it.each(["usage_persistence_failed","task_budget_exceeded"])("first cancellation outranks later %s",async later=>{
  const controller=new AbortController(),attempt=vi.fn(admission.commitOutcome);
  const result=await runGenerationDispatchOnce(db,async()=>{controller.abort(new TaskCancellationError("cancelled"));throw later==="task_budget_exceeded"?new TaskBudgetError("task_budget_exceeded"):new Error(later);},{signal:controller.signal,stagedTerminalWriterAdmission:{...admission,commitOutcome:attempt}});
  expect(attempt).toHaveBeenCalledOnce();expect(attempt.mock.calls[0][2].error?.reason_code).toBe("cancelled");expect(result.stagedTerminalCommit?.kind).toBe("committed");
 });
 it("lease loss outranks cancellation and budget without terminal or unguarded failure writes",async()=>{
  const controller=new AbortController(),attempt=vi.fn(admission.commitOutcome);
  const result=await runGenerationDispatchOnce(db,async()=>{controller.abort(new TaskCancellationError("cancelled"));db.exec("UPDATE generation_lease SET owner_token='other-owner'");throw new TaskBudgetError("task_budget_exceeded");},{signal:controller.signal,stagedTerminalWriterAdmission:{...admission,commitOutcome:attempt}});
  expect(result).toMatchObject({status:"failed"});expect(result).not.toHaveProperty("stagedTerminalCommit");expect(attempt).not.toHaveBeenCalled();expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({state:"claimed"});
 });
 it.each(["deny","throw"])("terminal done %s never retries failed",async mode=>{
  const attempt=vi.fn(()=>{if(mode==="throw")throw new Error("private control cut");return {kind:"not_committed" as const,businessCommit:"not_committed" as const,code:"staged_terminal_revoked" as const};});
  const result=await runGenerationDispatchOnce(db,async()=>{},{stagedTerminalWriterAdmission:{...admission,commitOutcome:attempt}});expect(attempt).toHaveBeenCalledOnce();expect(result.status).toBe("failed");expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({state:"claimed"});expect(result.stagedTerminalCommit?.kind).toBe(mode==="deny"?"not_committed":"unknown");
 });
 it("post-COMMIT trace read failure retains known business COMMIT without failed fallback",async()=>{
  vi.spyOn(provenance,"getGenerationTraceStatus").mockImplementation(()=>{throw new Error("private post-read cut");});const attempt=vi.fn(admission.commitOutcome);
  const result=await runGenerationDispatchOnce(db,async()=>{},{stagedTerminalWriterAdmission:{...admission,commitOutcome:attempt}});expect(attempt).toHaveBeenCalledOnce();expect(result).toMatchObject({status:"failed",stagedTerminalCommit:{kind:"committed",businessCommit:"committed"}});expect(db.prepare("SELECT count(*) AS n FROM generation_event WHERE event_type='failed'").get()).toEqual({n:0});
 });
 it("business COMMIT then registry loss/local finish failure preserves truth and unfinished task",async()=>{
  const exec=db.exec.bind(db);db.exec=sql=>{const result=exec(sql);if(sql==="COMMIT")writers.close();return result;};
  const attempt=vi.fn(admission.commitOutcome),result=await runGenerationDispatchOnce(db,async()=>{throw new Error("controlled failure");},{stagedTerminalWriterAdmission:{...admission,commitOutcome:attempt}});db.exec=exec;
  expect(attempt).toHaveBeenCalledOnce();expect(result).toMatchObject({status:"failed",stagedTerminalCommit:{kind:"unknown",businessCommit:"committed",code:"staged_terminal_gate_commit_unknown"}});
  const fresh=openWriters(root);try{expect(fresh.stagedTerminalControl().inspect().completions).toEqual([]);expect(fresh.inspect().tasks[0].outcome).toBeNull();}finally{fresh.close();}expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({state:"failed"});
 });
 it("pre-cancel creates only local completion, no claim/attempt/diagnostic; no terminal fact does not hide finish failure",async()=>{
  const controller=new AbortController();controller.abort(new TaskCancellationError("cancelled"));const execute=vi.fn();expect(await runGenerationDispatchOnce(db,execute,{signal:controller.signal,stagedTerminalWriterAdmission:admission})).toEqual({claimed:false});expect(execute).not.toHaveBeenCalled();expect(writers.stagedTerminalControl().inspect().attempts).toEqual([]);
  await expect(runGenerationDispatchOnce(db,execute,{signal:controller.signal,stagedTerminalWriterAdmission:{...admission,finish:()=>{throw new Error("private finish cut");}}})).rejects.toThrow("private finish cut");expect(db.prepare("SELECT state FROM generation_dispatch").get()).toEqual({state:"queued"});
 });
 it("bind denial before execution never creates terminal fallback",async()=>{
  const attempt=vi.fn(admission.commitOutcome),execute=vi.fn();const result=await runGenerationDispatchOnce(db,execute,{stagedTerminalWriterAdmission:{...admission,bindClaim:()=>{throw new Error("private bind refusal");},commitOutcome:attempt}});expect(result).toEqual({claimed:true,traceId:expect.any(String),status:"failed"});expect(execute).not.toHaveBeenCalled();expect(attempt).not.toHaveBeenCalled();expect(writers.stagedTerminalControl().inspect().claims).toEqual([]);
 });
 it("outside staged terminal, real C3 late usage writer remains uncovered, so all readiness stays false",async()=>{
  await runGenerationDispatchOnce(db,async(_d,_t,opts)=>{revoke();beginModelUsageAttempt(db,{attempt_id:"uncovered",logical_call_id:"uncovered-logical",attempt_number:1,run_id:opts.rootRunId!,trace_id:opts.traceId!,role:"analyzer",provider:"anthropic",model:"synthetic-unpriced",started_at:new Date().toISOString()},opts.assertWrite);observeModelUsage(db,"uncovered",{observation_number:1,final:false,usage:{input_tokens:1,output_tokens:null,cache_creation_input_tokens:null,cache_read_input_tokens:null}},opts.assertWrite);},{stagedTerminalWriterAdmission:admission});expect(db.prepare("SELECT usage_status FROM model_usage_attempt").get()).toEqual({usage_status:"partial"});expect(writers.stagedTerminalControl().inspect()).toMatchObject({writer_quiescence:false,drain_ready:false,production_permitted:false,process_termination:"unknown"});
 });
});
