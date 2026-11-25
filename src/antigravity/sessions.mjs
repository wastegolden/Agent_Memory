export function session(db, id) {
  return db.prepare('SELECT * FROM session_roles WHERE conversationId=?').get(id)
}

// Authority comes from the host's per-call metadata, outside the model's tool arguments.
export function organizerSession(db, meta) {
  const id = meta?.['antigravity.google/conversation_id']
  const parentId = meta?.['antigravity.google/parent_conversation_id']
  const rootId = meta?.['antigravity.google/root_conversation_id']
  const parent = parentId || rootId
  if (typeof id !== 'string' || !id || typeof parent !== 'string' || !parent || id === parent ||
      (rootId && rootId !== parent) ||
      meta['antigravity.google/agent_name'] !== 'memory-organizer') return null
  db.exec('BEGIN IMMEDIATE')
  try {
    const bound = session(db, parent)
    const child = session(db, id)
    const parentConfirmed = bound?.role === 'owner' || (bound?.role === 'reader' && rootId === parent)
    const alreadyBound = child?.role === 'organizer' && child.scope === bound?.scope
    if (!parentConfirmed || (child && child.role !== 'reader' && !alreadyBound)) return null
    if (!alreadyBound) {
      if (db.prepare('SELECT 1 FROM memory_queue WHERE sourceSessionId=? LIMIT 1').get(id)) return null
      // A child can receive a private SessionStart scope before the host identifies its parent.
      // Retire unconsumed captures with the provisional session. Later markers recheck role.
      db.prepare('DELETE FROM transcript_ranges WHERE sourceSessionId=?').run(id)
      db.prepare('DELETE FROM transcript_cursor WHERE sourceSessionId=?').run(id)
      db.prepare(`INSERT INTO session_roles (conversationId,role,scope) VALUES (?,'organizer',?)
        ON CONFLICT(conversationId) DO UPDATE SET role='organizer',scope=excluded.scope,
        seen_rev=-1,snapshot='[]'`).run(id, bound.scope)
    }
    if (bound.role === 'reader') db.prepare("UPDATE session_roles SET role='owner' WHERE conversationId=?").run(parent)
    db.exec('COMMIT')
    return { role: 'organizer', scope: bound.scope }
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK')
  }
}
