import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const authors = ['owner', 'worker', 'external']

export function initQueue(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_queue (
      id INTEGER PRIMARY KEY, scope TEXT NOT NULL, authorRole TEXT NOT NULL,
      sourceSessionId TEXT NOT NULL, sourceId TEXT NOT NULL, text TEXT NOT NULL,
      batchId TEXT, consumerId TEXT, leaseUntil INTEGER, done INTEGER NOT NULL DEFAULT 0,
      retry_after INTEGER NOT NULL DEFAULT 0, retry_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(scope,sourceSessionId,sourceId)
    );
    CREATE INDEX IF NOT EXISTS queue_pending ON memory_queue(scope,done,id);
    CREATE INDEX IF NOT EXISTS queue_batch ON memory_queue(batchId);
    CREATE TABLE IF NOT EXISTS transcript_cursor (
      scope TEXT NOT NULL, sourceSessionId TEXT NOT NULL, path TEXT NOT NULL,
      generation TEXT NOT NULL, fileId TEXT NOT NULL, captured INTEGER NOT NULL, consumed INTEGER NOT NULL,
      stamp TEXT NOT NULL,
      PRIMARY KEY(scope,sourceSessionId)
    );
    CREATE TABLE IF NOT EXISTS transcript_ranges (
      scope TEXT NOT NULL, sourceSessionId TEXT NOT NULL, generation TEXT NOT NULL,
      endByte INTEGER NOT NULL, authorRole TEXT NOT NULL,
      PRIMARY KEY(scope,sourceSessionId,generation,endByte)
    );`)
}

function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = action()
    db.exec('COMMIT')
    return value
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export function enqueue(db, {scope, authorRole, sourceSessionId, sourceId, text}) {
  if (![scope, sourceSessionId, sourceId, text].every(v => typeof v === 'string' && v.trim()) ||
      !authors.includes(authorRole)) throw new Error('Invalid source event')
  db.prepare(`INSERT INTO memory_queue(scope,authorRole,sourceSessionId,sourceId,text)
    VALUES(?,?,?,?,?) ON CONFLICT(scope,sourceSessionId,sourceId) DO NOTHING`)
    .run(scope, authorRole, sourceSessionId, sourceId, text)
  return db.prepare('SELECT id FROM memory_queue WHERE scope=? AND sourceSessionId=? AND sourceId=?')
    .get(scope, sourceSessionId, sourceId).id
}

function fileId(stat) { return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}` }

function markerDirectory(database) {
  const file = typeof database === 'string' ? database : database.prepare('PRAGMA database_list').get().file
  return file && join(dirname(file), 'pending-stops', basename(file))
}

function applyCapture(db, {scope, authorRole, sourceSessionId, transcriptPath, identity, size, stamp, unbound}) {
  const session = db.prepare('SELECT scope,role FROM session_roles WHERE conversationId=?').get(sourceSessionId)
  if (session && (session.scope !== scope || session.role === 'organizer')) return
  if (unbound) authorRole = 'worker'
  const previous = db.prepare('SELECT * FROM transcript_cursor WHERE scope=? AND sourceSessionId=?')
    .get(scope,sourceSessionId)
  const sameFile = previous?.path === transcriptPath && previous.fileId === identity
  let earlier = previous && stamp <= previous.stamp
  if (!earlier && sameFile && size < previous.captured &&
      stamp.split('-')[1] < previous.stamp.split('-')[1]) {
    // A wall-clock rollback can publish the longer capture first. The monotonic
    // suffix identifies the older marker; check the file in case the host rebooted.
    const current = statSync(transcriptPath, { bigint: true, throwIfNoEntry: false })
    earlier = current && fileId(current) === identity && current.size >= previous.captured
  }
  if (earlier && !(sameFile && size > previous.captured)) {
    // A concurrent drain may already have published (& acknowledged) a later
    // boundary. A replay must never rewind its byte cursor.
    if (sameFile && size > previous.consumed && size < previous.captured)
      db.prepare('INSERT OR IGNORE INTO transcript_ranges VALUES(?,?,?,?,?)')
        .run(scope,sourceSessionId,previous.generation,size,authorRole)
    return
  }
  const same = sameFile && size >= previous.captured
  if (same && size === previous.captured) return
  const generation = same ? previous.generation : randomUUID()
  if (!same && previous) db.prepare('DELETE FROM transcript_ranges WHERE scope=? AND sourceSessionId=?')
    .run(scope,sourceSessionId)
  db.prepare(`INSERT INTO transcript_cursor(scope,sourceSessionId,path,generation,fileId,captured,consumed,stamp)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(scope,sourceSessionId) DO UPDATE SET
    path=excluded.path,generation=excluded.generation,fileId=excluded.fileId,
    captured=excluded.captured,consumed=excluded.consumed,stamp=excluded.stamp`)
    .run(scope,sourceSessionId,transcriptPath,generation,identity,size,same ? previous.consumed : 0,
      same && previous.stamp > stamp ? previous.stamp : stamp)
  if (size) db.prepare('INSERT INTO transcript_ranges VALUES(?,?,?,?,?)')
    .run(scope,sourceSessionId,generation,size,authorRole)
}

