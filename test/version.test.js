import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportLock, exportAnalysis } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, optionsFor, versionConstraints, analyzeCatalog, POLICY, POLICY_HASH, TOKEN, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/model.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-version-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later candidates; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), 'supported'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and non-handoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input = { max_length: 30 }; }, (q) => { q.options[0].primary = true; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { q.kind = 'poll'; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-button answers never establish support', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = 'left'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), 'supported'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.lockExport, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across candidates', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), 'supported'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).lockExport, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), 'supported');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), 'supported'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), 'supported'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), 'supported');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), 'supported'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).lockExport, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});
const choices = (input, values) => tasksFor(input).map((task,index) => ({candidateId:task.id,choice:values[index]}));
const allSupport = (input, value = true) => Object.fromEntries(tasksFor(input).map(task => [task.id,value]));
const tiny = () => ({catalogId:'test',title:'Finite catalog',context:'Internal test releases.',target:'Fixture target',packages:['a','b'].map(id => ({id,label:id,versions:[{id:'v1',label:'Release 1',rank:1},{id:'v2',label:'Release 2',rank:2}]})),dependencies:[]});

// Independent oracle: enumerate subsets of the flat candidate catalog and retain
// exactly one version per package; production uses a recursive Cartesian product.
function oracle(input, support, dependencies = input.dependencies) {
  const flat = input.packages.flatMap(pkg => pkg.versions.map(version => ({packageId:pkg.id,versionId:version.id,rank:version.rank}))), results = [];
  for (let bits = 0; bits < 2 ** flat.length; bits++) {
    const selected = flat.filter((_,index) => bits & (1 << index));
    if (input.packages.some(pkg => selected.filter(row => row.packageId === pkg.id).length !== 1)) continue;
    if (selected.some(row => !support[`${row.packageId}/${row.versionId}`])) continue;
    if (dependencies.some(dep => selected.some(row => row.packageId === dep.fromPackage && row.versionId === dep.fromVersion)
      && !selected.some(row => row.packageId === dep.toPackage && dep.allowedVersions.includes(row.versionId)))) continue;
    results.push(selected.sort((a,b) => a.packageId < b.packageId ? -1 : 1));
  }
  return results.sort((a,b) => { for (let i = 0; i < a.length; i++) if (a[i].rank !== b[i].rank) return b[i].rank-a[i].rank; return 0; });
}
function coreOracle(input, constraints) {
  const support = allSupport(input), dependencies = [];
  for (const constraint of constraints) {
    if (constraint.kind === 'unsupported') support[`${constraint.packageId}/${constraint.versionId}`] = false;
    else dependencies.push(constraint);
  }
  return oracle(input,support,dependencies);
}
function verifyCore(input, result) {
  assert.equal(result.unsatCore.minimality,'deletion-minimal; not minimum cardinality');
  const core = result.unsatCore.constraints; assert.equal(coreOracle(input,core).length,0);
  assert.equal(result.unsatCore.witnesses.length,core.length);
  for (const row of result.unsatCore.witnesses) {
    const remaining = core.filter(constraint => constraint.id !== row.removedConstraintId), possible = coreOracle(input,remaining);
    assert.ok(possible.length); assert.ok(possible.some(assignment => hash(assignment) === hash(row.assignment)));
    assert.deepEqual(row.satisfiedRemainingConstraintIds,remaining.map(constraint => constraint.id));
    assert.match(row.evaluatedAgainst,/remaining core only/);
  }
}

test('independent subset oracle agrees across all two-package guarded allowlists and support combinations', () => {
  let cases = 0, unsatisfiable = 0;
  for (let dependencyCode = 0; dependencyCode < 256; dependencyCode++) for (let supportBits = 0; supportBits < 16; supportBits++) {
    const input = tiny(); let code = dependencyCode;
    for (const [index,[fromPackage,fromVersion,toPackage]] of [['a','v1','b'],['a','v2','b'],['b','v1','a'],['b','v2','a']].entries()) {
      const allow = code % 4; code = Math.floor(code/4);
      if (allow) input.dependencies.push({id:`d${index}`,fromPackage,fromVersion,toPackage,allowedVersions:allow === 1 ? ['v1'] : allow === 2 ? ['v2'] : ['v1','v2']});
    }
    const support = Object.fromEntries(tasksFor(input).map((task,index) => [task.id,Boolean(supportBits & (1 << index))])), expected = oracle(input,support), actual = analyzeCatalog(input,support);
    assert.equal(actual.evaluatedAssignmentCount,4); assert.equal(actual.feasibleAssignmentCount,expected.length); assert.deepEqual(actual.selection,expected[0] ?? null);
    assert.equal(actual.status,expected.length ? 'resolved' : 'unsatisfiable');
    assert.deepEqual(actual.evaluations.filter(row => !row.violatedConstraintIds.length).map(row => row.assignment),expected);
    if (!expected.length) { verifyCore(input,actual); unsatisfiable++; }
    cases++;
  }
  assert.equal(cases,4096); assert.ok(unsatisfiable > 2000);
});

