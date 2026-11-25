import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { runScript, sandbox, stdioClient } from './helpers/host-process.mjs'
import { enqueue, pendingScopes } from '../src/organizer/queue.mjs'

const mainTools = ['memory_short_term_list', 'memory_short_term_read', 'memory_search', 'memory_read']

function meta(id, root = id, organizer = false) {
  return {
    'antigravity.google/conversation_id': id,
    'antigravity.google/root_conversation_id': root,
    ...(organizer && { 'antigravity.google/agent_name': 'memory-organizer' }),
  }
}

function userLine(index, text) {
  return JSON.stringify({ step_index: index, type: 'USER_INPUT', source: 'USER_EXPLICIT',
    status: 'DONE', content: '<USER_REQUEST>' + text + '</USER_REQUEST>' }) + '\n'
}

async function hook(env, payload, event) {
  const child = await runScript('src/antigravity/hook.mjs', event ? ['--event', event] : [], env, JSON.stringify(payload))
  assert.equal(child.code, 0, child.stderr)
  return JSON.parse(child.stdout)
}

test('plugin declares only reader tools eager; explicit hook events override payload inference and fail open', async t => {
  const config = JSON.parse(readFileSync(new URL('../mcp_config.json', import.meta.url)))
  assert.deepEqual(Object.entries(config.mcpServers.memory.tools).filter(([, tool]) => tool.eager)
    .map(([name]) => name).sort(), [...mainTools].sort())
  const hooks = JSON.parse(readFileSync(new URL('../hooks.json', import.meta.url)))['agent-memory']
  for (const [key, event] of Object.entries({SessionStart:'start', PreInvocation:'pre', Stop:'stop'}))
    assert.deepEqual(hooks[key].map(x => x.command), ['node ./src/antigravity/hook.mjs --event ' + event])
  const { dir, env } = sandbox(t)
  const base = { conversationId: randomUUID(), transcriptPath: join(dir, 'minimal.jsonl') }
  writeFileSync(base.transcriptPath, userLine(0, 'Minimal Stop captured'))
  assert.match(injected(await hook(env, {...base, executionNum: 0}, 'start')), /list_rev/)
  assert.deepEqual(await hook(env, base, 'stop'), {})
  const server = stdioClient(t, [], env)
  await server.initialize()
  const child = meta(randomUUID(), base.conversationId, true)
  assert.equal((await server.call('memory_organizer_pull_batch', {}, child)).batch.events[0].text, 'Minimal Stop captured')
  for (const [input, options] of [['{', env], [JSON.stringify(base), {...env, MEMORY_CAPACITY:'bad'}]]) {
    const out = await runScript('src/antigravity/hook.mjs', ['--event','pre'], options, input)
    assert.equal(out.code, 0)
    assert.deepEqual(JSON.parse(out.stdout), {})
    assert.ok(out.stderr.includes('hook unavailable'))
    assert.ok(!out.stderr.includes(dir))
  }
})

