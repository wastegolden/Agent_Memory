import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { MemorySearch, rebuildIndex } from '../src/retrieval/index.mjs'
import { isPublicTitle } from '../src/retrieval/terms.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase } from '../src/storage/database.mjs'
import { parseProposal } from '../src/storage/proposal.mjs'

const reader = { scope: 'project', sessionId: 'reader', context: 'production' }
const route = { type: 'long.put', id: 'route', expectedVersion: 0, kind: 'procedure',
  title: 'GET /health & @api/v2 [HTTP] #checks', data: { conditions: [], steps: ['Check response'], parameters: ['CODE'] } }

function setup(t) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const service = new CommitService(db)
  function put(scope, operations) {
    const source = enqueue(db, { sourceId: randomUUID(), sourceSessionId: 'session', authorRole: 'owner',
      scope, text: 'Verified observation' })
    const batch = pullBatch(db, { scope, consumerId: 'organizer' })
    const result = service.commit({ scope, batchId: batch.batchId, proposalId: randomUUID(),
      operations: operations.map(op => ({ ...op, sourceIds: [source] })) }, 'organizer')
    assert.equal(result.status, 'COMMITTED', JSON.stringify(result))
  }
  return { db, put, search: new MemorySearch(db) }
}

test('technical titles survive proposal validation, indexing and two-step reads', t => {
  const { put, search } = setup(t)
  put(reader.scope, [route])
  const hit = search.search({ text: '/health & @api/v2' }, reader).results[0]
  assert.equal(hit.title, route.title)
  assert.equal(search.read({ handle: hit.handle }, reader).record.title, route.title)
  for (const title of ['http://example.invalid/path', 'schema：//destination', '//example.invalid/docs',
    'mailto:user@example.invalid', 'line\nline', 'a\u0001b', 'a\u202eb', 'x'.repeat(61)]) {
    assert.equal(isPublicTitle(title), false)
    for (const op of [{ ...route, title }, { type: 'short.put', id: 's', expectedVersion: 0, title, status: 'open', body: 'b' }]) {
      assert.throws(() => parseProposal({ scope: 's', batchId: 'b', proposalId: 'p', operations: [op] }), /INVALID_PROPOSAL/)
    }
  }
})

test('rebuilding old derived terms restores technical labels and preserves safe fallback for invalid legacy titles', t => {
  const { db, put, search } = setup(t)
  put(reader.scope, [route, { ...route, id: 'legacy', title: 'Old label', data: { ...route.data, parameters: ['LEGACY'] } }])
  db.prepare('UPDATE memory_search_terms SET terms=? WHERE id=?').run('通用程序', 'route')
  db.prepare('UPDATE long_records SET title=? WHERE id=?').run('invalid://hidden-address', 'legacy')
  assert.equal(search.search({ text: '/health' }, reader).status, 'NO_EVIDENCE')
  rebuildIndex(db)
  assert.equal(search.search({ text: '/health' }, reader).results[0].title, route.title)
  assert.equal(search.search({ text: 'hidden-address' }, reader).status, 'NO_EVIDENCE')
  const hit = search.search({ text: 'LEGACY' }, reader).results[0]
  assert.equal(hit.title, '通用程序')
  assert.equal(search.read({ handle: hit.handle }, reader).record.title, '通用程序')
})

test('native titles survive validation, indexing, partial Chinese search and session-bound reads', t => {
  const { put, search } = setup(t)
  const titles = ['接收端口｜入站信号不稳，需要巡检', '签收凭单·归档', '计量表组｜复核']
  for (const [index, title] of titles.entries()) {
    const op = { ...route, id: String(index), title }
    assert.equal(isPublicTitle(title), true)
    assert.equal(parseProposal({ scope: reader.scope, batchId: 'b', proposalId: 'p', operations: [op] })
      .operations[0].title, title)
    put(reader.scope, [op])
    const { results } = search.search({ text: title }, reader)
    assert.deepEqual(results.map(hit => hit.title), [title])
    assert.equal(search.read({ handle: results[0].handle }, reader).record.title, title)
  }
  const { results } = search.search({ text: '签收凭单 计量表组' }, reader)
  // The tokenizer may also match 收 in the port title.
  assert.deepEqual(results.slice(0, 2).map(hit => hit.title).sort(), titles.slice(1).sort())
  for (const { title, handle } of results) {
    assert.equal(search.read({ handle }, { ...reader, sessionId: 'other' }).status, 'INVALID_HANDLE')
    assert.equal(search.read({ handle }, reader).record.title, title)
  }
})

