/** Replay one frozen selection input under two fixed memory methods and keep every outcome as a comparison record. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { EventMemoryInput, EventMemorySelection } from './compaction-selection.ts'
import { publishFile } from './files.ts'
import type { MemoryMethod, MemoryMethods } from './methods.ts'

/** One case kind: an ordinary probe, or a known failure worth pinning as a counterexample. */
export type MethodReplayCaseKind = 'typical' | 'counterexample'
/** One replay case: the exact selector input captured once, never refreshed from the live libraries on a later read. */
export interface MethodReplayCase {
  id: string
  title: string
  kind: MethodReplayCaseKind
  createdAt: string
  /** The source event IDs the caller captured this case from. */
  eventIds: string[]
  /** The frozen four-group input: events, existing entries, tasks and people exactly as the selector saw them. */
  input: EventMemoryInput
}
/** The case one `createCase` call captures: identity, title, kind and the source events to freeze. */
export interface MethodReplayCaseInput {
  id: string
  title: string
  eventIds: string[]
  kind: MethodReplayCaseKind
}
/** One fixed method of a comparison: its version and the hash of the exact instructions the selector receives. */
export interface MethodReplayMethodRef { version: string; instructionsHash: string }
/**
 * One comparison side as it actually settled: the selection it returned, the error it threw, or `not-run` because
 * the earlier side failed first and this method never saw a prompt.
 */
export type MethodReplaySide =
  | { status: 'completed'; methodVersion: string; output: EventMemorySelection; citedEventIds: string[] }
  | { status: 'failed'; error: string }
  | { status: 'not-run' }
/** What the candidate added or removed relative to the baseline, keyed by normalized content. */
export interface MethodReplayDiff {
  addedItems: EventMemorySelection['items']
  removedItems: EventMemorySelection['items']
  addedChanges: EventMemorySelection['changes']
  removedChanges: EventMemorySelection['changes']
}
/** Whether a comparison is still running or how it settled; the `running` record is the pre-model evidence. */
export type MethodReplayComparisonStatus = 'running' | 'completed' | 'failed'
/** One persisted comparison: frozen input, both fixed methods, both actual outcomes, their diff and all event sources. */
export interface MethodReplayComparison {
  id: string
  status: MethodReplayComparisonStatus
  caseId: string
  caseTitle: string
  caseKind: MethodReplayCaseKind
  /** The caller's own run, when it named one; the selector itself is attributed `replay-<id>`. */
  requestedRunId?: string
  createdAt: string
  finishedAt?: string
  /** The exact input both sides receive; written before the first model call. */
  input: EventMemoryInput
  /** Every event ID of that input, sorted once so a repeated write compares exactly. */
  eventIds: string[]
  baseline: MethodReplayMethodRef
  candidate: MethodReplayMethodRef
  baselineResult?: MethodReplaySide
  candidateResult?: MethodReplaySide
  diff?: MethodReplayDiff
  error?: string
}
/** The one selection contract a replay hands down: its fixed method, replay reason, derived run ID and caller signal. */
export interface MethodReplaySelectOptions {
  methodVersion: string
  reason: 'replay'
  runId: string
  signal?: AbortSignal
}
/**
 * The services a replay needs: the immutable method library, one capture of the live libraries, and the one shared
 * selection entry. There is deliberately no writer, organizer or event-capture dependency.
 */
export interface MethodReplayDeps {
  methods: Pick<MemoryMethods, 'get' | 'active'>
  capture(eventIds: string[]): EventMemoryInput
  select(input: EventMemoryInput, options: MethodReplaySelectOptions): Promise<EventMemorySelection & { methodVersion: string }>
}
/** One run request: the case, the fixed baseline and candidate, and optional caller attribution or cancellation. */
export interface MethodReplayRunInput {
  caseId: string
  /** An explicit method version, or omitted to pin the method active when the run starts. */
  baselineVersion?: string
  candidateVersion: string
  runId?: string
  signal?: AbortSignal
}