test('a no-workspace provisional child safely adopts its parent scope without reading or collecting itself', async t => {
  const {dir,env} = sandbox(t)
  const root = randomUUID(), child = randomUUID(), otherRoot = randomUUID()
  const trace = join(dir, 'organizer.jsonl')
  const parentTrace = join(dir, 'parent.jsonl')
  writeFileSync(trace, userLine(0,'Self transcript'))
  writeFileSync(parentTrace, userLine(0,'Parent evidence'))
  const childHook = {conversationId:child, transcriptPath:trace}
  await hook(env, {conversationId:root}, 'start')
  await hook(env, childHook, 'start')
  const db = new DatabaseSync(join(dir,'memory.sqlite'))
  try {
    const bound = id => db.prepare('SELECT role,scope FROM session_roles WHERE conversationId=?').get(id)
    assert.notEqual(bound(root).scope, bound(child).scope)
    const server = stdioClient(t, [], env)
    await server.initialize()
    const organizer = meta(child, root, true)
    for (const [name,args] of [[mainTools[0],{}],[mainTools[1],{id:'x'}],[mainTools[2],{text:'x'}],[mainTools[3],{handle:'x'}]]) {
      assert.equal((await server.call(name, args, organizer)).status, 'FORBIDDEN')
    }
    await hook(env, {conversationId:root, transcriptPath:parentTrace}, 'stop')
    await hook(env, childHook, 'stop')
    pendingScopes(db) // Persist one cursor before binding, leaving its payload unread.
    appendFileSync(trace, userLine(1, 'Pending marker'))
    await hook(env, childHook, 'stop')
    const {batch} = await server.call('memory_organizer_pull_batch', {}, organizer)
    assert.deepEqual(batch.events.map(event => [event.sourceSessionId,event.text]), [[root,'Parent evidence']])
    assert.equal(bound(child).role, 'organizer')
    assert.equal(batch.scope, bound(child).scope)
    assert.equal(batch.scope, bound(root).scope)
    const receipt = await server.call('memory_organizer_commit',
      {batchId:batch.batchId,proposalId:randomUUID(),operations:[]}, organizer)
    assert.equal(receipt.status,'COMMITTED')
    await hook(env, childHook, 'stop')
    assert.equal((await server.call('memory_organizer_pull_batch', {}, organizer)).batch, null)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_queue WHERE sourceSessionId=?').get(child).n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM transcript_cursor WHERE sourceSessionId=?').get(child).n, 0)

    await hook(env, {conversationId:otherRoot}, 'start')
    const mismatch = {...meta(randomUUID(), otherRoot, true), 'antigravity.google/parent_conversation_id':root}
    assert.equal((await server.call('memory_organizer_pull_batch', {}, mismatch)).status, 'FORBIDDEN')
    assert.equal((await server.call('memory_organizer_pull_batch', {}, meta(child,otherRoot,true))).status, 'FORBIDDEN')
    assert.equal((await server.call('memory_organizer_pull_batch', {}, meta(root,otherRoot,true))).status, 'FORBIDDEN')
    const used = randomUUID()
    await hook(env, {conversationId:used}, 'start')
    enqueue(db, {sourceSessionId:used,scope:bound(used).scope,sourceId:'existing',text:'Existing event',authorRole:'worker'})
    assert.equal((await server.call('memory_organizer_pull_batch', {}, meta(used,otherRoot,true))).status, 'FORBIDDEN')
    assert.equal(bound(otherRoot).role,'reader')
    assert.equal(bound(used).role,'reader')
  } finally { db.close() }
})

test('a competing writer cannot block a public read and a named agent cannot obtain owner attribution', async t => {
  const {dir,env} = sandbox(t)
  const id = randomUUID()
  await hook(env, {conversationId:id}, 'start')
  const server = stdioClient(t, [], env)
  await server.initialize()
  const db = new DatabaseSync(join(dir, 'memory.sqlite'))
  try {
    db.exec('BEGIN IMMEDIATE')
    const before = performance.now()
    assert.deepEqual((await server.call('memory_short_term_list', {}, meta(id))).items, [])
    assert.ok(performance.now() - before < 2500)
    db.exec('ROLLBACK')
    const role = () => db.prepare('SELECT role FROM session_roles WHERE conversationId=?').get(id).role
    assert.equal(role(), 'reader')
    assert.deepEqual((await server.call('memory_short_term_list', {}, {...meta(id),'antigravity.google/agent_name':'research'})).items, [])
    assert.equal(role(), 'reader')
    await server.call('memory_short_term_list', {}, meta(id))
    assert.equal(role(), 'owner')
  } finally { db.close() }
})

function injected(response) {
  assert.equal(response.injectSteps.length, 1)
  const step = response.injectSteps[0]
  assert.deepEqual(Object.keys(step), ['systemMessage'])
  assert.equal(typeof step.systemMessage.systemMessage, 'string')
  return step.systemMessage.systemMessage
}

test('the public MCP rejects organizer calls while the daemon owns the queue', async t => {
  const { dir, env } = sandbox(t)
  const settings = { ...env, MEMORY_SCOPE: 'shared', MEMORY_MODE: 'daemon' }
  const root = randomUUID()
  await hook(settings, { conversationId: root, workspacePaths: [dir] })
  const server = stdioClient(t, [], settings)
  await server.initialize()
  const organizer = meta(randomUUID(), root, true)
  assert.equal((await server.call('memory_organizer_pull_batch', {}, organizer)).status, 'FORBIDDEN')
  assert.equal((await server.call('memory_organizer_commit', {
    batchId: randomUUID(), proposalId: randomUUID(), operations: [],
  }, organizer)).status, 'FORBIDDEN')
  assert.deepEqual((await server.call('memory_short_term_list', {}, meta(root))).items, [])
})

