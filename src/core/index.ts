/** Rebuildable SQLite index of memory metadata: the files stay authoritative, and this index only makes lookup by task, project, person, time, source and reference cheap. */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'

/** A pointer from one memory record to another, with the part and task that explain where the reference was indexed. */
export interface MemoryReference { kind: string; id: string; part?: string; taskId?: string }
/** The indexable metadata of one authoritative memory record: its file, version, sources, references, and its event fields when it is an event. */
export interface IndexedMemory {
  kind: string
  id: string
  path: string
  version: string
  sources?: { kind: string; id: string; path?: string }[]
  references?: MemoryReference[]
  event?: { kind: string; at: string; seq: number; taskId?: string; projectId?: string; personIds?: string[] }
}
/** Event filters, all applied by SQLite; `from`/`to` include their event times and `personId` matches any event person. */
export interface MemoryEventQuery { kind?: string; taskId?: string; projectId?: string; personId?: string; sourceKind?: string; sourceId?: string; from?: string; to?: string; afterSeq?: number }

/** Tables and indexes: records are keyed by (kind, id), and every event, source and reference filter has a real SQLite index. */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memory (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    path TEXT NOT NULL,
    version TEXT NOT NULL,
    event_kind TEXT,
    event_at TEXT,
    event_seq INTEGER,
    event_task_id TEXT,
    event_project_id TEXT,
    PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS memory_source (
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    path TEXT,
    position INTEGER NOT NULL,
    PRIMARY KEY (record_kind, record_id, kind, id)
  );
  CREATE TABLE IF NOT EXISTS memory_reference (
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_id TEXT NOT NULL,
    part TEXT,
    task_id TEXT
  );
  CREATE TABLE IF NOT EXISTS memory_person (
    record_kind TEXT NOT NULL,
    record_id TEXT NOT NULL,
    person_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (record_kind, record_id, person_id)
  );
  CREATE INDEX IF NOT EXISTS memory_kind_event_seq ON memory(kind, event_seq);
  CREATE INDEX IF NOT EXISTS memory_event_kind_seq ON memory(event_kind, event_seq);
  CREATE INDEX IF NOT EXISTS memory_event_at ON memory(event_at);
  CREATE INDEX IF NOT EXISTS memory_event_task ON memory(event_task_id, event_seq);
  CREATE INDEX IF NOT EXISTS memory_event_project ON memory(event_project_id, event_seq);
  CREATE INDEX IF NOT EXISTS memory_source_lookup ON memory_source(kind, id);
  CREATE INDEX IF NOT EXISTS memory_source_id ON memory_source(id);
  CREATE INDEX IF NOT EXISTS memory_person_lookup ON memory_person(person_id);
  CREATE INDEX IF NOT EXISTS memory_reference_target ON memory_reference(target_kind, target_id);
  CREATE INDEX IF NOT EXISTS memory_reference_from ON memory_reference(from_kind, from_id);
`

/**
 * The memory index at `root/index.sqlite`: metadata alone, rebuildable from the authoritative records with `rebuild`, answering
 * event, source and reference lookups from SQLite without reading the memory files. One connection is held for the index's lifetime.
 */
export class MemoryIndex {
  private readonly db: DatabaseSync
  /** Diagnostics by memory path; kept in memory because a repaired file clears its own entry. */
  private readonly reported = new Map<string, string>()
  /** Observers of committed version changes; empty during bulk reconciliation so upserts pay no extra read. */
  private readonly versionChangeListeners = new Set<(current: IndexedMemory, previous: IndexedMemory) => void>()
  /** Opens (or creates) `root/index.sqlite` and its tables and indexes. */
  constructor(root: string, options: { memory?: boolean } = {}) {
    if (!options.memory) mkdirSync(root, { recursive: true })
    this.db = new DatabaseSync(options.memory ? ':memory:' : join(root, 'index.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
  }
  /**
   * Registers `listener` for version changes: an `upsert` that replaces an already indexed record with a different
   * version calls it synchronously after the writing transaction commits, with the new metadata and the metadata the
   * index held before. First inserts, same-version upserts and `rebuild` never notify; the returned function unsubscribes.
   */
  onVersionChange(listener: (current: IndexedMemory, previous: IndexedMemory) => void): () => void {
    this.versionChangeListeners.add(listener)
    return () => { this.versionChangeListeners.delete(listener) }
  }
  /** Runs `operation` in one synchronous transaction, rolling back everything it wrote if it throws. */
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    let value: T
    try { value = operation() } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.db.exec('COMMIT')
    return value
  }
  /**
   * Replaces a record's metadata, sources and references in one transaction; duplicate sources and references are stored once.
   * Reads the previous metadata only when a version-change listener exists, so bulk event reconciliation pays no extra query.
   */
  upsert(record: IndexedMemory): void {
    const previous = this.versionChangeListeners.size === 0 ? undefined : this.get(record.kind, record.id)
    this.transaction(() => this.write(record))
    // Notify after COMMIT: listeners can read the new index state, and a failed write has already thrown to the caller.
    if (previous === undefined || previous.version === record.version) return
    for (const listener of [...this.versionChangeListeners]) listener(record, previous)
  }
  /** Writes one record and replaces its source, reference and person rows; the caller holds the transaction. */
  private write(record: IndexedMemory): void {
    const { event } = record
    this.db.prepare(`INSERT INTO memory (kind, id, path, version, event_kind, event_at, event_seq, event_task_id, event_project_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET path = excluded.path, version = excluded.version, event_kind = excluded.event_kind,
        event_at = excluded.event_at, event_seq = excluded.event_seq, event_task_id = excluded.event_task_id,
        event_project_id = excluded.event_project_id`)
      .run(record.kind, record.id, record.path, record.version, event?.kind ?? null, event?.at ?? null, event?.seq ?? null,
        event?.taskId ?? null, event?.projectId ?? null)
    this.db.prepare('DELETE FROM memory_source WHERE record_kind = ? AND record_id = ?').run(record.kind, record.id)
    const insertSource = this.db.prepare('INSERT INTO memory_source (record_kind, record_id, kind, id, path, position) VALUES (?, ?, ?, ?, ?, ?)')
    const seenSources = new Set<string>()
    let sourcePosition = 0
    for (const source of record.sources ?? []) {
      const key = JSON.stringify([source.kind, source.id])
      if (seenSources.has(key)) continue
      seenSources.add(key)
      insertSource.run(record.kind, record.id, source.kind, source.id, source.path ?? null, sourcePosition++)
    }
    this.db.prepare('DELETE FROM memory_reference WHERE from_kind = ? AND from_id = ?').run(record.kind, record.id)
    const insertReference = this.db.prepare(`INSERT INTO memory_reference (from_kind, from_id, target_kind, target_id, part, task_id)
      VALUES (?, ?, ?, ?, ?, ?)`)
    const seenReferences = new Set<string>()
    for (const reference of record.references ?? []) {
      const key = JSON.stringify([reference.kind, reference.id, reference.part ?? null, reference.taskId ?? null])
      if (seenReferences.has(key)) continue
      seenReferences.add(key)
      insertReference.run(record.kind, record.id, reference.kind, reference.id, reference.part ?? null, reference.taskId ?? null)
    }
    this.db.prepare('DELETE FROM memory_person WHERE record_kind = ? AND record_id = ?').run(record.kind, record.id)
    const insertPerson = this.db.prepare('INSERT INTO memory_person (record_kind, record_id, person_id, position) VALUES (?, ?, ?, ?)')
    const seenPeople = new Set<string>()
    let personPosition = 0
    for (const personId of event?.personIds ?? []) {
      if (seenPeople.has(personId)) continue
      seenPeople.add(personId)
      insertPerson.run(record.kind, record.id, personId, personPosition++)
    }
  }
  /** Removes a record with its sources, people and the references it makes; references other records make to it stay theirs. */
  remove(kind: string, id: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM memory WHERE kind = ? AND id = ?').run(kind, id)
      this.db.prepare('DELETE FROM memory_source WHERE record_kind = ? AND record_id = ?').run(kind, id)
      this.db.prepare('DELETE FROM memory_reference WHERE from_kind = ? AND from_id = ?').run(kind, id)
      this.db.prepare('DELETE FROM memory_person WHERE record_kind = ? AND record_id = ?').run(kind, id)
    })
  }
  /** Replaces the whole index with `records` in one synchronous transaction: anything not supplied is gone afterwards. */
  rebuild(records: Iterable<IndexedMemory>): void {
    this.transaction(() => {
      this.db.exec('DELETE FROM memory; DELETE FROM memory_source; DELETE FROM memory_reference; DELETE FROM memory_person')
      for (const record of records) this.write(record)
    })
  }
  /** The indexed metadata of `kind`/`id`, including its sources, references and event, or `undefined` when the index has no such record. */
  get(kind: string, id: string): IndexedMemory | undefined {
    const row = this.db.prepare(`SELECT kind, id, path, version, event_kind, event_at, event_seq, event_task_id, event_project_id
      FROM memory WHERE kind = ? AND id = ?`).get(kind, id)
    if (row === undefined) return undefined
    const sources: NonNullable<IndexedMemory['sources']> = this.db.prepare(
      'SELECT kind, id, path FROM memory_source WHERE record_kind = ? AND record_id = ? ORDER BY position')
      .all(kind, id).map(source => {
        const found: NonNullable<IndexedMemory['sources']>[number] = { kind: String(source.kind), id: String(source.id) }
        if (source.path !== null) found.path = String(source.path)
        return found
      })
    const references: MemoryReference[] = this.db.prepare(
      'SELECT target_kind, target_id, part, task_id FROM memory_reference WHERE from_kind = ? AND from_id = ? ORDER BY rowid')
      .all(kind, id).map(reference => {
        const found: MemoryReference = { kind: String(reference.target_kind), id: String(reference.target_id) }
        if (reference.part !== null) found.part = String(reference.part)
        if (reference.task_id !== null) found.taskId = String(reference.task_id)
        return found
      })
    const personIds = this.db.prepare('SELECT person_id FROM memory_person WHERE record_kind = ? AND record_id = ? ORDER BY position')
      .all(kind, id).map(person => String(person.person_id))
    const record: IndexedMemory = { kind: String(row.kind), id: String(row.id), path: String(row.path), version: String(row.version) }
    if (sources.length) record.sources = sources
    if (references.length) record.references = references
    if (row.event_kind !== null) {
      const event: NonNullable<IndexedMemory['event']> = { kind: String(row.event_kind), at: String(row.event_at), seq: Number(row.event_seq) }
      if (row.event_task_id !== null) event.taskId = String(row.event_task_id)
      if (row.event_project_id !== null) event.projectId = String(row.event_project_id)
      if (personIds.length) event.personIds = personIds
      record.event = event
    }
    return record
  }
  /** Events matching every given condition, oldest sequence first; the conditions run in SQLite and `from`/`to` include their times. */
  queryEvents(query: MemoryEventQuery = {}): IndexedMemory[] {
    const conditions = ["m.kind = 'event'", 'm.event_seq IS NOT NULL']
    const parameters: SQLInputValue[] = []
    const add = (condition: string, ...values: SQLInputValue[]): void => {
      conditions.push(condition)
      parameters.push(...values)
    }
    if (query.kind !== undefined) add('m.event_kind = ?', query.kind)
    if (query.taskId !== undefined) add('m.event_task_id = ?', query.taskId)
    if (query.projectId !== undefined) add('m.event_project_id = ?', query.projectId)
    if (query.personId !== undefined) add(`m.id IN (SELECT record_id FROM memory_person INDEXED BY memory_person_lookup
      WHERE record_kind = 'event' AND person_id = ?)`, query.personId)
    if (query.sourceKind !== undefined || query.sourceId !== undefined) {
      const source = ["s.record_kind = 'event'"]
      const values: SQLInputValue[] = []
      if (query.sourceKind !== undefined) { source.push('s.kind = ?'); values.push(query.sourceKind) }
      if (query.sourceId !== undefined) { source.push('s.id = ?'); values.push(query.sourceId) }
      const sourceIndex = query.sourceKind !== undefined ? 'memory_source_lookup' : 'memory_source_id'
      add(`m.id IN (SELECT s.record_id FROM memory_source s INDEXED BY ${sourceIndex} WHERE ${source.join(' AND ')})`, ...values)
    }
    if (query.from !== undefined) add('m.event_at >= ?', query.from)
    if (query.to !== undefined) add('m.event_at <= ?', query.to)
    if (query.afterSeq !== undefined) add('m.event_seq > ?', query.afterSeq)
    // Membership filters supply IDs; probe their primary keys rather than scanning every event to retain sequence order.
    const lookup = query.personId !== undefined || query.sourceKind !== undefined || query.sourceId !== undefined
      ? ' INDEXED BY sqlite_autoindex_memory_1' : ''
    return this.db.prepare(`SELECT m.kind, m.id FROM memory m${lookup} WHERE ${conditions.join(' AND ')}
      ORDER BY m.event_seq, m.rowid`).all(...parameters).map(row => this.get(String(row.kind), String(row.id))!)
  }
  /** Records that name `source` among their sources, answered by the source index alone. */
  findBySource(source: { kind: string; id: string }): IndexedMemory[] {
    return this.db.prepare(`SELECT m.kind, m.id FROM memory m JOIN memory_source s
      ON s.record_kind = m.kind AND s.record_id = m.id WHERE s.kind = ? AND s.id = ? ORDER BY m.kind, m.id`)
      .all(source.kind, source.id).map(row => this.get(String(row.kind), String(row.id))!)
  }
  /** The records that reference `kind`/`id`, each with the part and task recorded where it indexed that reference. */
  usedBy(kind: string, id: string): MemoryReference[] {
    return this.db.prepare(`SELECT from_kind, from_id, part, task_id FROM memory_reference
      WHERE target_kind = ? AND target_id = ? ORDER BY from_kind, from_id, rowid`).all(kind, id).map(row => {
      const reference: MemoryReference = { kind: String(row.from_kind), id: String(row.from_id) }
      if (row.part !== null) reference.part = String(row.part)
      if (row.task_id !== null) reference.taskId = String(row.task_id)
      return reference
    })
  }
  /** The largest persisted event sequence, or 0 when no event is indexed. */
  maxEventSeq(): number {
    const row = this.db.prepare("SELECT MAX(event_seq) AS seq FROM memory WHERE kind = 'event'").get()
    return row === undefined || row.seq === null ? 0 : Number(row.seq)
  }
  /** Records a diagnostic for memory `path`, replacing any earlier one for the same path. */
  report(path: string, reason: string): void { this.reported.set(path, reason) }
  /** Clears the diagnostic for `path`, if any. */
  clearDiagnostic(path: string): void { this.reported.delete(path) }
  /** Current diagnostics by path, in path order. */
  diagnostics(): { path: string; reason: string }[] {
    return [...this.reported].map(([path, reason]) => ({ path, reason })).sort((a, b) => a.path.localeCompare(b.path))
  }
  /** Closes the SQLite handle so the index file and its directory can be released. */
  close(): void { this.db.close() }
}
