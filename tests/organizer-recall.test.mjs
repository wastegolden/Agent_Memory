import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { pullForOrganizer } from '../src/organizer/contract.mjs'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { settings } from '../src/organizer/settings.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase, recordProcedureOutcome } from '../src/storage/database.mjs'

function fixture(t) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const service = new CommitService(db)
  const request = {scope: 'product', consumerId: 'organizer'}
  function emit(text, scope = request.scope) {
    enqueue(db, {scope, text, sourceId: randomUUID(), sourceSessionId: 'session', authorRole: 'worker'})
  }
  function apply(operations, scope = request.scope) {
    emit('Initial evidence', scope)
    const {batchId} = pullBatch(db, {...request, scope})
    assert.equal(service.commit({scope, batchId, proposalId: randomUUID(), operations}, request.consumerId).status, 'COMMITTED')
  }
  return {db, request, emit, apply}
}

function fact(id, subject, key, extra = {}) {
  return {type: 'long.put', id, expectedVersion: 0, kind: 'fact', title: '配置',
    data: {subject, key, value: 'source value'}, ...extra}
}

function procedure(id, extra = {}) {
  return {type: 'long.put', id, expectedVersion: 0, kind: 'procedure', title: '指引',
    data: {conditions: [], steps: ['private step'], parameters: []}, ...extra}
}

test('organizer matches indexed metadata across natural evidence and returns current scoped revisions', t => {
  const {db, request, emit, apply} = fixture(t)
  apply([
    fact('by-subject', '路由器', 'latency', {context: 'staging', validFrom: '2001-01-01', validUntil: '2099-01-01'}),
    fact('by-key', 'backend', 'Tcp_Window', {context: 'production'}),
    procedure('by-param', {tags: ['socket'], data: {conditions: ['connected'],
      steps: ['inspect', 'send', 'verify'], parameters: ['SocketMode'], outwardSteps: [2]}}),
    procedure('by-tag', {tags: ['ＰｒｏｂｅＴａｇ']}),
    procedure('by-title', {title: '驱动检测流程'}),
    fact('past', 'old', 'key', {tags: ['probetag'], validUntil: '2001-01-01'}),
    fact('future', 'later', 'key', {tags: ['probetag'], validFrom: '2099-01-01'}),
    procedure('deleted', {tags: ['probetag']}),
    procedure('unrelated'),
    {type: 'short.put', id: 'todo', expectedVersion: 0, title: '待检查', body: 'private task',
      status: 'open', expiresAt: '2099-01-01'},
  ])
  apply([procedure('foreign', {tags: ['probetag']})], 'other-scope')
  apply([{type: 'long.remove', id: 'deleted', expectedVersion: 1}])
  db.exec('BEGIN IMMEDIATE')
  for (const [i, status] of ['ok','failed','fallback','ok'].entries()) {
    recordProcedureOutcome(db, {scope: request.scope, procedureId: 'by-param', procedureVersion: 1,
      status, detail: String(i), failedStep: status === 'failed' ? 2 : null,
      outwardDone: status === 'failed', sessionId: 'session', authorRole: 'worker'})
  }
  db.exec('COMMIT')
  emit('请检查路由器，确认 ＴＣＰ＿ＷＩＮＤＯＷ 和 sOcKeTmOdE。')
  emit('安排驱动检测，再验证 probetag。')
  const batch = pullForOrganizer(db, {...request, context: 'production'})
  assert.equal(batch.context, 'production')
  assert.deepEqual(batch.current.short.map(row => ({...row})), [
    {id: 'todo', version: 1, title: '待检查', status: 'open', expiresAt: '2099-01-01T00:00:00.000Z', authorRole: 'worker'},
  ])
  const byId = new Map(batch.current.long.map(row => [row.id, row]))
  assert.deepEqual([...byId.keys()].sort(), ['by-key', 'by-param', 'by-subject', 'by-tag', 'by-title'])
  assert.deepEqual(byId.get('by-subject'), {id: 'by-subject', version: 1, kind: 'fact', title: '配置',
    context: 'staging', validFrom: '2001-01-01T00:00:00.000Z', validUntil: '2099-01-01T00:00:00.000Z',
    authorRole: 'worker', subject: '路由器', key: 'latency', tags: []})
  const {recentOutcomes, ...record} = byId.get('by-param')
  assert.deepEqual(record, {id: 'by-param', version: 1, kind: 'procedure', title: '指引',
    context: '', validFrom: null, validUntil: null, authorRole: 'worker',
    tags: ['socket'], conditions: ['connected'], steps: ['inspect', 'send', 'verify'],
    outwardSteps: [2], parameters: ['SocketMode']})
  assert.deepEqual(recentOutcomes.map(r => [r.status, r.detail, r.failedStep, r.outwardDone]),
    [['ok','3',null,false], ['fallback','2',null,false], ['failed','1',2,true]])
  assert.deepEqual(byId.get('by-tag').recentOutcomes, [])
  assert.equal(Object.hasOwn(byId.get('by-tag'), 'outwardSteps'), false)
})

test('organizer ranks distinct evidence terms before limiting long suggestions to 32', t => {
  const {db, request, emit, apply} = fixture(t)
  apply([
    ...Array.from({length: 35}, (_, i) => procedure('ordinary-' + i, {tags: ['standby']})),
    procedure('z-target', {tags: ['standby', 'thermostat']}),
  ])
  emit('Review the standby thermostat.')
  const batch = pullForOrganizer(db, request)
  assert.equal(batch.context, null)
  assert.equal(batch.current.long.length, 32)
  assert.equal(batch.current.long[0].id, 'z-target')
})

test('failedRevisions returns the latest failure of the two most recently failing older live snapshots', t => {
  const {db, request, emit, apply} = fixture(t)
  const id = 'deploy'
  for (let version = 1; version <= 6; version++) {
    const data = {conditions:[], parameters:[], steps:['step v' + version]}
    if (version >= 3) data.outwardSteps = [1]
    apply([version === 5 ? {type:'long.remove', id, expectedVersion:4} :
      procedure(id, {expectedVersion:version-1, data})])
  }
  for (const [version, status, detail, outwardDone] of [
    [4,'failed','older failure',false], [3,'failed','first try',true], [1,'failed','legacy',null],
    [3,'fallback','external step',true], [3,'ok','later success',false], [5,'failed','deleted',false],
    [6,'failed','current',null],
  ]) {
    recordProcedureOutcome(db, {scope:request.scope, procedureId:id, procedureVersion:version, status, detail,
      failedStep:version === 3 ? 1 : null, outwardDone, authorRole:'worker', sessionId:'session'})
  }
  emit(id)
  const [recalled] = pullForOrganizer(db, request).current.long
  assert.deepEqual(recalled.failedRevisions, [
    {version:3, steps:['step v3'], outwardSteps:[1],
      lastFailure:{status:'fallback', failedStep:1, outwardDone:true, detail:'external step'}},
    {version:1, steps:['step v1'], outwardSteps:[],
      lastFailure:{status:'failed', failedStep:null, outwardDone:null, detail:'legacy'}},
  ])
})

test('settings trim scope and context and treat blank overrides as absent', () => {
  const configured = settings({MEMORY_SCOPE: ' release  ', MEMORY_CONTEXT: '  staging\t'})
  assert.equal(configured.scope, 'release')
  assert.equal(configured.context, 'staging')
  const blank = settings({MEMORY_SCOPE: '\t ', MEMORY_CONTEXT: '   '})
  assert.equal(blank.scope, undefined)
  assert.equal(blank.context, undefined)
})
