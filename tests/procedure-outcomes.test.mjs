import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { MemorySearch } from '../src/retrieval/index.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { openDatabase, readLong, recordProcedureOutcome } from '../src/storage/database.mjs'
import { parseProposal } from '../src/storage/proposal.mjs'
import { onExit, runScript, sandbox, stdioClient } from './helpers/host-process.mjs'

const scope = 'release'
const procedure = {type: 'long.put', kind: 'procedure', id: 'internal-checklist', expectedVersion: 0,
  title: 'Checklist', data: {conditions: [], steps: ['inspect', 'publish', 'verify'], parameters: [], outwardSteps: [2]}}

for (const [legacyVersion, hasOutcomes] of [[2,false],[2,true],[3,true]]) {
  test(`v${legacyVersion} upgrade preserves revisions and sessions (existing outcomes: ${hasOutcomes})`, t => {
    const {dir} = sandbox(t)
    const file = join(dir, 'memory.sqlite')
    const db = openDatabase(file)
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4)
    db.exec(`DROP TABLE procedure_outcomes; DROP TABLE long_revisions; DROP TABLE long_events;
      DROP INDEX procedures_by_scope; DROP INDEX procedure_history_by_scope;
      ALTER TABLE session_roles DROP COLUMN seen_long_rev;
      INSERT INTO session_roles VALUES ('root','owner','release',8,'[]'),('new','reader','release',-1,'[]');
      INSERT INTO list_revisions VALUES ('release', 8);
      PRAGMA user_version=${legacyVersion}`)
    if (hasOutcomes) db.exec(`CREATE TABLE procedure_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,procedure_id TEXT NOT NULL,procedure_version INTEGER NOT NULL,
      status TEXT NOT NULL,failed_step INTEGER,outward_done INTEGER NOT NULL DEFAULT 0,detail TEXT NOT NULL DEFAULT '',
      author_role TEXT NOT NULL,session_id TEXT NOT NULL,recorded_at TEXT NOT NULL);
      CREATE INDEX procedure_outcomes_recent ON procedure_outcomes(scope,procedure_id,id DESC);
      INSERT INTO procedure_outcomes VALUES (5,'release','p',1,'ok',NULL,0,'first','worker','s','t'),
        (9,'release','p',2,'failed',2,1,'second','owner','s','u'),(15,'release','p',2,'ok',NULL,0,'','owner','s','v');
      DELETE FROM procedure_outcomes WHERE id=15`)
    const outcomes = hasOutcomes ? db.prepare('SELECT * FROM procedure_outcomes ORDER BY id').all() : []
    db.close()
    assert.throws(() => openDatabase(file, {readOnly: true}), /upgrade/)
    const upgraded = openDatabase(file)
    onExit(t, () => upgraded.close())
    assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version, 4)
    assert.equal(upgraded.prepare('SELECT rev FROM list_revisions WHERE scope=?').get(scope).rev, 8)
    assert.deepEqual(upgraded.prepare('SELECT * FROM procedure_outcomes ORDER BY id').all(), outcomes)
    assert.deepEqual(upgraded.prepare('SELECT seen_rev,seen_long_rev FROM session_roles ORDER BY conversationId').all()
      .map(row => [row.seen_rev,row.seen_long_rev]), [[-1,-1],[8,0]])
    recordProcedureOutcome(upgraded, {scope, procedureId:'p', procedureVersion:2, status:'failed', authorRole:'owner', sessionId:'s'})
    const last = upgraded.prepare('SELECT id,outward_done FROM procedure_outcomes ORDER BY id DESC LIMIT 1').get()
    assert.deepEqual({...last}, {id: hasOutcomes ? 16 : 1, outward_done:null})
    assert.throws(() => upgraded.exec('UPDATE procedure_outcomes SET outward_done=2'), /CHECK/)
    assert.deepEqual(upgraded.prepare('PRAGMA index_xinfo(procedure_outcomes_recent)').all()
      .filter(row => row.key).map(row => [row.name, row.desc]), [['scope', 0], ['procedure_id', 0], ['id', 1]])
  })
}

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
  const read = (handle, version) => call('read', {handle, version})
  const v1 = await handleFor('Checklist')
  const {lastOutcome, recentFailures, fallbackVersion} = await read(v1)
  assert.deepEqual([lastOutcome, recentFailures, fallbackVersion], [null, 0, null])
  const fact = await handleFor('Mode')
  assert.equal(Object.hasOwn(await read(fact), 'lastOutcome'), false)
  assert.deepEqual(await read(fact, 1), {status:'INVALID_HANDLE'})
  for (const version of [0, -1, 1.5, '1', null]) assert.deepEqual(await read(v1, version), {status:'INVALID_INPUT'})
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
  commit({...procedure, expectedVersion: 1, data: {...procedure.data, steps:['new inspection','publish','verify']}})
  const changed = await runScript('src/antigravity/hook.mjs', ['--event','pre'], config, '{"conversationId":"root"}')
  assert.match(changed.stdout, /Long memory rev=2/)
  assert.deepEqual(await report(v1, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  const v2 = await handleFor('Checklist')
  const before = readLong(db, scope, procedure.id)
  const queueBefore = db.prepare('SELECT * FROM memory_queue ORDER BY id').all()
  const workerHandle = await handleFor('Checklist', worker)
  assert.deepEqual(await report(workerHandle, {status: 'failed', failedStep: 1, detail: 'missing input'}, worker),
    {status: 'OK'})
  let view = await read(v2)
  assert.deepEqual(view.lastOutcome, {procedureVersion: 2, status: 'failed', failedStep: 1, outwardDone: false,
    detail: 'missing input', authorRole: 'worker', recordedAt: new Date(view.lastOutcome.recordedAt).toISOString()})
  assert.deepEqual([view.recentFailures, view.fallbackVersion], [1, 1])
  const historical = await read(v2, view.fallbackVersion)
  assert.deepEqual(historical, {status:'OK', record:{kind:'procedure', title:'Checklist', data:procedure.data,
    context:'', validFrom:null, validUntil:null, version:1}, sources:[{kind:'event', id:1}]})
  assert.deepEqual(await read(v2, 99), {status:'NOT_FOUND'})
  assert.deepEqual(await read(v1, 1), {status:'INVALID_HANDLE'})
  assert.deepEqual(await call('read', {handle:v2, version:1}, worker), {status:'INVALID_HANDLE'})
  assert.deepEqual(await report(v2, {status:'ok', version:1}), {status:'INVALID_INPUT'})
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
  assert.deepEqual(db.prepare('SELECT * FROM memory_queue ORDER BY id').all(), queueBefore)
  assert.equal((await call('short_term_list', {})).list_rev, 1)
  assert.equal(db.prepare('SELECT rev FROM long_revisions WHERE scope=?').get(scope).rev, 2)
  const pre = await runScript('src/antigravity/hook.mjs', ['--event','pre'], config, '{"conversationId":"root"}')
  assert.deepEqual(JSON.parse(pre.stdout), {})
  assert.deepEqual(db.prepare('SELECT DISTINCT session_id,author_role FROM procedure_outcomes ORDER BY session_id')
    .all().map(row => [row.session_id, row.author_role]), [['child','worker'], ['root','owner']])

  assert.deepEqual(await report(v2, {status: 'ok'}), {status: 'OK'})
  assert.equal((await read(v2)).fallbackVersion, null)
  await report(v2, {status: 'failed', failedStep: 1})
  commit({type: 'long.remove', id: procedure.id, expectedVersion: 2})
  assert.deepEqual(await read(v2, 1), {status:'INVALID_HANDLE'})
  assert.deepEqual(await report(workerHandle, {status: 'ok'}, worker), {status: 'INVALID_HANDLE'})
  commit({...procedure, expectedVersion: 3})
  assert.deepEqual(await report(v2, {status: 'ok'}), {status: 'INVALID_HANDLE'})
  const restored = await handleFor('Checklist')
  view = await read(restored)
  assert.deepEqual([view.lastOutcome.procedureVersion, view.recentFailures, view.fallbackVersion], [2, 0, null])
  await report(restored, {status: 'failed'})
  assert.deepEqual([(await read(restored)).lastOutcome.outwardDone, (await read(restored)).fallbackVersion], [null, null])
  assert.deepEqual(await read(restored, 3), {status:'NOT_FOUND'})
  await report(restored, {status:'failed', outwardDone:false})
  assert.equal((await read(restored)).fallbackVersion, 1)
})

