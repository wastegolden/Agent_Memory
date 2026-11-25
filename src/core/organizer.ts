/** The S3-2 organizer: one persisted cursor/pending state turns new source events into short-term entries and changes. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChangeEntry, ChangeInput, MemoryChange, MemoryChanges } from './changes.ts'
import { changeIdOf, managedEntryId, personRequirementEntry, sameChangeEntry, taskNoteEntry } from './changes.ts'
import type { DroppedSelectionEntry, EventMemoryInput, EventMemorySelection } from './compaction-selection.ts'
import type { MemoryEvent, MemoryEvents } from './events.ts'
import { publishFile } from './files.ts'
import type { MemoryReference } from './index.ts'
import { BUILTIN_METHOD_VERSION } from './methods.ts'
import type { PersonCards } from './people.ts'
import type { ShortTerm, ShortTermInput, ShortTermView } from './short-term.ts'
import type { TaskLists } from './task-lists.ts'

/** Why an organize pass was requested; only `turn` applies the event-count threshold. */
export type OrganizerReason = 'turn' | 'compaction' | 'idle' | 'sleep'
/** The extra selection context one pass hands down: its trigger reason and the run that actually started it. */
export interface OrganizerSelectContext { reason: OrganizerReason; runId?: string }
/** One selection plus the code-fixed method version that produced it. */
export type OrganizerSelection = EventMemorySelection & { methodVersion?: string }
/** How many events a `turn` needs before a pass, and the most events one model call may take. */
export interface OrganizerLimits { threshold: number; batchSize: number }
/** One referenced event's captured version, so a later write never uses evidence the selector did not see. */
export interface OrganizerObservedSource { kind: 'event'; id: string; version: string; selectionVersion?: string }
/** The pre-select evidence one operation needs: its cited event versions and its target entry (null when absent). */
export interface OrganizerObserved { sources: OrganizerObservedSource[]; target: ChangeEntry | null }
/** One durable operation of a pending batch, named by its stable ID so a retry never writes it twice. */
export type OrganizerOperation =
  | { id: string; type: 'remember'; input: ShortTermInput; observed?: OrganizerObserved }
  | { id: string; type: 'change'; input: ChangeInput; observed?: OrganizerObserved }
/**
 * The batch saved before its first write: every operation must finish before the cursor may move to `throughSeq`.
 * `methodVersion` is the version fixed when this batch was selected; a legacy pending file without it is builtin-v1.
 */
export interface OrganizerPending {
  throughSeq: number
  methodVersion?: string
  operations: OrganizerOperation[]
  dropped?: DroppedSelectionEntry[]
}
/** The whole persisted organizer state: how far the cursor reached, plus the unfinished batch it must replay first. */
export interface OrganizerState { cursor: number; pending?: OrganizerPending }
/**
 * One stale operation handed to the controller's durable review queue instead of being written.
 * `target` names what a redo applies to; `observedSources` carries only versions actually captured before the
 * selector ran, while `sourceIds` preserves the cited events even for a legacy pending operation with no versions.
 */