test('PreInvocation recovers a locked SessionStart and injects the initial list exactly once', async t => {
  const { dir, env } = sandbox(t)
  const base = { conversationId: randomUUID(), workspacePaths: [dir] }
  // A separate process already uses the plugin, so the database and its schema exist.
  await hook(env, { ...base, conversationId: randomUUID() })
  const locker = new DatabaseSync(join(dir, 'memory.sqlite'))
  try {
    locker.exec('BEGIN IMMEDIATE')
    assert.deepEqual(await hook(env, base), {})
  } finally { locker.close() }
  assert.match(injected(await hook(env, { ...base, invocationNum: 0 })), /list_rev/)
  assert.deepEqual(await hook(env, { ...base, invocationNum: 1 }), {})
})

test('a final Stop under a write lock preserves its exact byte range and original authority after restart', async t => {
  const { dir, env } = sandbox(t)
  const scope = 'release'
  const settings = { ...env, MEMORY_SCOPE: scope }
  const owner = randomUUID(), provisional = randomUUID()
  const payload = id => ({ conversationId: id, transcriptPath: join(dir, id + '.jsonl'), workspacePaths: [dir] })
  const clients = [owner, provisional].map(payload)
  for (const base of clients) {
    await hook(settings, base)
    writeFileSync(base.transcriptPath, userLine(1, 'Captured ' + base.conversationId))
  }
  const initial = stdioClient(t, [], settings)
  await initial.initialize()
  await initial.call('memory_short_term_list', {}, meta(owner))
  const locker = new DatabaseSync(join(dir, 'memory.sqlite'))
  try {
    locker.exec('BEGIN IMMEDIATE')
    const start = performance.now()
    const replies = await Promise.all(clients.map(base => hook(settings, {
      ...base, terminationReason: 'model_stop', executionNum: 1, fullyIdle: true,
    })))
    assert.deepEqual(replies, [{}, {}])
    assert.ok(performance.now() - start < 2_500, 'Stop should return before the ordinary 3s writer timeout')
  } finally { locker.close() }
  for (const base of clients) appendFileSync(base.transcriptPath, userLine(2, 'Appended after Stop'))
  const recovered = stdioClient(t, [], settings)
  await recovered.initialize()
  // Proof obtained after Stop must not elevate already captured provisional evidence.
  await recovered.call('memory_short_term_list', {}, meta(provisional))
  const worker = meta(randomUUID(), owner, true)
  const evidence = []
  for (let i = 0; i < clients.length; i++) {
    const { batch } = await recovered.call('memory_organizer_pull_batch', {}, worker)
    assert.ok(batch)
    evidence.push(...batch.events)
    assert.equal((await recovered.call('memory_organizer_commit', { batchId: batch.batchId,
      proposalId: randomUUID(), operations: [] }, worker)).status, 'COMMITTED')
  }
  assert.deepEqual(evidence.map(event => [event.sourceSessionId, event.authorRole, event.text]).sort(),
    [[owner, 'owner', 'Captured ' + owner], [provisional, 'worker', 'Captured ' + provisional]].sort())
  assert.equal((await recovered.call('memory_organizer_pull_batch', {}, worker)).batch, null)
})

