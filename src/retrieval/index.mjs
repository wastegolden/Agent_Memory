import { randomUUID } from 'node:crypto'
import { listProcedureOutcomes, readLong, recordProcedureOutcome } from '../storage/database.mjs'
import { isPublicTitle, normalizeTerm, tokenize } from './terms.mjs'

/**
 * @typedef {NonNullable<ReturnType<typeof readLong>>} MemoryRecord
 * @typedef {{upsert(record: MemoryRecord): void, remove(id: string, scope: string): void}} MemoryIndexer
 * @typedef {{text: string, scope: string, context?: string, limit?: number, at?: string}} SearchQuery
 * @typedef {{scope: string, id: string, version: number}} SearchHit
 * @typedef {{search(query: SearchQuery): SearchHit[] | Promise<SearchHit[]>}} MemoryRetriever
 */

const maximumHits = 4
const maximumHandles = 2000
const genericTerms = new Set(['全部', '所有', '所有记录', '经验', '流程', 'all', 'everything'])

/** Only initialization and the writer call this. A search never initializes a database. */
export function installIndex(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS memory_search_terms (
    scope TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
    kind TEXT NOT NULL, context TEXT, valid_from TEXT, valid_until TEXT,
    terms TEXT NOT NULL, PRIMARY KEY(scope, id)
  ) WITHOUT ROWID`)
}

/** @implements {MemoryIndexer} The caller owns the SQLite transaction. */
export class SQLiteMemoryIndexer {
  constructor(db) {
    this.db = db
  }

  upsert(record) {
    const { scope, id, version, kind, data } = record
    const fields = [publicTitle(record), ...(record.tags ?? [])]
    if (kind === 'fact') fields.push(data.subject, data.key)
    else fields.push(...data.parameters)
    this.db.prepare(`INSERT INTO memory_search_terms
      (scope,id,version,kind,context,valid_from,valid_until,terms)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(scope,id) DO UPDATE SET version=excluded.version,kind=excluded.kind,
        context=excluded.context,valid_from=excluded.valid_from,
        valid_until=excluded.valid_until,terms=excluded.terms`)
      .run(scope, id, version, kind, record.context || null, record.validFrom || null,
        record.validUntil || null, fields.map(normalizeTerm).join('\n'))
  }

  remove(id, scope) {
    this.db.prepare('DELETE FROM memory_search_terms WHERE scope=? AND id=?').run(scope, id)
  }
}

/** Rebuild derived terms when upgrading indexed fields or the public-title policy. */
export function rebuildIndex(db) {
  const indexer = new SQLiteMemoryIndexer(db)
  db.exec('DELETE FROM memory_search_terms')
  for (const { scope, id } of db.prepare('SELECT scope,id FROM long_records WHERE deleted=0').iterate()) {
    indexer.upsert(readLong(db, scope, id))
  }
}

/** @implements {MemoryRetriever} Titles and bodies come from the authoritative record. */
export class SQLiteMemoryRetriever {
  constructor(db) {
    this.db = db
  }

  search({ text, scope, context = '', limit = maximumHits + 1, at = new Date().toISOString() }) {
    const query = normalizeTerm(text)
    const tokens = tokenize(query)
    if (!scope || !tokens.length) return []
    const matches = tokens.map(() => '(instr(terms,?)>0)')
    // Apply current-record visibility before LIMIT so stale candidates cannot hide a fifth hit.
    const candidates = `SELECT scope,id,version FROM memory_search_terms
      JOIN long_records r USING(scope,id,version)
      WHERE scope=? AND r.deleted=0 AND (r.kind='procedure' OR (r.kind='fact'
        AND (r.context='' OR r.context=?) AND (r.valid_from IS NULL OR julianday(r.valid_from)<=julianday(?))
        AND (r.valid_until IS NULL OR julianday(r.valid_until)>julianday(?))))`
    const visibility = [scope, context, at, at]
    const strict = this.db.prepare(`${candidates} AND (instr(terms,?)>0 OR (${matches.join(' AND ')}))
      ORDER BY (instr(terms,?)>0) DESC, id LIMIT ?`)
      .all(...visibility, query, ...tokens, query, limit)
    if (strict.length || tokens.length === 1) return strict
    return this.db.prepare(`${candidates} AND (${matches.join(' OR ')})
      ORDER BY ${matches.join(' + ')} DESC, (instr(terms,?)>0) DESC, id LIMIT ?`)
      .all(...visibility, ...tokens, ...tokens, query, limit)
  }
}

function visible(record, scope, context, now) {
  if (!record || record.deleted || record.scope !== scope) return false
  if (record.kind !== 'fact') return record.kind === 'procedure'
  return (!record.context || record.context === context)
    && (!record.validFrom || Date.parse(record.validFrom) <= now)
    && (!record.validUntil || now < Date.parse(record.validUntil))
}

function publicTitle(record) {
  // Titles are explicitly published metadata. Never synthesize one from a value or the first line of a body.
  if (isPublicTitle(record.title)) return record.title.trim()
  return record.kind === 'fact' ? '情境事实' : '通用程序'
}

/** Own one instance per MCP server. Pass the authenticated session binding separately from tool arguments. */
export class MemorySearch {
  constructor(db, { retriever = new SQLiteMemoryRetriever(db),
    readRecord = (scope, id) => readLong(db, scope, id), clock = Date.now } = {}) {
    this.db = db
    this.retriever = retriever
    this.readRecord = readRecord
    this.clock = clock
    this.handles = new Map()
  }

  search({ text, scope, context }, identity) {
    if (!identity?.sessionId || !identity.scope || (scope !== undefined && scope !== identity.scope))
      return { status: 'FORBIDDEN' }
    if (typeof text !== 'string' || text.length > 256 || (context !== undefined && typeof context !== 'string'))
      return { status: 'INVALID_ARGUMENT' }
    const query = normalizeTerm(text)
    if (!/[\p{L}\p{N}]/u.test(query) || genericTerms.has(query)) return { status: 'REFINE_QUERY' }
    const effectiveContext = context?.trim() ?? (identity.context || '')
    const hits = this.retriever.search({ text: query, scope: identity.scope, context: effectiveContext,
      at: new Date(this.clock()).toISOString(), limit: maximumHits + 1 })
    return Array.isArray(hits) ? this.#issue(hits, identity, effectiveContext)
      : hits.then(rows => this.#issue(rows, identity, effectiveContext))
  }

  #issue(hits, identity, context) {
    const now = this.clock()
    const records = new Map()
    for (const hit of hits) {
      if (hit.scope !== identity.scope) continue
      const record = this.readRecord(identity.scope, hit.id)
      if (visible(record, identity.scope, context, now) && record.id === hit.id && record.version === hit.version)
        records.set(hit.id, record)
    }
    if (records.size > maximumHits) return { status: 'REFINE_QUERY' }
    if (!records.size) return { status: 'NO_EVIDENCE', stop: true,
      overview: '当前可见范围内没有匹配的有效证据。', next: '停止重复检索，等待新的来源证据。' }
    const results = []
    for (const record of records.values()) {
      const handle = randomUUID()
      if (this.handles.size >= maximumHandles) this.handles.delete(this.handles.keys().next().value)
      this.handles.set(handle, { sessionId: identity.sessionId, scope: identity.scope,
        defaultContext: identity.context || '', context, id: record.id, version: record.version })
      results.push({ title: publicTitle(record), handle })
    }
    return { status: 'OK', results }
  }

  #resolve(handle, identity, readRecord = this.readRecord) {
    const bound = this.handles.get(handle)
    if (!bound || !identity || bound.sessionId !== identity.sessionId || bound.scope !== identity.scope
      || bound.defaultContext !== (identity.context || '')) return null
    const record = readRecord(bound.scope, bound.id)
    if (!visible(record, bound.scope, bound.context, this.clock()) || record.id !== bound.id || record.version !== bound.version) {
      this.handles.delete(handle)
      return null
    }
    this.handles.delete(handle)
    this.handles.set(handle, bound)
    return record
  }

  read({ handle }, identity) {
    const record = this.#resolve(handle, identity)
    if (!record) return { status: 'INVALID_HANDLE' }
    const { kind, data, context, validFrom, validUntil, version } = record
    const result = { status: 'OK', record: { kind, title: publicTitle(record), data, context, validFrom, validUntil, version },
      sources: record.sources.map(source => ({ kind: 'event', id: source.id })) }
    if (kind === 'procedure') {
      const {scope, id} = record
      const last = this.db && listProcedureOutcomes(this.db, scope, id, 1)[0]
      result.lastOutcome = last ?? null
      result.recentFailures = last ? this.db.prepare(`SELECT count(*) AS n FROM procedure_outcomes
        WHERE scope=? AND procedure_id=? AND procedure_version=? AND status='failed'`).get(scope, id, version).n : 0
      result.fallbackVersion = null
      if (last?.procedureVersion === version && last.status === 'failed' && !last.outwardDone) {
        result.fallbackVersion = this.db.prepare(`SELECT max(h.version) AS version FROM long_history h
          JOIN procedure_outcomes o ON o.scope=h.scope AND o.procedure_id=h.id AND o.procedure_version=h.version
          WHERE h.scope=? AND h.id=? AND h.version<? AND o.status='ok'`).get(scope, id, version).version
      }
    }
    return result
  }

  reportOutcome(writer, {handle, status, failedStep, outwardDone = false, detail}, identity) {
    const record = this.#resolve(handle, identity, (scope, id) => readLong(writer, scope, id))
    if (record?.kind !== 'procedure') return { status: 'INVALID_HANDLE' }
    if (failedStep !== undefined) {
      if (status === 'ok' || failedStep > record.data.steps.length) return { status: 'INVALID_INPUT' }
      outwardDone ||= record.data.outwardSteps?.some(step => failedStep >= step) ?? false
    }
    recordProcedureOutcome(writer, {scope: record.scope, procedureId: record.id, procedureVersion: record.version,
      status, failedStep, outwardDone, detail, authorRole: identity.authorRole, sessionId: identity.sessionId})
    return { status: 'OK' }
  }
}
