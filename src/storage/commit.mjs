import { createHash } from 'node:crypto'
import { requireLease, finishBatch } from '../organizer/queue.mjs'
import { SQLiteMemoryIndexer } from '../retrieval/index.mjs'
import { factKey, readShort, readLong } from './database.mjs'
import { parseProposal, CommitError } from './proposal.mjs'

function refuse(code) { throw new CommitError(code) }

const rank = {external: 0, worker: 1, owner: 2}

function checkVersion(current, expected, role) {
  if (current && rank[role] < rank[current.authorRole]) refuse('FORBIDDEN')
  if ((current?.version ?? 0) !== expected) refuse('VERSION_CONFLICT')
}

function mergeSources(previous, added) {
  return [...new Map([...previous, ...added].map(source => [source.id, source])).values()]
}

const normalized = value => value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase()
const active = ['open','done','expired']
const unfinished = (row,now) => row.status === 'open' && (!row.expiresAt || Date.parse(row.expiresAt) > now)
const stamp = (now, previous) => new Date(Math.max(now, previous ? Date.parse(previous) + 1 : now)).toISOString()

export class CommitService {
  constructor(db, {indexer = new SQLiteMemoryIndexer(db), capacity = 18, now = Date.now} = {}) {
    if (!Number.isInteger(capacity) || capacity < 15 || capacity > 20) {
      throw new RangeError('capacity must be an integer from 15 to 20')
    }
    this.db = db
    this.indexer = indexer
    this.capacity = capacity
    this.now = now
  }

  commit(raw, consumerId) {
    let began = false
    try {
      const {scope, batchId, proposalId, operations} = parseProposal(raw)
      if (typeof consumerId !== 'string' || !consumerId.trim()) refuse('FORBIDDEN')
      const json = JSON.stringify({batchId,operations}, (_, value) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
        }
        return value
      })
      const fingerprint = createHash('sha256').update(json).digest('hex')
      this.db.exec('BEGIN IMMEDIATE')
      began = true
      const receipt = this.db.prepare('SELECT * FROM receipts WHERE scope=? AND proposal_id=?').get(scope,proposalId)
      if (receipt) {
        if (receipt.consumer_id !== consumerId) refuse('FORBIDDEN')
        if (receipt.fingerprint !== fingerprint) refuse('PROPOSAL_CONFLICT')
        this.db.exec('COMMIT')
        return JSON.parse(receipt.result)
      }
      const events = requireLease(this.db, {scope, consumerId, batchId})
      if (!events?.length) refuse('LEASE_LOST')
      // A model cannot gain owner authority by citing only one owner event in a mixed batch.
      const roles = events.map(event => event.authorRole)
      const role = roles.every(role => role === 'owner') ? 'owner' : roles.includes('external') ? 'external' : 'worker'
      const evidence = new Map(events.map(({id,sourceId,sourceSessionId,authorRole}) =>
        [id, {id,sourceId,sourceSessionId,authorRole}]))
      const now = this.now()
      const changes = []
      for (const op of operations) {
        const sources = op.sourceIds ? [...new Set(op.sourceIds)].map(id =>
          evidence.get(id) ?? refuse('INVALID_PROPOSAL')) : [...evidence.values()]
        if (op.type === 'long.put' || op.type === 'long.remove') {
          changes.push(this.#long(scope,op,role,sources,now))
        } else if (op.type === 'short.put') {
          changes.push(...this.#short(scope,op,role,sources,now))
        } else {
          const short = readShort(this.db,scope,op.id)
          checkVersion(short,op.expectedVersion,role)
          if (!active.includes(short.status)) refuse('VERSION_CONFLICT')
          if (op.type === 'short.archive' && unfinished(short,now)) refuse('UNFINISHED')
          if (op.type === 'short.promote') {
            changes.push(this.#long(scope,op.record,role,mergeSources(short.sources,sources),now))
          }
          changes.push(this.#retire(short,op.record?.id ?? null,now))
        }
      }
      if (changes.some(change => change.kind === 'short')) {
        this.db.prepare(`INSERT INTO list_revisions (scope,rev) VALUES (?,1)
          ON CONFLICT(scope) DO UPDATE SET rev=rev+1`).run(scope)
      }
      const result = {status:'COMMITTED', changes}
      this.db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)')
        .run(scope,proposalId,consumerId,fingerprint,JSON.stringify(result))
      finishBatch(this.db,batchId)
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      if (began) {
        // SQLite may have rolled the transaction back before reporting the original error.
        try { this.db.exec('ROLLBACK') } catch {}
      }
      if (error instanceof CommitError || error.message === 'LEASE_LOST' || error.code === 'LEASE_LOST') {
        return {status:error instanceof CommitError ? error.message : 'LEASE_LOST'}
      }
      if ((error.errcode & 255) === 5) return {status:'BUSY'}
      throw error
    }
  }

  #retire(row, promotedTo, now) {
    const status = promotedTo ? 'promoted' : 'archived'
    this.db.prepare(`UPDATE short_items SET status=?, promoted_to=?, updated_at=?, version=version+1
      WHERE scope=? AND id=? AND version=?`)
      .run(status,promotedTo,stamp(now,row.updatedAt),row.scope,row.id,row.version)
    return {kind:'short', id:row.id, version:row.version+1, status}
  }