test('preference uses the highest lexicographic rank vector, never a global rank sum or version-name order', () => {
  const input = tiny(); input.packages[1].versions[0].rank = 0; input.packages[1].versions[1].rank = 999;
  input.dependencies = [{id:'requires-old',fromPackage:'a',fromVersion:'v2',toPackage:'b',allowedVersions:['v1']}];
  const result = analyzeCatalog(input,allSupport(input)); assert.deepEqual(result.selectedRankVector,[2,0]); assert.deepEqual(result.selection.map(row => row.versionId),['v2','v1']);
  assert.equal(result.feasibleAssignmentCount,3); assert.ok(result.evaluations.some(row => !row.violatedConstraintIds.length && row.assignment.reduce((sum,v) => sum+v.rank,0) === 1000));
});

test('dependency cycles are allowed and guards for unselected versions impose no requirement', () => {
  const input = tiny(); input.dependencies = [
    {id:'a-new',fromPackage:'a',fromVersion:'v2',toPackage:'b',allowedVersions:['v2']},
    {id:'b-new',fromPackage:'b',fromVersion:'v2',toPackage:'a',allowedVersions:['v2']},
  ];
  assert.deepEqual(analyzeCatalog(input,allSupport(input)).selection.map(row => row.versionId),['v2','v2']);
  const support = allSupport(input); support['a/v2'] = false; support['b/v2'] = false;
  assert.deepEqual(analyzeCatalog(input,support).selection.map(row => row.versionId),['v1','v1']);
  input.dependencies.push({id:'self-old',fromPackage:'a',fromVersion:'v1',toPackage:'a',allowedVersions:['v2']});
  const result = analyzeCatalog(input,support); assert.equal(result.status,'unsatisfiable'); verifyCore(input,result);
});

test('all unsupported candidates yield complete unsatisfiability with deletion witnesses, not incomplete evidence', () => {
  const input = simple(), result = versionConstraints(input,choices(input,Array(4).fill('unsupported')));
  assert.equal(result.status,'complete'); assert.equal(result.analysis.status,'unsatisfiable'); assert.equal(result.analysis.proposedLock,null); verifyCore(input,result.analysis);
  assert.ok(result.analysis.unsatCore.witnesses.some(row => {
    const original = result.analysis.constraints;
    return !coreOracle(input,original).some(assignment => hash(assignment) === hash(row.assignment));
  }));
});

test('every mandatory package is selected once and eight-candidate bounds include the maximal eighteen assignments', () => {
  const input = tiny(); input.packages = [3,3,2].map((size,index) => ({id:String.fromCharCode(97+index),label:`Package ${index}`,versions:Array.from({length:size},(_,i) => ({id:`v${i}`,label:`Release ${i}`,rank:i}))}));
  const result = analyzeCatalog(input,allSupport(input)); assert.equal(result.evaluatedAssignmentCount,18); assert.equal(result.feasibleAssignmentCount,18); assert.deepEqual(result.selection,oracle(input,allSupport(input))[0]);
  for (const row of result.evaluations) { assert.equal(row.assignment.length,3); assert.equal(new Set(row.assignment.map(version => version.packageId)).size,3); }
  const single = {...tiny(),packages:[{id:'a',label:'Single package',versions:[{id:'zero',label:'Rank zero',rank:0}]}]};
  assert.deepEqual(analyzeCatalog(single,allSupport(single)).selectedRankVector,[0]);
});

test('Unknown or missing judgments block all analysis, including unselected or already-excluded candidates', () => {
  for (let index = 0; index < 4; index++) for (const missing of [null,'unknown']) {
    const values = Array(4).fill('unsupported'); values[index] = missing;
    assert.deepEqual(versionConstraints(simple(),choices(simple(),values)),{status:'incomplete',analysis:null});
  }
  assert.throws(() => versionConstraints(simple(),choices(simple(),['Supported','supported','supported','supported'])));
});