// The last Stop must survive a competing SQLite writer even if the host exits.
// Publish only its exact byte boundary. Consumers parse transcript bodies later.
export function captureStop(database, {scope, authorRole, sourceSessionId, transcriptPath, unbound = false}) {
  if (!authors.includes(authorRole)) throw new Error('Invalid transcript author')
  const stat = statSync(transcriptPath, {throwIfNoEntry: false, bigint: true})
  if (!stat?.isFile()) return
  const stamp = Date.now() + '-' + process.hrtime.bigint().toString().padStart(21,'0')
  const marker = {scope,authorRole,sourceSessionId,transcriptPath,unbound,identity:fileId(stat),size:Number(stat.size),stamp}
  const directory = markerDirectory(database)
  if (!directory) return transaction(database, () => applyCapture(database,marker))
  mkdirSync(directory, {recursive:true,mode:0o700})
  const path = join(directory,stamp + '-' + randomUUID())
  writeFileSync(path + '.tmp', JSON.stringify(marker), {mode:0o600,flag:'wx',flush:true})
  renameSync(path + '.tmp',path + '.json')
}

function drainCaptures(db) {
  const directory = markerDirectory(db)
  if (!directory) return
  let names
  try { names = readdirSync(directory) } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const markers = []
  for (const name of names.filter(name => name.endsWith('.json')).sort()) {
    const path = join(directory,name)
    try {
      const raw = readFileSync(path,'utf8')
      let marker
      try { marker = JSON.parse(raw) } catch { /* handled with malformed fields below */ }
      if (!marker || !authors.includes(marker.authorRole) ||
          ![marker.scope,marker.sourceSessionId,marker.transcriptPath,marker.identity,marker.stamp]
            .every(value => typeof value === 'string' && value.trim() && !value.includes('\0')) ||
          !Number.isSafeInteger(marker.size) || marker.size < 0 ||
          (marker.unbound !== undefined && typeof marker.unbound !== 'boolean')) {
        renameSync(path, path + '.corrupt')
        process.stderr.write('Quarantined a malformed transcript capture marker.\n')
        continue
      }
      markers.push({path,marker})
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  if (!markers.length) return
  transaction(db, () => {
    for (const {marker} of markers) applyCapture(db,marker)
  })
  for (const {path} of markers) rmSync(path,{force:true})
}

function messageOf(line, authorRole) {
  if (line.status && line.status !== 'DONE') return
  const user = line.type === 'USER_INPUT' && line.source === 'USER_EXPLICIT'
  const assistant = line.type === 'PLANNER_RESPONSE' && line.source === 'MODEL'
  if (!user && !assistant) return
  if (typeof line.content !== 'string') return
  const wrapped = user && /<USER_REQUEST>([\s\S]*)<\/USER_REQUEST>/.exec(line.content)
  const text = (wrapped ? wrapped[1] : line.content).trim()
  if (text) return {text, authorRole: user ? authorRole : authorRole === 'external' ? 'external' : 'worker'}
}

function ingest(db, cursor, limit) {
  const ranges = db.prepare(`SELECT endByte,authorRole FROM transcript_ranges
    WHERE scope=? AND sourceSessionId=? AND generation=? AND endByte>? AND endByte<=? ORDER BY endByte`)
    .all(cursor.scope,cursor.sourceSessionId,cursor.generation,cursor.consumed,cursor.captured)
  if (!ranges.length) return
  let rangeIndex = 0
  let descriptor
  try {
    descriptor = openSync(cursor.path, 'r')
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const events = []
  let consumed = cursor.consumed
  let position = consumed
  const pieces = []
  const chunk = Buffer.allocUnsafe(64 * 1024)
  try {
    if (fileId(fstatSync(descriptor, {bigint: true})) !== cursor.fileId) return
    while (position < cursor.captured && events.length < limit) {
      const count = readSync(descriptor, chunk, 0, Math.min(chunk.length, cursor.captured - position), position)
      if (!count) break
      let start = 0
      while (start < count && events.length < limit) {
        const end = chunk.subarray(start, count).indexOf(10)
        if (end < 0) {
          pieces.push(Buffer.from(chunk.subarray(start, count)))
          break
        }
        pieces.push(chunk.subarray(start, start + end))
        const line = Buffer.concat(pieces).toString('utf8').trim()
        pieces.length = 0
        const offset = consumed
        start += end + 1
        consumed = position + start
        if (!line) continue
        let parsed
        try { parsed = JSON.parse(line) } catch {
          process.stderr.write('Skipped invalid transcript JSON at byte ' + offset + '\n')
          continue
        }
        // A partial line may straddle Stop events. Keep the least privilege
        // of its byte ranges even if the host attested the session later.
        while (ranges[rangeIndex].endByte <= offset) rangeIndex++
        let authority = authors.indexOf(ranges[rangeIndex].authorRole)
        while (ranges[rangeIndex].endByte < consumed) {
          rangeIndex++
          authority = Math.max(authority, authors.indexOf(ranges[rangeIndex].authorRole))
        }
        const event = parsed && messageOf(parsed, authors[authority])
        if (event) events.push({...event, sourceId: cursor.generation + ':' + offset})
      }
      position += count
      // A partial final line stays pending until a later Stop includes its newline.
    }
  } finally { closeSync(descriptor) }
  if (consumed === cursor.consumed) return
  transaction(db, () => {
    const advanced = db.prepare(`UPDATE transcript_cursor SET consumed=? WHERE scope=? AND
      sourceSessionId=? AND generation=? AND consumed=?`)
      .run(consumed, cursor.scope, cursor.sourceSessionId, cursor.generation, cursor.consumed)
    if (!advanced.changes) return
    for (const event of events) enqueue(db, {...cursor, ...event})
    db.prepare('DELETE FROM transcript_ranges WHERE scope=? AND sourceSessionId=? AND generation=? AND endByte<=?')
      .run(cursor.scope,cursor.sourceSessionId,cursor.generation,consumed)
  })
}

export function pendingScopes(db) {
  drainCaptures(db)
  const now = Date.now()
  return db.prepare(`SELECT scope FROM memory_queue WHERE done=0 AND retry_after<=?
    UNION SELECT scope FROM transcript_cursor WHERE consumed<captured
    EXCEPT SELECT scope FROM memory_queue WHERE done=0 AND leaseUntil>?
    ORDER BY scope`).all(now,now).map(row => row.scope)
}

const eventColumns = 'id, scope, authorRole, sourceSessionId, sourceId, text'

export function requireLease(db, {scope, consumerId, batchId}) {
  const events = db.prepare(`SELECT ${eventColumns} FROM memory_queue
    WHERE scope=? AND consumerId=? AND batchId=? AND leaseUntil>? AND done=0 ORDER BY id`)
    .all(scope, consumerId, batchId, Date.now())
  if (!events.length) throw new Error('LEASE_LOST')
  return events
}

export function finishBatch(db, batchId) {
  db.prepare('UPDATE memory_queue SET done=1 WHERE batchId=? AND done=0').run(batchId)
}

export function deferBatch(db, batchId, consumerId, delayMs = 30_000) {
  if (!Number.isSafeInteger(delayMs) || delayMs < 1) throw new RangeError('Invalid retry delay')
  const now = Date.now()
  return db.prepare(`UPDATE memory_queue SET batchId=NULL,consumerId=NULL,leaseUntil=NULL,
    retry_after=?+min(3600000, ?*(1 << min(retry_count,22))), retry_count=retry_count+1
    WHERE batchId=? AND consumerId=? AND done=0 AND leaseUntil>?`)
    .run(now,delayMs,batchId,consumerId,now).changes
}

export function pullBatch(db, {scope, consumerId, limit = 16, leaseMs = 120_000}) {
  if (!scope || !consumerId || !Number.isInteger(limit) || limit < 1 || limit > 100 ||
      !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('Invalid batch request')
  drainCaptures(db)
  for (const cursor of db.prepare('SELECT * FROM transcript_cursor WHERE scope=? AND consumed<captured')
    .all(scope)) ingest(db, cursor, limit)
  return transaction(db, () => {
    const now = Date.now()
    const active = db.prepare('SELECT batchId,consumerId,leaseUntil FROM memory_queue WHERE scope=? AND done=0 AND leaseUntil>? LIMIT 1')
      .get(scope, now)
    if (active && active.consumerId !== consumerId) return null
    const batchId = active?.batchId ?? randomUUID()
    const leaseUntil = active?.leaseUntil ?? now + leaseMs
    if (!active) {
      const pending = db.prepare(`SELECT id,authorRole,(retry_count>0) AS retry FROM memory_queue
        WHERE scope=? AND done=0 AND retry_after<=? ORDER BY retry,id LIMIT ?`).all(scope,now,limit)
      if (!pending.length) return null
      // Consecutive evidence with the same authority can be safely considered
      // together. An assistant reply must never make its user an untrusted author.
      const first = pending[0]
      const boundary = pending.findIndex(row => row.authorRole !== first.authorRole || row.retry !== first.retry)
      const ids = pending.slice(0,boundary === -1 ? pending.length : boundary).map(row => row.id)
      db.prepare(`UPDATE memory_queue SET batchId=?,consumerId=?,leaseUntil=?
        WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(batchId, consumerId, leaseUntil, ...ids)
    }
    const events = db.prepare(`SELECT ${eventColumns} FROM memory_queue WHERE batchId=? ORDER BY id`).all(batchId)
    return {batchId, scope, events, leaseUntil}
  })
}