  #short(scope, op, role, sources, now) {
    let row = readShort(this.db,scope,op.id)
    const retired = []
    checkVersion(row,op.expectedVersion,role)
    if (row && !active.includes(row.status)) refuse('VERSION_CONFLICT')
    const dedupeKey = JSON.stringify([normalized(op.title),normalized(op.body)])
    const duplicate = this.db.prepare(`SELECT id FROM short_items WHERE scope=? AND dedupe_key=?
      AND id<>? AND status IN ('open','done','expired') LIMIT 1`).get(scope,dedupeKey,op.id)
    if (duplicate) {
      const kept = readShort(this.db,scope,duplicate.id)
      checkVersion(kept,kept.version,role)
      if (!unfinished(kept,now) && (unfinished(op,now) || (row && unfinished(row,now)))) refuse('UNFINISHED')
      if (row) {
        sources = mergeSources(row.sources,sources)
        retired.push(this.#retire(row,null,now))
      }
      row = kept
    }
    if (!row) {
      const {count} = this.db.prepare(`SELECT count(*) AS count FROM short_items
        WHERE scope=? AND status IN ('open','done','expired')`).get(scope)
      const overflow = count - this.capacity + 1
      if (overflow > 0) {
        const evict = this.db.prepare(`SELECT id FROM short_items WHERE scope=?
          AND (author_role='external' OR author_role=? OR ?='owner')
          AND (status IN ('done','expired') OR (status='open' AND expires_at<=?))
          ORDER BY updated_at,id LIMIT ?`).all(scope,role,role,stamp(now),overflow)
        if (evict.length !== overflow) refuse('CAPACITY_REACHED')
        for (const item of evict) retired.push(this.#retire(readShort(this.db,scope,item.id),null,now))
      }
    }
    const id = row?.id ?? op.id
    const version = (row?.version ?? 0) + 1
    const updatedAt = stamp(now,row?.updatedAt)
    // A duplicate adds evidence without reopening a completed item or replacing its deadline.
    const status = duplicate ? row.status : op.status
    const expiresAt = duplicate ? row.expiresAt : op.expiresAt
    this.db.prepare(`INSERT INTO short_items
      (scope,id,title,status,updated_at,version,author_role,expires_at,dedupe_key)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET
      title=excluded.title,status=excluded.status,updated_at=excluded.updated_at,
      version=excluded.version,author_role=excluded.author_role,expires_at=excluded.expires_at,
      dedupe_key=excluded.dedupe_key WHERE short_items.version=excluded.version-1`)
      .run(scope,id,duplicate ? row.title : op.title,status,updatedAt,version,role,expiresAt,dedupeKey)
    this.db.prepare(`INSERT INTO short_bodies VALUES (?,?,?,?) ON CONFLICT(scope,id)
      DO UPDATE SET body=excluded.body,sources=excluded.sources`)
      .run(scope,id,duplicate ? row.body : op.body,JSON.stringify(mergeSources(row?.sources ?? [],sources)))
    return [{kind:'short',id,version,status}, ...retired]
  }

  #long(scope, op, role, sources, now) {
    const current = readLong(this.db,scope,op.id)
    checkVersion(current,op.expectedVersion,role)
    const deleted = op.type === 'long.remove'
    if (deleted && (!current || current.deleted)) refuse('VERSION_CONFLICT')
    const content = deleted ? current : op
    if (current && current.kind !== content.kind) refuse('VERSION_CONFLICT')
    const subject = content.kind === 'fact' ? factKey(content.data.subject) : null
    const key = content.kind === 'fact' ? factKey(content.data.key) : null
    if (!deleted && content.kind === 'fact') {
      const occupied = this.db.prepare(`SELECT author_role FROM long_records WHERE scope=? AND context=?
        AND kind='fact' AND deleted=0 AND fact_subject=? AND fact_key=?
        AND id<>?`).get(scope,content.context,subject,key,op.id)
      if (occupied) refuse(rank[role] < rank[occupied.author_role] ? 'FORBIDDEN' : 'VERSION_CONFLICT')
    }
    const version = (current?.version ?? 0) + 1
    const record = {id:op.id,scope,kind:content.kind,title:content.title,data:content.data,
      context:content.context,validFrom:content.validFrom,validUntil:content.validUntil,tags:content.tags,
      sources:mergeSources(current?.sources ?? [],sources),version,deleted,authorRole:role,
      updatedAt:stamp(now,current?.updatedAt)}
    this.db.prepare(`INSERT INTO long_records
      (scope,id,kind,title,data,context,valid_from,valid_until,tags,sources,version,deleted,author_role,updated_at,
       fact_subject,fact_key)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET
      kind=excluded.kind,title=excluded.title,data=excluded.data,context=excluded.context,
      valid_from=excluded.valid_from,valid_until=excluded.valid_until,tags=excluded.tags,
      sources=excluded.sources,version=excluded.version,deleted=excluded.deleted,
      author_role=excluded.author_role,updated_at=excluded.updated_at,
      fact_subject=excluded.fact_subject,fact_key=excluded.fact_key WHERE long_records.version=excluded.version-1`)
      .run(scope,record.id,record.kind,record.title,JSON.stringify(record.data),record.context,
        record.validFrom,record.validUntil,JSON.stringify(record.tags),JSON.stringify(record.sources),
        version,Number(deleted),role,record.updatedAt,subject,key)
    this.db.prepare('INSERT INTO long_history VALUES (?,?,?,?)').run(scope,record.id,version,JSON.stringify(record))
    const indexed = deleted ? this.indexer.remove(record.id,scope) : this.indexer.upsert(record)
    if (indexed && typeof indexed.then === 'function') {
      // The transaction is synchronous. Roll back before acknowledging this batch.
      Promise.resolve(indexed).catch(() => {})
      throw new TypeError('MemoryIndexer must finish synchronously inside the SQLite transaction')
    }
    return {kind:record.kind,id:record.id,version,deleted}
  }
}
