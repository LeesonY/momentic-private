import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { SecretVault, hashPayload } from '../../packages/storage/dist/index.js';
import { AuthStateService } from '../../packages/orchestrator/dist/auth-state-service.js';
const facts={rootIndependent:true,scope:'Actual AuthStateService importer reader and SecretVault crypto over explicitly synthetic query rows; no real PG/lease/permission/effect/browser claims',tests:[]};
function world(){
 const id=()=>randomUUID(),key=randomBytes(32),vault=new SecretVault(1,new Map([[1,key]]));
 const profile={id:id(),projectId:id(),version:1,allowedOrigins:['http://localhost:8181'],status:'active',mode:'form'};
 const run={id:id(),projectId:profile.projectId};
 const session={id:id(),project_id:profile.projectId,run_id:run.id,task_id:id(),worker_id:'root-crypto-worker',fencing_token:'7',context_version:1,context_id:id(),auth_profile_id:profile.id,auth_profile_version:1,auth_epoch:1,purpose:'initializer',status:'ended',end_reason:'auth_finished'};
 const job={id:session.task_id,document:{summary:'auth'},fencing_token:'7'};
 const grant={id:id(),status:'consumed',project_id:profile.projectId,run_id:run.id,task_id:job.id,auth_session_id:session.id,auth_epoch:1};
 const state={cookies:[{name:'root_cookie',value:'root-synthetic-cookie-value',domain:'localhost',path:'/'}],origins:[]};
 const envelope={projectId:profile.projectId,runId:run.id,contextVersion:1,contextId:session.context_id,profileId:profile.id,profileVersion:1,authEpoch:1,capturingSessionId:session.id,capturingTaskId:job.id,capturingWorkerId:session.worker_id,capturingFencingToken:7,capturingGrantId:grant.id,state};
 const stateId=id(),binding={projectId:profile.projectId,secretId:stateId,purpose:'run_auth_state'};
 const c=vault.encrypt(JSON.stringify(envelope),binding),h=vault.keyedHmac(hashPayload(state),'auth_state_capture');
 const row={id:stateId,project_id:profile.projectId,run_id:run.id,auth_profile_id:profile.id,auth_profile_version:1,context_version:1,capturing_context_id:session.context_id,capturing_session_id:session.id,capturing_task_id:job.id,capturing_worker_id:session.worker_id,capturing_fencing_token:'7',capturing_grant_id:grant.id,auth_epoch:1,status:'granted',ciphertext:c.ciphertext,nonce:c.nonce,auth_tag:c.authTag,key_version:c.keyVersion,state_hmac:h.hmac,hmac_key_version:h.keyVersion,origin_fingerprint:hashPayload(profile.allowedOrigins.map(x=>new URL(x).origin).sort()),captured_at:new Date()};
 const client={async query(sql){let value;if(sql.includes('FROM run_auth_states'))value=row;else if(sql.includes('FROM auth_execution_sessions'))value=session;else if(sql.includes('FROM jobs'))value=job;else if(sql.includes('FROM auth_capture_grants'))value=grant;else throw Error('Unexpected query in synthetic reader boundary');return {rows:[value]}}};
 let decrypts=0;const original=vault.decrypt;vault.decrypt=function(...a){decrypts++;return original.apply(this,a)};
 const coordinator={vault},service=new AuthStateService(coordinator),current={run,profile,epoch:1,contextVersion:1,stateId};
 return {vault,coordinator,service,client,current,row,session,job,grant,state,envelope,binding,key,decrypts:()=>decrypts};
}
async function check(name,fn){const w=world();try{await fn(w);facts.tests.push({name,passed:true})}catch(e){facts.tests.push({name,passed:false,code:e.code??'TEST_FAILED',message:e.message});process.exitCode=1}finally{w.coordinator.vault.dispose();if(w.vault!==w.coordinator.vault)w.vault.dispose()}}
const denied=w=>assert.rejects(()=>w.service.importState(w.client,w.current,true),e=>e.code==='AUTH_FAILED');
await check('Historical ended capture is validated with actual encryption and HMAC before returning synthetic state',async w=>{const result=await w.service.importState(w.client,w.current,true);assert.equal(result.cookies[0].value,w.state.cookies[0].value);assert.equal(w.decrypts(),1)});
await check('Fingerprint-only authority read decrypts zero material',async w=>{const fingerprint=await w.service.importState(w.client,w.current,false);assert.equal(fingerprint,hashPayload(w.row));assert.equal(w.decrypts(),0)});
await check('Wrong current epoch rejects before decryption',async w=>{w.current.epoch=2;await denied(w);assert.equal(w.decrypts(),0)});
await check('Revoked state and unconsumed capture do not produce material',async w=>{w.row.status='revoked';await denied(w);w.row.status='granted';w.grant.status='started';await denied(w);assert.equal(w.decrypts(),0)});
await check('Historical tuple mismatch is rejected before decryption',async w=>{w.session.worker_id='foreign-worker';await denied(w);assert.equal(w.decrypts(),0)});
await check('Consistent tampering of database historical columns is still rejected by the encrypted envelope',async w=>{w.row.capturing_worker_id='foreign-worker';w.session.worker_id='foreign-worker';await denied(w);assert.equal(w.decrypts(),1)});
await check('Ciphertext tampering cannot yield imported state',async w=>{w.row.ciphertext=Buffer.from(w.row.ciphertext);w.row.ciphertext[0]^=1;await denied(w)});
await check('Changed cookie value in a valid ciphertext is rejected by historical full-state HMAC',async w=>{w.envelope.state={cookies:[{...w.state.cookies[0],value:'changed-cookie-value'}],origins:[]};const cipher=w.vault.encrypt(JSON.stringify(w.envelope),w.binding);Object.assign(w.row,{ciphertext:cipher.ciphertext,nonce:cipher.nonce,auth_tag:cipher.authTag,key_version:cipher.keyVersion});await denied(w)});
await check('Encryption and HMAC historical key survive a real in-memory key-ring rotation',async w=>{const rotated=new SecretVault(2,new Map([[1,Buffer.from(w.key)],[2,randomBytes(32)]]));w.coordinator.vault=rotated;const result=await w.service.importState(w.client,w.current,true);assert.equal(result.cookies[0].value,w.state.cookies[0].value)});
await check('Replacing the historical key cannot validate the captured state',async w=>{w.coordinator.vault=new SecretVault(1,new Map([[1,randomBytes(32)]]));await denied(w)});
facts.summary={passed:facts.tests.filter(t=>t.passed).length,failed:facts.tests.filter(t=>!t.passed).length};facts.sourceSha256=Object.fromEntries(['../../packages/orchestrator/src/auth-state-service.ts','../../packages/orchestrator/src/auth-import-service.ts','../../packages/storage/src/crypto.ts'].map(path=>[path,createHash('sha256').update(readFileSync(new URL(path,import.meta.url))).digest('hex')]));
const report=new URL(`./T10-AUTH9-controller-crypto-${randomUUID()}.json`,import.meta.url);writeFileSync(report,JSON.stringify(facts,null,2)+'\n',{flag:'wx'});console.log(report.pathname);console.log(facts.summary);