export interface OrganizerDeferred {
  operationId: string
  target: MemoryReference
  sourceIds: string[]
  observedSources: OrganizerObservedSource[]
  reason: 'redo'
  mode: 'target' | 'reselect'
}
/** A synchronous handoff to the controller's durable review queue; its success counts as this operation handled. */
export type OrganizerDefer = (deferred: OrganizerDeferred) => string | void
/** What one pass did; `cursor` is the persisted cursor after the pass and `throughSeq` names the batch that finished. */
export interface OrganizeResult {
  status: 'skipped' | 'idle' | 'organized' | 'recovered'
  cursor: number
  throughSeq?: number
  /** The code-fixed method version of the selected batch; a skipped or idle pass selected nothing and omits it. */
  methodVersion?: string
  itemIds: string[]
  changeIds: string[]
  dropped?: DroppedSelectionEntry[]
  deferredIds?: string[]
  reviewIds?: string[]
}
/** What the organizer reads and writes; the selector is the only model-facing dependency. */
export interface MemoryOrganizerDeps {
  events: MemoryEvents
  shortTerm: ShortTerm
  changes: MemoryChanges
  people: PersonCards
  tasks: TaskLists
  select: (input: EventMemoryInput, signal?: AbortSignal,
    context?: OrganizerSelectContext) => Promise<OrganizerSelection>
  /** Optional so an older standalone fixture still works; a genuinely stale operation without it fails closed. */
  defer?: OrganizerDefer
}
/** One eligible source event's indexed identity; bodies are read once a batch is chosen. */
interface EligibleEvent { id: string; seq: number }
/** The durable batch's pre-select evidence: event versions and every candidate person/task target entry. */
interface OrganizerObservations {
  events: Map<string, { version: string; selectionVersion: string }>
  people: Map<string, Map<string, ChangeEntry>>
  tasks: Map<string, Map<string, ChangeEntry>>
}
/** The ids one pass wrote or deferred, plus every value this durable batch actually wrote. */
interface ApplyPass {
  itemIds: string[]
  changeIds: string[]
  deferredIds: string[]
  reviewIds: string[]
  owned: Map<string, ChangeEntry[]>
}
type RememberOperation = Extract<OrganizerOperation, { type: 'remember' }>
type ChangeOperation = Extract<OrganizerOperation, { type: 'change' }>
type PersonRead = ReturnType<PersonCards['list']>[number]
type TaskRead = ReturnType<TaskLists['list']>[number]

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The exact event fields the selector sees; linking a person only changes metadata outside this projection. */
const selectedEvent = (event: MemoryEvent): EventMemoryInput['events'][number] => ({
  id: event.id, seq: event.seq,
  event: { kind: event.event.kind, at: event.event.at, text: event.event.text,
    source: { kind: event.event.source.kind, id: event.event.source.id },
    ...(event.event.taskId === undefined ? {} : { taskId: event.event.taskId }) },
})
/** The identity of one change target, for knowing which entries this durable batch already wrote. */
const targetKeyOf = (input: ChangeInput): string =>
  JSON.stringify([input.scope, input.personId, input.property, input.taskId ?? null])
/** Whether a file-read error means the record simply does not exist yet. */
const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'

/**
 * One persisted organizer state over the event stream: every pass reads `organizer-state.json`, replays an unfinished
 * batch before selecting anything new, and advances the cursor only after every operation of a batch succeeded. A batch
 * is published before its first write together with the event versions and target entries the selector saw, so an
 * interrupted or killed process reopens with the same stable operation IDs, idempotent store writes and late-edit
 * evidence instead of a second copy or an overwrite. One instance runs one pass at a time.
 */
