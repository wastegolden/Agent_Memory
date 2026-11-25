import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase, historyLong, listShort, readLong, readShort } from '../src/storage/database.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { MemorySearch, SQLiteMemoryIndexer, SQLiteMemoryRetriever } from '../src/retrieval/index.mjs'

const scope = 'lab'
const owner = { scope, authorRole: 'owner', sourceSessionId: 'owner-session' }
const identity = { scope, sessionId: 'reader', context: 'test' }
const consumer = 'organizer-one'

function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-'))
  const file = join(dir, 'memory.sqlite')
  const db = openDatabase(file, { busyTimeout: 100 })
  t.after(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const indexer = new SQLiteMemoryIndexer(db)
  const service = new CommitService(db, { indexer, ...options })
  function proposal(operations, author = owner, claimant = consumer) {
    const sourceId = randomUUID()
    enqueue(db, { ...author, sourceId, text: 'Observed ' + sourceId })
    const batch = pullBatch(db, { scope: author.scope, consumerId: claimant, limit: 1 })
    assert.ok(batch)
    return { batchId: batch.batchId, scope: batch.scope, proposalId: randomUUID(), operations }
  }
  function commit(operations, author = owner) {
    return service.commit(proposal(operations, author), consumer)
  }
  function apply(operations, author = owner) {
    const reply = commit(operations, author)
    assert.equal(reply.status, 'COMMITTED', JSON.stringify(reply))
    return reply
  }
  return { db, file, indexer, service, proposal, commit, apply }
}

function short(id, overrides = {}) {
  return { type: 'short.put', id, expectedVersion: 0, title: '事项 ' + id,
    body: '待办详情 ' + id, status: 'open', ...overrides }
}

function fact(id, overrides = {}) {
  return { type: 'long.put', id, expectedVersion: 0, kind: 'fact', title: '数据库端口',
    context: 'test', data: { subject: '数据库', key: 'DB_PORT', value: '5433' },
    tags: ['连接设置'], ...overrides }
}

function procedure(id, overrides = {}) {
  return { type: 'long.put', id, expectedVersion: 0, kind: 'procedure', title: '连接步骤',
    data: { conditions: ['已选择环境'], steps: ['读取当前环境参数', '连接并检查响应'], parameters: ['DB_PORT'] },
    tags: ['连接设置'], ...overrides }
}

test('short list exposes four fields with monotonic revisions and preserves archived body and provenance', t => {
  const { db, apply, commit } = fixture(t)
  const initial = listShort(db, scope)
  assert.deepEqual(initial.items, [])
  apply([short('entry')])
  const added = listShort(db, scope)
  assert.ok(added.list_rev > initial.list_rev)
  assert.deepEqual(Object.keys(added.items[0]).sort(), ['id', 'status', 'title', 'updatedAt'])
  const entry = readShort(db, scope, 'entry')
  assert.equal(entry.body, '待办详情 entry')
  assert.equal(commit([{ type: 'short.archive', id: 'entry', expectedVersion: entry.version }]).status, 'UNFINISHED')
  assert.deepEqual(listShort(db, scope), added)
  assert.equal(entry.sources[0].sourceSessionId, owner.sourceSessionId)
  apply([short('entry', { expectedVersion: entry.version, status: 'done' })])
  const completed = listShort(db, scope)
  assert.ok(completed.list_rev > added.list_rev)
  assert.equal(completed.items[0].status, 'done')
  apply([{ type: 'short.archive', id: 'entry', expectedVersion: readShort(db, scope, 'entry').version }])
  assert.ok(listShort(db, scope).list_rev > completed.list_rev)
  assert.deepEqual(listShort(db, scope).items, [])
  assert.equal(readShort(db, scope, 'entry').status, 'archived')
  assert.equal(readShort(db, scope, 'entry').body, entry.body)
  assert.equal(readShort(db, 'different', 'entry'), null)
})

