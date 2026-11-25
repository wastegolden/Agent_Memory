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
