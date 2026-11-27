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
  // Both revision counters, the directory and its change log share one read snapshot.
  db.exec('BEGIN')
  const {list_rev, long_rev} = db.prepare(`SELECT
    coalesce((SELECT rev FROM list_revisions WHERE scope=?),0) AS list_rev,
    coalesce((SELECT rev FROM long_revisions WHERE scope=?),0) AS long_rev`).get(current.scope, current.scope)
  if (list_rev === current.seen_rev && long_rev === current.seen_long_rev) {
    db.exec('COMMIT')
    return {}
  }
  const initial = current.seen_rev < 0
  const items = list_rev !== current.seen_rev ? listShort(db, current.scope).items : null
  const messages = []
  if (initial) {
    const rows = items.map(row => [row.id, row.title, row.status, row.updatedAt].map(x => JSON.stringify(x)).join(' | '))
    messages.push(['Short-term memory (list_rev=' + list_rev + ', organizer=' + config.mode + ')',
      'id | title | status | updatedAt', ...rows].join('\n'))
  } else {
    if (items) {
      const summary = shortDiff(items, current.snapshot, list_rev)
      if (summary) messages.push(summary)
    }
    if (long_rev > current.seen_long_rev) {
      messages.push(longDiff(db, current.scope, current.seen_long_rev, long_rev))
    }
  }
  const won = db.prepare(`UPDATE session_roles SET seen_rev=?,snapshot=?,seen_long_rev=?
    WHERE conversationId=? AND seen_rev=? AND seen_long_rev=?`)
    .run(list_rev, items ? JSON.stringify(items) : current.snapshot, long_rev, id, current.seen_rev, current.seen_long_rev).changes
  db.exec('COMMIT')
  return won && messages.length ? inject(messages.join(' | ')) : {}
}

function shortDiff(items, snapshot, list_rev) {
  const previous = new Map(JSON.parse(snapshot).map(item => [item.id, item]))
  const diff = []
  for (const item of items) {
    const old = previous.get(item.id)
    if (!old) diff.push('+ ' + JSON.stringify(item.id) + ' ' + JSON.stringify(item.title))
    else if (old.title !== item.title || old.status !== item.status || old.updatedAt !== item.updatedAt)
      diff.push('~ ' + JSON.stringify(item.id) + ' ' + JSON.stringify(item.title) + ' ' + JSON.stringify(item.status))
    previous.delete(item.id)
  }
  for (const key of previous.keys()) diff.push('- ' + JSON.stringify(key))
  if (!diff.length) return ''
  let summary = diff.join(' / ')
  if (summary.length > 220) {
    summary = ['+', '~', '-'].map(mark => mark + diff.filter(entry => entry.startsWith(mark)).length).join(' / ')
      + ' (short_term_list)'
  }
  return 'Memory list_rev=' + list_rev + ' ' + summary
}

function longDiff(db, scope, since, revision) {
  const prefix = 'Long memory rev=' + revision + ': '
  const counts = {'+': 0, '~': 0, '-': 0}
  let summary = ''
  const events = db.prepare(`SELECT kind,id,action,from_version,to_version FROM long_events
    WHERE scope=? AND rev>? AND rev<=? ORDER BY rev,seq`).iterate(scope, since, revision)
  for (const {kind,id,action,from_version,to_version} of events) {
    counts[action]++
    if (summary === null) continue
    if (id.startsWith('#')) {
      summary = null
      continue
    }
    const label = kind === 'procedure' ? 'proc' : 'fact'
    summary += (summary ? ' / ' : '') + action + label + ':' + id
    if (action === '~') summary += '(v' + from_version + '->v' + to_version + ')'
    if (prefix.length + summary.length > 220) summary = null
  }
  return prefix + (summary ?? Object.entries(counts).map(([action,n]) => action + n).join(' / '))
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