test('same-scope duplicate merges provenance into one item while identical cross-scope entries stay independent', t => {
  const { db, apply } = fixture(t)
  apply([short('first', { title: '检查', body: 'Deploy  ABC' })])
  const reply = apply([short('alias', { title: '检查', body: 'deploy abc' })])
  assert.equal(reply.changes[0].id, 'first')
  assert.deepEqual(listShort(db, scope).items.map(row => row.id), ['first'])
  assert.equal(new Set(readShort(db, scope, 'first').sources.map(x => x.sourceId)).size, 2)
  apply([short('separate', { title: '检查', body: 'deploy abc' })], { ...owner, scope: 'second' })
  assert.deepEqual(listShort(db, 'second').items.map(row => row.id), ['separate'])
})

test('default capacity keeps eighteen open commitments and returns capacity signal without consuming the proposal', t => {
  const { db, file, apply, service, proposal } = fixture(t)
  const ids = Array.from({ length: 18 }, (_, i) => 'task-' + i)
  apply(ids.map(id => short(id)))
  const full = listShort(db, scope)
  assert.equal(full.items.length, 18)
  const pending = proposal([short('next')])
  assert.equal(service.commit(pending, consumer).status, 'CAPACITY_REACHED')
  assert.deepEqual(listShort(db, scope), full)
  const revised = { ...pending, proposalId: randomUUID(), operations: [
    short(ids[0], { status: 'done', expectedVersion: 1 }), ...pending.operations,
  ] }
  assert.equal(service.commit(revised, consumer).status, 'COMMITTED')
  assert.equal(listShort(db, scope).items.length, 18)
  assert.equal(readShort(db, scope, ids[0]).status, 'archived')
  const reopened = openDatabase(file, { readOnly: true })
  try {
    assert.equal(readShort(reopened, scope, ids[0]).body, '待办详情 ' + ids[0])
  } finally {
    reopened.close()
  }
})

test('configured bounds apply to the active directory; expired entries yield a slot', t => {
  const { db, indexer, apply } = fixture(t, { capacity: 15 })
  for (const capacity of [14, 21, 16.5]) {
    assert.throws(() => new CommitService(db, { capacity, indexer }), RangeError)
  }
  assert.doesNotThrow(() => new CommitService(db, { capacity: 20, indexer }))
  apply(Array.from({ length: 15 }, (_, i) => short('task-' + i, i === 0 ? { expiresAt: '2000-01-01T00:00:00Z' } : {})))
  apply([short('current')])
  assert.equal(listShort(db, scope).items.length, 15)
  assert.equal(readShort(db, scope, 'task-0').status, 'archived')
})

test('capacity cleanup respects the author of owner-confirmed items', t => {
  const { db, apply, commit } = fixture(t, { capacity: 15 })
  apply(Array.from({ length: 15 }, (_, i) => short('owner-' + i, { status: i === 0 ? 'done' : 'open' })))
  const before = listShort(db, scope)
  const reply = commit([short('worker')], { scope, authorRole: 'worker', sourceSessionId: 'worker-session' })
  assert.equal(reply.status, 'CAPACITY_REACHED')
  assert.deepEqual(listShort(db, scope), before)
  assert.equal(readShort(db, scope, 'owner-0').status, 'done')
})

test('promotion and history are atomic with other operations, revisions survive correction and removal', t => {
  const { db, service, proposal, apply } = fixture(t)
  apply([short('draft')])
  const { type, ...record } = fact('port')
  const promotion = { type: 'short.promote', id: 'draft', expectedVersion: 1, record }
  const invalid = proposal([promotion, fact('port', { expectedVersion: 8 })])
  const before = listShort(db, scope)
  assert.equal(service.commit(invalid, consumer).status, 'VERSION_CONFLICT')
  assert.deepEqual(listShort(db, scope), before)
  assert.equal(readLong(db, scope, 'port'), null)
  apply([promotion])
  assert.equal(readShort(db, scope, 'draft').promotedTo, 'port')
  assert.deepEqual(listShort(db, scope).items, [])
  apply([fact('port', { expectedVersion: 1, data: { subject: '数据库', key: 'DB_PORT', value: '6433' } })])
  const versions = historyLong(db, scope, 'port')
  assert.deepEqual(versions.map(row => row.version), [1, 2])
  assert.deepEqual(versions.map(row => row.data.value), ['5433', '6433'])
  apply([{ type: 'long.remove', id: 'port', expectedVersion: 2 }])
  assert.equal(readLong(db, scope, 'port').deleted, true)
  assert.equal(historyLong(db, scope, 'port').length, 3)
})

