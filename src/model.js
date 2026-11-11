import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const TOKEN = /^[^\s\x00-\x1f\x7f]{1,8192}(?![\s\S])/;
export const ROOM = /^[A-Z0-9]{12}$(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\s\S])/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,39}$(?![\s\S])/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && value.isWellFormed()
  && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$(?![\s\S])/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const POLICY = Object.freeze({ algorithm: 'finite-mandatory-package-assignment-v1', preference: 'descending-rank-vector-in-ascii-package-order-v1', unknown: 'all-candidates-required-v1', core: 'deletion-minimal-with-core-only-witnesses-v1' });
export const POLICY_HASH = hash(POLICY);
const safeId = value => word(value) && value.length <= 12 && !['constructor', 'prototype', '__proto__'].includes(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const candidateId = (packageId, versionId) => `${packageId}/${versionId}`;
const tasksFrom = input => input.packages.flatMap(pkg => pkg.versions.map(version => ({ id: candidateId(pkg.id, version.id), packageId: pkg.id, packageLabel: pkg.label, versionId: version.id, versionLabel: version.label, rank: version.rank })));
const promptFor = (input, task) => `${input.title}\nCatalog ${input.catalogId}: ${input.context}\nTarget: ${input.target}\nPackage [${task.packageId}] ${task.packageLabel}\nCandidate [${task.versionId}] ${task.versionLabel}\nSupported on this exact target? Supported=yes; Unsupported=no; Unknown=not established. Judge target support only; code checks declared dependencies.`;
export function validateInput(input) {
  if (!keys(input, ['catalogId', 'title', 'context', 'target', 'packages', 'dependencies']) || !word(input.catalogId) || input.catalogId.length > 32
    || !line(input.title, 32) || !line(input.context, 60) || !line(input.target, 60) || !Array.isArray(input.packages) || input.packages.length < 1 || input.packages.length > 4
    || !Array.isArray(input.dependencies) || input.dependencies.length > 12) throw new Error('Provide catalog context, target, 1–4 mandatory packages and at most 12 dependencies.');
  const packageIds = new Set(); let count = 0;
  for (const pkg of input.packages) {
    if (!keys(pkg, ['id', 'label', 'versions']) || !safeId(pkg.id) || packageIds.has(pkg.id) || !line(pkg.label, 40) || !Array.isArray(pkg.versions) || pkg.versions.length < 1 || pkg.versions.length > 8) throw new Error('Packages require unique safe IDs, labels and 1–8 versions.');
    packageIds.add(pkg.id); const ids = new Set(), ranks = new Set();
    for (const version of pkg.versions) {
      if (!keys(version, ['id', 'label', 'rank']) || !safeId(version.id) || ids.has(version.id) || !line(version.label, 40)
        || !Number.isSafeInteger(version.rank) || version.rank < 0 || version.rank > 999 || Object.is(version.rank, -0) || ranks.has(version.rank)) throw new Error('Versions require unique safe IDs and distinct integer ranks 0..999 within each package.');
      ids.add(version.id); ranks.add(version.rank); count++;
    }
  }
  if (count > 8) throw new Error('The entire catalog may contain at most eight candidate versions.');
  const dependencyIds = new Set(), guards = new Set();
  for (const dependency of input.dependencies) {
    if (!keys(dependency, ['id', 'fromPackage', 'fromVersion', 'toPackage', 'allowedVersions']) || !safeId(dependency.id) || dependencyIds.has(dependency.id)
      || !packageIds.has(dependency.fromPackage) || !packageIds.has(dependency.toPackage) || !Array.isArray(dependency.allowedVersions) || dependency.allowedVersions.length < 1 || dependency.allowedVersions.length > 8) throw new Error('Dependencies require unique IDs, known source/target packages and a nonempty allowed-version list.');
    const source = input.packages.find(pkg => pkg.id === dependency.fromPackage), target = input.packages.find(pkg => pkg.id === dependency.toPackage);
    const guard = `${dependency.fromPackage}/${dependency.fromVersion}/${dependency.toPackage}`;
    if (!source.versions.some(version => version.id === dependency.fromVersion) || new Set(dependency.allowedVersions).size !== dependency.allowedVersions.length
      || Array.from(dependency.allowedVersions).some(id => !target.versions.some(version => version.id === id)) || guards.has(guard)) throw new Error('Dependency versions must exist; duplicate allowed versions or repeated source-version/target rules are rejected.');
    dependencyIds.add(dependency.id); guards.add(guard);
  }
  const result = structuredClone(input); result.packages.sort((a,b) => compare(a.id,b.id));
  for (const pkg of result.packages) pkg.versions.sort((a,b) => compare(a.id,b.id));
  result.dependencies.sort((a,b) => compare(a.id,b.id)); for (const dependency of result.dependencies) dependency.allowedVersions.sort(compare);
  if (tasksFrom(result).some(task => promptFor(result,task).length > 500)) throw new Error('Full candidate prompt exceeds 500 characters.');
  return result;
}
export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label']) || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact release owner UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => tasksFrom(validateInput(input));
export const optionsFor = () => [['supported','Supported'],['unsupported','Unsupported'],['unknown','Unknown']].map(([value,label]) => ({value,label,style:'default'}));
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), task = tasksFor(input).find(row => row.id === taskId); validateConfig(config);
  if (!task || !isId(attemptId)) throw new Error('Invalid candidate or attempt.');
  const key = `versions-${attemptId}`;
  return { prompt: promptFor(input,task), context: `To ${config.participant.id}`, options: optionsFor(), responder_scope:'direct', target_user_id:config.participant.id, ttl:TTL, correlation_id:key,
    data:{input_hash:hash(input),candidate_hash:hash(task),policy_hash:POLICY_HASH,task_id:taskId,attempt_id:attemptId}, idempotencyKey:key };
}