test('catalog order, candidate order, dependency order and allowed-list order canonicalize without changing the result', () => {
  const input = tiny(); input.dependencies = [
    {id:'z',fromPackage:'a',fromVersion:'v1',toPackage:'b',allowedVersions:['v1','v2']},
    {id:'a',fromPackage:'b',fromVersion:'v2',toPackage:'a',allowedVersions:['v1','v2']},
  ];
  const shuffled = structuredClone(input); shuffled.packages.reverse(); for (const pkg of shuffled.packages) pkg.versions.reverse(); shuffled.dependencies.reverse(); for (const dep of shuffled.dependencies) dep.allowedVersions.reverse();
  assert.deepEqual(validateInput(input),validateInput(shuffled)); assert.deepEqual(tasksFor(input),tasksFor(shuffled)); assert.deepEqual(analyzeCatalog(input,allSupport(input)),analyzeCatalog(shuffled,allSupport(shuffled)));
});

test('exact schemas and bounds reject undeclared candidates, rank ties, duplicate rules and sparse inputs', () => {
  for (const mutate of [
    x => {x.extra=true;},x => {x.catalogId+='\n';},x => {x.title='\ud800';},x => {x.target='x\u2028y';},x => {x.packages=[];},x => {x.packages.push(x.packages[0]);},x => {delete x.packages[0];},
    x => {x.packages[0].id='constructor';},x => {x.packages[0].versions[0].rank=-0;},x => {x.packages[0].versions[0].rank=1000;},x => {x.packages[0].versions[0].rank=1.5;},x => {x.packages[0].versions[0].rank=2;},
    x => {x.packages[0].versions[1].id='v1';},x => {x.packages[0].versions[0].extra=1;},x => {delete x.packages[0].versions[0];},x => {x.packages[0].versions=[];},
    x => {x.dependencies[0].fromPackage='absent';},x => {x.dependencies[0].fromVersion='absent';},x => {x.dependencies[0].toPackage='absent';},x => {x.dependencies[0].allowedVersions=[];},
    x => {x.dependencies[0].allowedVersions=['absent'];},x => {x.dependencies[0].allowedVersions=['v2','v2'];},x => {delete x.dependencies[0].allowedVersions[0];},x => {x.dependencies.push({...x.dependencies[0],id:'other'});},x => {delete x.dependencies[0];},
  ]) {const input=simple();mutate(input);assert.throws(() => validateInput(input));}
  const tooMany=tiny();tooMany.packages[0].versions=Array.from({length:7},(_,i) => ({id:`v${i}`,label:'V',rank:i}));assert.throws(() => validateInput(tooMany),/eight/);
  const answer=choices(simple(),Array(4).fill('supported'));delete answer[1];assert.throws(() => versionConstraints(simple(),answer));
  for (const support of [{},{...allSupport(simple()),extra:true},{...allSupport(simple()),'editor/v1':'supported'}]) assert.throws(() => analyzeCatalog(simple(),support));
});

test('maximum prompts retain target, package and exact candidate meaning within the published SDK limit', () => {
  const input = {catalogId:'c'.repeat(32),title:'界'.repeat(32),context:'é'.repeat(60),target:'μ'.repeat(60),packages:[{id:'p'.repeat(12),label:'包'.repeat(40),versions:[{id:'v'.repeat(12),label:'版'.repeat(40),rank:999}]}],dependencies:[]};
  const task=tasksFor(input)[0], req=requestFor(input,CONFIG,task.id,id(99)); assert.ok(req.prompt.length<=500,req.prompt.length);
  for (const text of [input.context,input.target,task.packageId,task.packageLabel,task.versionId,task.versionLabel]) assert.ok(req.prompt.includes(text));
  assert.deepEqual(req.options.map(option => option.value),['supported','unsupported','unknown']);assert.equal(req.data.candidate_hash,hash(task));assert.equal(req.data.policy_hash,POLICY_HASH);
});

test('results and handoff fields accept documented absence while all noncanonical values are rejected', async t => {
  const accepted=await setup(t);await accepted.run();const q=accepted.api.questions.get(id(1));delete q.results;delete q.is_handoff;for (const option of q.options){delete option.primary;delete option.destructive;}
  assert.equal((await accepted.run()).status,'pending');accepted.api.answer(id(1),'supported');assert.equal((await accepted.run()).status,'ready');
  for (const [field,values] of [['results',[{},[],false,0]],['is_handoff',[true,null,0,'false']]]) for (const value of values) {const s=await setup(t);await s.run();s.api.questions.get(id(1))[field]=value;await assert.rejects(s.run(),/does not match/);}
  for (const field of ['primary','destructive']) for (const value of [true,null,0,'false']) {const s=await setup(t);await s.run();s.api.questions.get(id(1)).options[0][field]=value;await assert.rejects(s.run(),/does not match/);}
});

