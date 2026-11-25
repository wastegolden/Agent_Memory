import assert from 'node:assert/strict'
import { once } from 'node:events'
import fs from 'node:fs'
import { createServer } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { basename, join } from 'node:path'
import test from 'node:test'
import { runDaemon } from '../src/organizer/daemon.mjs'
import { captureStop, deferBatch, enqueue, finishBatch, pendingScopes, pullBatch } from '../src/organizer/queue.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase, readShort } from '../src/storage/database.mjs'
import { onExit, sandbox } from './helpers/host-process.mjs'

const scope = 'release'
const consumerId = 'organizer'

function fixture(t) {
  const { dir, env } = sandbox(t)
  const file = join(dir, 'memory.sqlite')
  const db = openDatabase(file)
  onExit(t, () => db.close())
  const post = (authorRole, sourceId) => enqueue(db, {
    scope, authorRole, sourceSessionId: authorRole + '-session', sourceId, text: sourceId,
  })
  const pull = () => pullBatch(db, { scope, consumerId })
  return { dir, file, env, db, post, pull }
}

const short = (id, expectedVersion = 0) => ({
  type: 'short.put', id, expectedVersion, title: id, body: id, status: 'open',
})

test('deferred rows yield to fresh work and double their retry delay on each failed lease', t => {
  const { db, post, pull } = fixture(t)
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  post('worker', 'blocked')
  const first = pull()
  post('owner', 'owner-one')
  assert.equal(deferBatch(db, first.batchId, 'other', 1000), 0)
  assert.equal(pull().batchId, first.batchId)
  assert.equal(deferBatch(db, first.batchId, consumerId, 1000), 1)
  const next = pull()
  assert.deepEqual(next.events.map(e => e.sourceId), ['owner-one'])
  finishBatch(db, next.batchId)
  assert.deepEqual(pendingScopes(db), [])
  assert.equal(pull(), null)
  now += 1000
  assert.deepEqual(pendingScopes(db), [scope])
  post('owner', 'owner-two')
  const fresh = pull()
  assert.deepEqual(fresh.events.map(e => e.sourceId), ['owner-two'])
  finishBatch(db, fresh.batchId)
  const retry = pull()
  assert.deepEqual(retry.events.map(e => e.sourceId), ['blocked'])
  assert.notEqual(retry.batchId, first.batchId)
  deferBatch(db, retry.batchId, consumerId, 1000)
  now += 1999
  assert.equal(pull(), null)
  now++
  assert.deepEqual(pull().events.map(e => e.sourceId), ['blocked'])
})

test('capacity rejection keeps the original lease available for immediate amendment', t => {
  const { db, post, pull } = fixture(t)
  const service = new CommitService(db, { capacity: 15 })
  post('owner', 'fill')
  const fill = pull()
  assert.equal(service.commit({ scope, batchId: fill.batchId, proposalId: 'fill',
    operations: Array.from({ length: 15 }, (_, i) => short('open-' + i)) }, consumerId).status, 'COMMITTED')
  post('worker', 'blocked')
  const { batchId } = pull()
  const proposal = { scope, batchId, proposalId: 'blocked', operations: [short('new-item')] }
  assert.equal(service.commit(proposal, consumerId).status, 'CAPACITY_REACHED')
  assert.equal(pull().batchId, batchId)
  assert.equal(service.commit({ ...proposal, operations: [] }, consumerId).status, 'COMMITTED')
})

test('daemon defers forbidden worker evidence, commits later owner evidence, and idles until retry', async t => {
  const { db, env, post, pull } = fixture(t)
  const service = new CommitService(db)
  post('owner', 'seed')
  const seed = pull()
  assert.equal(service.commit({ scope, batchId: seed.batchId, proposalId: 'seed',
    operations: [short('protected')] }, consumerId).status, 'COMMITTED')
  post('worker', 'blocked')
  post('owner', 'permitted')
  const inputs = []
  const api = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const input = JSON.parse(payload.messages.find(m => m.role === 'user').content)
    inputs.push(input)
    const op = input.events[0].sourceId === 'blocked' ? short('protected', 1) : short('published')
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ operations: [op] }) } }] }))
  })
  api.listen(0, 'localhost')
  await once(api, 'listening')
  onExit(t, () => new Promise(resolve => api.close(resolve)))
  const config = { ...env, MEMORY_SCOPE: scope, MEMORY_CONTEXT: 'staging', MEMORY_MODE: 'daemon',
    MEMORY_API_STYLE: 'openai', MEMORY_API_BASE_URL: 'http://localhost:' + api.address().port, MEMORY_API_MODEL: 'local' }
  const run = () => runDaemon({ env: config, once: true })
  for (const [attempt, delay] of [[1, 30_000], [2, 60_000]]) {
    const before = Date.now()
    await assert.rejects(run(), /Organizer commit FORBIDDEN/)
    const blocked = db.prepare('SELECT * FROM memory_queue WHERE sourceId=?').get('blocked')
    assert.equal(blocked.batchId, null)
    assert.equal(blocked.retry_count, attempt)
    assert.ok(blocked.retry_after >= before + delay && blocked.retry_after <= Date.now() + delay)
    if (attempt === 1) {
      assert.equal((await run()).status, 'COMMITTED')
      assert.equal(readShort(db, scope, 'published').authorRole, 'owner')
      assert.equal((await run()).status, 'IDLE')
      db.prepare('UPDATE memory_queue SET retry_after=? WHERE id=?').run(Date.now(), blocked.id)
    }
  }
  assert.equal((await run()).status, 'IDLE')
  assert.deepEqual(inputs.map(i => i.events[0].sourceId), ['blocked', 'permitted', 'blocked'])
  assert.ok(inputs.every(i => i.context === 'staging'))
})

