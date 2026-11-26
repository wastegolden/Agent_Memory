import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('installed production entries start without core, package.json, npm or third-party imports', t => {
  const install = mkdtempSync(join(tmpdir(), 'agent-memory-install-test-'))
  t.after(() => rmSync(install, { recursive: true, force: true }))
  for (const dir of ['storage', 'retrieval', 'organizer', 'antigravity']) {
    cpSync(new URL('../src/' + dir, import.meta.url), join(install, 'src', dir), { recursive: true })
  }
  // Reject even accidentally resolvable packages in a parent/global installation.
  const guard = `import { registerHooks } from 'node:module';
    registerHooks({ resolve(s, c, next) {
      if (!s.startsWith('node:') && !s.startsWith('file:') && !s.startsWith('.'))
        throw Error('Non-native runtime import: ' + s);
      return next(s, c);
    }});`
  const env = { ...process.env, NODE_OPTIONS: '', MEMORY_MODE: 'subagent',
    MEMORY_DATA_DIR: join(install, 'data'), MEMORY_SCOPE: 'standalone', MEMORY_CAPACITY: '18' }
  const run = (file, input, overrides = {}, ...args) => {
    const result = spawnSync(process.execPath,
      ['--import', 'data:text/javascript,' + encodeURIComponent(guard), join(install, 'src', file), ...args],
      { cwd: install, env: { ...env, ...overrides }, encoding: 'utf8', input, timeout: 15000 })
    assert.equal(result.status, 0, result.error?.message || result.stderr)
    return result.stdout.trim().split('\n').map(line => JSON.parse(line))
  }
  const id = 'standalone-reader'
  const [start] = run('antigravity/hook.mjs', JSON.stringify({ conversationId: id, workspacePaths: [install] }))
  assert.match(start.injectSteps[0].systemMessage.systemMessage, /list_rev=0/)
  const requests = [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/call', params: { name: 'search', arguments: { text: 'unique-term' },
      _meta: { 'antigravity.google/conversation_id': id } } },
  ]
  const [, reply] = run('antigravity/mcp.mjs', requests.map(x => JSON.stringify({ jsonrpc: '2.0', ...x })).join('\n'))
  assert.equal(reply.result.structuredContent.status, 'NO_EVIDENCE')
  const [daemon] = run('organizer/daemon.mjs', '', { MEMORY_MODE: 'daemon', MEMORY_API_STYLE: 'openai',
    MEMORY_API_BASE_URL: 'https://service.invalid/v1', MEMORY_API_MODEL: 'fixture' }, '--once')
  assert.deepEqual(daemon, { status: 'IDLE' })
})
