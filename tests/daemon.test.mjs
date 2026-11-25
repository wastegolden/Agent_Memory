import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { openDatabase, listShort, readShort } from '../src/storage/database.mjs'
import { initQueue, enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { onExit, runScript, sandbox } from './helpers/host-process.mjs'

for (const style of ['openai', 'gemini']) {
  test(`daemon consumes and commits through a real ${style} HTTP endpoint`, async t => {
    const { dir, env } = sandbox(t)
    const scope = 'release', eventText = '检查备用端口后发布'
    const db = openDatabase(join(dir, 'memory.sqlite'))
    onExit(t, () => db.close())
    initQueue(db)
    enqueue(db, { scope, sourceSessionId: 'operator-session', authorRole: 'owner',
      sourceId: 'turn-7', text: eventText })
    // An exited organizer leaves a lease. The standalone daemon must recover it.
    const abandoned = pullBatch(db, { scope, consumerId: 'exited', leaseMs: 1 })
    const eventId = abandoned.events[0].id
    const operation = { type: 'short.put', id: 'release-check', expectedVersion: 0,
      title: '端口检查', body: eventText, status: 'open', sourceIds: [eventId] }
    const answer = JSON.stringify({ operations: [operation] })
    const calls = []
    const api = createServer(async (req, res) => {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({ url: req.url, method: req.method, headers: req.headers, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(style === 'openai'
        ? { choices: [{ message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }
        : { candidates: [{ content: { role: 'model', parts: [{ text: answer }] }, finishReason: 'STOP' }] }))
    })
    api.listen(0, 'localhost')
    await once(api, 'listening')
    onExit(t, () => new Promise(resolve => api.close(resolve)))
    const key = randomUUID(), model = 'memory-test-model'
    const basePath = style === 'openai' ? '/v1' : '/v1beta'
    const config = { ...env, MEMORY_MODE: 'daemon', MEMORY_SCOPE: scope, MEMORY_API_STYLE: style,
      MEMORY_API_KEY: key, MEMORY_API_MODEL: model,
      MEMORY_API_BASE_URL: 'http://localhost:' + api.address().port + basePath }
    const run = mode => runScript('src/organizer/daemon.mjs', ['--once'], { ...config, MEMORY_MODE: mode })
    const disabled = await run('subagent')
    assert.notEqual(disabled.code, 0)
    assert.equal(calls.length, 0)

    const active = await run('daemon')
    assert.equal(active.code, 0, active.stderr)
    assert.equal(calls.length, 1)
    const [call] = calls
    assert.equal(call.method, 'POST')
    if (style === 'openai') {
      assert.equal(call.url, basePath + '/chat/completions')
      assert.equal(call.headers.authorization, 'Bearer ' + key)
      assert.equal(call.body.model, model)
      assert.ok(Array.isArray(call.body.messages))
      assert.ok(JSON.stringify(call.body.messages).includes(eventText))
    } else {
      assert.equal(call.url, basePath + '/models/' + model + ':generateContent')
      assert.equal(call.headers['x-goog-api-key'], key)
      assert.ok(Array.isArray(call.body.contents))
      assert.ok(JSON.stringify(call.body.contents).includes(eventText))
    }
    assert.equal(listShort(db, scope).items.length, 1)
    assert.equal(readShort(db, scope, operation.id).body, eventText)
    assert.equal(pullBatch(db, { scope, consumerId: 'after-restart' }), null)
    assert.equal((await run('daemon')).code, 0)
    assert.equal(calls.length, 1)
  })
}

test('standalone daemon consumes later turns without restarting or an active MCP session', async t => {
  const { dir, env } = sandbox(t)
  const db = openDatabase(join(dir, 'memory.sqlite'))
  onExit(t, () => db.close())
  const scope = 'service', seen = []
  const api = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const input = JSON.parse(payload.messages.find(message => message.role === 'user').content)
    const [event] = input.events
    seen.push(event.sourceId)
    const content = JSON.stringify({ operations: [{ type: 'short.put', id: event.sourceId,
      expectedVersion: 0, title: event.text, body: event.text, status: 'open', sourceIds: [event.id] }] })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }))
  })
  api.listen(0, 'localhost')
  await once(api, 'listening')
  onExit(t, () => new Promise(resolve => api.close(resolve)))
  const post = sourceId => enqueue(db, { scope, authorRole: 'external', sourceSessionId: 'ingress',
    sourceId, text: 'Event ' + sourceId })
  post('first')
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/organizer/daemon.mjs', import.meta.url))], {
    stdio: 'ignore', windowsHide: true, env: { ...env, MEMORY_MODE: 'daemon', MEMORY_API_STYLE: 'openai',
      MEMORY_API_MODEL: 'local-test', MEMORY_API_BASE_URL: 'http://localhost:' + api.address().port },
  })
  const closed = once(child, 'close')
  onExit(t, async () => { child.kill(); await closed })
  async function waitForCommit(id) {
    const deadline = Date.now() + 10_000
    while (!readShort(db, scope, id) && Date.now() < deadline && child.exitCode === null) await sleep(40)
    assert.equal(readShort(db, scope, id)?.body, 'Event ' + id)
  }
  await waitForCommit('first')
  post('later')
  await waitForCommit('later')
  assert.deepEqual(seen, ['first', 'later'])
})