test('submission is idempotent and lease ownership is enforced before a write', t => {
  const { db, proposal, service } = fixture(t)
  const request = proposal([short('once')])
  assert.equal(service.commit(request, 'someone-else').status, 'LEASE_LOST')
  assert.equal(readShort(db, scope, 'once'), null)
  const committed = service.commit(request, consumer)
  assert.equal(committed.status, 'COMMITTED')
  const rev = listShort(db, scope).list_rev
  assert.deepEqual(service.commit(request, consumer), committed)
  assert.equal(service.commit({ ...request, operations: [short('changed')] }, consumer).status, 'PROPOSAL_CONFLICT')
  assert.equal(service.commit(request, 'someone-else').status, 'FORBIDDEN')
  assert.equal(listShort(db, scope).list_rev, rev)
  assert.equal(readShort(db, scope, 'once').version, 1)
})

test('a worker cannot introduce a second active fact under the identity of an owner-confirmed parameter', t => {
  const { db, apply, commit } = fixture(t)
  apply([fact('canonical')])
  const reply = commit([fact('alternative', { data: { subject: '数据库', key: 'DB_PORT', value: '10' } })],
    { scope, sourceSessionId: 'worker-session', authorRole: 'worker' })
  assert.equal(reply.status, 'FORBIDDEN')
  assert.equal(readLong(db, scope, 'alternative'), null)
})

for (const role of ['worker', 'external']) {
  test(role + ' cannot replace, remove, merge with or promote owner records', t => {
    const { db, apply, commit } = fixture(t)
    apply([short('draft'), fact('port'), procedure('connect')])
    const author = { scope, authorRole: role, sourceSessionId: role + '-session' }
    const { type, ...record } = fact('private')
    const changes = [
      short('draft', { expectedVersion: 1, body: 'different' }),
      short('alias', { title: '事项 draft', body: '待办详情 draft' }),
      { type: 'short.archive', id: 'draft', expectedVersion: 1 },
      { type: 'short.promote', id: 'draft', expectedVersion: 1, record },
      fact('port', { expectedVersion: 1 }),
      { type: 'long.remove', id: 'port', expectedVersion: 1 },
      procedure('connect', { expectedVersion: 1 }),
      { type: 'long.remove', id: 'connect', expectedVersion: 1 },
    ]
    for (const change of changes) {
      assert.equal(commit([change], author).status, 'FORBIDDEN', change.type)
    }
    assert.equal(readShort(db, scope, 'draft').version, 1)
    assert.equal(readLong(db, scope, 'port').version, 1)
    assert.equal(readLong(db, scope, 'connect').version, 1)
    assert.equal(readLong(db, scope, 'private'), null)
  })
}

test('queue deduplicates source events, isolates scoped batches and reissues expired leases', t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2030, 0, 1) })
  const { db, service } = fixture(t)
  const event = { ...owner, sourceId: 'line-one', text: 'observed' }
  const firstId = enqueue(db, event)
  assert.equal(enqueue(db, event), firstId)
  const secondId = enqueue(db, { ...event, sourceId: 'line-two' })
  enqueue(db, { ...event, scope: 'other', sourceId: 'private-line' })
  const first = pullBatch(db, { scope, consumerId: consumer, limit: 1, leaseMs: 80 })
  assert.deepEqual(first.events.map(x => x.id), [firstId])
  assert.equal(pullBatch(db, { scope, consumerId: 'three' }), null)
  assert.equal(pullBatch(db, { scope: 'other', consumerId: 'two' }).events[0].text, event.text)
  t.mock.timers.tick(100)
  const reclaimed = pullBatch(db, { scope, consumerId: 'three', limit: 1 })
  assert.notEqual(reclaimed.batchId, first.batchId)
  assert.deepEqual(reclaimed.events.map(x => x.id), [firstId])
  const stale = { scope, proposalId: randomUUID(), batchId: first.batchId, operations: [short('stale')] }
  assert.equal(service.commit(stale, consumer).status, 'LEASE_LOST')
  const request = { scope, batchId: reclaimed.batchId, proposalId: randomUUID(), operations: [short('current')] }
  assert.equal(service.commit(request, 'three').status, 'COMMITTED')
  assert.equal(enqueue(db, event), firstId)
  const next = pullBatch(db, { scope, consumerId: consumer })
  assert.deepEqual(next.events.map(x => x.id), [secondId])
})

