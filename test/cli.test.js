import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, cp, symlink, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('..', import.meta.url));
const preload = `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const file = process.env.PROBE_QUESTIONS;
const questions = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
globalThis.fetch = async (raw, init) => {
  if (process.env.PROBE_OFFLINE === 'yes') throw new Error('Offline command attempted a request');
  const url = new URL(raw);
  assert.equal(url.origin, 'https://api.pingroom.io');
  assert.equal(init.redirect, 'manual');
  if (init.method === 'GET' && url.pathname === '/api/agent/rooms') return Response.json([{ invite_code: 'DEMO12345678', type: 'standard', is_public: false, members: [{ user_id: '11111111-1111-4111-8111-111111111111' }] }]);
  if (init.method === 'POST' && url.pathname === '/api/agent/rooms/DEMO12345678/questions') {
    const body = JSON.parse(init.body), now = new Date().toISOString();
    assert.ok(body.options.length >= 3 && body.options.length <= 4); assert.equal(body.text_input, undefined);
    assert.equal(new Headers(init.headers).get('idempotency-key'), body.correlation_id);
    const id = '01990000-0000-7000-8000-' + String(Object.keys(questions).length + 1).padStart(12, '0');
    const q = { ...body, id, kind: 'question', is_handoff: false, resolution_policy: 'first', room_code: 'DEMO12345678', room: { code: 'DEMO12345678' },
      asker: { type: 'agent', id: '33333333-3333-4333-8333-333333333333' }, results: null, options: body.options.map(({value,label}) => ({value,label,primary:false,destructive:false})), text_input:null,
      state: 'pending', created_at: now, expires_at: new Date(Date.parse(now) + 900000).toISOString(), resolved_at: null, answer: null, reply_to: null };
    questions[id] = q; writeFileSync(file, JSON.stringify(questions));
    if (process.env.PROBE_LOST === 'yes') throw new Error('Lost creation response');
    return Response.json(q, { status: 201 });
  }
  if (init.method === 'GET' && url.pathname === '/api/agent/questions') return Response.json({questions:Object.values(questions)});
  if (init.method === 'GET' && url.pathname.startsWith('/api/agent/questions/')) {
    const q = questions[url.pathname.split('/').at(-1)];
    if (!q) throw new Error('Unexpected Question');
    if (process.env.PROBE_ANSWER !== undefined) {
      q.state = 'answered'; q.resolved_at = new Date().toISOString();
      q.answer = { value:process.env.PROBE_ANSWER, label:q.options.find(option => option.value === process.env.PROBE_ANSWER)?.label ?? null, text:null, responder:{id:q.target_user_id}, answered_at:q.resolved_at };
    } else if (process.env.PROBE_CANCEL === 'yes') { q.state = 'cancelled'; q.resolved_at = new Date().toISOString(); }
    writeFileSync(file, JSON.stringify(questions)); return Response.json(q);
  }
  throw new Error('Unexpected mocked request');
};
`;
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'version-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(source, 'src'), join(directory, 'src'), { recursive: true });
  await cp(join(source, 'package.json'), join(directory, 'package.json'));
  await cp(join(source, 'config.example.json'), join(directory, 'config.json'));
  await symlink(join(source, 'node_modules'), join(directory, 'node_modules'));
  await writeFile(join(directory, 'preload.mjs'), preload);
  await cp(join(source, 'examples/model.json'), join(directory, 'model.json'));
  return directory;
}
function run(directory, command = ['run'], extra = {}) {
  const env = { ...process.env, PINGROOM_TOKEN: 'offline-fixture', PINGROOM_ROOM: 'DEMO12345678', PROBE_QUESTIONS: join(directory, 'questions.json') };
  for (const key of ['NODE_OPTIONS','PROBE_ANSWER','PROBE_CANCEL','PROBE_LOST','PROBE_OFFLINE']) delete env[key];
  Object.assign(env,extra);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', join(directory, 'preload.mjs'), join(directory, 'src/cli.js'), ...command], { cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}
async function collect(directory, values) {
  let answer;
  for(const [i,value] of values.entries()) {
    const pending=await run(directory);assert.equal(pending.code,3,pending.stderr);assert.equal(JSON.parse(pending.stdout).status,'pending');
    answer=await run(directory,['run'],{PROBE_ANSWER:value});
    if(i<values.length-1)assert.ok([2,3].includes(answer.code),answer.stderr);
  }
  return answer;
}
test('CLI collects support and exports the coherent lock from another working directory', async t => {
  const directory=await fixture(t),validation=await run(directory,['validate'],{PROBE_OFFLINE:'yes'});assert.equal(validation.code,0,validation.stderr);assert.equal(JSON.parse(validation.stdout).tasks.length,4);assert.equal(JSON.parse(validation.stdout).catalogId,'paper-tools');
  const finished=await collect(directory,Array(4).fill('supported'));assert.equal(finished.code,0,finished.stderr);const result=JSON.parse(finished.stdout);assert.equal(result.status,'complete');assert.deepEqual(result.analysis.selection.map(row=>row.versionId),['v2','v2']);
  for(const command of ['status','report']){const local=await run(directory,[command],{PROBE_OFFLINE:'yes'});assert.equal(local.code,0,local.stderr);assert.deepEqual(JSON.parse(local.stdout).lockExport,result.lockExport);}
  const exported=await run(directory,['export-lock'],{PROBE_OFFLINE:'yes',PINGROOM_TOKEN:undefined,PINGROOM_ROOM:undefined});assert.equal(exported.code,0,exported.stderr);const artifact=JSON.parse(exported.stdout),path=join(directory,'.catalog/proposed-lock.json');assert.deepEqual(artifact,result.lockExport);assert.equal(artifact.packagesInstalled,false);assert.equal(artifact.registryQueried,false);
  assert.ok(artifact.answers.every(answer=>answer.questionId&&answer.responderId&&answer.askerId&&answer.answeredAt));const bytes=await readFile(path,'utf8');assert.deepEqual(JSON.parse(bytes),artifact);assert.equal((await stat(path)).mode&0o777,0o600);
  assert.equal((await run(directory,['export-lock'],{PROBE_OFFLINE:'yes'})).code,0);assert.equal(await readFile(path,'utf8'),bytes);assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,4);
});

