/** Confirmed experiences in the experiences memory library, promoted from a tentative short-term item by a final fact. */
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { MemoryEvent, MemoryEvents } from './events.ts'
import type { MemoryIndex, MemoryReference } from './index.ts'
import type { MemoryRecord, MemorySource, MemoryStore } from './store.ts'
import type { ShortTerm, ShortTermView } from './short-term.ts'

/** Where one experience came from: a user's direct teaching, or an inference later confirmed by final facts. */
export type ExperienceOrigin = 'user' | 'inferred'
/** One earlier text of a confirmed experience: when it was replaced, by which user event, and why. */
export interface ExperienceRevision { at: string; text: string; eventId: string; reason: string }
/** One confirmed experience as its record holds it, plus the file path and content version a reader can cite. */
export interface ExperienceView {
  id: string
  text: string
  eventIds: string[]
  finalEventIds: string[]
  reason: string
  methodVersion: string
  origin: ExperienceOrigin
  history: ExperienceRevision[]
  path: string
  version: string
}
/** A tentative lesson: real source events, an optional owner task, and the method version that produced it. */
export interface TentativeExperienceInput { text: string; eventIds: string[]; taskId?: string; methodVersion?: string }
/** A confirmation attempt: high needs final facts; tentative leaves the short-term item where it is. */
export interface JudgeExperienceInput {
  id: string
  finalEventIds: string[]
  confidence: 'high' | 'tentative'
  reason: string
  methodVersion?: string
}
/** What a review decided: a confirmed experience, or the untouched tentative item. */
export type JudgeExperienceResult =
  | { status: 'confirmed'; experience: ExperienceView }
  | { status: 'tentative'; item: ShortTermView }
/** A user's direct teaching is confirmed at once. */
export interface DirectExperienceInput { text: string; eventId: string; methodVersion?: string }
/** One replacement of a confirmed experience's text, evidenced by a user event. */
export interface CorrectExperienceInput { id: string; text: string; eventId: string; reason: string }

/** The JSON content of one confirmed experience record. */
interface StoredExperience {
  text: string
  eventIds: string[]
  finalEventIds: string[]
  reason: string
  methodVersion: string
  origin: ExperienceOrigin
  history: ExperienceRevision[]
}

const DEFAULT_METHOD_VERSION = 'builtin-v1'
const TICKET_ENDED = 'ticket.ended'
const DIRECT_REASON = 'direct'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.length > 0)
const isRevisions = (value: unknown): value is ExperienceRevision[] =>
  Array.isArray(value) && value.every(entry => isRecord(entry) && typeof entry.at === 'string'
    && typeof entry.text === 'string' && typeof entry.eventId === 'string' && typeof entry.reason === 'string')

/**
 * The experiences library over the events memory store and its shared index. A tentative lesson is one short-term
 * experience item; a high-confidence review writes the confirmed record first and only then removes that item.
 * Confirmed records reference every source event and final fact in the same MemoryIndex used by the rest of memory.
 */