/** The recursive product contains exactly one candidate for every package. */
function enumerate(input) {
  const assignments = [];
  function visit(index, selected) {
    if (index === input.packages.length) { assignments.push(selected.map(row => ({...row}))); return; }
    const pkg = input.packages[index];
    for (const version of [...pkg.versions].sort((a,b) => b.rank - a.rank)) {
      selected.push({packageId:pkg.id,versionId:version.id,rank:version.rank}); visit(index+1,selected); selected.pop();
    }
  }
  visit(0,[]); return assignments;
}
function violates(assignment, constraint) {
  const selected = id => assignment.find(row => row.packageId === id).versionId;
  return constraint.kind === 'unsupported' ? selected(constraint.packageId) === constraint.versionId
    : selected(constraint.fromPackage) === constraint.fromVersion && !constraint.allowedVersions.includes(selected(constraint.toPackage));
}
export function analyzeCatalog(rawInput, support) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(support,tasks.map(row => row.id)) || Object.values(support).some(value => typeof value !== 'boolean')) throw new Error('Every catalog candidate requires a known supported or unsupported judgment.');
  const constraints = [
    ...tasks.filter(task => !support[task.id]).map(task => ({id:`unsupported:${task.id}`,kind:'unsupported',packageId:task.packageId,versionId:task.versionId})),
    ...input.dependencies.map(dependency => ({...dependency,id:`dependency:${dependency.id}`,kind:'dependency'})),
  ].sort((a,b) => compare(a.id,b.id));
  const assignments = enumerate(input), evaluations = assignments.map(assignment => ({assignment,violatedConstraintIds:constraints.filter(constraint => violates(assignment,constraint)).map(constraint => constraint.id)}));
  const feasible = evaluations.filter(row => row.violatedConstraintIds.length === 0), selection = feasible[0]?.assignment ?? null;
  let unsatCore = null;
  if (!selection) {
    let core = [...constraints];
    const witness = remaining => assignments.find(assignment => remaining.every(constraint => !violates(assignment,constraint)));
    for (const constraint of constraints) {
      const remaining = core.filter(row => row.id !== constraint.id);
      if (!witness(remaining)) core = remaining;
    }
    unsatCore = { constraints:core, background:'exactly one candidate from each mandatory package', minimality:'deletion-minimal; not minimum cardinality',
      witnesses:core.map(constraint => { const remaining = core.filter(row => row.id !== constraint.id); return {removedConstraintId:constraint.id,assignment:witness(remaining),satisfiedRemainingConstraintIds:remaining.map(row => row.id),evaluatedAgainst:'remaining core only; omitted original constraints may fail'}; }) };
  }
  const proposedLock = selection ? {schema:'pingroom-finite-catalog-lock-v1',catalogId:input.catalogId,target:input.target,sourceHash:hash(input),policyHash:POLICY_HASH,packages:selection} : null;
  const result = {status:selection ? 'resolved' : 'unsatisfiable',packageOrder:input.packages.map(pkg => pkg.id),preference:'highest rank vector lexicographically in ASCII package-ID order; ranks are distinct per package',
    selectedRankVector:selection?.map(row => row.rank) ?? null,selection,proposedLock,feasibleAssignmentCount:feasible.length,evaluatedAssignmentCount:assignments.length,constraints,evaluations,unsatCore,
    sourceHash:hash(input),packagesInstalled:false,registryQueried:false,externalActionsPerformed:false};
  return {...result,analysisHash:hash(result)};
}
export function versionConstraints(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length || Array.from(answers).some((row,index) => !keys(row,['candidateId','choice']) || row.candidateId !== tasks[index].id || row.choice !== null && !optionsFor().some(option => option.value === row.choice))) throw new Error('Provide one ordered supported choice or missing outcome for every candidate.');
  if (answers.some(row => row.choice === null || row.choice === 'unknown')) return {status:'incomplete',analysis:null};
  return {status:'complete',analysis:analyzeCatalog(input,Object.fromEntries(answers.map(row => [row.candidateId,row.choice === 'supported'])))};
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed release catalog. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved candidate request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(task => {
    const attempt = state.attempts.find(row => row.taskId === task.id), answer = attempt?.observation?.answer;
    return { candidateId: task.id, candidateHash: hash(task), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      choice: answer?.value ?? null, label: answer?.label ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = versionConstraints(input, answers.map(({ candidateId, choice }) => ({ candidateId, choice })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { catalogId: input.catalogId, source: input, sourceHash: hash(input), configHash: hash(state.config), policy: POLICY, policyHash: POLICY_HASH,
    participant: state.config.participant, room: state.room, answers, analysis: calculation.analysis, packagesInstalled: false, registryQueried: false, externalActionsPerformed: false };
  return { ...evidence, status, lockExport: calculation.status === 'complete' && calculation.analysis.status === 'resolved' ? { ...evidence, status: 'complete' } : null };
}

function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['value', 'label', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || !request.options.some(option => option.value === answer.value && option.label === answer.label)
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved candidate support evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain candidate support evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== undefined && q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== undefined && q.results !== null || q.text_input !== null || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== request.options.length
    || q.options.some((option, index) => option?.value !== request.options[index].value || option?.label !== request.options[index].label || option?.primary !== undefined && option.primary !== false || option?.destructive !== undefined && option.destructive !== false)) throw new Error('Question does not match the saved task, room, or release owner.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.text !== null || answer.responder?.id !== request.target_user_id || !request.options.some(option => option.value === answer.value && option.label === answer.label)) throw new Error('Invalid button answer.');
      observation.answer = { value: answer.value, label: answer.label, responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
