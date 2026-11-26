import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase, readLong } from '../src/storage/database.mjs'
import { parseProposal } from '../src/storage/proposal.mjs'
import { onExit, runScript, sandbox, stdioClient } from './helpers/host-process.mjs'

const scope = 'release'
const procedure = {type: 'long.put', kind: 'procedure', id: 'internal-checklist', expectedVersion: 0,
  title: 'Checklist', data: {conditions: [], steps: ['inspect', 'publish', 'verify'], parameters: [], outwardSteps: [2]}}

test('fresh and v2 databases acquire the v3 outcome index and retain existing revisions', t => {
  const {dir} = sandbox(t)
  const file = join(dir, 'memory.sqlite')
  const db = openDatabase(file)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3)
  db.exec(`DROP TABLE procedure_outcomes; PRAGMA user_version=2;
    INSERT INTO list_revisions VALUES ('release', 8)`)
  db.close()
  assert.throws(() => openDatabase(file, {readOnly: true}), /upgrade/)
  const upgraded = openDatabase(file)
  onExit(t, () => upgraded.close())
  assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 3)
  assert.equal(upgraded.prepare('SELECT rev FROM list_revisions WHERE scope=?').get(scope).rev, 8)
  assert.equal(upgraded.prepare('SELECT count(*) AS n FROM procedure_outcomes').get().n, 0)
  assert.deepEqual(upgraded.prepare('PRAGMA index_xinfo(procedure_outcomes_recent)').all()
    .filter(row => row.key).map(row => [row.name, row.desc]), [['scope', 0], ['procedure_id', 0], ['id', 1]])
})

test('outward step markers use sorted, unique, 1-based indices into the string steps', () => {
  const parse = data => parseProposal({scope, batchId: 'b', proposalId: 'p',
    operations: [{...procedure, data}]}).operations[0].data
  const {outwardSteps, ...legacy} = procedure.data
  assert.deepEqual(parse(legacy), legacy)
  assert.deepEqual(parse({...legacy, outwardSteps: [3,1,3]}), {...legacy, outwardSteps: [1,3]})
  for (const invalid of [null, 1, ['1'], [0], [-1], [4], [1.5]])
    assert.throws(() => parse({...legacy, outwardSteps: invalid}), /INVALID_PROPOSAL/)
})