test('Antigravity hooks, organizer and two main sessions share a scoped memory database over stdio', async t => {
  const { dir, env } = sandbox(t)
  const root = randomUUID(), other = randomUUID(), child = randomUUID()
  const work = join(dir, 'workspace')
  mkdirSync(work)
  const settings = { ...env, MEMORY_SCOPE: 'release', MEMORY_CONTEXT: 'staging', MEMORY_MODE: 'subagent' }
  const trace = join(dir, 'transcript.jsonl')
  writeFileSync(trace, '')
  const base = { conversationId: root, workspacePaths: [work], transcriptPath: trace, modelName: 'test' }
  const stop = { ...base, terminationReason: 'model_stop', executionNum: 1, fullyIdle: true }
  assert.match(injected(await hook(settings, base)), /list_rev/)
  assert.deepEqual(await hook(settings, base), {})
  assert.deepEqual(await hook(settings, { ...base, invocationNum: 1 }), {})

  const server = stdioClient(t, [], settings)
  await server.initialize()
  const principal = meta(root), worker = meta(child, root, true)
  const names = (await server.request('tools/list', { _meta: principal })).result.tools.map(tool => tool.name)
  for (const tool of mainTools) assert.ok(names.includes(tool))
  const empty = await server.call('memory_search', { text: 'release port' }, principal)
  assert.equal(empty.status, 'NO_EVIDENCE')
  assert.equal(empty.stop, true)
  assert.ok(empty.overview && empty.next)
  const forged = { batchId: 'missing', proposalId: randomUUID(), operations: [], role: 'organizer', _meta: worker }
  assert.equal((await server.call('memory_organizer_commit', forged, principal)).status, 'FORBIDDEN')
  assert.equal((await server.call('memory_organizer_pull_batch', {}, meta(root, root, true))).status, 'FORBIDDEN')
  assert.equal((await server.call('memory_organizer_pull_batch', {}, meta(child, root))).status, 'FORBIDDEN')

  const evidence = '发布前检查监听端口'
  appendFileSync(trace, userLine(1, evidence))
  appendFileSync(trace, JSON.stringify({ step_index: 2, type: 'SYSTEM_MESSAGE', source: 'SYSTEM',
    content: 'synthetic system instruction must never enter the organizer queue' }) + '\n')
  assert.deepEqual(await hook(settings, stop), {})
  assert.deepEqual(await hook(settings, stop), {})
  const { batch } = await server.call('memory_organizer_pull_batch', {}, worker)
  assert.ok(batch?.batchId)
  assert.equal(batch.context, 'staging')
  assert.equal(batch.events.length, 1)
  assert.ok(batch.events[0].text.includes(evidence))
  assert.equal(batch.events[0].sourceSessionId, root)
  assert.equal(batch.events[0].authorRole, 'owner')
  const sourceIds = [batch.events[0].id]
  const proposal = { batchId: batch.batchId, proposalId: randomUUID(), operations: [
    { type: 'short.put', id: 'check', expectedVersion: 0, title: '发布检查', body: evidence, status: 'open', sourceIds },
    { type: 'long.put', id: 'port', expectedVersion: 0, kind: 'fact', title: 'Staging port',
      data: { subject: 'service', key: 'service_port', value: 43210 }, context: 'staging', sourceIds },
  ] }
  assert.equal((await server.call('memory_organizer_commit', proposal, principal)).status, 'FORBIDDEN')
  assert.equal((await server.call('memory_organizer_commit', proposal, worker)).status, 'COMMITTED')
  assert.equal((await server.call('memory_organizer_pull_batch', {}, worker)).batch, null)

  const concurrent = await Promise.all([2, 3].map(invocationNum => hook(settings, { ...base, invocationNum })))
  assert.equal(concurrent.filter(output => output.injectSteps).length, 1)
  const digest = injected(concurrent.find(output => output.injectSteps))
  assert.equal(digest.split(/\r?\n/).length, 1)
  assert.ok(digest.includes('+'))
  assert.ok(!digest.includes(evidence))
  assert.deepEqual(await hook(settings, { ...base, invocationNum: 3 }), {})
  const list = await server.call('memory_short_term_list', {}, principal)
  assert.ok(list.list_rev > 0)
  assert.equal(list.items.length, 1)
  assert.deepEqual(Object.keys(list.items[0]).sort(), ['id', 'status', 'title', 'updatedAt'])
  assert.equal((await server.call('memory_short_term_read', { id: 'check' }, principal)).body, evidence)
  const found = await server.call('memory_search', { text: 'service_port' }, principal)
  assert.equal(found.status, 'OK')
  assert.equal(found.results.length, 1)
  assert.deepEqual(Object.keys(found.results[0]).sort(), ['handle', 'title'])
  assert.ok(!JSON.stringify(found).includes('43210'))
  const { handle } = found.results[0]
  const read = await server.call('memory_read', { handle }, principal)
  assert.equal(read.record.data.value, 43210)
  assert.deepEqual(read.sources.map(Object.keys), [['kind', 'id']])
  assert.equal((await server.call('memory_search', {text:'service_port',context:'production'}, principal)).status,'NO_EVIDENCE')
  const alternate = stdioClient(t, [], {...settings,MEMORY_CONTEXT:'production'})
  await alternate.initialize()
  assert.equal((await alternate.call('memory_search',{text:'service_port'},principal)).status,'NO_EVIDENCE')
  const override = await alternate.call('memory_search',{text:'service_port',context:'staging'},principal)
  assert.equal(override.status,'OK')
  assert.equal((await alternate.call('memory_read',{handle:override.results[0].handle},principal)).record.context,'staging')
  const invalid = (await server.request('tools/call', {name:'memory_search',arguments:{text:'service_port',context:null},_meta:principal})).result
  assert.equal(invalid.structuredContent.status,'INVALID_ARGUMENT')
  assert.equal(invalid.isError,true)

  // Same workspace and stdio transport, different registered conversation.
  assert.match(injected(await hook(settings, { ...base, conversationId: other })), /发布检查/)
  assert.equal((await server.call('memory_read', { handle }, meta(other))).status, 'INVALID_HANDLE')
  assert.equal((await alternate.call('memory_read', {handle:override.results[0].handle}, meta(other))).status, 'INVALID_HANDLE')
  const unrelated = randomUUID()
  await hook({ ...settings, MEMORY_SCOPE: 'unrelated' }, { ...base, conversationId: unrelated })
  const denied = await server.call('memory_search', { text: 'service_port', scope: 'release' }, meta(unrelated))
  assert.ok(['FORBIDDEN', 'NO_EVIDENCE'].includes(denied.status))
  assert.ok(!JSON.stringify(denied).includes('Staging port'))

  // The organizer cannot enqueue its own transcript, even if its workspace inherits hooks.
  const own = { ...base, conversationId: child }
  assert.deepEqual(await hook(settings, { ...own, invocationNum: 1 }), {})
  assert.deepEqual(await hook(settings, { ...stop, conversationId: child }), {})
  assert.equal((await server.call('memory_organizer_pull_batch', {}, worker)).batch, null)
  appendFileSync(trace, userLine(3, '发布复核'))
  assert.deepEqual(await hook(settings, { ...stop, executionNum: 2 }), {})
  const next = (await server.call('memory_organizer_pull_batch', {}, worker)).batch
  assert.equal(next.events.length, 1)
  assert.ok(next.events[0].text.includes('发布复核'))
  assert.notEqual(next.events[0].id, sourceIds[0])
  const existing = next.current.short.find(row => row.id === 'check')
  assert.equal(existing.version, 1)
  assert.equal((await server.call('memory_organizer_commit', {
    batchId: next.batchId, proposalId: randomUUID(), operations: [
      { type: 'short.put', id: existing.id, expectedVersion: existing.version, title: '发布复核',
        body: '单据已复核', status: 'done', sourceIds: [next.events[0].id] },
    ],
  }, worker)).status, 'COMMITTED')
  assert.ok(injected(await hook(settings, { ...base, invocationNum: 4 })).includes('~'))
  appendFileSync(trace, userLine(4, '划掉已完成的检查'))
  await hook(settings, { ...stop, executionNum: 3 })
  const last = (await server.call('memory_organizer_pull_batch', {}, worker)).batch
  const done = last.current.short.find(row => row.id === 'check')
  assert.equal((await server.call('memory_organizer_commit', {
    batchId: last.batchId, proposalId: randomUUID(), operations: [
      { type: 'short.archive', id: done.id, expectedVersion: done.version, sourceIds: [last.events[0].id] },
    ],
  }, worker)).status, 'COMMITTED')
  const removed = injected(await hook(settings, { ...base, invocationNum: 5 }))
  assert.match(removed, /- .*check/)
  assert.deepEqual(await hook(settings, { ...base, invocationNum: 6 }), {})

  // A nested agent's delegated prompt resembles user input in the transcript.
  // Its authority is still worker, even after it has used a public read tool.
  const delegated = randomUUID(), nestedTrace = join(dir, 'nested-transcript.jsonl')
  writeFileSync(nestedTrace, userLine(1, '移除 service_port'))
  const nested = { ...base, conversationId: delegated, transcriptPath: nestedTrace }
  await hook(settings, nested)
  await server.call('memory_short_term_list', {}, meta(delegated, root))
  await hook(settings, { ...nested, terminationReason: 'model_stop', fullyIdle: true })
  const lower = (await server.call('memory_organizer_pull_batch', {}, worker)).batch
  assert.equal(lower.events[0].authorRole, 'worker')
  const refused = await server.call('memory_organizer_commit', { batchId: lower.batchId, proposalId: randomUUID(),
    operations: [{ type: 'long.remove', id: 'port', expectedVersion: 1, sourceIds: [lower.events[0].id] }] }, worker)
  assert.equal(refused.status, 'FORBIDDEN')
  assert.equal((await server.call('memory_read', { handle }, principal)).record.data.value, 43210)
})
