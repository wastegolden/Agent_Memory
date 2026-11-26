import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { initQueue } from '../organizer/queue.mjs'
import { installIndex, rebuildIndex } from '../retrieval/index.mjs'

export const factKey = value => value.normalize('NFKC').trim().toLowerCase()
const factIndex = `CREATE UNIQUE INDEX fact_identity ON long_records(scope,context,fact_subject,fact_key)
  WHERE kind='fact' AND deleted=0`

const outcomeSchema = `
  CREATE TABLE procedure_outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, procedure_id TEXT NOT NULL,
    procedure_version INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','failed','fallback')),
    failed_step INTEGER, outward_done INTEGER NOT NULL DEFAULT 0, detail TEXT NOT NULL DEFAULT '',
    author_role TEXT NOT NULL CHECK(author_role IN ('owner','worker','external')),
    session_id TEXT NOT NULL, recorded_at TEXT NOT NULL
  );
  CREATE INDEX procedure_outcomes_recent ON procedure_outcomes(scope, procedure_id, id DESC);
`

const schema = `
  CREATE TABLE IF NOT EXISTS session_roles (
    conversationId TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('reader','owner','organizer')),
    scope TEXT NOT NULL,
    seen_rev INTEGER NOT NULL DEFAULT -1,
    snapshot TEXT NOT NULL DEFAULT '[]'
  );
  CREATE TABLE IF NOT EXISTS list_revisions (
    scope TEXT PRIMARY KEY, rev INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS short_items (
    scope TEXT NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
    updated_at TEXT NOT NULL, version INTEGER NOT NULL, author_role TEXT NOT NULL,
    expires_at TEXT, promoted_to TEXT, dedupe_key TEXT NOT NULL,
    PRIMARY KEY (scope, id)
  );
  CREATE INDEX IF NOT EXISTS short_duplicate ON short_items(scope, dedupe_key, status);
  CREATE TABLE IF NOT EXISTS short_bodies (
    scope TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, sources TEXT NOT NULL,
    PRIMARY KEY (scope, id),
    FOREIGN KEY (scope, id) REFERENCES short_items(scope, id)
  );
  CREATE TABLE IF NOT EXISTS long_records (
    scope TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
    data TEXT NOT NULL, context TEXT NOT NULL, valid_from TEXT, valid_until TEXT,
    tags TEXT NOT NULL, sources TEXT NOT NULL, version INTEGER NOT NULL,
    deleted INTEGER NOT NULL, author_role TEXT NOT NULL, updated_at TEXT NOT NULL,
    fact_subject TEXT, fact_key TEXT,
    PRIMARY KEY (scope, id)
  );
  CREATE TABLE IF NOT EXISTS long_history (
    scope TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (scope, id, version)
  );
  CREATE TABLE IF NOT EXISTS receipts (
    scope TEXT NOT NULL, proposal_id TEXT NOT NULL, consumer_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY (scope, proposal_id)
  );
`

function migrateV1(db) {
  db.exec(`DROP INDEX fact_identity;
    ALTER TABLE long_records ADD COLUMN fact_subject TEXT;
    ALTER TABLE long_records ADD COLUMN fact_key TEXT;
    ALTER TABLE memory_queue ADD COLUMN retry_after INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE memory_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`)
  const update = db.prepare('UPDATE long_records SET fact_subject=?,fact_key=? WHERE scope=? AND id=?')
  const retire = db.prepare('UPDATE long_records SET deleted=1,version=version+1,updated_at=? WHERE scope=? AND id=?')
  const revision = db.prepare('INSERT INTO long_history VALUES (?,?,?,?)')
  const winners = new Map()
  const facts = db.prepare(`SELECT scope,id,deleted,context,data FROM long_records WHERE kind='fact'
    ORDER BY (author_role='owner') DESC,(author_role='worker') DESC,updated_at DESC,version DESC,id`).all()
  for (const {scope,id,deleted,context,data} of facts) {
    const parsed = JSON.parse(data)
    const subject = factKey(parsed.subject)
    const key = factKey(parsed.key)
    update.run(subject,key,scope,id)
    if (deleted) continue
    const identity = JSON.stringify([scope,context,subject,key])
    const winner = winners.get(identity)
    if (winner === undefined) {
      winners.set(identity,id)
    } else {
      const record = readLong(db,scope,id)
      const updatedAt = new Date(Math.max(Date.now(),Date.parse(record.updatedAt)+1)).toISOString()
      retire.run(updatedAt,scope,id)
      revision.run(scope,id,record.version+1,JSON.stringify({...record, version:record.version+1,
        updatedAt, deleted:true, supersededBy:winner}))
    }
  }
  rebuildIndex(db)
}

