/** User changes to remembered values: one editable file per change, keeping corrections beside the facts they correct. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEvents } from './events.ts'
import { publishFile } from './files.ts'
import type { PersonCards } from './people.ts'
import type { TaskLists } from './task-lists.ts'

/** A change the user asked for: what it applies to, its new text, when it became true, and the events that show it happened. */
export interface ChangeInput {
  kind: 'fact' | 'correction' | 'change'
  scope: 'task' | 'ongoing' | 'unclear'
  personId: string
  property: string
  text: string
  evidenceEventIds: string[]
  effectiveAt: string
  targetId?: string
  taskId?: string
  reason: string
}
/** The value one change writes to its target: a person requirement or a managed task note, as the target format holds it. */
export interface ChangeEntry {
  id: string
  text: string
  eventIds: string[]
  recipient?: string
  kind?: 'agreement' | 'note' | 'experience'
  createdAt?: string
}
/** The durable application of one change operation, kept in its history file so an interrupted write can resume. */
export interface ChangeApplication {
  status: 'pending' | 'applied'
  before: ChangeEntry | null
  expected: ChangeEntry | null
}
/** A saved change, exactly as its JSON file holds it. */
export interface MemoryChange extends ChangeInput { id: string; recordedAt: string; order: number; application?: ChangeApplication }
/** The actual target of a change, read from its person card or task list now. */
export interface ChangeTarget {
  kind: 'person' | 'task'
  id: string
  property: string
  path: string
  entry: ChangeEntry | null
}
/** The two stores a change applies to: a person card or a task list, through the writes each store already owns. */
export interface ChangeTargets {
  people: Pick<PersonCards, 'read' | 'save'>
  tasks: Pick<TaskLists, 'read' | 'save'>
}
/** The answer to a change request: saved as a record, or not saved because its scope must be asked about. */
export type ChangeResult = { status: 'recorded'; record: MemoryChange }
  | { status: 'needs_clarification'; question: string }
/**
 * The answer to applying a change: the saved record and the history record in effect at this moment, plus the actual
 * target entry read back from the card or task file, so a hand edit is never reported as the change's value.
 */
export type ChangeApplyResult = { status: 'recorded'; record: MemoryChange; current: MemoryChange | null; target: ChangeTarget }
  | { status: 'needs_clarification'; question: string }

const SCOPE_QUESTION = '这个要求只适用于这次任务，还是以后都适用？'
/** A task requirement of one person is one managed note, named by its person and property. */
const MANAGED_PREFIX = 'memory:'
/** The entry ID of one person's requirement on a task list. */
export const managedEntryId = (personId: string, property: string): string =>
  `${MANAGED_PREFIX}${personId}:${property}`
/** The stable history ID of one operation: replaying an operationId always names the same change file. */
export const changeIdOf = (operationId: string): string =>
  'change-' + createHash('sha256').update(operationId, 'utf8').digest('hex')

/** The target-entry shape of one person requirement, the same snapshot `target` reads back from the card. */
export const personRequirementEntry = (requirement: { id: string; text: string; eventIds: string[] }): ChangeEntry =>
  ({ id: requirement.id, text: requirement.text, eventIds: [...requirement.eventIds] })
/** The target-entry shape of one task note, so a captured target and a read-back target compare by the same fields. */
export const taskNoteEntry = (note: { id: string; text: string; sources?: readonly { id: string }[]
  recipient?: string; kind?: 'note' | 'agreement' | 'experience'; createdAt?: string }): ChangeEntry => ({
  id: note.id, text: note.text, eventIds: (note.sources ?? []).map(source => source.id),
  ...(note.recipient === undefined ? {} : { recipient: note.recipient }),
  ...(note.kind === undefined ? {} : { kind: note.kind }),
  ...(note.createdAt === undefined ? {} : { createdAt: note.createdAt }),
})
/** Whether two entry snapshots hold the same target content, ignoring object key order. */
export const sameChangeEntry = (left: ChangeEntry | null, right: ChangeEntry | null): boolean => {
  if (left === null || right === null) return left === right
  return left.id === right.id && left.text === right.text && left.recipient === right.recipient
    && left.kind === right.kind && left.createdAt === right.createdAt
    && left.eventIds.length === right.eventIds.length
    && left.eventIds.every((eventId, index) => eventId === right.eventIds[index])
}

/**
 * File-authoritative change history: every call reads the files, so hand edits and reopens are visible immediately.
 * A recorded change is one file. `apply` additionally keeps a pending/applied journal in that same file, so an
 * interrupted application can be completed after a reopen without a second history record or a second note.
 */