test('SDK support evidence exports a source-bound proposed lock privately and offline', async t => {
  const s=await setup(t),result=await decide(s,Array(4).fill('supported'));assert.equal(result.status,'complete');assert.equal(result.analysis.status,'resolved');assert.deepEqual(result.analysis.selection.map(row => row.versionId),['v2','v2']);
  assert.ok(result.answers.every(row => row.responderId===CONFIG.participant.id && row.askerId===ASKER && row.candidateHash && row.answeredAt));
  const calls=s.api.calls.length;assert.deepEqual(await exportLock(s.directory,simple()),result.lockExport);assert.deepEqual((await exportAnalysis(s.directory,simple())).analysis,result.analysis);assert.equal(s.api.calls.length,calls);assert.equal(sends(s.api),4);
  assert.equal((await stat(join(s.directory,'proposed-lock.json'))).mode & 0o777,0o600);assert.equal(result.packagesInstalled,false);assert.equal(result.registryQueried,false);
  assert.equal(result.analysis.proposedLock.sourceHash,hash(validateInput(simple())));assert.equal(result.analysis.proposedLock.policyHash,POLICY_HASH);
  const release=await acquireLock(s.directory);await assert.rejects(exportLock(s.directory,simple()),/lock exists/);await release();
});

test('complete unsatisfiability exports its negative analysis and witnesses but refuses a lock', async t => {
  const s=await setup(t),result=await decide(s,Array(4).fill('unsupported'));assert.equal(result.status,'complete');assert.equal(result.analysis.status,'unsatisfiable');assert.equal(result.lockExport,null);verifyCore(simple(),result.analysis);
  assert.equal((await exportAnalysis(s.directory,simple())).analysis.status,'unsatisfiable');await assert.rejects(exportLock(s.directory,simple()),/coherent supported/);assert.equal(await readJson(join(s.directory,'proposed-lock.json')),null);
});

test('Unknown and malformed SDK support evidence withhold the whole analysis', async t => {
  for (const first of ['unknown','invalid']) {const s=await setup(t),result=await decide(s,[first,'supported','supported','supported']);assert.equal(result.status,'incomplete');assert.equal(result.analysis,null);await assert.rejects(exportAnalysis(s.directory,simple()));await assert.rejects(exportLock(s.directory,simple()));}
});

test('catalog, target, rank, dependencies and saved answers remain bound before requests or exports', async t => {
  const s=await setup(t);await decide(s,Array(4).fill('supported'));const original=await s.saved(),calls=s.api.calls.length;
  for (const mutate of [x=>{x.target='Other target';},x=>{x.packages[0].label='Other meaning';},x=>{x.packages[0].versions[0].rank=10;},x=>{x.dependencies[0].allowedVersions=['v1'];}]){const input=simple();mutate(input);await assert.rejects(s.run({input}));await assert.rejects(exportAnalysis(s.directory,input));}
  for (const mutate of [x=>{x.attempts[0].observation.answer.value='unsupported';},x=>{x.attempts[0].observation.answer.label='Other';},x=>{x.attempts[0].request.data.policy_hash=hash({});}]){const saved=structuredClone(original);mutate(saved);await atomicJson(s.directory,'state.json',saved);await assert.rejects(s.run());await assert.rejects(exportLock(s.directory,simple()));}
  await atomicJson(s.directory,'state.json',original);await assert.rejects(s.run({token:'other'}));await assert.rejects(s.run({config:{participant:{id:OTHER,label:'Other'}}}));assert.equal(s.api.calls.length,calls);
});

test('independent oracle checks every assignment for all 162 bounded package-size shapes, including cyclic guards', () => {
  let shapes=0;
  function check(sizes) {
    const input={...tiny(),packages:sizes.map((size,index)=>({id:String.fromCharCode(97+index),label:`Package ${index}`,versions:Array.from({length:size},(_,rank)=>({id:`v${rank}`,label:`Version ${rank}`,rank}))}))};
    for (const guarded of [false,true]) {
      input.dependencies=guarded?input.packages.map((pkg,index)=>({id:`d${index}`,fromPackage:pkg.id,fromVersion:pkg.versions.at(-1).id,toPackage:input.packages[(index+1)%input.packages.length].id,allowedVersions:['v0']})):[];
      const support=allSupport(input),actual=analyzeCatalog(input,support),expected=oracle(input,support);
      assert.equal(actual.evaluatedAssignmentCount,sizes.reduce((product,size)=>product*size,1));assert.deepEqual(actual.evaluations.filter(row=>!row.violatedConstraintIds.length).map(row=>row.assignment),expected);assert.deepEqual(actual.selection,expected[0]??null);
      if(!expected.length)verifyCore(input,actual);
    }
    shapes++;
  }
  function sizes(prefix,remaining,left){if(!left){check(prefix);return;}for(let size=1;size<=remaining-left+1;size++)sizes([...prefix,size],remaining-size,left-1);}
  for(let packages=1;packages<=4;packages++)sizes([],8,packages);
  assert.equal(shapes,162);
});