export class Experiences {
  private readonly root: string
  private readonly store: MemoryStore
  private readonly index: MemoryIndex
  /** Opens the library, sharing the event store's index and reindexing every confirmed record once. */
  constructor(memoryRoot: string, private readonly shortTerm: ShortTerm, private readonly events: MemoryEvents) {
    this.root = join(memoryRoot, 'experiences')
    this.store = events.store
    this.index = events.index
    this.list()
  }
  /** Record a tentative lesson as an independent or task-bound experience item with real event sources. */
  tentative(input: TentativeExperienceInput): ShortTermView {
    const eventIds = [...input.eventIds]
    for (const eventId of eventIds) this.events.get(eventId)
    return this.shortTerm.remember({
      kind: 'experience',
      text: input.text,
      sources: eventIds.map(id => ({ kind: 'event', id })),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
      methodVersion: input.methodVersion ?? DEFAULT_METHOD_VERSION,
    }, randomUUID())
  }
  /**
   * Review one tentative experience. `tentative` returns the same item and moves nothing; `high` requires existing
   * final facts, accepting a user event or a worker `ticket.ended` engine event, and a task-bound worker final event
   * must carry that task ID. The written record keeps the item's method version, then the item is removed.
   */
  judge(input: JudgeExperienceInput): JudgeExperienceResult {
    const item = this.shortTerm.read(input.id)
    if (item.kind !== 'experience') throw new Error(`Short-term memory ${input.id} is not an experience`)
    if (input.confidence === 'tentative') return { status: 'tentative', item }
    this.checkFinalFacts(input.finalEventIds, item.taskId)
    const experience = this.save(item.id, {
      text: item.text,
      eventIds: item.sources.filter(source => source.kind === 'event').map(source => source.id),
      finalEventIds: [...input.finalEventIds],
      reason: input.reason,
      methodVersion: item.methodVersion ?? input.methodVersion ?? DEFAULT_METHOD_VERSION,
      origin: 'inferred',
      history: [],
    })
    this.shortTerm.removeExperience(item.id)
    return { status: 'confirmed', experience }
  }
  /** Record a user's direct teaching as a confirmed experience at once; the event must be a real user event. */
  direct(input: DirectExperienceInput): ExperienceView {
    const event = this.userEvent(input.eventId)
    return this.save(randomUUID(), {
      text: input.text,
      eventIds: [event.id],
      finalEventIds: [],
      reason: DIRECT_REASON,
      methodVersion: input.methodVersion ?? DEFAULT_METHOD_VERSION,
      origin: 'user',
      history: [],
    })
  }
  /** Replace the text of one confirmed experience, keeping its origin, method version, event sources and revisions. */
  correct(input: CorrectExperienceInput): ExperienceView {
    const record = this.store.get('experiences', input.id)
    const current = this.viewOf(record)
    const event = this.userEvent(input.eventId)
    return this.save(input.id, {
      text: input.text,
      eventIds: [...current.eventIds],
      finalEventIds: [...current.finalEventIds],
      reason: current.reason,
      methodVersion: current.methodVersion,
      origin: current.origin,
      history: [...current.history, { at: new Date().toISOString(), text: current.text,
        eventId: event.id, reason: input.reason }],
    }, record.source)
  }
  /** Read one confirmed experience by ID, from its authoritative record. */
  read(id: string): ExperienceView {
    const record = this.store.get('experiences', id)
    const view = this.viewOf(record)
    this.indexRecord(record, view)
    return view
  }
  /** Every confirmed experience, oldest first; a broken record is reported and never hides the others. */
  list(): ExperienceView[] {
    const views: ExperienceView[] = []
    const records = this.store.list('experiences')
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    for (const record of records) {
      try {
        const view = this.viewOf(record)
        this.indexRecord(record, view)
        views.push(view)
      } catch (error) {
        this.index.report(this.pathOf(record.id), reasonOf(error))
      }
    }
    return views
  }
  /** Reject high confidence that cites no real final fact, an ordinary worker report, or a task-bound mismatch. */
  private checkFinalFacts(finalEventIds: string[], taskId: string | undefined): void {
    if (finalEventIds.length === 0) {
      throw new Error('High-confidence experience review needs at least one final event')
    }
    for (const eventId of finalEventIds) {
      const event = this.events.get(eventId)
      if (event.event.kind === 'user') continue
      if (event.event.kind !== 'worker' || event.event.source.kind !== 'engine-event') {
        throw new Error(`Event ${eventId} is not a final user fact or worker ticket.ended engine event`)
      }
      let parsed: unknown = undefined
      try {
        parsed = JSON.parse(event.event.text)
      } catch {
        throw new Error(`Event ${eventId} is not a final ticket.ended engine event`)
      }
      if (!isRecord(parsed) || parsed.type !== TICKET_ENDED) {
        throw new Error(`Event ${eventId} is not a final ticket.ended engine event`)
      }
      if (taskId !== undefined && event.event.taskId !== taskId) {
        throw new Error(`Final event ${eventId} belongs to task ${event.event.taskId ?? '(none)'}, not ${taskId}`)
      }
    }
  }
  /** Read one event and require the user origin, for direct teaching and corrections. */
  private userEvent(eventId: string): MemoryEvent {
    const event = this.events.get(eventId)
    if (event.event.kind !== 'user') throw new Error(`Event ${eventId} is not a user event`)
    return event
  }
  /** Store one confirmed record, then index every source and final event so usedBy can find it. */
  private save(id: string, data: StoredExperience, source?: MemorySource): ExperienceView {
    const first = [...data.eventIds, ...data.finalEventIds][0]
    const record = this.store.put('experiences', { id,
      source: source ?? (first === undefined ? { kind: 'experience', id } : { kind: 'event', id: first }),
      content: JSON.stringify(data, null, 2) + '\n' })
    const view: ExperienceView = { ...data, id: record.id, path: this.pathOf(record.id), version: record.version }
    this.indexRecord(record, view)
    return view
  }
  /** One record as a view, rejecting content that is not a stored experience. */
  private viewOf(record: MemoryRecord): ExperienceView {
    const path = this.pathOf(record.id)
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(record.content)
    } catch (error) {
      throw new Error(`Invalid experience ${path}: ${reasonOf(error)}`)
    }
    if (!isRecord(parsed)) throw new Error(`Invalid experience ${path}: not a stored experience`)
    const { text, eventIds, finalEventIds, reason, methodVersion, origin, history } = parsed
    if (typeof text !== 'string' || !isStringArray(eventIds) || !isStringArray(finalEventIds)
      || typeof reason !== 'string' || typeof methodVersion !== 'string'
      || (origin !== 'user' && origin !== 'inferred') || !isRevisions(history)) {
      throw new Error(`Invalid experience ${path}: not a stored experience`)
    }
    return { id: record.id, text, eventIds: [...eventIds], finalEventIds: [...finalEventIds], reason,
      methodVersion, origin, history: history.map(entry => ({ ...entry })), path, version: record.version }
  }
  /**
   * Index one record's sources (original events and final events) and references (those plus every correction event),
   * keeping the record's own source first so a later MemoryStore read does not replace the richer rows.
   */
  private indexRecord(record: MemoryRecord, view: ExperienceView): void {
    const sourceIds: string[] = []
    const addSource = (id: string): void => { if (!sourceIds.includes(id)) sourceIds.push(id) }
    for (const id of view.eventIds) addSource(id)
    for (const id of view.finalEventIds) addSource(id)
    const references: MemoryReference[] = sourceIds.map(id => ({ kind: 'event', id }))
    const referenceIds = new Set(sourceIds)
    for (const revision of view.history) {
      if (referenceIds.has(revision.eventId)) continue
      referenceIds.add(revision.eventId)
      references.push({ kind: 'event', id: revision.eventId })
    }
    const sources: MemorySource[] = [record.source]
    for (const id of sourceIds) {
      if (sources.some(source => source.kind === 'event' && source.id === id)) continue
      sources.push({ kind: 'event', id })
    }
    this.index.upsert({ kind: 'experiences', id: record.id, path: this.pathOf(record.id),
      version: record.version, sources, references })
  }
  /** The absolute path of one confirmed record. */
  private pathOf(id: string): string { return join(this.root, id + '.json') }
}
