import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {step,exportAnalysis,exportLock} from './engine.js';
import {readJson} from './storage.js';
import {mockApi,CONFIG,ROOM_CODE} from './mock.js';

const input=await readJson(new URL('../examples/model.json',import.meta.url));
for(const [scenario,responses,expected,selected] of [
  ['preferred',Array(4).fill('supported'),'resolved',['v2','v2']],
  ['fallback',['supported','supported','supported','unsupported'],'resolved',['v1','v1']],
  ['unsatisfiable',Array(4).fill('unsupported'),'unsatisfiable',null],
  ['unknown',['unknown','supported','supported','supported'],null,null],
]){
  const directory=await mkdtemp(join(tmpdir(),'pingroom-version-demo-'));
  try{
    const now=()=>'2026-11-11T13:00:00.000Z',api=mockApi(now),options={client:api.client,directory,input,config:CONFIG,token:'offline-fixture-token',room:ROOM_CODE,now};let result;
    for(const choice of responses){result=await step(options);const pending=result.answers.find(row=>row.status==='pending');api.answer(pending.questionId,choice);result=await step(options);}
    assert.equal(result.analysis?.status??null,expected);assert.deepEqual(result.analysis?.selection?.map(row=>row.versionId)??null,selected);
    if(expected)await exportAnalysis(directory,input);else await assert.rejects(exportAnalysis(directory,input));
    if(expected==='resolved')await exportLock(directory,input);else await assert.rejects(exportLock(directory,input));
    assert.equal(api.calls.filter(row=>row.method==='POST').length,4);
    console.log(JSON.stringify({scenario,status:result.status,analysis:result.analysis,mockedQuestions:4,liveDeliveryTested:false},null,2));
  }finally{await rm(directory,{recursive:true,force:true});}
}
