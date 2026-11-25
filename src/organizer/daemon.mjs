import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { openDatabase } from '../storage/database.mjs'
import { CommitService } from '../storage/commit.mjs'
import { pullForOrganizer } from './contract.mjs'
import { deferBatch, pendingScopes } from './queue.mjs'
import { settings } from './settings.mjs'

function providerConfig(env) {
  const style = env.MEMORY_API_STYLE || 'openai'
  const model = env.MEMORY_API_MODEL
  if (!['openai', 'gemini'].includes(style) || !model || !env.MEMORY_API_BASE_URL) {
    throw new Error('Configure MEMORY_API_STYLE, MEMORY_API_MODEL and MEMORY_API_BASE_URL')
  }
  const base = new URL(env.MEMORY_API_BASE_URL)
  if (!['https:', 'http:'].includes(base.protocol) || base.search || base.hash || base.username || base.password) {
    throw new Error('Invalid MEMORY_API_BASE_URL')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return {style, model, base, key: env.MEMORY_API_KEY}
}

async function propose(batch, {style, model, base, key}, signal) {
  const {instructions, scope, context, events, current} = batch
  const input = JSON.stringify({scope, context, events, current})
  const headers = {'content-type': 'application/json'}
  let route, body
  if (style === 'gemini') {
    if (key) headers['x-goog-api-key'] = key
    route = 'models/' + encodeURIComponent(model) + ':generateContent'
    body = {systemInstruction: {parts: [{text: instructions}]},
      contents: [{role: 'user', parts: [{text: input}]}], generationConfig: {responseMimeType: 'application/json'}}
  } else {
    if (key) headers.authorization = 'Bearer ' + key
    route = 'chat/completions'
    body = {model, messages: [{role: 'system', content: instructions}, {role: 'user', content: input}],
      response_format: {type: 'json_object'}}
  }
  const deadline = AbortSignal.timeout(90_000)
  const response = await fetch(new URL(route, base), {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline, redirect: 'error',
  })
  if (!response.ok) throw new Error('Organizer provider HTTP ' + response.status)
  const result = await response.json()
  const choice = style === 'gemini' ? result.candidates?.[0] : result.choices?.[0]
  const finish = choice?.finishReason ?? choice?.finish_reason
  if (finish && !['STOP', 'stop'].includes(finish)) throw new Error('Incomplete provider response')
  const text = style === 'gemini'
    ? choice?.content?.parts?.filter(part => !part.thought).map(part => part.text ?? '').join('')
    : choice?.message?.content
  if (typeof text !== 'string') throw new Error('Missing organizer response')
  const answer = JSON.parse(text)
  if (!answer || !Array.isArray(answer.operations)) throw new Error('Invalid organizer response')
  return answer.operations
}

export async function runDaemon({env = process.env, once = false, signal} = {}) {
  const config = settings(env)
  if (config.mode !== 'daemon') throw new Error('Set MEMORY_MODE=daemon to run this consumer')
  const provider = providerConfig(env)
  const db = openDatabase(config.databaseFile)
  const service = new CommitService(db, {capacity: config.capacity})
  const consumerId = 'daemon-' + randomUUID()
  try {
    do {
      let scopes
      try { scopes = pendingScopes(db).filter(scope => !config.scope || config.scope === scope) }
      catch (error) {
        if ((error.errcode & 255) !== 5 || once) throw error
        await sleep(2_000, undefined, {signal})
        continue
      }
      for (const scope of scopes) {
        try {
          const batch = pullForOrganizer(db, {scope, consumerId, context: config.context})
          if (!batch) continue
          try {
            const operations = await propose(batch, provider, signal)
            const result = service.commit({scope, batchId: batch.batchId, proposalId: batch.batchId, operations}, consumerId)
            if (result.status !== 'COMMITTED') throw new Error('Organizer commit ' + result.status)
            if (once) return result
          } catch (error) {
            if (!signal?.aborted) deferBatch(db, batch.batchId, consumerId)
            throw error
          }
        } catch (error) {
          if (once || signal?.aborted) throw error
          // Invalid replies can contain model text or secrets. Keep the queue
          // pending and use only a generic diagnostic in unattended mode.
          process.stderr.write('Organizer batch pending for retry.\n')
        }
      }
      if (once) return {status: 'IDLE'}
      if (!signal?.aborted) await sleep(2_000, undefined, {signal})
    } while (!signal?.aborted)
  } finally { db.close() }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const stop = new AbortController()
  process.once('SIGTERM', () => stop.abort())
  process.once('SIGINT', () => stop.abort())
  runDaemon({once: process.argv.includes('--once'), signal: stop.signal})
    .then(result => { if (result) console.log(JSON.stringify(result)) })
    .catch(error => {
      if (stop.signal.aborted) return
      // JSON parser errors may quote model-produced text.
      console.error(error instanceof SyntaxError ? 'Invalid JSON from organizer input or provider' : error.message)
      process.exitCode = 1
    })
}