test('citing an event outside the claimed scope cannot authorize a write', t => {
  const { db, service, proposal } = fixture(t)
  const outside = enqueue(db, { ...owner, scope: 'other', sourceId: 'evidence', text: 'private' })
  const request = proposal([short('laundered', { sourceIds: [outside] })])
  const reply = service.commit(request, consumer)
  assert.notEqual(reply.status, 'COMMITTED')
  assert.equal(readShort(db, scope, 'laundered'), null)
})

test('owner corrections and assistant observations are processed in ordered, independently authorized batches', t => {
  const { db, service, apply } = fixture(t)
  apply([fact('port')])
  enqueue(db, { ...owner, sourceId: 'owner-line', text: 'update DB_PORT' })
  enqueue(db, { ...owner, authorRole: 'worker', sourceId: 'assistant-line', text: 'acknowledged' })
  const batch = pullBatch(db, { scope, consumerId: consumer })
  assert.deepEqual(batch.events.map(row => row.authorRole), ['owner'])
  assert.equal(service.commit({ scope, batchId: batch.batchId, proposalId: randomUUID(),
    operations: [fact('port', { expectedVersion: 1, data: { subject: '数据库', key: 'DB_PORT', value: '6433' } })]
  }, consumer).status, 'COMMITTED')
  const next = pullBatch(db, { scope, consumerId: consumer })
  assert.deepEqual(next.events.map(row => row.authorRole), ['worker'])
})

test('malformed procedure and missing fact values roll back every operation in a batch', t => {
  const { db, commit } = fixture(t)
  const invalid = [procedure('bad', { data: { steps: 'untyped' } }),
    fact('bad', { data: { subject: '数据库', key: 'DB_PORT' } })]
  for (const op of invalid) {
    assert.equal(commit([short('survivor'), op]).status, 'INVALID_PROPOSAL')
    assert.equal(readShort(db, scope, 'survivor'), null)
  }
})

test('literal Chinese and parameter names retrieve the current contextual fact and reusable procedure without old values', t => {
  const { db, apply } = fixture(t)
  apply([
    fact('port'), procedure('connect'),
    fact('production', { title: '生产端口', context: 'production' }),
    fact('expired', { title: '已过期端口', data: { subject: '旧实例', key: 'DB_PORT', value: '1000' }, validUntil: '2000-01-01T00:00:00Z' }),
    fact('future', { title: '未来端口', data: { subject: '待启用实例', key: 'DB_PORT', value: '2000' }, validFrom: '2099-01-01T00:00:00Z' }),
  ])
  const search = new MemorySearch(db)
  const query = (text, who = identity) => search.search({ text }, who)
  let result = query('DB_PORT')
  assert.equal(result.status, 'OK')
  assert.deepEqual(result.results.map(x => x.title).sort(), ['数据库端口', '连接步骤'].sort())
  assert.deepEqual(Object.keys(result.results[0]).sort(), ['handle', 'title'])
  assert.deepEqual(query('端口').results.map(x => x.title), ['数据库端口'])
  const old = query('端口').results[0].handle
  const port = search.read({ handle: old }, identity)
  assert.equal(port.status, 'OK')
  assert.equal(port.record.data.value, '5433')
  assert.deepEqual(query('DB_PORT', { scope, sessionId: 'unbound' }).results.map(x => x.title), ['连接步骤'])
  apply([fact('port', { expectedVersion: 1, data: { subject: '数据库', key: 'DB_PORT', value: '6433' } })])
  assert.equal(search.read({ handle: old }, identity).status, 'INVALID_HANDLE')
  result = query('DB_PORT')
  const current = result.results.find(x => x.title === '数据库端口')
  assert.equal(search.read({ handle: current.handle }, identity).record.data.value, '6433')
  assert.equal(JSON.stringify(query('5433')).includes('数据库端口'), false)
})

