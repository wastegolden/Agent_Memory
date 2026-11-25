import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { pullForOrganizer } from '../src/organizer/contract.mjs'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { settings } from '../src/organizer/settings.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase } from '../src/storage/database.mjs'

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
    procedure('by-param', {data: {conditions: [], steps: ['private step'], parameters: ['SocketMode']}}),
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
    authorRole: 'worker', subject: '路由器', key: 'latency', parameters: []})
  assert.deepEqual(byId.get('by-param'), {id: 'by-param', version: 1, kind: 'procedure', title: '指引',
    context: '', validFrom: null, validUntil: null, authorRole: 'worker',
    subject: null, key: null, parameters: ['SocketMode']})
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

test('settings trim scope and context and treat blank overrides as absent', () => {
  const configured = settings({MEMORY_SCOPE: ' release  ', MEMORY_CONTEXT: '  staging\t'})
  assert.equal(configured.scope, 'release')
  assert.equal(configured.context, 'staging')
  const blank = settings({MEMORY_SCOPE: '\t ', MEMORY_CONTEXT: '   '})
  assert.equal(blank.scope, undefined)
  assert.equal(blank.context, undefined)
})