type SelectedItem = EventMemorySelection['items'][number]
type SelectedChange = EventMemorySelection['changes'][number]

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** A plain JSON copy: a selector call must never share the input of the other call or the saved case. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
/** Freeze one read case or comparison so a caller cannot edit the evidence it was handed. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}
/** The IDs of one evidence array, sorted so two selections with the same content serialize equally. */
const sortedIds = (ids: readonly string[]): string[] => [...ids].sort()
/** The stable content key of one selected item: kind, text, task target and every cited event, order-insensitive. */
const itemKey = (item: SelectedItem): string =>
  JSON.stringify([item.kind, item.text, item.taskId ?? null, sortedIds(item.eventIds)])
/** The stable content key of one selected change: every stored field, with its evidence IDs order-insensitive. */
const changeKey = (change: SelectedChange): string =>
  JSON.stringify([change.kind, change.scope, change.personId, change.property, change.text,
    change.taskId ?? null, change.effectiveAt, change.reason, sortedIds(change.evidenceEventIds)])
/** One method as a comparison pins it: version and the hash of the instructions its prompt actually carries. */
const methodRef = (method: MemoryMethod): MethodReplayMethodRef =>
  ({ version: method.version, instructionsHash: sha256(method.instructions) })
/**
 * Normalize one selection for storage: cited IDs sorted and records ordered by their stable content key, so two
 * selections whose content is equal serialize to exactly the same JSON.
 */
function normalizeSelection(selection: EventMemorySelection): EventMemorySelection {
  return {
    items: selection.items.map(item => ({ ...item, eventIds: sortedIds(item.eventIds) }))
      .sort((left, right) => itemKey(left).localeCompare(itemKey(right))),
    changes: selection.changes.map(change => ({ ...change, evidenceEventIds: sortedIds(change.evidenceEventIds) }))
      .sort((left, right) => changeKey(left).localeCompare(changeKey(right))),
  }
}
/** Every event ID one selection cites, sorted and once each. */
const citedEventIdsOf = (selection: EventMemorySelection): string[] =>
  [...new Set([...selection.items.flatMap(item => item.eventIds),
    ...selection.changes.flatMap(change => change.evidenceEventIds)])].sort()
/** What the candidate added or removed relative to the baseline; equal content in another order is no difference. */
function diffOf(baseline: EventMemorySelection, candidate: EventMemorySelection): MethodReplayDiff {
  const baselineItems = new Set(baseline.items.map(itemKey))
  const candidateItems = new Set(candidate.items.map(itemKey))
  const baselineChanges = new Set(baseline.changes.map(changeKey))
  const candidateChanges = new Set(candidate.changes.map(changeKey))
  return {
    addedItems: candidate.items.filter(item => !baselineItems.has(itemKey(item))),
    removedItems: baseline.items.filter(item => !candidateItems.has(itemKey(item))),
    addedChanges: candidate.changes.filter(change => !baselineChanges.has(changeKey(change))),
    removedChanges: baseline.changes.filter(change => !candidateChanges.has(changeKey(change))),
  }
}
/** The one concrete failure a failed comparison names, keeping the completed side untouched. */
function failureOf(baseline: MethodReplaySide, candidate: MethodReplaySide): string {
  if (baseline.status === 'failed') return `baseline selection failed: ${baseline.error}`
  if (candidate.status === 'failed') return `candidate selection failed: ${candidate.error}`
  return 'replay selection did not complete'
}
/** Whether a parsed value has the four selector input groups a stored case or comparison needs. */
const isEventInput = (value: unknown): value is EventMemoryInput => isRecord(value)
  && Array.isArray(value.events) && Array.isArray(value.existing)
  && Array.isArray(value.tasks) && Array.isArray(value.people)
/** One saved case file, checked so a broken file fails with its own path instead of becoming a silent default. */
const isCase = (value: unknown): value is MethodReplayCase => isRecord(value)
  && typeof value.id === 'string' && typeof value.title === 'string'
  && (value.kind === 'typical' || value.kind === 'counterexample')
  && typeof value.createdAt === 'string'
  && Array.isArray(value.eventIds) && value.eventIds.every(id => typeof id === 'string')
  && isEventInput(value.input)