test('zero hits stop, broad queries request refinement, scoped handles refuse foreign sessions and scopes', t => {
  const { db, apply } = fixture(t)
  const search = new MemorySearch(db)
  apply([fact('hidden', { title: '范围外绝密' })], { ...owner, scope: 'other' })
  const missing = search.search({ text: '范围外绝密' }, identity)
  assert.equal(missing.status, 'NO_EVIDENCE')
  assert.equal(missing.stop, true)
  assert.ok(missing.overview && missing.next)
  assert.doesNotMatch(JSON.stringify(missing), /范围外绝密|hidden|other/)
  apply([fact('port')])
  assert.equal(search.search({ text: '全部' }, identity).status, 'REFINE_QUERY')
  const hit = search.search({ text: '端口' }, identity).results[0]
  assert.match(hit.handle, /^[a-f\d-]{36}$/i)
  assert.equal(search.read({ handle: hit.handle }, { ...identity, sessionId: 'another' }).status, 'INVALID_HANDLE')
  assert.equal(search.read({ handle: hit.handle }, { ...identity, scope: 'other' }).status, 'INVALID_HANDLE')
  assert.equal(search.read({ handle: hit.handle }, { ...identity, context: 'production' }).status, 'INVALID_HANDLE')
  assert.equal(search.read({ handle: 'port' }, identity).status, 'INVALID_HANDLE')
  assert.equal(search.search({ text: '范围外绝密', scope: 'other' }, identity).results?.length ?? 0, 0)
  apply([{ type: 'long.remove', id: 'port', expectedVersion: 1 }])
  assert.equal(search.read({ handle: hit.handle }, identity).status, 'INVALID_HANDLE')
})

test('read-only database serves search and read without changing index, persisted rows or receipts', t => {
  const { file, db, apply } = fixture(t)
  apply([procedure('connect')])
  const ro = openDatabase(file, { readOnly: true })
  try {
    const version = db.prepare('PRAGMA data_version').get().data_version
    const search = new MemorySearch(ro)
    const result = search.search({ text: '连接' }, identity)
    assert.equal(result.status, 'OK')
    assert.equal(search.read({ handle: result.results[0].handle }, identity).status, 'OK')
    assert.equal(search.search({ text: 'missing' }, identity).status, 'NO_EVIDENCE')
    assert.equal(db.prepare('PRAGMA data_version').get().data_version, version)
  } finally {
    ro.close()
  }
})

test('broad match thresholds count authorized live records only, and expiration after search invalidates a handle', t => {
  const { db, apply } = fixture(t)
  const start = Date.parse('2030-01-01T00:00:00Z')
  let now = start
  const search = new MemorySearch(db, { clock: () => now })
  apply([fact('expires', { validUntil: new Date(start + 1000).toISOString() })])
  const handle = search.search({ text: '端口' }, identity).results[0].handle
  now += 1000
  assert.equal(search.read({ handle }, identity).status, 'INVALID_HANDLE')
  apply(Array.from({ length: 5 }, (_, i) => procedure('procedure-' + i)))
  assert.equal(search.search({ text: '连接设置' }, identity).status, 'REFINE_QUERY')
  assert.equal(search.search({ text: '连接设置' }, { ...identity, scope: 'other' }).status, 'NO_EVIDENCE')
})

