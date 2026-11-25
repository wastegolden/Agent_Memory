/** Event facts with separate user, Jarvis and Worker origins: flat monthly JSON files stay authoritative, and the rebuildable index answers every filter. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { publishFile } from './files.ts'
import { MemoryIndex, type IndexedMemory } from './index.ts'
import { MemoryStore, type MemoryRecord, type MemorySource } from './store.ts'

export interface EventInput {
  kind: 'user' | 'jarvis' | 'worker'
  at: string
  text: string
  source: MemorySource
  taskId?: string
  projectId?: string
  personIds?: string[]
  log?: { sessionId: string; resource: string }
}
/** One event as its file holds it: `id`, `seq` and the save times are flat beside the event fields, never nested. */
interface StoredEvent extends EventInput { id: string; seq: number; createdAt: string; updatedAt: string }
/** One event as memory returns it: the compatibility record fields, the event fields, its sequence and its authoritative file path. */
export interface MemoryEvent extends MemoryRecord { event: EventInput; seq: number; path: string }
/** Event filters, all applied by SQLite; `from`/`to` include their event times and `afterSeq` returns later sequences. */
export interface EventQuery {
  kind?: EventInput['kind']
  taskId?: string
  projectId?: string
  personId?: string
  sourceKind?: string
  sourceId?: string
  from?: string
  to?: string
  afterSeq?: number
}

/** A month directory holds only event files, named `YYYYMMDD-<sha256 of the event identity>.json`. */
const MONTH_DIRECTORY = /^\d{4}-\d{2}$/
/** The event ID carries the first event date, so `get` locates its file without the index. */
const EVENT_ID = /^\d{8}-[0-9a-f]{64}$/
const EVENT_KINDS = new Set(['user', 'jarvis', 'worker'])
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/** The identity of one event source: the same kind, source kind and source ID keep the same event ID forever. */
const eventHash = (kind: EventInput['kind'], source: MemorySource): string => sha256(JSON.stringify([kind, source.kind, source.id]))
/** The 8-digit first event date that names the file and its month directory. */
const eventDate = (at: string): string => {
  const match = /^\d{4}-\d{2}-\d{2}/.exec(at)
  const date = match?.[0]
  if (date === undefined) throw new Error(`Event time must start with an ISO date: ${at}`)
  return date.replaceAll('-', '')
}
/** The compatibility source on a returned record: `event-user`, `event-jarvis` or `event-worker`. */
const wrapperSource = (kind: string, source: MemorySource): MemorySource =>
  ({ kind: `event-${kind}`, id: source.id, ...(source.path === undefined ? {} : { path: source.path }) })
/** Whether a parsed file is one flat event record with a walkable first date and sequence. */
const isStoredEvent = (value: unknown): value is StoredEvent => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<StoredEvent>
  return typeof candidate.id === 'string' && typeof candidate.seq === 'number' && Number.isInteger(candidate.seq)
    && candidate.seq >= 1 && typeof candidate.createdAt === 'string' && typeof candidate.updatedAt === 'string'
    && typeof candidate.kind === 'string' && EVENT_KINDS.has(candidate.kind)
    && typeof candidate.at === 'string' && /^\d{4}-\d{2}-\d{2}/.test(candidate.at) && typeof candidate.text === 'string'
    && typeof candidate.source === 'object' && candidate.source !== null
    && typeof candidate.source.kind === 'string' && typeof candidate.source.id === 'string'
    && (candidate.source.path === undefined || typeof candidate.source.path === 'string')
    && (candidate.taskId === undefined || typeof candidate.taskId === 'string')
    && (candidate.projectId === undefined || typeof candidate.projectId === 'string')
    && (candidate.personIds === undefined || (Array.isArray(candidate.personIds)
      && candidate.personIds.every(id => typeof id === 'string')))
    && (candidate.log === undefined || (typeof candidate.log === 'object' && candidate.log !== null
      && typeof candidate.log.sessionId === 'string' && typeof candidate.log.resource === 'string'))
}

/**
 * Event facts under `<memoryRoot>/events/YYYY-MM`, one flat JSON file per event whose ID and sequence are assigned once per
 * source kind and kept across edits and rebuilds. The index answers every filter; reads still go to the authoritative file.
 */