/** One saved comparison file, checked only for the identity and outcome fields a reader needs. */
const isComparison = (value: unknown): value is MethodReplayComparison => isRecord(value)
  && typeof value.id === 'string'
  && (value.status === 'running' || value.status === 'completed' || value.status === 'failed')
  && typeof value.caseId === 'string' && typeof value.caseTitle === 'string'
  && (value.caseKind === 'typical' || value.caseKind === 'counterexample')
  && typeof value.createdAt === 'string'
  && Array.isArray(value.eventIds)
  && isRecord(value.baseline) && typeof value.baseline.version === 'string'
  && typeof value.baseline.instructionsHash === 'string'
  && isRecord(value.candidate) && typeof value.candidate.version === 'string'
  && typeof value.candidate.instructionsHash === 'string'
  && isEventInput(value.input)

/**
 * One replay workspace under `<memoryRoot>/methods`: immutable cases under `cases/` and one persistent comparison
 * under `comparisons/` per run. A replay reads the method library and the one shared selection entry only; it never
 * activates a method, moves the organizer cursor, or writes short-term, experience, task or person memory.
 */
export class MethodReplay {
  readonly root: string
  private readonly cases: string
  private readonly comparisons: string
  /** Opens the workspace under `memoryRoot`, creating both evidence directories so the first write needs no setup. */
  constructor(memoryRoot: string, private readonly deps: MethodReplayDeps) {
    this.root = join(memoryRoot, 'methods')
    this.cases = join(this.root, 'cases')
    this.comparisons = join(this.root, 'comparisons')
    mkdirSync(this.cases, { recursive: true })
    mkdirSync(this.comparisons, { recursive: true })
  }
  /**
   * Capture one case exactly once: the live libraries are read through `deps.capture`, the four input groups are
   * frozen into `methods/cases/<id>.json`, and no later read or run ever asks the live libraries again.
   */
  createCase(input: MethodReplayCaseInput): MethodReplayCase {
    if (input.id.length === 0) throw new Error('A replay case needs an ID')
    const path = this.casePath(input.id)
    if (existsSync(path)) throw new Error(`Replay case ${input.id} already exists and cannot be changed`)
    const frozen: MethodReplayCase = {
      id: input.id,
      title: input.title,
      kind: input.kind,
      createdAt: new Date().toISOString(),
      eventIds: [...input.eventIds],
      input: clone(this.deps.capture([...input.eventIds])),
    }
    publishFile(path, JSON.stringify(frozen, null, 2) + '\n')
    return deepFreeze(frozen)
  }
  /** One stored case by ID, read from its file and frozen; a later change in the live libraries never reaches it. */
  readCase(id: string): MethodReplayCase {
    const path = this.casePath(id)
    if (!existsSync(path)) throw new Error(`Replay case ${id} does not exist`)
    return deepFreeze(this.parseCase(path))
  }
  /** Every stored case, ordered by creation time and ID so a repeated listing is deterministic. */
  listCases(): MethodReplayCase[] {
    return this.filesOf(this.cases).map(path => this.parseCase(path))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
  /**
   * Run one case under a fixed baseline and candidate method. Both versions are resolved before anything is written,
   * the input snapshot, both versions and both instruction hashes are published as a `running` comparison before the
   * first model call, and the two calls run serially on independent clones of that snapshot. A selector failure is
   * captured as a `failed` comparison that keeps whichever side completed; every other failure is thrown.
   */
  async run(input: MethodReplayRunInput): Promise<MethodReplayComparison> {
    const replayCase = this.readCase(input.caseId)
    const baselineMethod = input.baselineVersion === undefined
      ? this.deps.methods.active()
      : this.deps.methods.get(input.baselineVersion)
    if (baselineMethod === undefined) throw new Error(`Memory method ${input.baselineVersion} does not exist`)
    const candidateMethod = this.deps.methods.get(input.candidateVersion)
    if (candidateMethod === undefined) throw new Error(`Memory method ${input.candidateVersion} does not exist`)
    const id = this.newComparisonId()
    const running: MethodReplayComparison = {
      id,
      status: 'running',
      caseId: replayCase.id,
      caseTitle: replayCase.title,
      caseKind: replayCase.kind,
      ...(input.runId === undefined ? {} : { requestedRunId: input.runId }),
      createdAt: new Date().toISOString(),
      input: clone(replayCase.input),
      eventIds: [...new Set([...replayCase.eventIds,
        ...replayCase.input.events.map(event => event.id)])].sort(),
      baseline: methodRef(baselineMethod),
      candidate: methodRef(candidateMethod),
    }
    this.publishComparison(running)
    const baselineResult = await this.attempt(baselineMethod.version, replayCase.input, id, input.signal)
    let candidateResult: MethodReplaySide = { status: 'not-run' }
    if (baselineResult.status === 'completed')
      candidateResult = await this.attempt(candidateMethod.version, replayCase.input, id, input.signal)
    const finishedAt = new Date().toISOString()
    if (baselineResult.status === 'completed' && candidateResult.status === 'completed') {
      const completed: MethodReplayComparison = { ...running, status: 'completed', finishedAt,
        baselineResult, candidateResult, diff: diffOf(baselineResult.output, candidateResult.output) }
      this.publishComparison(completed)
      return deepFreeze(completed)
    }
    const failed: MethodReplayComparison = { ...running, status: 'failed', finishedAt,
      baselineResult, candidateResult, error: failureOf(baselineResult, candidateResult) }
    this.publishComparison(failed)
    return deepFreeze(failed)
  }
  /** One persisted comparison by ID, read from its file and frozen for the later confirmation. */
  readComparison(id: string): MethodReplayComparison {
    const path = this.comparisonPath(id)
    if (!existsSync(path)) throw new Error(`Replay comparison ${id} does not exist`)
    return deepFreeze(this.parseComparison(path))
  }
  /** Every stored comparison, ordered by creation time and ID so a repeated listing is deterministic. */
  listComparisons(): MethodReplayComparison[] {
    return this.filesOf(this.comparisons).map(path => this.parseComparison(path))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
  /** One serialized selection: a fresh input clone, the fixed method, replay attribution and the caller signal. */
  private async attempt(version: string, input: EventMemoryInput, comparisonId: string,
    signal: AbortSignal | undefined): Promise<MethodReplaySide> {
    try {
      const selection = await this.deps.select(clone(input), {
        methodVersion: version,
        reason: 'replay',
        runId: 'replay-' + comparisonId,
        ...(signal === undefined ? {} : { signal }),
      })
      const output = normalizeSelection(selection)
      return { status: 'completed', methodVersion: selection.methodVersion, output,
        citedEventIds: citedEventIdsOf(output) }
    } catch (error) {
      return { status: 'failed', error: reasonOf(error) }
    }
  }
  /** A fresh comparison ID: the millisecond stamp, then a random suffix that makes concurrent runs distinct. */
  private newComparisonId(): string {
    return `comparison-${new Date().toISOString().replace(/\D/g, '')}-${randomUUID().slice(0, 8)}`
  }
  /** Publish one complete comparison file; the `running` record is replaced by the settled one at the same path. */
  private publishComparison(comparison: MethodReplayComparison): void {
    publishFile(this.comparisonPath(comparison.id), JSON.stringify(comparison, null, 2) + '\n')
  }
  /** One stored comparison file, checked so a broken file fails with its own path. */
  private parseComparison(path: string): MethodReplayComparison {
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`Invalid replay comparison ${path}: ${reasonOf(error)}`)
    }
    if (!isComparison(parsed)) throw new Error(`Invalid replay comparison ${path}`)
    return parsed
  }
  /** One stored case file, checked so a broken file fails with its own path. */
  private parseCase(path: string): MethodReplayCase {
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`Invalid replay case ${path}: ${reasonOf(error)}`)
    }
    if (!isCase(parsed)) throw new Error(`Invalid replay case ${path}`)
    return parsed
  }
  /** Every `.json` evidence file in one directory, in stable name order. */
  private filesOf(directory: string): string[] {
    return readdirSync(directory)
      .filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .sort()
      .map(name => join(directory, name))
  }
  /** The file of one case: the ID is percent-encoded so one case is always one portable filename. */
  private casePath(id: string): string { return join(this.cases, encodeURIComponent(id) + '.json') }
  /** The file of one comparison: generated IDs are filesystem-safe, and encoding keeps manual lookups portable. */
  private comparisonPath(id: string): string { return join(this.comparisons, encodeURIComponent(id) + '.json') }
}