export class MemoryChanges {
  readonly root: string
  constructor(memoryRoot: string, private readonly events: MemoryEvents) {
    this.root = join(memoryRoot, 'changes')
    mkdirSync(this.root, { recursive: true })
  }
  /**
   * Saves `input` as a change, checking its evidence, scope and correction target once at entry.
   * An unclear scope writes nothing; it asks whether the request is for one task or from now on.
   */
  record(input: ChangeInput): ChangeResult {
    if (input.evidenceEventIds.length === 0) throw new Error('A change needs at least one evidence event')
    for (const id of input.evidenceEventIds) this.events.get(id)
    if (input.scope === 'task' && !input.taskId) throw new Error('A task-scoped change needs taskId')
    if (input.scope === 'unclear') return { status: 'needs_clarification', question: SCOPE_QUESTION }
    let target: MemoryChange | null = null
    if (input.kind === 'correction') {
      if (!input.targetId) throw new Error('A correction needs targetId')
      target = this.get(input.targetId)
      if (target.personId !== input.personId || target.property !== input.property
        || target.scope !== input.scope || target.taskId !== input.taskId)
        throw new Error('A correction must match its target person, property, scope and task')
    }
    const change: MemoryChange = { ...input, effectiveAt: target?.effectiveAt ?? input.effectiveAt,
      id: randomUUID(), recordedAt: new Date().toISOString(), order: this.history().length }
    this.writeChange(change)
    return { status: 'recorded', record: change }
  }
  /**
   * Records `input` under its stable `operationId` and applies the value currently in effect to the target card or
   * task list. The first call validates the evidence and the target, writes the complete pending record, writes the
   * expected entry, then marks the record applied. Replaying the operationId reads that record first: an applied
   * operation writes nothing, a pending one finishes the interrupted write, and a hand-edited target is kept.
   */
  apply(input: ChangeInput & { operationId: string }, targets: ChangeTargets): ChangeApplyResult {
    if (input.operationId.length === 0) throw new Error('A change operation needs an operationId')
    const id = changeIdOf(input.operationId)
    const path = join(this.root, id + '.json')
    // The retry reads the one record it already wrote, so it resumes that operation instead of recording a second one.
    if (existsSync(path)) return this.replay(this.get(id), targets)
    if (input.evidenceEventIds.length === 0) throw new Error('A change needs at least one evidence event')
    for (const eventId of input.evidenceEventIds) this.events.get(eventId)
    if (input.scope === 'task' && !input.taskId) throw new Error('A task-scoped change needs taskId')
    if (input.scope === 'unclear') return { status: 'needs_clarification', question: SCOPE_QUESTION }
    let effectiveAt = input.effectiveAt
    if (input.kind === 'correction') {
      if (!input.targetId) throw new Error('A correction needs targetId')
      const target = this.get(input.targetId)
      if (target.personId !== input.personId || target.property !== input.property
        || target.scope !== input.scope || target.taskId !== input.taskId)
        throw new Error('A correction must match its target person, property, scope and task')
      effectiveAt = target.effectiveAt
    }
    // The destination is read before anything is written, so a missing card or task leaves no journal behind.
    const destination = this.target(input, targets)
    const all = this.history()
    const records = all.filter(change => change.personId === input.personId
      && (input.taskId === undefined || change.taskId === input.taskId))
    const recordedAt = new Date().toISOString()
    const scope = input.scope as 'task' | 'ongoing'
    const draft: MemoryChange = { kind: input.kind, scope: input.scope, personId: input.personId,
      property: input.property, text: input.text, evidenceEventIds: [...input.evidenceEventIds], effectiveAt,
      reason: input.reason, id, recordedAt, order: all.length,
      ...(input.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) }
    const current = this.effective([...records, draft], { property: input.property, scope, taskId: input.taskId, at: recordedAt })
    const before = destination.entry
    const expected = current ? this.entryFor(input, current, scope, recordedAt, before) : null
    const pending: MemoryChange = { ...draft, application: { status: 'pending', before, expected } }
    this.writeChange(pending)
    if (expected !== null) this.saveTarget(input, expected, targets)
    const applied: MemoryChange = { ...pending, application: { status: 'applied', before, expected } }
    this.writeChange(applied)
    return { status: 'recorded', record: applied, current, target: this.target(input, targets) }
  }
  /** The actual target entry of `query` now; throws when its person card or task list does not exist. */
  target(query: Pick<ChangeInput, 'personId' | 'property' | 'scope' | 'taskId'>, targets: ChangeTargets): ChangeTarget {
    if (query.scope === 'ongoing') {
      const view = targets.people.read(query.personId)
      const requirement = view.card.requirements.find(item => item.id === query.property)
      return { kind: 'person', id: query.personId, property: query.property, path: view.path,
        entry: requirement ? personRequirementEntry(requirement) : null }
    }
    if (query.scope !== 'task') throw new Error('A task-scoped change needs taskId')
    const taskId = query.taskId
    if (taskId === undefined) throw new Error('A task-scoped change needs taskId')
    const view = targets.tasks.read(taskId)
    const note = view.task.notes.find(item => item.id === managedEntryId(query.personId, query.property))
    return { kind: 'task', id: taskId, property: query.property, path: view.path,
      entry: note ? taskNoteEntry(note) : null }
  }
  /** Every saved change matching the query, read from disk and ordered by when it was recorded. */
  history({ personId, taskId }: { personId?: string; taskId?: string } = {}): MemoryChange[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json'))
      .map(name => this.get(name.slice(0, -'.json'.length)))
      .filter(change => (!personId || change.personId === personId) && (!taskId || change.taskId === taskId))
      .sort((a, b) => a.order - b.order)
  }
  /**
   * The value in effect at `at`: corrections replace the entries they point at, including chained
   * corrections, then the latest fact or change whose effective time is not after `at` wins, or null.
   */
  current(query: { personId: string; property: string; scope: 'task' | 'ongoing'; taskId?: string; at: string }): MemoryChange | null {
    return this.effective(this.history({ personId: query.personId, taskId: query.taskId }), query)
  }
  /** The saved change `id` as its file currently holds it. */
  get(id: string): MemoryChange {
    return JSON.parse(readFileSync(join(this.root, id + '.json'), 'utf8')) as MemoryChange
  }
  /** The effective record among `records` at `query.at`, applying correction chains as `current` always has. */
  private effective(records: MemoryChange[],
    query: { property: string; scope: 'task' | 'ongoing'; taskId?: string; at: string }): MemoryChange | null {
    const matching = records.filter(change => change.property === query.property && change.scope === query.scope
      && change.taskId === query.taskId)
    const corrections = new Map<string, MemoryChange>()
    for (const change of matching) if (change.kind === 'correction' && change.targetId) corrections.set(change.targetId, change)
    const inEffect = matching.filter(change => change.kind !== 'correction').map(change => {
      let current = change
      let correction = corrections.get(current.id)
      while (correction) { current = correction; correction = corrections.get(current.id) }
      return current
    })
    return inEffect.filter(change => change.effectiveAt <= query.at)
      .sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.order - b.order).at(-1) ?? null
  }
  /** Finish or ignore an operation that already has a history file, never writing a second record. */
  private replay(record: MemoryChange, targets: ChangeTargets): ChangeApplyResult {
    const application = record.application
    if (application === undefined || application.status === 'applied') return this.finished(record, targets)
    const destination = this.target(record, targets)
    if (sameChangeEntry(destination.entry, application.before)) {
      // The interrupted call wrote its journal but not the card or note: finish what it planned.
      if (application.expected !== null) this.saveTarget(record, application.expected, targets)
    }
    // An already-written value or a later manual edit needs no current-value write.
    const applied: MemoryChange = { ...record,
      application: { status: 'applied', before: application.before, expected: application.expected } }
    this.writeChange(applied)
    return this.finished(applied, targets)
  }
  /** The recorded result of one operation, with the actual target read back from its file. */
  private finished(record: MemoryChange, targets: ChangeTargets): ChangeApplyResult {
    const scope = record.scope
    if (scope === 'unclear') throw new Error(`Change ${record.id} has no applicable scope`)
    const at = new Date().toISOString()
    return { status: 'recorded', record, current: this.current({ personId: record.personId,
      property: record.property, scope, taskId: record.taskId, at }), target: this.target(record, targets) }
  }
  /** The target entry the effective record should have, keeping an updated task note's creation time. */
  private entryFor(input: ChangeInput, current: MemoryChange, scope: 'task' | 'ongoing', recordedAt: string,
    before: ChangeEntry | null): ChangeEntry {
    if (scope === 'ongoing') return { id: input.property, text: current.text, eventIds: [...current.evidenceEventIds] }
    // A single task requirement is one agreement note whose id names the person and property; its creation time survives updates.
    return { id: managedEntryId(input.personId, input.property), text: current.text, eventIds: [...current.evidenceEventIds],
      recipient: input.personId, kind: 'agreement', createdAt: before?.createdAt ?? recordedAt }
  }
  /** Write one target entry in place: replace the managed entry when it exists, otherwise append it once. */
  private saveTarget(query: Pick<ChangeInput, 'personId' | 'property' | 'scope' | 'taskId'>, expected: ChangeEntry,
    targets: ChangeTargets): void {
    if (query.scope === 'ongoing') {
      const view = targets.people.read(query.personId)
      const requirement = { id: expected.id, text: expected.text, eventIds: [...expected.eventIds] }
      const exists = view.card.requirements.some(item => item.id === expected.id)
      targets.people.save({ ...view.card, requirements: exists
        ? view.card.requirements.map(item => item.id === expected.id ? requirement : item)
        : [...view.card.requirements, requirement] })
      return
    }
    if (query.scope !== 'task') throw new Error('A task-scoped change needs taskId')
    const taskId = query.taskId
    if (taskId === undefined) throw new Error('A task-scoped change needs taskId')
    const view = targets.tasks.read(taskId)
    const note = { id: expected.id, text: expected.text, kind: 'agreement' as const, recipient: query.personId,
      sources: expected.eventIds.map(eventId => ({ kind: 'event', id: eventId })),
      ...(expected.createdAt !== undefined ? { createdAt: expected.createdAt } : {}) }
    const exists = view.task.notes.some(item => item.id === expected.id)
    targets.tasks.save({ ...view.task, notes: exists
      ? view.task.notes.map(item => item.id === expected.id ? note : item)
      : [...view.task.notes, note] })
  }
  /** Publish one history record completely; a reader sees the old file or the new one, never a partial journal. */
  private writeChange(change: MemoryChange): void {
    publishFile(join(this.root, change.id + '.json'), JSON.stringify(change, null, 2) + '\n')
  }
}