test('outward evidence is three-state for marked and unmarked procedures', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const search = new MemorySearch(db)
  const identity = {scope, sessionId:'runner', authorRole:'worker'}
  const service = new CommitService(db)
  for (const markers of [undefined, [], [2]]) {
    const id = markers === undefined ? 'legacy' : markers.length ? 'marked' : 'unmarked'
    const data = {conditions:[], steps:['inspect','send'], parameters:[]}
    if (markers) data.outwardSteps = markers
    enqueue(db, {scope, sourceId:randomUUID(), sourceSessionId:'s', authorRole:'worker', text:'evidence'})
    const {batchId} = pullBatch(db, {scope, consumerId:'organizer'})
    const op = {...procedure, id, title:id, data}
    assert.equal(service.commit({scope, batchId, proposalId:id, operations:[op, {...op, expectedVersion:1}]},
      'organizer').status, 'COMMITTED')
    recordProcedureOutcome(db, {...identity, procedureId:id, procedureVersion:1, status:'ok'})
    const {handle} = search.search({text:id}, identity).results.find(hit => hit.title === id)
    assert.deepEqual(search.read({handle, version:0}, identity), {status:'INVALID_INPUT'})
    assert.deepEqual(search.read({handle, version:0}, {...identity, scope:'other'}), {status:'INVALID_HANDLE'})
    for (const [args, expected] of [
      [{status:'failed'}, null], [{status:'ok'}, null], [{status:'fallback'}, null],
      [{status:'failed', failedStep:1}, markers?.length ? false : null],
      [{status:'failed', failedStep:2}, markers?.length ? true : null],
      [{status:'failed', failedStep:2, outwardDone:false}, Boolean(markers?.length)],
      [{status:'failed', outwardDone:false}, false], [{status:'failed', outwardDone:true}, true],
    ]) {
      assert.deepEqual(search.reportOutcome(db, {handle, ...args}, identity), {status:'OK'})
      const view = search.read({handle}, identity)
      assert.equal(view.lastOutcome.outwardDone, expected)
      assert.equal(view.fallbackVersion, expected === false && args.status === 'failed' ? 1 : null)
    }
  }
})

