import { homedir } from 'node:os'
import { openDatabase, listShort } from '../storage/database.mjs'
import { captureStop } from '../organizer/queue.mjs'
import { settings, scopeForSession } from '../organizer/settings.mjs'
import { session } from './sessions.mjs'

const inject = text => ({ injectSteps: [{ systemMessage: { systemMessage: text } }] })

function handleHook(db, config, input, event) {
  const id = input.conversationId
  if (typeof id !== 'string' || !id) return {}
  let current = session(db, id)
  if (event === 'stop') return stop(db, config, input, current)
  if (!current) {
    // A first SessionStart may have collided with database initialization or a writer.
    // The next PreInvocation can register and deliver the initial list exactly once.
    const scope = scopeForSession(config, input.workspacePaths ?? [], id)
    db.prepare("INSERT OR IGNORE INTO session_roles (conversationId,role,scope) VALUES (?,'reader',?)").run(id, scope)
    current = session(db, id)
  }
  if (current.role === 'organizer' || (event === 'start' && current.seen_rev >= 0)) return {}
  const revision = db.prepare('SELECT rev FROM list_revisions WHERE scope=?').get(current.scope)?.rev ?? 0
  if (revision === current.seen_rev) return {}
  const { items, list_rev } = listShort(db, current.scope)
  // Only one competing invocation may publish a particular change to the conversation.
  const won = db.prepare('UPDATE session_roles SET seen_rev=?,snapshot=? WHERE conversationId=? AND seen_rev=?')
    .run(list_rev, JSON.stringify(items), id, current.seen_rev).changes
  if (!won) return {}
  if (current.seen_rev < 0) {
    const rows = items.map(row => [row.id, row.title, row.status, row.updatedAt].map(x => JSON.stringify(x)).join(' | '))
    return inject(['Short-term memory (list_rev=' + list_rev + ', organizer=' + config.mode + ')',
      'id | title | status | updatedAt', ...rows].join('\n'))
  }
  const previous = new Map(JSON.parse(current.snapshot).map(item => [item.id, item]))
  const diff = []
  for (const item of items) {
    const old = previous.get(item.id)
    if (!old) diff.push('+ ' + JSON.stringify(item.id) + ' ' + JSON.stringify(item.title))
    else if (old.title !== item.title || old.status !== item.status || old.updatedAt !== item.updatedAt)
      diff.push('~ ' + JSON.stringify(item.id) + ' ' + JSON.stringify(item.title) + ' ' + JSON.stringify(item.status))
    previous.delete(item.id)
  }
  for (const key of previous.keys()) diff.push('- ' + JSON.stringify(key))
  if (!diff.length) return {}
  let summary = diff.join(' / ')
  if (summary.length > 220) {
    summary = ['+', '~', '-'].map(mark => mark + diff.filter(entry => entry.startsWith(mark)).length).join(' / ')
      + ' (short_term_list)'
  }
  return inject('Memory list_rev=' + list_rev + ' ' + summary)
}

function stop(dbOrFile, config, input, binding) {
  if (binding?.role !== 'organizer' && typeof input.conversationId === 'string' && input.conversationId &&
      typeof input.transcriptPath === 'string' && input.transcriptPath) {
    const path = input.transcriptPath.replace(/^~[\\/]/, () => homedir() + '/')
    captureStop(dbOrFile, { sourceSessionId: input.conversationId, authorRole: binding?.role === 'owner' ? 'owner' : 'worker',
      scope: binding?.scope ?? scopeForSession(config, input.workspacePaths ?? [], input.conversationId),
      transcriptPath: path, unbound: !binding })
  }
  return {}
}

async function run() {
  let raw = ''
  for await (const chunk of process.stdin.setEncoding('utf8')) raw += chunk
  const input = JSON.parse(raw)
  const args = process.argv.slice(2)
  const inferred = 'terminationReason' in input || 'executionNum' in input || 'fullyIdle' in input ? 'stop'
    : 'invocationNum' in input ? 'pre' : 'start'
  const event = args.length === 0 ? inferred : args.length === 2 && args[0] === '--event' ? args[1] : undefined
  if (!['start','pre','stop'].includes(event)) throw new Error('Invalid hook event')
  const config = settings()
  let db
  try {
    db = openDatabase(config.databaseFile, { busyTimeout: 25 })
    return handleHook(db, config, input, event)
  } catch (error) {
    if ((error.errcode & 255) !== 5) throw error
    // If even the database could not open, preserve the boundary at worker authority.
    return event === 'stop' ? stop(config.databaseFile, config, input, null) : {}
  } finally {
    db?.close()
  }
}

// A plugin fault must not cancel a host model turn. Keep transcript data and local paths out of diagnostics.
const result = await run().catch(() => {
  process.stderr.write('agent-memory: hook unavailable\n')
  return {}
})
process.stdout.write(JSON.stringify(result) + '\n')
