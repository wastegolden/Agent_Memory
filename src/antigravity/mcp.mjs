import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { openDatabase, listShort, readShort } from '../storage/database.mjs'
import { CommitService } from '../storage/commit.mjs'
import { MemorySearch } from '../retrieval/index.mjs'
import { pullForOrganizer } from '../organizer/contract.mjs'
import { settings } from '../organizer/settings.mjs'
import { organizerSession, session } from './sessions.mjs'

const string = { type: 'string', minLength: 1 }
const schema = (properties = {}, required = Object.keys(properties)) =>
  ({ type: 'object', properties, required, additionalProperties: false })
const tools = [
  { name: 'short_term_list', description: 'List the current scoped short-term directory.', inputSchema: schema() },
  { name: 'short_term_read', description: 'Read a scoped short-term item by ID.', inputSchema: schema({ id: string }) },
  { name: 'search', description: 'Search for short titles and session-bound handles. On REFINE_QUERY, search one specific term at a time. Stop on NO_EVIDENCE.',
    inputSchema: schema({ text: { type: 'string', maxLength: 256 }, scope: string, context: { type: 'string' } }, ['text']) },
  { name: 'read', description: 'Read authorized evidence for a handle returned by search.',
    inputSchema: schema({ handle: string }) },
  { name: 'report_outcome', description: 'Report a procedure run using its search handle. Mark outwardDone if a step with external effects was reached.',
    inputSchema: schema({ handle: string, status: { type: 'string', enum: ['ok','failed','fallback'] },
      failedStep: { type: 'integer', minimum: 1 }, outwardDone: { type: 'boolean' },
      detail: { type: 'string', maxLength: 240 } }, ['handle','status']) },
  { name: 'organizer_pull_batch', description: 'Organizer only. Claim evidence and receive the current proposal contract.',
    inputSchema: schema() },
  { name: 'organizer_commit', description: 'Organizer only. Commit a proposal for the batch under its lease. Follow the operation contract returned by organizer_pull_batch.',
    inputSchema: schema({ batchId: string, proposalId: string, operations: { type: 'array', items: { type: 'object' } } }) },
]

const config = settings()
let reader, search, writer, attestor, commits
let initialized = false
const forbidden = { status: 'FORBIDDEN' }

function publicIdentity(db, id, meta) {
  const bound = session(db, id)
  if (!bound || bound.role === 'organizer') return null
  if (bound.role === 'reader' && !meta['antigravity.google/agent_name'] &&
      meta['antigravity.google/root_conversation_id'] === id && !meta['antigravity.google/parent_conversation_id']) {
    try {
      const writable = db === writer ? writer : (attestor ??= openDatabase(config.databaseFile, { busyTimeout: 0 }))
      if (writable.prepare("UPDATE session_roles SET role='owner' WHERE conversationId=? AND role='reader'").run(id).changes)
        bound.role = 'owner'
    } catch (error) {
      // Reads can proceed while another writer holds the lock.
      if ((error.errcode & 255) !== 5) throw error
    }
  }
  return { sessionId: id, scope: bound.scope, context: config.context, authorRole: bound.role === 'owner' ? 'owner' : 'worker' }
}

