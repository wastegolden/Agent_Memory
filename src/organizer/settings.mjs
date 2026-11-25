import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export function settings(env = process.env) {
  // PLUGIN_DATA is injected into MCP servers, but hooks and standalone daemons
  // also need the same default without having to discover a running host.
  const directory = env.MEMORY_DATA_DIR || join(homedir(), '.agent-memory')
  if (!isAbsolute(directory)) throw new Error('MEMORY_DATA_DIR must be absolute')
  const mode = env.MEMORY_MODE || 'subagent'
  if (!['subagent', 'daemon'].includes(mode)) throw new Error('Invalid MEMORY_MODE')
  const capacity = Number(env.MEMORY_CAPACITY || 18)
  if (!Number.isInteger(capacity) || capacity < 15 || capacity > 20) throw new Error('Invalid MEMORY_CAPACITY')
  return { databaseFile: join(directory, 'memory.sqlite'), mode, capacity,
    scope: env.MEMORY_SCOPE?.trim() || undefined, context: env.MEMORY_CONTEXT?.trim() || undefined }
}

export function scopeForSession(config, workspacePaths, conversationId) {
  if (config.scope) return config.scope
  const roots = [...new Set((workspacePaths ?? []).map(path => {
    const absolute = resolve(path)
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute
  }))].sort()
  const label = roots.length ? 'workspace' : 'session'
  const key = roots.length ? JSON.stringify(roots) : conversationId
  return label + '-' + createHash('sha256').update(key).digest('hex')
}