test('CommitService invokes the injected indexer inside its write transaction and rolls back failed indexing', t => {
  const { db, proposal } = fixture(t)
  const calls = []
  let fail = false
  const indexer = {
    upsert(row) {
      assert.ok(db.isTransaction)
      calls.push(['upsert', row.id, row.version])
      if (fail) throw new Error('index write fault')
    },
    remove(id, seenScope) {
      assert.ok(db.isTransaction)
      calls.push(['remove', id, seenScope])
    },
  }
  const service = new CommitService(db, { indexer })
  const request = proposal([procedure('connect')])
  const asynchronous = new CommitService(db, { indexer: { async upsert() {}, remove() {} } })
  assert.throws(() => asynchronous.commit(request, consumer), /synchronously/)
  assert.equal(readLong(db, scope, 'connect'), null)
  fail = true
  assert.throws(() => service.commit(request, consumer), /index write fault/)
  assert.equal(readLong(db, scope, 'connect'), null)
  fail = false
  assert.equal(service.commit(request, consumer).status, 'COMMITTED')
  const remove = proposal([{ type: 'long.remove', id: 'connect', expectedVersion: 1 }])
  assert.equal(service.commit(remove, consumer).status, 'COMMITTED')
  assert.deepEqual(calls, [['upsert', 'connect', 1], ['upsert', 'connect', 1], ['remove', 'connect', scope]])
})

test('replaceable retriever supplies candidates only; stale, foreign and unsolicited private fields never reach search', async t => {
  const { db, apply } = fixture(t)
  apply([procedure('real')])
  const candidate = { id: 'real', scope, version: 1 }
  let calls = 0
  const search = new MemorySearch(db, { retriever: { async search(query) {
    calls += 1
    assert.equal(query.scope, scope)
    return [{ ...candidate, scope: 'elsewhere' }, { ...candidate, version: 0 }, { ...candidate, title: 'secret', body: 'secret' }]
  } } })
  const result = await search.search({ text: '匹配' }, identity)
  assert.equal(calls, 1)
  assert.deepEqual(result.results.map(x => x.title), ['连接步骤'])
  assert.doesNotMatch(JSON.stringify(result), /secret|elsewhere/)
  assert.equal(search.read({ handle: result.results[0].handle }, identity).record.kind, 'procedure')
  assert.ok(new SQLiteMemoryRetriever(db).search({ text: '连接', scope }).length > 0)
})

async function startWriter(file, mode) {
  const child = fork(new URL('./helpers/domain-writer.mjs', import.meta.url), [file, mode], {
    execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const receive = () => once(child, 'message', { signal: AbortSignal.timeout(10000) }).then(([reply]) => reply)
  assert.equal((await receive()).status, 'READY')
  return {
    async request(message) {
      const reply = receive()
      child.send(message)
      return reply
    },
    async stop() {
      const exited = once(child, 'exit')
      child.disconnect()
      const [code] = await exited
      assert.equal(code, 0)
    },
  }
}

test('a real foreign-process write lock yields BUSY, then the identical proposal succeeds after release', async t => {
  const { db, file, service, proposal } = fixture(t)
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.ok(db.prepare('PRAGMA busy_timeout').get().timeout > 0)
  const request = proposal([short('held')])
  const writer = await startWriter(file, 'lock')
  try {
    await writer.request({ action: 'lock' })
    assert.equal(service.commit(request, consumer).status, 'BUSY')
    assert.equal(readShort(db, scope, 'held'), null)
    await writer.request({ action: 'release' })
    assert.equal(service.commit(request, consumer).status, 'COMMITTED')
  } finally {
    await writer.stop()
  }
})

test('two independent writer processes racing the same expectedVersion produce exactly one revision', async t => {
  const { db, file, apply } = fixture(t)
  apply([short('race')])
  for (const name of ['left', 'right']) enqueue(db, { ...owner, sourceId: name, text: 'observed ' + name })
  const left = await startWriter(file, 'commit')
  try {
    const right = await startWriter(file, 'commit')
    try {
      const results = await Promise.all([
        left.request({ action: 'race', scope, operation: short('race', { expectedVersion: 1, body: 'left' }), consumer: 'left' }),
        right.request({ action: 'race', scope, operation: short('race', { expectedVersion: 1, body: 'right' }), consumer: 'right' }),
      ])
      assert.deepEqual(results.map(row => row.status).sort(), ['COMMITTED', 'VERSION_CONFLICT'])
      const row = readShort(db, scope, 'race')
      assert.equal(row.version, 2)
      assert.equal(row.body, results[0].status === 'COMMITTED' ? 'left' : 'right')
    } finally {
      await right.stop()
    }
  } finally {
    await left.stop()
  }
})