function call(tool, args, meta) {
  const id = meta?.['antigravity.google/conversation_id']
  if (typeof id !== 'string' || !id) return forbidden
  const organizes = tool.name.startsWith('organizer_')
  const agentName = meta['antigravity.google/agent_name']
  if (organizes ? (config.mode !== 'subagent' || agentName !== 'memory-organizer') : agentName === 'memory-organizer')
    return forbidden
  const shape = tool.inputSchema
  const invalid = { status: tool.name === 'search' ? 'INVALID_ARGUMENT' : 'INVALID_INPUT' }
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !Object.hasOwn(shape.properties, key)) ||
      shape.required.some(key => !Object.hasOwn(args, key))) return invalid
  for (const [key, value] of Object.entries(args)) {
    const field = shape.properties[key]
    if (field.type === 'string' && (typeof value !== 'string' || (field.minLength && !value.trim()) ||
        (field.maxLength && [...value].length > field.maxLength))) return invalid
    if (field.type === 'array' && !Array.isArray(value)) return invalid
    if (field.enum && !field.enum.includes(value)) return invalid
    if (field.type === 'integer' && (!Number.isInteger(value) || value < field.minimum)) return invalid
    if (field.type === 'boolean' && typeof value !== 'boolean') return invalid
  }
  // SessionStart owns initialization. Reads never create a store or write selections.
  if (!existsSync(config.databaseFile)) return forbidden
  if (organizes) {
    writer ??= openDatabase(config.databaseFile)
    const child = organizerSession(writer, meta)
    if (!child) return forbidden
    if (tool.name === 'organizer_pull_batch') {
      return { batch: pullForOrganizer(writer, { scope: child.scope, consumerId: id, context: config.context }) }
    }
    commits ??= new CommitService(writer, { capacity: config.capacity })
    return commits.commit({ ...args, scope: child.scope }, id)
  }
  reader ??= openDatabase(config.databaseFile, { readOnly: true })
  search ??= new MemorySearch(reader)
  if (tool.name === 'report_outcome') {
    writer ??= openDatabase(config.databaseFile)
    writer.exec('BEGIN IMMEDIATE')
    try {
      const identity = publicIdentity(writer, id, meta)
      if (!identity) return forbidden
      const result = search.reportOutcome(writer, args, identity)
      writer.exec('COMMIT')
      return result
    } finally {
      if (writer.isTransaction) writer.exec('ROLLBACK')
    }
  }
  const identity = publicIdentity(reader, id, meta)
  if (!identity) return forbidden
  switch (tool.name) {
    case 'short_term_list': return listShort(reader, identity.scope)
    case 'short_term_read': {
      const item = readShort(reader, identity.scope, args.id)
      if (!item) return { status: 'NOT_FOUND' }
      return { id: item.id, title: item.title, status: item.status, updatedAt: item.updatedAt, body: item.body,
        sources: item.sources.map(source => ({ kind: 'event', id: source.id })) }
    }
    case 'search':
      return search.search(args, identity)
    case 'read':
      return search.read(args, identity)
  }
}

const send = (id, body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...body }) + '\n')
const fail = (id, code, message) => send(id, { error: { code, message } })
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    let request
    try { request = JSON.parse(line) } catch { fail(null, -32700, 'Parse error'); continue }
    if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      fail(null, -32600, 'Invalid Request')
      continue
    }
    if (!Object.hasOwn(request, 'id')) continue
    const { id, method, params } = request
    if (method === 'initialize') {
      const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
      const protocolVersion = versions.includes(params?.protocolVersion) ? params.protocolVersion : versions[0]
      initialized = true
      send(id, { result: { protocolVersion, capabilities: { tools: {} },
        serverInfo: { name: 'agent-memory', version: '0.1.0' } } })
    } else if (method === 'ping') send(id, { result: {} })
    else if (!initialized) fail(id, -32002, 'Server not initialized')
    else if (method === 'tools/list') send(id, { result: { tools } })
    else if (method === 'tools/call') {
      const tool = tools.find(entry => entry.name === params?.name)
      if (!tool) { fail(id, -32602, 'Unknown tool'); continue }
      let value
      try { value = await call(tool, params.arguments ?? {}, params._meta) }
      catch (error) {
        value = { status: (error.errcode & 255) === 5 ? 'BUSY' : 'UNAVAILABLE' }
      }
      const isError = ['FORBIDDEN','INVALID_INPUT','INVALID_ARGUMENT','INVALID_PROPOSAL','INVALID_HANDLE','NOT_FOUND','UNAVAILABLE',
        'LEASE_LOST','VERSION_CONFLICT','PROPOSAL_CONFLICT','CAPACITY_REACHED','UNFINISHED','BUSY'].includes(value.status)
      send(id, { result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError } })
    } else fail(id, -32601, 'Method not found')
  }
} finally {
  reader?.close()
  attestor?.close()
  writer?.close()
}