test('strict hits take precedence and partial hits rank by distinct matched terms then ID', t => {
  const { put, search } = setup(t)
  const text = 'alpha beta gamma'
  const query = () => search.search({ text }, reader)
  const putTitle = (id, title) => put(reader.scope, [{ ...route, id, title }])
  assert.equal(query().status, 'NO_EVIDENCE')
  assert.equal(query().stop, true)
  putTitle('0', 'unrelated')
  const miss = query()
  assert.equal(miss.status, 'NO_EVIDENCE')
  assert.equal(miss.stop, true)
  putTitle('a', 'gamma gamma gamma')
  putTitle('c', 'alpha beta')
  putTitle('b', 'beta gamma')
  putTitle('d', 'alpha')
  assert.deepEqual(query().results.map(hit => hit.title), ['beta gamma', 'alpha beta', 'gamma gamma gamma', 'alpha'])
  putTitle('e', 'beta')
  assert.equal(query().status, 'REFINE_QUERY')
  putTitle('f', 'gamma beta alpha')
  putTitle('z', text)
  assert.deepEqual(query().results.map(hit => hit.title), [text, 'gamma beta alpha'])
})

test('partial search counts only current visible records before applying the four-hit threshold', t => {
  const { db, put, search } = setup(t)
  const fact = { type: 'long.put', expectedVersion: 0, kind: 'fact', title: 'Signal',
    data: { key: 'signal', subject: 'sensor', value: 1 } }
  put('other', [{ ...route, id: 'foreign', title: 'Signal missing' }])
  put(reader.scope, [
    { ...fact, id: 'a', title: 'Signal missing', context: 'preview' },
    { ...fact, id: 'b', validUntil: '2000-01-01' },
    { ...fact, id: 'c', data: { ...fact.data, subject: 'upcoming' }, validFrom: '2099-01-01' },
    { ...route, id: 'd', title: 'Signal missing' }, { ...route, id: 'e', title: 'Signal' },
  ])
  db.prepare('UPDATE long_records SET deleted=1 WHERE id=?').run('d')
  db.prepare('UPDATE memory_search_terms SET version=0 WHERE id=?').run('e')
  const query = () => search.search({ text: 'signal missing' }, reader)
  const miss = query()
  assert.equal(miss.status, 'NO_EVIDENCE')
  assert.equal(miss.stop, true)
  const titles = ['Signal one', 'Signal two', 'Signal three', 'Signal four']
  put(reader.scope, titles.map((title, i) => ({ ...route, id: 'live-' + i, title })))
  assert.deepEqual(query().results.map(hit => hit.title), titles)
  put(reader.scope, [{ ...route, id: 'last', title: 'Signal five' }])
  assert.equal(query().status, 'REFINE_QUERY')
})

test('explicit search context selects scoped facts and the handle retains that effective context', t => {
  const { db, put, search } = setup(t)
  const fact = { type: 'long.put', id: 'live', kind: 'fact', title: '运行端口', expectedVersion: 0,
    context: 'production', data: { key: 'PORT', subject: 'runtime', value: 40 } }
  put(reader.scope, [fact, { ...fact, id: 'preview', title: '预演端口', context: 'staging' }])
  put('foreign', [{ ...fact, title: '其它端口', context: 'staging' }])
  assert.deepEqual(search.search({ text: 'PORT' }, reader).results.map(x => x.title), [fact.title])
  assert.equal(search.search({ text: 'PORT', context: '' }, reader).status, 'NO_EVIDENCE')
  assert.equal(search.search({ text: 'PORT', context: null }, reader).status, 'INVALID_ARGUMENT')
  assert.equal(search.search({ text: 'PORT', context: 'staging', scope: 'foreign' }, reader).status, 'FORBIDDEN')
  const { results } = search.search({ text: 'PORT', context: 'staging' }, reader)
  assert.deepEqual(results.map(x => x.title), ['预演端口'])
  const lookup = { handle: results[0].handle }
  assert.equal(search.read(lookup, reader).record.context, 'staging')
  assert.equal(search.read(lookup, { ...reader, context: 'staging' }).status, 'INVALID_HANDLE')
  assert.equal(search.read(lookup, { ...reader, scope: 'foreign' }).status, 'INVALID_HANDLE')
  db.prepare('UPDATE long_records SET context=? WHERE scope=? AND id=?').run('private', reader.scope, 'preview')
  assert.equal(search.read(lookup, reader).status, 'INVALID_HANDLE')
})

test('the 2000-handle cache evicts the least recently used authorized handle', () => {
  const record = { ...route, version: 1, scope: reader.scope, sources: [] }
  const search = new MemorySearch(null, { retriever: { search: () => [record] }, readRecord: () => record })
  const issue = () => ({ handle: search.search({ text: 'checks' }, reader).results[0].handle })
  const first = issue(), second = issue()
  for (let i = 2; i < 2000; i++) issue()
  assert.equal(search.read(first, reader).status, 'OK')
  assert.equal(search.read(second, { ...reader, sessionId: 'another' }).status, 'INVALID_HANDLE')
  const newest = issue()
  assert.equal(search.read(second, reader).status, 'INVALID_HANDLE')
  assert.equal(search.read(first, reader).status, 'OK')
  assert.equal(search.read(newest, reader).status, 'OK')
})
