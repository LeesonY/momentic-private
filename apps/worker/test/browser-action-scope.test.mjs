import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from '../dist/index.js';

test('failed explorer browser action ends only the child job, not the whole run',async()=>{
  const ids={project:randomUUID(),run:randomUUID(),task:randomUUID(),context:randomUUID()};
  const scratch=mkdtempSync(join(tmpdir(),'localqa-scoped-browser-'));
  const calls=[];
  const runtime={
    async claim(){return {task:{id:ids.task,role:'explorer'},fencingToken:1,leaseToken:'fake',contextVersion:1}},
    async work(){return {
      stage:'explore',
      task:{id:ids.task,role:'explorer'},
      targetUrl:'http://fixture.local/',
      contextId:ids.context,
      run:{projectId:ids.project,id:ids.run,executionMode:'smoke',
        effectiveConfig:{authProfileVersion:null,actionPolicy:'non_submitting',
          allowedOrigins:['http://fixture.local'],budget:{maxActionsPerCase:1,maxPages:2,maxDepth:1}}}
    }},
    async requireAnonymousOrInput(){return true},
    async grant(){calls.push('grant');return {step:{id:randomUUID()}}},
    async record(_proof,_grant,status){calls.push('record:'+status)},
    async finish(_proof,result){calls.push(result)},
    async stop(){calls.push('STOP_RUN');throw new Error('unexpected run termination')},
    async heartbeat(){return {contextVersion:1,cancelRequested:false}}
  };
  const browser={async createSession(){return {
    id:ids.context,activePageId:randomUUID(),getPageById(){return undefined},
    async executeTool(){return {status:'failed',reasonCode:'TARGET_NOT_FOUND',data:null}},
    async close(){calls.push('close')}
  }}};
  try {
    const worker=new Worker({runtime,browser,scratch,heartbeatMs:10000});
    assert.equal(await worker.once(),true);
    assert.deepEqual(calls.filter(x=>typeof x==='string'),['grant','record:failed','close']);
    const settled=calls.find(x=>x&&typeof x==='object');
    assert.equal(settled.stage,'explore');
    assert.equal(settled.browserFailureCode,'TARGET_NOT_FOUND');
    assert.ok(!calls.includes('STOP_RUN'));
  } finally {rmSync(scratch,{recursive:true,force:true})}
});