test('fallback selects the highest surviving version with a winning count and a non-failed latest outcome', t => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const search = new MemorySearch(db)
  const identity = {scope, sessionId:'runner', authorRole:'owner'}
  enqueue(db, {scope, sourceId:'seed', sourceSessionId:'s', authorRole:'owner', text:'checklist'})
  const {batchId} = pullBatch(db, {scope, consumerId:'organizer'})
  const operations = [procedure, {...procedure,expectedVersion:1}, {type:'long.remove',id:procedure.id,expectedVersion:2},
    {...procedure,expectedVersion:3}]
  assert.equal(new CommitService(db).commit({scope,batchId,proposalId:'p',operations},'organizer').status, 'COMMITTED')
  const {handle} = search.search({text:procedure.title},identity).results[0]
  const outcome = (version,status) => recordProcedureOutcome(db, {...identity, procedureId:procedure.id,
    procedureVersion:version, status, outwardDone:false})
  const check = expected => {
    outcome(4,'failed')
    assert.equal(search.read({handle},identity).fallbackVersion, expected)
  }
  outcome(3,'ok') // A tombstone stays ineligible even with an imported success.
  outcome(2,'fallback')
  check(null)
  outcome(1,'ok')
  check(1)
  outcome(2,'ok')
  check(2)
  outcome(2,'failed')
  check(1)
  outcome(2,'fallback')
  check(1) // One success and one failure, with a non-failed latest run.
  outcome(2,'failed')
  check(1)
  outcome(2,'ok')
  outcome(2,'ok')
  outcome(2,'ok')
  outcome(2,'failed') // Four successes vs three failures; latest failure disqualifies.
  check(1)
  outcome(2,'fallback')
  check(2)
  outcome(1,'ok')
  outcome(1,'failed') // Exactly two successes followed by one failure.
  outcome(2,'failed')
  check(null)
})