export function openDatabase(file, { readOnly = false, busyTimeout = 3000 } = {}) {
  if (!Number.isSafeInteger(busyTimeout) || busyTimeout < 0 || busyTimeout > 60000) {
    throw new RangeError('busyTimeout must be an integer between 0 and 60000')
  }
  if (!readOnly && file !== ':memory:') mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file, { readOnly, timeout: busyTimeout })
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeout}`)
    const schemaVersion = db.prepare('PRAGMA user_version')
    const version = schemaVersion.get().user_version
    if (version === 3) return db
    if ((version === 1 || version === 2) && readOnly) throw new Error('Open the memory database for writing once to upgrade it')
    if (![0,1,2].includes(version) || readOnly) throw new Error('Unsupported or uninitialized memory database')
    db.exec('PRAGMA journal_mode = WAL; BEGIN IMMEDIATE')
    switch (schemaVersion.get().user_version) {
      case 0:
        db.exec(schema)
        initQueue(db)
        installIndex(db)
        db.exec(factIndex)
        break
      case 1:
        migrateV1(db)
        db.exec(factIndex)
        break
      case 2:
        break
      case 3:
        db.exec('COMMIT')
        return db
      default:
        throw new Error('Unsupported memory database version')
    }
    db.exec(outcomeSchema)
    db.exec('PRAGMA user_version = 3; COMMIT')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function listShort(db, scope) {
  // One statement gives both revision and list rows from the same SQLite snapshot.
  const rows = db.prepare(`SELECT rev, s.id, s.title, s.status, s.updated_at AS updatedAt
    FROM list_revisions AS r LEFT JOIN short_items AS s
      ON s.scope=r.scope AND s.status IN ('open','done','expired')
    WHERE r.scope=? ORDER BY s.updated_at DESC,s.id`).all(scope)
  return {
    list_rev: rows[0]?.rev ?? 0,
    items: rows.filter(row => row.id !== null).map(({id, title, status, updatedAt}) =>
      ({id, title, status, updatedAt})),
  }
}

export function readShort(db, scope, id) {
  const row = db.prepare(`SELECT s.scope,s.id,s.title,s.status,s.version,
    s.author_role AS authorRole,s.updated_at AS updatedAt,s.expires_at AS expiresAt,
    s.promoted_to AS promotedTo,b.body,b.sources
    FROM short_items s JOIN short_bodies b USING(scope,id) WHERE scope=? AND id=?`).get(scope,id)
  return row ? {...row, sources: JSON.parse(row.sources)} : null
}

export function readLong(db, scope, id) {
  const row = db.prepare(`SELECT scope,id,kind,title,data,context,valid_from AS validFrom,
    valid_until AS validUntil,tags,sources,version,deleted,author_role AS authorRole,
    updated_at AS updatedAt FROM long_records WHERE scope=? AND id=?`).get(scope,id)
  return row ? {...row, data: JSON.parse(row.data), tags: JSON.parse(row.tags),
    sources: JSON.parse(row.sources), deleted: Boolean(row.deleted)} : null
}

export function historyLong(db, scope, id) {
  return db.prepare('SELECT record FROM long_history WHERE scope=? AND id=? ORDER BY version')
    .all(scope,id).map(row => JSON.parse(row.record))
}

// The caller holds BEGIN IMMEDIATE from handle resolution through this insert.
export function recordProcedureOutcome(db, {scope, procedureId, procedureVersion, status, failedStep = null,
  outwardDone = false, detail = '', authorRole, sessionId}) {
  db.prepare(`INSERT INTO procedure_outcomes
    (scope,procedure_id,procedure_version,status,failed_step,outward_done,detail,author_role,session_id,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(scope, procedureId, procedureVersion, status, failedStep,
      Number(outwardDone), detail, authorRole, sessionId, new Date().toISOString())
}

export function listProcedureOutcomes(db, scope, id, limit = 3) {
  return db.prepare(`SELECT procedure_version AS procedureVersion, status, failed_step AS failedStep,
    outward_done AS outwardDone, detail, author_role AS authorRole, recorded_at AS recordedAt
    FROM procedure_outcomes WHERE scope=? AND procedure_id=? ORDER BY id DESC LIMIT ?`)
    .all(scope, id, limit).map(row => ({...row, outwardDone: Boolean(row.outwardDone)}))
}