test('stdio reports bind an authenticated session to a live procedure and expose only eligible fallback versions', async t => {
  const {dir, env} = sandbox(t)
  const config = {...env, MEMORY_SCOPE: scope}
  const db = openDatabase(join(dir, 'memory.sqlite'))
  onExit(t, () => db.close())
  const service = new CommitService(db)
  function commit(...operations) {
    enqueue(db, {scope, sourceId: randomUUID(), sourceSessionId: 'seed', authorRole: 'owner', text: 'Check release procedure'})
    const {batchId} = pullBatch(db, {scope, consumerId: 'organizer'})
    assert.equal(service.commit({scope, batchId, proposalId: randomUUID(), operations}, 'organizer').status, 'COMMITTED')
  }
  commit(procedure, {type: 'long.put', id: 'internal-mode', kind: 'fact', title: 'Mode', expectedVersion: 0,
    data: {subject: 'platform', key: 'mode', value: 'test'}},
    {type: 'short.put', id: 'pending', expectedVersion: 0, title: 'Review', status: 'open', body: 'Inspect output'})
  const owner = {'antigravity.google/conversation_id': 'root', 'antigravity.google/root_conversation_id': 'root'}
  const worker = {...owner, 'antigravity.google/conversation_id': 'child', 'antigravity.google/agent_name': 'reviewer'}
  for (const conversationId of ['root', 'child']) {
    const start = await runScript('src/antigravity/hook.mjs', ['--event','start'], config, JSON.stringify({conversationId}))
    assert.match(start.stdout, /list_rev=1/)
  }
  const client = stdioClient(t, [], config)
  await client.initialize()
  const call = (name, args, who = owner) => client.call(name, args, who)
  const handleFor = async (text, who) => (await call('search', {text}, who)).results[0].handle
  const report = (handle, args, who) => call('report_outcome', {handle, ...args}, who)
  const read = handle => call('read', {handle})
  const v1 = await handleFor('Checklist')
  const {lastOutcome, recentFailures, fallbackVersion} = await read(v1)
  assert.deepEqual([lastOutcome, recentFailures, fallbackVersion], [null, 0, null])
  const fact = await handleFor('Mode')
  assert.equal(Object.hasOwn(await read(fact), 'lastOutcome'), false)
  for (const handle of [fact, procedure.id, randomUUID()])
    assert.deepEqual(await report(handle, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  assert.deepEqual(await report(v1, {status: 'ok'}, worker), {status: 'INVALID_HANDLE'})
  const rebind = db.prepare('UPDATE session_roles SET scope=? WHERE conversationId=?')
  rebind.run('other', 'root')
  assert.deepEqual(await report(v1, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  rebind.run(scope, 'root')
  assert.deepEqual(await report(v1, {status: 'ok'}, {...owner, 'antigravity.google/agent_name': 'memory-organizer'}),
    {status: 'FORBIDDEN'})
  for (const args of [{status: 'ok', failedStep: 1}, {status: 'unknown'}, {status: 'failed', failedStep: 4},
    {status: 'failed', failedStep: 0}, {status: 'failed', failedStep: 1.5}, {status: 'failed', outwardDone: 1},
    {status: 'ok', detail: 'x'.repeat(241)}, {status: 'ok', authorRole: 'owner'}])
    assert.deepEqual(await report(v1, args), {status: 'INVALID_INPUT'})
  assert.equal(db.prepare('SELECT count(*) AS n FROM procedure_outcomes').get().n, 0)

  assert.deepEqual(await report(v1, {status: 'ok', detail: '🚀'.repeat(240)}), {status: 'OK'})
  commit({...procedure, expectedVersion: 1})
  assert.deepEqual(await report(v1, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  const v2 = await handleFor('Checklist')
  const before = readLong(db, scope, procedure.id)
  const workerHandle = await handleFor('Checklist', worker)
  assert.deepEqual(await report(workerHandle, {status: 'failed', failedStep: 1, detail: 'missing input'}, worker),
    {status: 'OK'})
  let view = await read(v2)
  assert.deepEqual(view.lastOutcome, {procedureVersion: 2, status: 'failed', failedStep: 1, outwardDone: false,
    detail: 'missing input', authorRole: 'worker', recordedAt: new Date(view.lastOutcome.recordedAt).toISOString()})
  assert.deepEqual([view.recentFailures, view.fallbackVersion], [1, 1])
  for (const args of [{failedStep: 2, outwardDone: false}, {failedStep: 3}, {failedStep: 1, outwardDone: true}]) {
    assert.deepEqual(await report(v2, {status: 'failed', ...args}), {status: 'OK'})
    view = await read(v2)
    assert.deepEqual([view.lastOutcome.outwardDone, view.fallbackVersion, view.lastOutcome.authorRole], [true, null, 'owner'])
  }
  assert.equal(view.recentFailures, 4)
  assert.deepEqual(await report(v2, {status: 'fallback'}), {status: 'OK'})
  view = await read(v2)
  assert.deepEqual([view.lastOutcome.status, view.fallbackVersion, view.recentFailures], ['fallback', null, 4])
  assert.deepEqual(readLong(db, scope, procedure.id), before)
  assert.equal((await call('short_term_list', {})).list_rev, 1)
  const pre = await runScript('src/antigravity/hook.mjs', ['--event','pre'], config, '{"conversationId":"root"}')
  assert.deepEqual(JSON.parse(pre.stdout), {})
  assert.deepEqual(db.prepare('SELECT DISTINCT session_id,author_role FROM procedure_outcomes ORDER BY session_id')
    .all().map(row => [row.session_id, row.author_role]), [['child','worker'], ['root','owner']])

  assert.deepEqual(await report(v2, {status: 'ok'}), {status: 'OK'})
  assert.equal((await read(v2)).fallbackVersion, null)
  await report(v2, {status: 'failed', failedStep: 1})
  commit({type: 'long.remove', id: procedure.id, expectedVersion: 2})
  assert.deepEqual(await report(workerHandle, {status: 'ok'}, worker), {status: 'INVALID_HANDLE'})
  commit({...procedure, expectedVersion: 3})
  assert.deepEqual(await report(v2, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  const restored = await handleFor('Checklist')
  view = await read(restored)
  assert.deepEqual([view.lastOutcome.procedureVersion, view.recentFailures, view.fallbackVersion], [2, 0, null])
  await report(restored, {status: 'failed'})
  assert.equal((await read(restored)).fallbackVersion, 2)
})
