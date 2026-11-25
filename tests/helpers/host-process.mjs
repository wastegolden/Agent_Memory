import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const cleanups = new WeakMap()

export function onExit(t, cleanup) {
  cleanups.get(t).push(cleanup)
}

export function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-memory-e2e-'))
  const callbacks = []
  cleanups.set(t, callbacks)
  t.after(async () => {
    for (const callback of callbacks.reverse()) await callback()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  })
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(MEMORY_|AGENT_MEMORY_|PLUGIN_|GEMINI_API_KEY$|OPENAI_API_KEY$|NODE_OPTIONS$)/i.test(name)))
  return { dir, env: { ...env, PLUGIN_ROOT: root, PLUGIN_DATA: dir, MEMORY_DATA_DIR: dir } }
}

export async function runScript(script, args, env, input = '') {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: root, env, windowsHide: true, timeout: 12_000, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const closed = once(child, 'close')
  child.stdin.end(input)
  const [code, signal] = await closed
  return { code, signal, stdout, stderr }
}

/** One persistent MCP transport so handle reuse and caller isolation use the same server process. */
export function stdioClient(t, args, env) {
  const child = spawn(process.execPath, ['src/antigravity/mcp.mjs', ...args], {
    cwd: root, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let nextId = 1, stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const pending = new Map()
  const lines = createInterface({ input: child.stdout })
  lines.on('line', line => {
    const message = JSON.parse(line)
    pending.get(message.id)?.resolve(message)
  })
  const closed = once(child, 'close')
  closed.then(() => {
    for (const { reject } of pending.values()) reject(new Error('MCP closed early: ' + stderr))
  })
  onExit(t, async () => {
    child.stdin.end()
    child.kill()
    await closed
  })
  function send(message) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
  }
  async function request(method, params) {
    const id = nextId++
    const response = Promise.withResolvers()
    pending.set(id, response)
    const timer = setTimeout(() => response.reject(new Error('MCP timed out: ' + method + ' ' + stderr)), 8_000)
    try {
      send({ id, method, params })
      const message = await response.promise
      assert.equal(message.jsonrpc, '2.0')
      assert.equal(message.id, id)
      return message
    } finally {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
  return {
    request,
    async initialize() {
      const { result } = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'host-test', version: '1' },
      })
      assert.ok(result.capabilities.tools)
      assert.ok(result.serverInfo.name)
      send({ method: 'notifications/initialized' })
    },
    async call(name, args = {}, meta) {
      const response = await request('tools/call', { name, arguments: args, ...(meta && { _meta: meta }) })
      if (response.error) return { error: response.error }
      return response.result.structuredContent ?? JSON.parse(response.result.content[0].text)
    },
  }
}