test('CLI uncertain creation recovers the exact original Question without a duplicate', async t => {
  const directory=await fixture(t);assert.equal((await run(directory,['run'],{PROBE_LOST:'yes'})).code,4);assert.equal((await run(directory)).code,4);
  const found=await run(directory,['find']);assert.equal(found.code,4,found.stderr);const id=JSON.parse(found.stdout).candidates[0].id;
  const recovered=await run(directory,['recover',id],{PROBE_ANSWER:'supported'});assert.equal(recovered.code,3,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).status,'ready');
  assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);assert.equal((await run(directory,['recover','not-a-uuid'])).code,1);
});

test('CLI Unknown and malformed support buttons withhold complete analysis and proposed locks', async t => {
  for(const values of [['unknown','supported','supported','supported'],['invalid','supported','supported','supported']]){
    const directory=await fixture(t);assert.equal((await run(directory,['export-lock'],{PROBE_OFFLINE:'yes'})).code,1);const result=await collect(directory,values);assert.equal(result.code,2,result.stderr);const report=JSON.parse(result.stdout);assert.equal(report.status,'incomplete');assert.equal(report.lockExport,null);assert.equal(report.analysis,null);
    assert.equal((await run(directory,['export-lock'],{PROBE_OFFLINE:'yes'})).code,1);assert.equal((await run(directory,['export-analysis'],{PROBE_OFFLINE:'yes'})).code,1);await assert.rejects(readFile(join(directory,'.catalog/proposed-lock.json')),{code:'ENOENT'});
  }
});

test('CLI cancellation and malformed buttons retain original failed evidence', async t => {
  for(const extra of [{PROBE_CANCEL:'yes'},{PROBE_ANSWER:'SUPPORTED'},{PROBE_ANSWER:'supported\n'}]){
    const directory=await fixture(t);await run(directory);const result=await run(directory,['run'],extra);assert.equal(result.code,2,result.stderr);assert.equal(JSON.parse(result.stdout).status,'ready');assert.equal(JSON.parse(result.stdout).lockExport,null);assert.equal(Object.keys(JSON.parse(await readFile(join(directory,'questions.json'),'utf8'))).length,1);
  }
});

test('CLI all-unsupported evidence exports complete unsatisfiability and core witnesses without a lock', async t => {
  const directory=await fixture(t),finished=await collect(directory,Array(4).fill('unsupported'));assert.equal(finished.code,0,finished.stderr);const result=JSON.parse(finished.stdout);assert.equal(result.status,'complete');assert.equal(result.analysis.status,'unsatisfiable');assert.equal(result.lockExport,null);assert.ok(result.analysis.unsatCore.witnesses.length);
  const analysis=await run(directory,['export-analysis'],{PROBE_OFFLINE:'yes'});assert.equal(analysis.code,0,analysis.stderr);assert.deepEqual(JSON.parse(analysis.stdout).analysis,result.analysis);assert.deepEqual(JSON.parse(await readFile(join(directory,'.catalog/analysis.json'),'utf8')).analysis,result.analysis);
  assert.equal((await run(directory,['export-lock'],{PROBE_OFFLINE:'yes'})).code,1);await assert.rejects(readFile(join(directory,'.catalog/proposed-lock.json')),{code:'ENOENT'});assert.equal((await run(directory,['run'],{PROBE_OFFLINE:'yes'})).code,0);
});

test('CLI rejects changed target, duplicate ranks and arbitrary output paths', async t => {
  const directory=await fixture(t);await collect(directory,Array(4).fill('supported'));assert.equal((await run(directory,['export-lock','/etc/passwd'],{PROBE_OFFLINE:'yes'})).code,1);
  const input=JSON.parse(await readFile(join(directory,'model.json'),'utf8'));input.target='Different target';await writeFile(join(directory,'model.json'),JSON.stringify(input));assert.equal((await run(directory,['run'],{PROBE_OFFLINE:'yes'})).code,1);assert.equal((await run(directory,['export-lock'],{PROBE_OFFLINE:'yes'})).code,1);
  input.packages[0].versions[0].rank=2;await writeFile(join(directory,'model.json'),JSON.stringify(input));assert.equal((await run(directory,['validate'],{PROBE_OFFLINE:'yes'})).code,1);
});