export class MemoryOrganizer {
  readonly root: string
  private readonly statePath: string
  private readonly deps: MemoryOrganizerDeps
  private readonly limits: OrganizerLimits
  /** The last state this instance read or published; only a pass start and a successful publish change it. */
  private state: OrganizerState
  /** The one pass currently running, shared by every trigger until it settles. */
  private running: Promise<OrganizeResult> | undefined = undefined
  /** Opens the state at `root`, creating the directory when missing, and reads the persisted state once. */
  constructor(root: string, deps: MemoryOrganizerDeps, limits: OrganizerLimits) {
    this.root = root
    this.statePath = join(root, 'organizer-state.json')
    this.deps = deps
    this.limits = limits
    mkdirSync(root, { recursive: true })
    this.state = this.readState()
  }
  /** One pass at a time: a repeated trigger shares the running promise, and a settled pass lets the next trigger start. */
  organize(options: { reason: OrganizerReason; signal?: AbortSignal; runId?: string }): Promise<OrganizeResult> {
    if (this.running !== undefined) return this.running
    const running = this.run(options.reason, options.signal, options.runId)
    this.running = running
    const settle = (): void => { if (this.running === running) this.running = undefined }
    // Both branches settle the private promise, so a rejected pass never becomes an unhandled rejection here.
    void running.then(settle, settle)
    return running
  }
  /** Resolves when no pass is running; a rejected pass is swallowed here and still thrown to its caller. */
  settled(): Promise<void> {
    const running = this.running
    if (running === undefined) return Promise.resolve()
    return running.then(() => undefined, () => undefined)
  }
  /** The authoritative persisted state, read from `organizer-state.json` so evidence never leads the disk. */
  snapshot(): OrganizerState { return this.readState() }
  /** One pass: replay pending work first and return, otherwise select and persist one batch of new source events. */
  private async run(reason: OrganizerReason, signal: AbortSignal | undefined,
    runId: string | undefined): Promise<OrganizeResult> {
    const persisted = this.readState()
    this.state = persisted
    if (persisted.pending !== undefined) return this.recover(persisted.pending)
    const eligible = this.eligible(persisted.cursor)
    if (eligible.length === 0) return { status: 'idle', cursor: persisted.cursor, itemIds: [], changeIds: [] }
    // The threshold protects ordinary turns only; a compaction or idle pass with any eligible fact is worth one batch.
    if (reason === 'turn' && eligible.length < this.limits.threshold)
      return { status: 'skipped', cursor: persisted.cursor, itemIds: [], changeIds: [] }
    const batch = eligible.slice(0, this.limits.batchSize)
    const last = batch[batch.length - 1]!
    const events = batch.map(event => this.deps.events.get(event.id))
    const existing = this.deps.shortTerm.list()
    const people = this.deps.people.list()
    const tasks = this.deps.tasks.list()
    // Freeze the evidence before awaiting the model: exactly the versions and target entries the selector now sees.
    const observations = this.observationsOf(events, people, tasks)
    const input = this.inputOf(events, existing, people, tasks)
    const selection = await this.deps.select(input, signal,
      { reason, ...(runId === undefined ? {} : { runId }) })
    // The method version is fixed by the selection entry before the model call; a selector that names none is builtin.
    const methodVersion = selection.methodVersion ?? BUILTIN_METHOD_VERSION
    const pending: OrganizerPending = { throughSeq: last.seq, methodVersion,
      ...(selection.dropped && { dropped: selection.dropped }),
      operations: this.operationsOf(selection, batch, observations, methodVersion) }
    // The batch is durable before its first operation, so a crash can replay these exact IDs, inputs and evidence.
    this.publish({ cursor: persisted.cursor, pending })
    const pass = this.execute(pending, methodVersion)
    this.publish({ cursor: pending.throughSeq })
    return this.result('organized', pending, pass, methodVersion)
  }
  /** Replays one durable batch with its stored evidence; only a complete apply-or-durable-defer publishes the cursor. */
  private recover(pending: OrganizerPending): OrganizeResult {
    // A legacy pending file without a version was selected under the builtin method; never use the current active one.
    const methodVersion = pending.methodVersion ?? BUILTIN_METHOD_VERSION
    const pass = this.execute(pending, methodVersion)
    this.publish({ cursor: pending.throughSeq })
    return this.result('recovered', pending, pass, methodVersion)
  }
  /** Eligible source facts after `cursor`, by sequence: web-message user/jarvis and worker-report worker only. */
  private eligible(cursor: number): EligibleEvent[] {
    const found = new Map<string, EligibleEvent>()
    for (const sourceKind of ['web-message', 'worker-report'] as const) {
      for (const item of this.deps.events.index.queryEvents({ afterSeq: cursor, sourceKind })) {
        const event = item.event
        if (event === undefined) continue
        const wanted = sourceKind === 'web-message'
          ? event.kind === 'user' || event.kind === 'jarvis'
          : event.kind === 'worker'
        if (wanted) found.set(item.id, { id: item.id, seq: event.seq })
      }
    }
    return [...found.values()].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id))
  }
  /** The frozen selector input: the batch bodies, current short-term entries, task identities and person requirements. */
  private inputOf(events: MemoryEvent[], existing: ShortTermView[], people: PersonRead[],
    tasks: TaskRead[]): EventMemoryInput {
    return {
      events: events.map(selectedEvent),
      existing: existing.map(view => ({
        id: view.id, kind: view.kind, text: view.text,
        ...(view.taskId === undefined ? {} : { taskId: view.taskId }),
        ...(view.recipient === undefined ? {} : { recipient: view.recipient }),
        sources: view.sources.map(source => ({ kind: source.kind, id: source.id })),
      })),
      tasks: tasks.map(read => ({ id: read.task.id, title: read.task.title })),
      people: people.map(card => ({ id: card.id, name: card.name,
        requirements: card.requirements.map(requirement => ({ id: requirement.id, text: requirement.text,
          eventIds: [...requirement.eventIds] })) })),
    }
  }
  /** Snapshot every event version and candidate target entry before the selector runs, so a late edit stays visible. */
  private observationsOf(events: MemoryEvent[], people: PersonRead[], tasks: TaskRead[]): OrganizerObservations {
    return {
      events: new Map(events.map(event => [event.id, { version: event.version,
        selectionVersion: sha256(JSON.stringify(selectedEvent(event))) }] as const)),
      people: new Map(people.map(card => [card.id, new Map(card.requirements.map(requirement =>
        [requirement.id, personRequirementEntry(requirement)] as const))])),
      tasks: new Map(tasks.map(read => [read.task.id, new Map(read.task.notes.map(note =>
        [note.id, taskNoteEntry(note)] as const))])),
    }
  }
  /** Give every selected item and change a stable operation ID, derived from the batch IDs, kind and ordinal. */
  private operationsOf(selection: OrganizerSelection, batch: EligibleEvent[],
    observations: OrganizerObservations, methodVersion: string): OrganizerOperation[] {
    const batchIds = batch.map(event => event.id)
    const operations: OrganizerOperation[] = []
    let ordinal = 0
    for (const item of selection.items) {
      const id = this.operationId(batchIds, 'remember', ordinal++)
      operations.push({ id, type: 'remember', input: { kind: item.kind, text: item.text,
        ...(item.taskId === undefined ? {} : { taskId: item.taskId }),
        // A tentative experience keeps the method version fixed for this batch; other kinds have no such field.
        ...(item.kind === 'experience' ? { methodVersion } : {}),
        sources: item.eventIds.map(eventId => ({ kind: 'event', id: eventId })) },
        observed: { sources: this.observedSources(item.eventIds, observations), target: null } })
    }
    for (const change of selection.changes) {
      const id = this.operationId(batchIds, 'change', ordinal++)
      operations.push({ id, type: 'change', input: { kind: change.kind, scope: change.scope,
        personId: change.personId, property: change.property, text: change.text,
        evidenceEventIds: [...change.evidenceEventIds], effectiveAt: change.effectiveAt, reason: change.reason,
        ...(change.taskId === undefined ? {} : { taskId: change.taskId }) },
        observed: { sources: this.observedSources(change.evidenceEventIds, observations),
          target: this.observedTarget(change, observations) } })
    }
    return operations
  }
  /** The captured version of every event one operation cites; a cited event outside the batch is a selection failure. */
  private observedSources(eventIds: readonly string[], observations: OrganizerObservations): OrganizerObservedSource[] {
    return eventIds.map(id => {
      const observed = observations.events.get(id)
      if (observed === undefined) throw new Error(`Selected event ${id} is not part of this batch`)
      return { kind: 'event', id, ...observed }
    })
  }
  /** The target entry the selector saw for one change; a missing target is null, never a later read. */
  private observedTarget(change: EventMemorySelection['changes'][number],
    observations: OrganizerObservations): ChangeEntry | null {
    if (change.scope === 'ongoing') return observations.people.get(change.personId)?.get(change.property) ?? null
    const taskId = change.taskId
    if (taskId === undefined) return null
    return observations.tasks.get(taskId)?.get(managedEntryId(change.personId, change.property)) ?? null
  }
  /** The deterministic operation ID: a hash of the batch event IDs, the operation type and its ordinal. */
  private operationId(batchIds: string[], type: OrganizerOperation['type'], ordinal: number): string {
    return 'organizer-' + sha256(JSON.stringify([batchIds, type, ordinal]))
  }
  /** Apply or durable-defer every operation of one pending batch; a stale operation is never written. */
  private execute(pending: OrganizerPending, methodVersion: string): ApplyPass {
    const pass: ApplyPass = { itemIds: [], changeIds: [], deferredIds: [], reviewIds: [],
      owned: new Map() }
    for (const operation of pending.operations) {
      if (operation.type === 'remember') this.executeRemember(operation, pass, methodVersion)
      else this.executeChange(operation, pass)
    }
    return pass
  }
  /** Apply one remember, unless its stable ID exists, its task was archived or its cited evidence changed. */
  private executeRemember(operation: RememberOperation, pass: ApplyPass, methodVersion: string): void {
    // A stable ID that already exists is this operation's earlier write: keep its current value, never overwrite it.
    const existing = this.deps.shortTerm.list().find(view => view.id === operation.id)
    if (existing !== undefined) { pass.itemIds.push(existing.id); return }
    const observed = operation.observed
    if ((operation.input.taskId !== undefined && this.deps.tasks.isArchived(operation.input.taskId))
      || observed === undefined || this.sourcesChanged(observed.sources)) {
      this.defer({ operationId: operation.id, target: this.rememberTarget(operation),
        sourceIds: this.sourceIds(operation), observedSources: observed?.sources ?? [],
        reason: 'redo', mode: 'reselect' }, pass)
      return
    }
    // A legacy pending operation has no version on its own input: it was selected under this batch's fixed version.
    const input = operation.input.kind === 'experience' && operation.input.methodVersion === undefined
      ? { ...operation.input, methodVersion }
      : operation.input
    pass.itemIds.push(this.deps.shortTerm.remember(input, operation.id).id)
  }
  /** Apply one change only when its target and evidence still match the frozen snapshot. */
  private executeChange(operation: ChangeOperation, pass: ApplyPass): void {
    const journal = this.journalOf(operation.id)
    if (journal !== undefined) {
      const application = journal.application
      if (application !== undefined && application.status === 'pending') {
        const expected = application.expected
        if (expected !== null) {
          this.finishPendingChange(operation, application.before, expected, pass)
          return
        }
      }
      // An applied journal, a missing application or an expected null has no current-value write left.
      this.complete(operation, pass)
      return
    }
    this.firstChange(operation, pass)
  }
  /** Continue a journal that may still be waiting to write its expected value after an interruption. */
  private finishPendingChange(operation: ChangeOperation, before: ChangeEntry | null, expected: ChangeEntry,
    pass: ApplyPass): void {
    const current = this.currentTarget(operation.input)
    if (!current.ok) { this.deferChange(operation, pass); return }
    // The batch's own write already landed, even if a crash left the journal pending.
    if (sameChangeEntry(current.entry, expected)) { this.complete(operation, pass); return }
    // A later hand edit (or another value) already won: the existing replay keeps it and only closes the journal.
    if (!sameChangeEntry(current.entry, before)) { this.complete(operation, pass); return }
    // The journal is truly waiting to write. A legacy pending operation has no evidence to verify.
    const observed = operation.observed
    if (observed === undefined) { this.deferChange(operation, pass); return }
    if (!sameChangeEntry(current.entry, observed.target) && !this.isOwned(pass, operation.input, current.entry)) {
      this.deferChange(operation, pass)
      return
    }
    if (this.sourcesChanged(observed.sources)) { this.deferChange(operation, pass); return }
    this.complete(operation, pass)
  }
  /** The first application of a change: its target must still be the snapshot value and its evidence unchanged. */
  private firstChange(operation: ChangeOperation, pass: ApplyPass): void {
    const observed = operation.observed
    if (observed === undefined) { this.deferChange(operation, pass); return }
    const current = this.currentTarget(operation.input)
    if (!current.ok) { this.deferChange(operation, pass); return }
    if (!sameChangeEntry(current.entry, observed.target) && !this.isOwned(pass, operation.input, current.entry)) {
      this.deferChange(operation, pass)
      return
    }
    if (this.sourcesChanged(observed.sources)) { this.deferChange(operation, pass); return }
    this.complete(operation, pass)
  }
  /** Apply one change through its idempotent store path, then record only the value actually present in the target. */
  private complete(operation: ChangeOperation, pass: ApplyPass): void {
    const result = this.deps.changes.apply({ ...operation.input, operationId: operation.id },
      { people: this.deps.people, tasks: this.deps.tasks })
    // The selector contract only names task/ongoing scopes, so an unclear answer is a failure, never a silent success.
    if (result.status !== 'recorded') throw new Error(`Memory change ${operation.id} needs clarification: ${result.question}`)
    pass.changeIds.push(result.record.id)
    const expected = result.record.application?.expected
    // Merely marking a journal applied must not turn an unwritten expected value into this batch's own value.
    if (expected !== undefined && expected !== null && sameChangeEntry(result.target.entry, expected))
      this.own(pass, operation.input, expected)
  }
  /** Remember one expected entry as a value this durable batch actually wrote to its target. */
  private own(pass: ApplyPass, input: ChangeInput, expected: ChangeEntry): void {
    const key = targetKeyOf(input)
    const entries = pass.owned.get(key)
    if (entries === undefined) pass.owned.set(key, [expected])
    else if (!entries.some(entry => sameChangeEntry(entry, expected))) entries.push(expected)
  }
  /** Whether one target entry equals a value this same durable batch already wrote there. */
  private isOwned(pass: ApplyPass, input: ChangeInput, entry: ChangeEntry | null): boolean {
    return (pass.owned.get(targetKeyOf(input)) ?? []).some(expected => sameChangeEntry(entry, expected))
  }
  /** The target entry the authoritative card or task list holds now; an unreadable or removed target is external change. */
  private currentTarget(input: ChangeInput): { ok: true; entry: ChangeEntry | null } | { ok: false } {
    // An archived task still reads from its bundle, but only an explicit project restore may make it writable again.
    if (input.scope === 'task' && input.taskId !== undefined && this.deps.tasks.isArchived(input.taskId)) return { ok: false }
    try {
      return { ok: true, entry: this.deps.changes.target(input,
        { people: this.deps.people, tasks: this.deps.tasks }).entry }
    } catch {
      return { ok: false }
    }
  }
  /** Compare the persisted selector input; a card's metadata relink never makes an external content edit acceptable. */
  private sourcesChanged(sources: readonly OrganizerObservedSource[]): boolean {
    return sources.some(source => {
      try {
        const event = this.deps.events.get(source.id)
        return event.version !== source.version
          && (source.selectionVersion === undefined || sha256(JSON.stringify(selectedEvent(event))) !== source.selectionVersion)
      } catch { return true }
    })
  }
  /** The change record one operation already wrote, or undefined when its journal does not exist yet. */
  private journalOf(operationId: string): MemoryChange | undefined {
    try { return this.deps.changes.get(changeIdOf(operationId)) }
    catch (error) { if (isMissing(error)) return undefined; throw error }
  }
  /** Defer one change with the concrete target the redo would address. */
  private deferChange(operation: ChangeOperation, pass: ApplyPass): void {
    this.defer({ operationId: operation.id, target: this.targetOf(operation.input),
      sourceIds: this.sourceIds(operation), observedSources: operation.observed?.sources ?? [],
      reason: 'redo', mode: 'target' }, pass)
  }
  /** Hand one stale operation to the controller's synchronous durable queue; a missing callback fails closed. */
  private defer(deferred: OrganizerDeferred, pass: ApplyPass): void {
    const defer = this.deps.defer
    if (defer === undefined)
      throw new Error(`Memory organizer operation ${deferred.operationId} is stale and needs review, but no defer callback is configured`)
    const reviewId = defer(deferred)
    pass.deferredIds.push(deferred.operationId)
    if (typeof reviewId === 'string' && reviewId.length > 0) pass.reviewIds.push(reviewId)
  }
  /** The deferred reference of one change: the person requirement or the task's managed note. */
  private targetOf(input: ChangeInput): MemoryReference {
    if (input.scope === 'ongoing') return { kind: 'person', id: input.personId, part: input.property }
    if (input.scope === 'task' && input.taskId !== undefined)
      return { kind: 'task', id: input.taskId, part: 'notes', taskId: input.taskId }
    throw new Error(`A change ${input.personId}/${input.property} has no target scope to defer against`)
  }
  /** The deferred reference of one remember: its task, or the first source event for an independent item. */
  private rememberTarget(operation: RememberOperation): MemoryReference {
    const taskId = operation.input.taskId
    if (taskId !== undefined) return { kind: 'task', id: taskId,
      part: operation.input.kind === 'todo' ? 'todos' : 'notes', taskId }
    const anchor = operation.input.sources[0]?.id
    if (anchor === undefined) throw new Error(`Remember ${operation.id} has no source event to anchor its target`)
    return { kind: 'event', id: anchor }
  }
  /** Every event ID one operation actually cites, in order and once each. */
  private sourceIds(operation: OrganizerOperation): string[] {
    const ids = operation.type === 'remember'
      ? operation.input.sources.map(source => source.id)
      : operation.input.evidenceEventIds
    return [...new Set(ids)]
  }
  /** One pass result; the optional review arrays appear only when something was deferred, so older shapes stay exact. */
  private result(status: 'organized' | 'recovered', pending: OrganizerPending, pass: ApplyPass,
    methodVersion: string): OrganizeResult {
    return { status, cursor: pending.throughSeq, throughSeq: pending.throughSeq, methodVersion,
      itemIds: pass.itemIds, changeIds: pass.changeIds,
      ...(pending.dropped && { dropped: pending.dropped }),
      ...(pass.deferredIds.length === 0 ? {} : { deferredIds: pass.deferredIds }),
      ...(pass.reviewIds.length === 0 ? {} : { reviewIds: pass.reviewIds }) }
  }
  /** Publish one complete state file first, then remember it in memory, so the snapshot never leads the disk. */
  private publish(state: OrganizerState): void {
    publishFile(this.statePath, JSON.stringify(state, null, 2) + '\n')
    this.state = state
  }
  /** The authoritative state file, or cursor 0 when the organizer has not written one yet. */
  private readState(): OrganizerState {
    if (!existsSync(this.statePath)) return { cursor: 0 }
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as OrganizerState
    return parsed.pending === undefined ? { cursor: parsed.cursor } : { cursor: parsed.cursor, pending: parsed.pending }
  }
}