const line = content => JSON.stringify({ type: 'USER_INPUT', source: 'USER_EXPLICIT', content }) + '\n'

test('drain quarantines bad JSON and malformed fields and tolerates a concurrent marker removal', t => {
  const { db, dir, file, pull } = fixture(t)
  const transcriptPath = join(dir, 'turns.jsonl')
  fs.writeFileSync(transcriptPath, line('<USER_REQUEST>quote </USER_REQUEST> and continue</USER_REQUEST>'))
  captureStop(file, { scope, authorRole: 'worker', sourceSessionId: 'session', transcriptPath })
  const directory = join(dir, 'pending-stops', basename(file))
  fs.writeFileSync(join(directory, '00.json'), '{private')
  fs.writeFileSync(join(directory, '01.json'), JSON.stringify({ scope }))
  fs.writeFileSync(join(directory, '02.json'), 'null')
  const disappeared = join(directory, '02.json')
  const original = fs.readdirSync
  const listing = t.mock.method(fs, 'readdirSync', function (...args) {
    const result = original.apply(this, args)
    if (args[0] === directory) fs.rmSync(disappeared, { force: true })
    return result
  })
  const diagnostics = []
  const stderr = t.mock.method(process.stderr, 'write', message => { diagnostics.push(message); return true })
  syncBuiltinESMExports()
  try {
    assert.deepEqual(pull().events.map(e => e.text), ['quote </USER_REQUEST> and continue'])
  } finally {
    listing.mock.restore()
    stderr.mock.restore()
    syncBuiltinESMExports()
  }
  assert.deepEqual(fs.readdirSync(directory).sort(), ['00.json.corrupt', '01.json.corrupt'])
  assert.equal(diagnostics.length, 2)
  assert.ok(diagnostics.every(message => message.includes('malformed') && !message.includes('private')))
  assert.deepEqual(pendingScopes(db), [])
})

test('same-file growth during clock rollback preserves byte-range authority and ignores replayed markers', t => {
  const { db, dir, file, pull } = fixture(t)
  const transcriptPath = join(dir, 'turns.jsonl')
  const directory = join(dir, 'pending-stops', basename(file))
  const capture = authorRole => captureStop(file, { scope, authorRole, sourceSessionId: 'session', transcriptPath })
  const cursor = () => db.prepare('SELECT * FROM transcript_cursor').get()
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  const first = line('before rollback'), second = line('after rollback')
  fs.writeFileSync(transcriptPath, first)
  capture('worker')
  const old = fs.readFileSync(join(directory, fs.readdirSync(directory)[0]))
  pendingScopes(db)
  const initial = cursor()
  now -= 60_000
  fs.appendFileSync(transcriptPath, second)
  capture('owner')
  const recent = fs.readFileSync(join(directory, fs.readdirSync(directory)[0]))
  pendingScopes(db)
  assert.equal(cursor().captured, Buffer.byteLength(first + second))
  assert.equal(cursor().stamp, initial.stamp)
  assert.deepEqual(db.prepare('SELECT endByte,authorRole FROM transcript_ranges ORDER BY endByte').all()
    .map(r => [r.endByte, r.authorRole]), [[Buffer.byteLength(first), 'worker'], [Buffer.byteLength(first + second), 'owner']])
  for (const [text, role] of [['before rollback', 'worker'], ['after rollback', 'owner']]) {
    const batch = pull()
    assert.deepEqual(batch.events.map(e => [e.text, e.authorRole]), [[text, role]])
    finishBatch(db, batch.batchId)
  }
  for (const [name, data] of [['replay-a', recent], ['replay-b', old]]) {
    fs.writeFileSync(join(directory, name + '.json'), data)
  }
  assert.equal(pull(), null)
  assert.equal(cursor().generation, initial.generation)
  assert.equal(cursor().consumed, Buffer.byteLength(first + second))
  assert.equal(db.prepare('SELECT count(*) AS n FROM memory_queue').get().n, 2)
})

test('a rollover in the capture clock while two Stop markers await draining preserves both authorities', t => {
  const { db, file, dir, pull } = fixture(t)
  const transcriptPath = join(dir, 'turns.jsonl')
  const capture = authorRole => captureStop(file, { scope, sourceSessionId: 'same', transcriptPath, authorRole })
  let now = Date.now()
  t.mock.method(Date, 'now', () => now)
  fs.writeFileSync(transcriptPath, line('first'))
  capture('worker')
  now -= 60_000
  fs.appendFileSync(transcriptPath, line('second'))
  capture('owner')
  for (const expected of [['first', 'worker'], ['second', 'owner']]) {
    const batch = pull()
    assert.deepEqual(batch?.events.map(e => [e.text, e.authorRole]), [expected])
    finishBatch(db, batch.batchId)
  }
  assert.equal(pull(), null)
})