export class MemoryEvents {
  readonly store: MemoryStore
  readonly index: MemoryIndex
  /**
   * Opens the event stream at `root`; a supplied index is shared, and without one the stream keeps an in-memory index.
   * Scans the month files once so the index starts from the authoritative sequences, never from a stale row.
   */
  constructor(readonly root: string, index?: MemoryIndex) {
    this.index = index ?? new MemoryIndex(root, { memory: true })
    this.store = new MemoryStore(root, { index: this.index })
    this.reconcile()
  }
  /**
   * Writes one event. A source already recorded under this kind keeps its ID, sequence, path and createdAt whatever its
   * `at` becomes; a new source gets `index.maxEventSeq() + 1` and a path dated by its first `at`.
   */
  record(event: EventInput): MemoryEvent {
    const now = new Date().toISOString()
    const existing = this.index.queryEvents({ sourceKind: event.source.kind, sourceId: event.source.id })
      .find(item => item.event?.kind === event.kind)
    if (existing) {
      if (existsSync(existing.path)) {
        const { stored } = this.readStored(existing.path)
        return this.write({ id: existing.id, seq: stored.seq, createdAt: stored.createdAt, updatedAt: now, ...event },
          existing.path)
      }
      // The indexed file is gone: drop the stale row, then treat the source as new so no identity points at nothing.
      this.index.remove('event', existing.id)
    }
    const id = `${eventDate(event.at)}-${eventHash(event.kind, event.source)}`
    return this.write({ id, seq: this.index.maxEventSeq() + 1, createdAt: now, updatedAt: now, ...event }, this.eventPath(id))
  }
  /** Reads event `id` from the file its date names, so the index locates nothing; an edited file is hashed again and refreshed. */
  get(id: string): MemoryEvent {
    const path = this.eventPath(id)
    const { content, stored } = this.readStored(path)
    if (stored.id !== id) {
      this.index.report(path, `event id ${stored.id} does not match its file name`)
      throw new Error(`Invalid event file ${path}: id ${stored.id} does not match ${id}`)
    }
    const version = sha256(content)
    const indexed = this.index.get('event', id)
    if (!indexed || indexed.version !== version || indexed.path !== path) this.index.upsert(this.indexed(stored, path, version))
    this.index.clearDiagnostic(path)
    return this.memoryEvent(stored, path, version)
  }
  /**
   * Events matching every filter, located by the index and read from their files; a damaged file is reported by path and
   * left out instead of hiding the other hits. The default order stays by event time, and an `afterSeq` cursor reads by sequence.
   */
  list(query: EventQuery = {}): MemoryEvent[] {
    const events: MemoryEvent[] = []
    for (const hit of this.index.queryEvents(query)) {
      try {
        events.push(this.get(hit.id))
      } catch (error) {
        this.index.report(hit.path, reasonOf(error))
      }
    }
    return query.afterSeq === undefined
      ? events.sort((a, b) => a.event.at.localeCompare(b.event.at) || a.seq - b.seq)
      : events.sort((a, b) => a.seq - b.seq)
  }
  /**
   * Rebuilds the event rows by scanning the month files once: every flat event is indexed from its file's sequence and
   * version, rows whose files are gone are removed (other kinds are left alone), and a repaired file loses its diagnostic.
   */
  reconcile(): void {
    const found = new Map<string, { stored: StoredEvent; path: string; version: string }>()
    const eventsRoot = join(this.root, 'events')
    if (existsSync(eventsRoot)) {
      for (const month of readdirSync(eventsRoot, { withFileTypes: true })) {
        if (!month.isDirectory() || !MONTH_DIRECTORY.test(month.name)) continue
        const directory = join(eventsRoot, month.name)
        for (const file of readdirSync(directory, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.json') || file.name.startsWith('.')) continue
          const path = join(directory, file.name)
          try {
            const { content, stored } = this.readStored(path)
            found.set(stored.id, { stored, path, version: sha256(content) })
            this.index.clearDiagnostic(path)
          } catch (error) {
            this.index.report(path, reasonOf(error))
          }
        }
      }
    }
    const indexed = new Map(this.index.queryEvents({}).map(item => [item.id, item] as const))
    for (const item of indexed.values()) {
      if (found.has(item.id) || existsSync(item.path)) continue
      this.index.remove('event', item.id)
    }
    for (const [id, item] of found) {
      const current = indexed.get(id)
      if (!current || current.version !== item.version || current.path !== item.path)
        this.index.upsert(this.indexed(item.stored, item.path, item.version))
    }
  }
  /** Reads one event file and its flat record; a broken file is reported by path and thrown with that path in the message. */
  private readStored(path: string): { content: string; stored: StoredEvent } {
    const content = readFileSync(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(content)
    } catch (error) {
      this.index.report(path, `invalid JSON: ${reasonOf(error)}`)
      throw new Error(`Invalid event file ${path}: ${reasonOf(error)}`)
    }
    if (!isStoredEvent(value)) {
      this.index.report(path, 'invalid event record')
      throw new Error(`Invalid event file ${path}: not a flat event record`)
    }
    return { content, stored: value }
  }
  /** Publishes `stored` at `path` first, then indexes its version: a failed file write never leaves an index row. */
  private write(stored: StoredEvent, path: string): MemoryEvent {
    mkdirSync(dirname(path), { recursive: true })
    const text = `${JSON.stringify(stored, null, 2)}\n`
    const version = sha256(text)
    publishFile(path, text)
    this.index.upsert(this.indexed(stored, path, version))
    this.index.clearDiagnostic(path)
    return this.memoryEvent(stored, path, version)
  }
  /** The authoritative path of event `id`: its first date names the month directory and file name. */
  private eventPath(id: string): string {
    if (!EVENT_ID.test(id)) throw new Error(`Event ID has no date prefix: ${id}`)
    return join(this.root, 'events', `${id.slice(0, 4)}-${id.slice(4, 6)}`, `${id}.json`)
  }
  /** The index metadata of one event: its original source and compatibility source, plus the fields every filter reads. */
  private indexed(stored: StoredEvent, path: string, version: string): IndexedMemory {
    const event: NonNullable<IndexedMemory['event']> = { kind: stored.kind, at: stored.at, seq: stored.seq }
    if (stored.taskId !== undefined) event.taskId = stored.taskId
    if (stored.projectId !== undefined) event.projectId = stored.projectId
    if (stored.personIds !== undefined) event.personIds = stored.personIds
    return { kind: 'event', id: stored.id, path, version,
      sources: [stored.source, wrapperSource(stored.kind, stored.source)], event }
  }
  /** One returned event: flat metadata beside the event, the compatibility source, and the JSON content kept in memory only. */
  private memoryEvent(stored: StoredEvent, path: string, version: string): MemoryEvent {
    const { id, seq, createdAt, updatedAt, ...event } = stored
    return { id, seq, createdAt, updatedAt, source: wrapperSource(stored.kind, stored.source), version,
      content: JSON.stringify(event), event, path }
  }
}
