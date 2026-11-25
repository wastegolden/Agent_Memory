/** The S3-2 organizer: one persisted cursor/pending state, stable operation IDs and one in-flight pass over source events. */
import type { MemoryModelContext as Context } from '../../src/core/ports/model.ts'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryChanges, changeIdOf, managedEntryId } from '../../src/core/changes.ts'
import { selectEventMemory } from '../../src/core/compaction-selection.ts'
import { MemoryEvents } from '../../src/core/events.ts'
import { MemoryOrganizer, type OrganizerDeferred, type OrganizerState } from '../../src/core/organizer.ts'
import { PersonCards } from '../../src/core/people.ts'
import { MemoryReviews } from '../../src/core/reviews.ts'
import { ShortTerm, type ShortTermInput } from '../../src/core/short-term.ts'
import { TaskLists } from '../../src/core/task-lists.ts'

// Organizer state writes go through the same publishFile as every store. This wrapper fails exactly one organizer-state
// publication while every other file write stays real, so the failure paths are exercised without a production hook.
const stateFaults = vi.hoisted(() => ({ active: null as null | 'pending' | 'cursor', path: '' }))
vi.mock('../../src/core/files.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/core/files.ts')>()
  return {
    ...actual,
    publishFile: (path: string, content: string): void => {
      if (path === stateFaults.path) {
        const state = JSON.parse(content) as OrganizerState
        if (stateFaults.active === 'pending' && state.pending !== undefined)
          throw new Error('simulated state pending publish failure')
        if (stateFaults.active === 'cursor' && state.pending === undefined)
          throw new Error('simulated state cursor publish failure')
      }
      actual.publishFile(path, content)
    },
  }
})

type Deps = ConstructorParameters<typeof MemoryOrganizer>[1]
type Selector = Deps['select']
type Selection = Awaited<ReturnType<Selector>>
type OrganizerInput = Parameters<Selector>[0]

interface Memory {
  root: string
  events: MemoryEvents
  tasks: TaskLists
  shortTerm: ShortTerm
  people: PersonCards
  changes: MemoryChanges
}

const createMemory = (root: string): Memory => {
  const events = new MemoryEvents(root)
  const tasks = new TaskLists(root, () => undefined)
  const shortTerm = new ShortTerm(root, tasks)
  const people = new PersonCards(root, events)
  const changes = new MemoryChanges(root, events)
  return { root, events, tasks, shortTerm, people, changes }
}

const statePath = (root: string): string => join(root, 'organizer-state.json')
const readStateFile = (root: string): OrganizerState =>
  JSON.parse(readFileSync(statePath(root), 'utf8')) as OrganizerState
const emptySelection = (): Selection => ({ items: [], changes: [] })

const recordEvent = (memory: Memory, kind: 'user' | 'jarvis' | 'worker', sourceKind: string, sourceId: string,
  at: string, text: string, taskId?: string) => memory.events.record({ kind, at, text,
  source: { kind: sourceKind, id: sourceId }, ...(taskId === undefined ? {} : { taskId }) })
const webEvent = (memory: Memory, kind: 'user' | 'jarvis', sourceId: string, at: string, text: string) =>
  recordEvent(memory, kind, 'web-message', sourceId, at, text)

const organizerFor = (root: string, memory: Memory, select: Selector,
  limits: { threshold: number; batchSize: number } = { threshold: 1, batchSize: 10 },
  overrides: Partial<Deps> = {}): MemoryOrganizer =>
  new MemoryOrganizer(root, { events: memory.events, shortTerm: memory.shortTerm, changes: memory.changes,
    people: memory.people, tasks: memory.tasks, select, ...overrides }, limits)

/** Collect every defer handoff; each successful handoff returns a deterministic review id. */
const deferCalls = (): { calls: OrganizerDeferred[]; defer: NonNullable<Deps['defer']> } => {
  const calls: OrganizerDeferred[] = []
  return { calls, defer: (deferred: OrganizerDeferred): string => {
    calls.push(deferred)
    return `review-${calls.length}`
  } }
}
/** Use the same task archive record and location index that project archival publishes; keep both files for comparison. */
function archiveTask(taskId: string) {
  const current = memory.tasks.read(taskId)
  const archiveId = `archive-${taskId}`
  memory.events.store.put('tasks', { id: archiveId, source: { kind: 'project', id: taskId },
    content: JSON.stringify({ tasks: [{ ...current.task, taskId }] }) })
  memory.tasks.markArchived(taskId, archiveId)
  const archivePath = join(root, 'tasks', archiveId + '.json')
  return { taskPath: current.path, taskBytes: readFileSync(current.path, 'utf8'),
    archivePath, archiveBytes: readFileSync(archivePath, 'utf8') }
}
/** Save one task's notes exactly, keeping its editable title, plan, sources and todos. */
const saveNotes = (taskId: string, notes: Parameters<TaskLists['save']>[0]['notes']): void => {
  const task = memory.tasks.read(taskId).task
  memory.tasks.save({ id: task.id, title: task.title, plan: task.plan, sources: task.sources,
    todos: task.todos, notes })
}
/** One managed task note as a hand edit writes it. */
const editedNote = (personId: string, property: string, text: string) => ({
  id: managedEntryId(personId, property), text, kind: 'agreement' as const, recipient: personId,
  sources: [], createdAt: '2026-11-01T00:00:00.000Z',
})
/** Two changes for the same managed task note, in selection order. */
const sameTargetSelection = (taskId: string, evidenceId: string): Selection => ({ items: [], changes: [
  { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId, text: '第一次',
    evidenceEventIds: [evidenceId], effectiveAt: '2026-11-01T00:00:00.000Z', reason: '第一次要求' },
  { kind: 'change', scope: 'task', personId: 'lin', property: 'language', taskId, text: '第二次',
    evidenceEventIds: [evidenceId], effectiveAt: '2026-11-01T00:00:00.000Z', reason: '第二次要求' },
] })

const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return true
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  }
  return false
}

const CHILD_SCRIPT = fileURLToPath(new URL('./fixtures/memory-organizer-child.mjs', import.meta.url))

const interruptOrganizerChild = async (runRoot: string, mode: 'after-first' | 'after-last'): Promise<void> => {
  const ready = join(runRoot, `child-ready-${mode}`)
  const child = spawn(process.execPath, ['--experimental-transform-types', CHILD_SCRIPT], {
    env: { ...process.env, MEMORY_ORGANIZER_ROOT: runRoot, MEMORY_ORGANIZER_READY: ready, MEMORY_ORGANIZER_MODE: mode },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', code => resolve(code))
  })
  const reached = await waitForFile(ready, 15000)
  if (!reached) {
    child.kill('SIGKILL')
    await exited.catch(() => undefined)
    throw new Error(`organizer child did not reach the ${mode} breakpoint: ${stderr}`)
  }
  child.kill('SIGKILL')
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('organizer child did not exit after SIGKILL')), 10000)
    exited.then(() => { clearTimeout(timer); resolve() },
      (error: unknown) => { clearTimeout(timer); reject(error) })
  })
}

let root: string
let memory: Memory
const roots: string[] = []
const freshRoot = (): string => {
  const path = mkdtempSync(join(tmpdir(), 'jarvis-organizer-'))
  roots.push(path)
  return path
}

beforeEach(() => {
  root = freshRoot()
  memory = createMemory(root)
  stateFaults.active = null
  stateFaults.path = statePath(root)
})
afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

it('selects web-message user/jarvis and worker-report worker facts and ignores internal or engine events', async () => {
  recordEvent(memory, 'jarvis', 'internal', 'internal-1', '2026-11-10T00:00:00.000Z', '内部通知')
  recordEvent(memory, 'jarvis', 'engine-event', 'engine-1', '2026-11-10T00:00:01.000Z', '引擎节点')
  recordEvent(memory, 'worker', 'engine-event', 'engine-2', '2026-11-10T00:00:02.000Z', '引擎汇报')
  const user = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:03.000Z', '用户要求')
  const jarvis = webEvent(memory, 'jarvis', 'm2', '2026-11-10T00:00:04.000Z', 'Jarvis 回复')
  const worker = recordEvent(memory, 'worker', 'worker-report', 'r1', '2026-11-10T00:00:05.000Z', 'Worker 汇报', 't1')
  const inputs: OrganizerInput[] = []
  const select: Selector = async input => { inputs.push(input); return emptySelection() }
  const result = await organizerFor(root, memory, select).organize({ reason: 'idle' })
  expect(result).toEqual({ status: 'organized', cursor: worker.seq, throughSeq: worker.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(inputs).toHaveLength(1)
  const input = inputs[0]!
  expect(input.events.map(event => event.id)).toEqual([user.id, jarvis.id, worker.id])
  expect(input.events.map(event => event.event.kind)).toEqual(['user', 'jarvis', 'worker'])
  expect(input.events.map(event => event.event.source)).toEqual([
    { kind: 'web-message', id: 'm1' },
    { kind: 'web-message', id: 'm2' },
    { kind: 'worker-report', id: 'r1' },
  ])
  expect(input.events.map(event => event.seq)).toEqual([user.seq, jarvis.seq, worker.seq])
  expect(input.events[2]!.event.taskId).toBe('t1')
})

it('saves valid selections and advances past both mixed and fully invalid batches', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '日报用中文，明天给结果')
  const second = webEvent(memory, 'user', 'm2', '2026-11-10T00:00:01.000Z', '第二批')
  const task = memory.tasks.save({ title: '日报', plan: '', sources: [], todos: [], notes: [] })
  // The model cites the first batch both times. Those same citations are foreign to the second batch.
  const stream = vi.fn(async function* () {
    yield { type: 'text-delta', text: JSON.stringify({
      items: [{ kind: 'todo', text: '明天给结果', taskId: task.id, eventIds: [first.id] },
        { kind: 'agreement', text: '无来源', eventIds: ['missing'] }],
      changes: [{ kind: 'fact', scope: 'task', taskId: task.id, personId: 'lin', property: 'language',
        text: '日报用中文', evidenceEventIds: [first.id], effectiveAt: first.event.at, reason: '用户要求' }],
    }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  const organizer = organizerFor(root, memory, input => selectEventMemory(ctx, { provider: 'test', model: 'memory' }, input),
    { threshold: 1, batchSize: 1 })
  const mixed = await organizer.organize({ reason: 'idle' })
  const missing = { list: 'items', index: 1, reasons: [expect.stringContaining('Event missing is not part of this batch')] }
  expect(mixed).toMatchObject({ status: 'organized', cursor: first.seq, dropped: [missing] })
  expect(mixed.itemIds).toHaveLength(1)
  expect(mixed.changeIds).toHaveLength(1)
  const foreign = expect.stringContaining(`Event ${first.id} is not part of this batch`)
  expect(await organizer.organize({ reason: 'idle' })).toMatchObject({
    status: 'organized', cursor: second.seq, itemIds: [], changeIds: [], dropped: [
      { list: 'items', index: 0, reasons: [foreign] }, missing, { list: 'changes', index: 0, reasons: [foreign] },
    ],
  })
  expect(memory.tasks.read(task.id).task).toMatchObject({ todos: [{ text: '明天给结果' }], notes: [{ text: '日报用中文' }] })
  expect(memory.changes.history()).toHaveLength(1)
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
  expect((await organizer.organize({ reason: 'idle' })).status).toBe('idle')
  expect(stream).toHaveBeenCalledTimes(2)
})

it('stays idle on an all-internal turn without writing state and later resumes from the stored cursor', async () => {
  recordEvent(memory, 'jarvis', 'internal', 'internal-1', '2026-11-10T00:00:00.000Z', '内部通知')
  recordEvent(memory, 'jarvis', 'engine-event', 'engine-1', '2026-11-10T00:00:01.000Z', '引擎节点')
  const idleSelect: Selector = async () => { throw new Error('selector must not run for an idle turn') }
  const organizer = organizerFor(root, memory, idleSelect)
  const idle = await organizer.organize({ reason: 'idle' })
  expect(idle).toEqual({ status: 'idle', cursor: 0, itemIds: [], changeIds: [] })
  expect(existsSync(statePath(root))).toBe(false)
  const user = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:02.000Z', '用户要求')
  const calls: OrganizerInput[] = []
  const select: Selector = async input => { calls.push(input); return emptySelection() }
  const organized = await organizerFor(root, memory, select).organize({ reason: 'idle' })
  expect(organized.status).toBe('organized')
  expect(organized.cursor).toBe(user.seq)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.events.map(event => event.id)).toEqual([user.id])
  expect(readStateFile(root)).toEqual({ cursor: user.seq })
})

it('applies the event threshold to turn triggers only', async () => {
  const only = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '一条新事实')
  const calls: OrganizerInput[] = []
  const select: Selector = async input => { calls.push(input); return emptySelection() }
  const organizer = organizerFor(root, memory, select, { threshold: 2, batchSize: 10 })
  const skipped = await organizer.organize({ reason: 'turn' })
  expect(skipped).toEqual({ status: 'skipped', cursor: 0, itemIds: [], changeIds: [] })
  expect(calls).toEqual([])
  expect(existsSync(statePath(root))).toBe(false)
  const compacted = await organizer.organize({ reason: 'compaction' })
  expect(compacted.status).toBe('organized')
  expect(compacted.cursor).toBe(only.seq)
  expect(calls).toHaveLength(1)
  expect(calls[0]!.events.map(event => event.id)).toEqual([only.id])
})

it('caps one model batch at batchSize and continues from throughSeq on the next trigger', async () => {
  const facts = [1, 2, 3, 4, 5].map(index =>
    webEvent(memory, 'user', `m${index}`, `2026-11-10T00:00:0${index}.000Z`, `事实 ${index}`))
  const calls: OrganizerInput[] = []
  const select: Selector = async input => { calls.push(input); return emptySelection() }
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 3 })
  const first = await organizer.organize({ reason: 'turn' })
  expect(first).toEqual({ status: 'organized', cursor: facts[2]!.seq, throughSeq: facts[2]!.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(calls[0]!.events.map(event => event.id)).toEqual(facts.slice(0, 3).map(event => event.id))
  expect(readStateFile(root)).toEqual({ cursor: facts[2]!.seq })
  const second = await organizer.organize({ reason: 'turn' })
  expect(second).toEqual({ status: 'organized', cursor: facts[4]!.seq, throughSeq: facts[4]!.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(calls[1]!.events.map(event => event.id)).toEqual(facts.slice(3).map(event => event.id))
  const third = await organizer.organize({ reason: 'turn' })
  expect(third.status).toBe('idle')
  expect(calls).toHaveLength(2)
})

it('publishes the advanced cursor even when the model selects nothing', async () => {
  const event = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '无需保存')
  const select: Selector = async () => emptySelection()
  const organizer = organizerFor(root, memory, select)
  const result = await organizer.organize({ reason: 'idle' })
  expect(result).toEqual({ status: 'organized', cursor: event.seq, throughSeq: event.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(memory.shortTerm.list()).toEqual([])
  expect(readStateFile(root)).toEqual({ cursor: event.seq })
  expect(organizer.snapshot()).toEqual({ cursor: event.seq })
})

it('attempts a pending state publication even when the model selects nothing', async () => {
  const event = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '无需保存')
  const select: Selector = async () => emptySelection()
  const organizer = organizerFor(root, memory, select)
  stateFaults.active = 'pending'
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('simulated state pending publish failure')
  stateFaults.active = null
  expect(existsSync(statePath(root))).toBe(false)
  const retried = await organizer.organize({ reason: 'idle' })
  expect(retried.status).toBe('organized')
  expect(readStateFile(root)).toEqual({ cursor: event.seq })
})

it('reads eligible facts by sequence even when a later sequence has an older event time', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T10:00:00.000Z', '先入库')
  const late = webEvent(memory, 'user', 'm2', '2026-11-09T10:00:00.000Z', '旧时间晚入库')
  const inputs: OrganizerInput[] = []
  const select: Selector = async input => { inputs.push(input); return emptySelection() }
  const result = await organizerFor(root, memory, select).organize({ reason: 'idle' })
  expect(result.throughSeq).toBe(late.seq)
  expect(inputs[0]!.events.map(event => event.id)).toEqual([first.id, late.id])
  expect(inputs[0]!.events.map(event => event.seq)).toEqual([first.seq, late.seq])
  expect(inputs[0]!.events.map(event => event.event.at)).toEqual([first.event.at, late.event.at])
})

it('gives the selector the current short-term, task and person context', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '以后用中文')
  const existing = memory.shortTerm.remember({ kind: 'agreement', text: '用中文回复',
    sources: [{ kind: 'event', id: evidence.id, path: 'ignored-by-input' }] })
  const task = memory.tasks.save({ title: '整理既有上下文', plan: '', sources: [], todos: [], notes: [] })
  const person = memory.people.save({ name: '小林', description: '', requirements: [
    { id: 'language', text: '中文', eventIds: [evidence.id] }], relations: [] })
  const inputs: OrganizerInput[] = []
  const select: Selector = async input => { inputs.push(input); return emptySelection() }
  await organizerFor(root, memory, select).organize({ reason: 'idle' })
  const input = inputs[0]!
  expect(input.existing).toEqual([{ id: existing.id, kind: 'agreement', text: '用中文回复',
    sources: [{ kind: 'event', id: evidence.id }] }])
  expect(input.tasks).toEqual([{ id: task.id, title: '整理既有上下文' }])
  expect(input.people).toEqual([{ id: person.card.id, name: '小林',
    requirements: [{ id: 'language', text: '中文', eventIds: [evidence.id] }] }])
  expect(input.events.map(event => event.event.source)).toEqual([{ kind: 'web-message', id: 'm1' }])
})

it('shares one in-flight pass between triggers and lets a later trigger take new events', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '第一条事实')
  const inputs: OrganizerInput[] = []
  let release!: (selection: Selection) => void
  const gate = new Promise<Selection>(resolve => { release = resolve })
  const select: Selector = async input => { inputs.push(input); return gate }
  const organizer = organizerFor(root, memory, select)
  const pending = organizer.organize({ reason: 'turn' })
  const repeated = organizer.organize({ reason: 'idle' })
  expect(repeated).toBe(pending)
  let settled = false
  const waiting = organizer.settled().then(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  expect(settled).toBe(false)
  release(emptySelection())
  await pending
  await waiting
  expect(settled).toBe(true)
  expect(inputs).toHaveLength(1)
  expect(first.seq).toBe(1)
  const second = webEvent(memory, 'user', 'm2', '2026-11-10T00:00:01.000Z', '新事实')
  const later = await organizer.organize({ reason: 'turn' })
  expect(later).toEqual({ status: 'organized', cursor: second.seq, throughSeq: second.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(inputs).toHaveLength(2)
  expect(inputs[1]!.events.map(event => event.id)).toEqual([second.id])
})

it('reports a model failure to the caller, leaves the cursor unchanged and lets the next trigger retry', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '第一条')
  const second = webEvent(memory, 'jarvis', 'm2', '2026-11-10T00:00:01.000Z', '第二条')
  let fail = true
  const inputs: OrganizerInput[] = []
  const select: Selector = async input => {
    inputs.push(input)
    if (fail) throw new Error('selector failed')
    return emptySelection()
  }
  const organizer = organizerFor(root, memory, select)
  await expect(organizer.organize({ reason: 'turn' })).rejects.toThrow('selector failed')
  expect(existsSync(statePath(root))).toBe(false)
  expect(organizer.snapshot()).toEqual({ cursor: 0 })
  await expect(organizer.settled()).resolves.toBeUndefined()
  fail = false
  const retried = await organizer.organize({ reason: 'turn' })
  expect(retried).toEqual({ status: 'organized', cursor: second.seq, throughSeq: second.seq,
    methodVersion: 'builtin-v1', itemIds: [], changeIds: [] })
  expect(inputs).toHaveLength(2)
  expect(inputs[1]!.events.map(event => event.id)).toEqual([first.id, second.id])
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
})

it('replays a partially written batch with its stored IDs without calling the selector or the threshold', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '第一条事实')
  const second = webEvent(memory, 'jarvis', 'm2', '2026-11-10T00:00:01.000Z', '第二条事实')
  const task = memory.tasks.save({ title: '待办任务', plan: '', sources: [], todos: [], notes: [] })
  const selection: Selection = { items: [
    { kind: 'agreement', text: '约定一', eventIds: [first.id] },
    { kind: 'todo', text: '待办二', taskId: task.id, eventIds: [second.id] },
  ], changes: [] }
  const select: Selector = async () => selection
  let writes = 0
  const interruptingShortTerm = {
    list: () => memory.shortTerm.list(),
    remember: (input: ShortTermInput, internalId?: string) => {
      writes += 1
      if (writes === 2) throw new Error('interrupted remember')
      return memory.shortTerm.remember(input, internalId)
    },
  } as unknown as ShortTerm
  const organizer = organizerFor(root, memory, select, { threshold: 2, batchSize: 10 }, { shortTerm: interruptingShortTerm })
  await expect(organizer.organize({ reason: 'turn' })).rejects.toThrow('interrupted remember')
  const persisted = organizer.snapshot()
  expect(persisted.cursor).toBe(0)
  expect(persisted.pending?.throughSeq).toBe(second.seq)
  const operations = persisted.pending?.operations ?? []
  expect(operations).toHaveLength(2)
  expect(operations[0]).toMatchObject({ type: 'remember', input: { kind: 'agreement', text: '约定一' } })
  expect(operations[1]).toMatchObject({ type: 'remember', input: { kind: 'todo', taskId: task.id } })
  const operationIds = operations.map(operation => operation.id)
  expect(memory.shortTerm.list()).toHaveLength(1)
  expect(memory.tasks.read(task.id).task.todos).toEqual([])
  let selectorCalls = 0
  const throwingSelect: Selector = async () => { selectorCalls += 1; throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(selectorCalls).toBe(0)
  expect(recovered.itemIds).toEqual(operationIds)
  const views = memory.shortTerm.list()
  expect(views).toHaveLength(2)
  expect([...views.map(view => view.id)].sort()).toEqual([...operationIds].sort())
  expect(memory.tasks.read(task.id).task.todos.map(todo => todo.id)).toEqual([operationIds[1]!])
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
})

it('resumes a change interrupted before its current-value write with one history record', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '本次用中文')
  const task = memory.tasks.save({ title: '定向要求', plan: '', sources: [], todos: [], notes: [] })
  const change: Selection['changes'][number] = { kind: 'fact', scope: 'task', personId: 'lin', property: 'language',
    taskId: task.id, text: '本次用中文', evidenceEventIds: [evidence.id],
    effectiveAt: '2026-11-01T00:00:00.000Z', reason: '用户要求' }
  const select: Selector = async () => ({ items: [], changes: [change] })
  const interruptingTasks = { list: () => memory.tasks.list(), read: (id: string) => memory.tasks.read(id),
    isArchived: (id: string) => memory.tasks.isArchived(id),
    save: () => { throw new Error('interrupted note write') } } as unknown as TaskLists
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { tasks: interruptingTasks })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted note write')
  const pending = organizer.snapshot().pending
  expect(pending?.operations).toHaveLength(1)
  const operation = pending!.operations[0]!
  expect(operation.type).toBe('change')
  const initialHistory = memory.changes.history()
  expect(initialHistory).toHaveLength(1)
  expect(initialHistory[0]!.application?.status).toBe('pending')
  expect(memory.tasks.read(task.id).task.notes).toEqual([])
  let selectorCalls = 0
  const throwingSelect: Selector = async () => { selectorCalls += 1; throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(selectorCalls).toBe(0)
  expect(recovered.changeIds).toEqual([changeIdOf(operation.id)])
  expect(initialHistory[0]!.id).toBe(changeIdOf(operation.id))
  const history = memory.changes.history()
  expect(history).toHaveLength(1)
  expect(history[0]!.application?.status).toBe('applied')
  const notes = memory.tasks.read(task.id).task.notes
  expect(notes).toHaveLength(1)
  expect(notes[0]).toMatchObject({ id: managedEntryId('lin', 'language'), text: '本次用中文' })
  expect(memory.shortTerm.read(managedEntryId('lin', 'language')).text).toBe('本次用中文')
})

it('recovers a change whose current value was written but whose cursor was not, with one history record', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '本次用中文')
  const task = memory.tasks.save({ title: '光标发布失败', plan: '', sources: [], todos: [], notes: [] })
  const change: Selection['changes'][number] = { kind: 'fact', scope: 'task', personId: 'lin', property: 'language',
    taskId: task.id, text: '本次用中文', evidenceEventIds: [evidence.id],
    effectiveAt: '2026-11-01T00:00:00.000Z', reason: '用户要求' }
  const select: Selector = async () => ({ items: [], changes: [change] })
  const organizer = organizerFor(root, memory, select)
  stateFaults.active = 'cursor'
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('simulated state cursor publish failure')
  stateFaults.active = null
  const interrupted = readStateFile(root)
  expect(interrupted.cursor).toBe(0)
  expect(interrupted.pending?.throughSeq).toBe(evidence.seq)
  const historyBefore = memory.changes.history()
  expect(historyBefore).toHaveLength(1)
  expect(historyBefore[0]!.application?.status).toBe('applied')
  expect(memory.tasks.read(task.id).task.notes).toHaveLength(1)
  let selectorCalls = 0
  const throwingSelect: Selector = async () => { selectorCalls += 1; throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(selectorCalls).toBe(0)
  expect(recovered.changeIds).toEqual(historyBefore.map(record => record.id))
  const history = memory.changes.history()
  expect(history).toHaveLength(1)
  expect(history[0]!.application?.status).toBe('applied')
  expect(memory.tasks.read(task.id).task.notes).toHaveLength(1)
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('fails before any entry side effect when the pending state cannot be published', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '本次用中文')
  const task = memory.tasks.save({ title: '发布失败', plan: '', sources: [], todos: [], notes: [] })
  const selection: Selection = { items: [{ kind: 'agreement', text: '约定一', eventIds: [evidence.id] }],
    changes: [{ kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
      text: '本次用中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z', reason: '用户要求' }] }
  const select: Selector = async () => selection
  const organizer = organizerFor(root, memory, select)
  stateFaults.active = 'pending'
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('simulated state pending publish failure')
  stateFaults.active = null
  expect(existsSync(statePath(root))).toBe(false)
  expect(memory.shortTerm.list()).toEqual([])
  expect(memory.changes.history()).toEqual([])
  expect(memory.tasks.read(task.id).task.notes).toEqual([])
  expect(organizer.snapshot()).toEqual({ cursor: 0 })
  const retried = await organizer.organize({ reason: 'idle' })
  expect(retried.status).toBe('organized')
  expect(retried.itemIds).toHaveLength(1)
  expect(retried.changeIds).toHaveLength(1)
  expect(memory.shortTerm.list().map(item => item.id).sort())
    .toEqual([retried.itemIds[0]!, managedEntryId('lin', 'language')].sort())
  expect(memory.changes.history()).toHaveLength(1)
  expect(memory.tasks.read(task.id).task.notes).toHaveLength(1)
})

it('keeps a manual edit when an old pending change is recovered', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '本次用中文')
  const task = memory.tasks.save({ title: '人工修改', plan: '', sources: [], todos: [], notes: [] })
  const change: Selection['changes'][number] = { kind: 'fact', scope: 'task', personId: 'lin', property: 'language',
    taskId: task.id, text: '本次用中文', evidenceEventIds: [evidence.id],
    effectiveAt: '2026-11-01T00:00:00.000Z', reason: '用户要求' }
  const select: Selector = async () => ({ items: [], changes: [change] })
  const interruptingTasks = { list: () => memory.tasks.list(), read: (id: string) => memory.tasks.read(id),
    isArchived: (id: string) => memory.tasks.isArchived(id),
    save: () => { throw new Error('interrupted note write') } } as unknown as TaskLists
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { tasks: interruptingTasks })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted note write')
  memory.tasks.save({ id: task.id, title: '人工修改', plan: '', sources: [], todos: [],
    notes: [{ id: managedEntryId('lin', 'language'), text: '人工修改后的要求', kind: 'agreement', recipient: 'lin', sources: [] }] })
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  const notes = memory.tasks.read(task.id).task.notes
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('人工修改后的要求')
  const history = memory.changes.history()
  expect(history).toHaveLength(1)
  expect(history[0]!.application?.status).toBe('applied')
})

it('applies an ongoing change through the existing current/history logic', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '以后用中文')
  const person = memory.people.save({ name: '小林', description: '', requirements: [], relations: [] })
  const selection: Selection = { items: [], changes: [{ kind: 'change', scope: 'ongoing', personId: person.card.id,
    property: 'language', text: '以后用中文', evidenceEventIds: [evidence.id],
    effectiveAt: '2026-11-01T00:00:00.000Z', reason: '用户要求' }] }
  const select: Selector = async () => selection
  const result = await organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }).organize({ reason: 'turn' })
  expect(result.status).toBe('organized')
  const history = memory.changes.history()
  expect(history).toHaveLength(1)
  expect(result.changeIds).toEqual([history[0]!.id])
  expect(memory.people.read(person.card.id).card.requirements).toEqual([
    { id: 'language', text: '以后用中文', eventIds: [evidence.id] }])
  expect(memory.changes.current({ personId: person.card.id, property: 'language', scope: 'ongoing',
    at: '2027-01-01T00:00:00.000Z' })?.text).toBe('以后用中文')
})

it('resumes a real Node organizer process killed after a partial write without duplicating entries', async () => {
  const modes = ['after-first', 'after-last'] as const
  for (const mode of modes) {
    const runRoot = freshRoot()
    await interruptOrganizerChild(runRoot, mode)
    const persisted = readStateFile(runRoot)
    expect(persisted.cursor).toBe(0)
    expect(persisted.pending?.throughSeq).toBe(2)
    const operations = persisted.pending?.operations ?? []
    expect(operations).toHaveLength(2)
    expect(operations.map(operation => operation.type)).toEqual(['remember', 'remember'])
    const operationIds = operations.map(operation => operation.id)
    const runMemory = createMemory(runRoot)
    const beforeIds = runMemory.shortTerm.list().map(view => view.id)
    expect(beforeIds).toHaveLength(mode === 'after-first' ? 1 : 2)
    expect([...beforeIds].sort()).toEqual(mode === 'after-first' ? [operationIds[0]!] : [...operationIds].sort())
    let selectorCalls = 0
    const throwingSelect: Selector = async () => { selectorCalls += 1; throw new Error('selector must not run during recovery') }
    const recovered = await organizerFor(runRoot, runMemory, throwingSelect, { threshold: 99, batchSize: 1 })
      .organize({ reason: 'turn' })
    expect(recovered.status).toBe('recovered')
    expect(recovered.throughSeq).toBe(2)
    expect(selectorCalls).toBe(0)
    expect([...recovered.itemIds].sort()).toEqual([...operationIds].sort())
    const views = runMemory.shortTerm.list()
    expect(views).toHaveLength(2)
    expect([...views.map(view => view.id)].sort()).toEqual([...operationIds].sort())
    expect(views.find(view => view.id === operationIds[0])?.text).toBe('约定一')
    expect(views.find(view => view.id === operationIds[1])?.text).toBe('经验二')
    expect(readStateFile(runRoot)).toEqual({ cursor: 2 })
  }
}, 120000)

it('defers a change hand-edited while the model is running and still applies other selected work', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '等待期间手改目标')
  const task = memory.tasks.save({ title: '等待手改', plan: '', sources: [], todos: [], notes: [] })
  let release!: (selection: Selection) => void
  const gate = new Promise<Selection>(resolve => { release = resolve })
  const select: Selector = async () => gate
  const deferred = deferCalls()
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { defer: deferred.defer })
  const organizing = organizer.organize({ reason: 'idle' })
  const edited = editedNote('lin', 'language', '等待中的手改')
  saveNotes(task.id, [edited])
  release({ items: [{ kind: 'agreement', text: '约定一', eventIds: [evidence.id] }], changes: [
    { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
      text: '本次用中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z',
      reason: '用户要求' },
  ] })
  const result = await organizing
  expect(result.status).toBe('organized')
  expect(result.cursor).toBe(evidence.seq)
  expect(result.throughSeq).toBe(evidence.seq)
  expect(memory.tasks.read(task.id).task.notes).toEqual([edited])
  expect(memory.changes.history()).toEqual([])
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    operationId: expect.stringMatching(/^organizer-/),
    target: { kind: 'task', id: task.id, part: 'notes', taskId: task.id },
    sourceIds: [evidence.id],
    observedSources: [{ kind: 'event', id: evidence.id, version: evidence.version }],
    reason: 'redo',
    mode: 'target',
  })
  expect(result.deferredIds).toEqual([deferred.calls[0]!.operationId])
  expect(result.reviewIds).toEqual(['review-1'])
  expect(result.itemIds).toHaveLength(1)
  expect(memory.shortTerm.read(result.itemIds[0]!).text).toBe('约定一')
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('defers an ongoing change when its person requirement was hand-edited while the model was running', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '等待期间手改人物要求')
  const person = memory.people.save({ name: '小林', description: '', relations: [],
    requirements: [{ id: 'language', text: '旧要求', eventIds: [evidence.id] }] })
  let release!: (selection: Selection) => void
  const gate = new Promise<Selection>(resolve => { release = resolve })
  const select: Selector = async () => gate
  const deferred = deferCalls()
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { defer: deferred.defer })
  const organizing = organizer.organize({ reason: 'idle' })
  memory.people.save({ id: person.card.id, name: person.card.name, description: person.card.description,
    relations: person.card.relations,
    requirements: [{ id: 'language', text: '等待中手改的要求', eventIds: [] }] })
  release({ items: [], changes: [
    { kind: 'change', scope: 'ongoing', personId: person.card.id, property: 'language',
      text: '以后用中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z',
      reason: '用户要求' },
  ] })
  const result = await organizing
  expect(result.status).toBe('organized')
  expect(memory.people.read(person.card.id).card.requirements[0]?.text).toBe('等待中手改的要求')
  expect(memory.changes.history()).toEqual([])
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    target: { kind: 'person', id: person.card.id, part: 'language' },
    sourceIds: [evidence.id], mode: 'target', reason: 'redo',
  })
  expect(result.deferredIds).toHaveLength(1)
})

it('defers a pending change whose target was hand-edited after the pending state was saved', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', 'pending 后手改')
  const task = memory.tasks.save({ title: 'pending 手改', plan: '', sources: [], todos: [], notes: [] })
  const select: Selector = async () => ({ items: [], changes: [
    { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
      text: '本次用中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z',
      reason: '用户要求' },
  ] })
  const beforeJournal = {
    get: (id: string) => memory.changes.get(id),
    target: (...args: Parameters<MemoryChanges['target']>) => memory.changes.target(...args),
    apply: () => { throw new Error('interrupted before journal') },
  } as unknown as MemoryChanges
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { changes: beforeJournal })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted before journal')
  expect(organizer.snapshot().pending?.operations).toHaveLength(1)
  expect(memory.changes.history()).toEqual([])
  const edited = editedNote('lin', 'language', 'pending 保存后的手改')
  saveNotes(task.id, [edited])
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.cursor).toBe(evidence.seq)
  expect(recovered.changeIds).toEqual([])
  expect(memory.tasks.read(task.id).task.notes).toEqual([edited])
  expect(memory.changes.history()).toEqual([])
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    target: { kind: 'task', id: task.id, part: 'notes', taskId: task.id },
    sourceIds: [evidence.id],
    observedSources: [{ kind: 'event', id: evidence.id, version: evidence.version }],
    reason: 'redo', mode: 'target',
  })
  expect(recovered.deferredIds).toEqual([deferred.calls[0]!.operationId])
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('defers a pending change journal whose evidence event changed and writes no old expected value', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '第一条证据')
  const second = webEvent(memory, 'jarvis', 'm2', '2026-11-10T00:00:01.000Z', '第二条证据')
  const task = memory.tasks.save({ title: '两源中断', plan: '', sources: [], todos: [], notes: [] })
  const select: Selector = async () => ({ items: [], changes: [
    { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
      text: '两源要求', evidenceEventIds: [first.id, second.id], effectiveAt: '2026-11-01T00:00:00.000Z',
      reason: '用户要求' },
  ] })
  const interruptingTasks = { list: () => memory.tasks.list(), read: (id: string) => memory.tasks.read(id),
    isArchived: (id: string) => memory.tasks.isArchived(id),
    save: () => { throw new Error('interrupted note write') } } as unknown as TaskLists
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { tasks: interruptingTasks })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted note write')
  const pendingHistory = memory.changes.history()
  expect(pendingHistory).toHaveLength(1)
  expect(pendingHistory[0]!.application?.status).toBe('pending')
  expect(memory.tasks.read(task.id).task.notes).toEqual([])
  memory.events.record({ kind: second.event.kind, at: second.event.at, text: '被修改的第二条证据',
    source: second.event.source })
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.changeIds).toEqual([])
  expect(memory.tasks.read(task.id).task.notes).toEqual([])
  expect(memory.changes.history()[0]!.application?.status).toBe('pending')
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    target: { kind: 'task', id: task.id, part: 'notes', taskId: task.id },
    sourceIds: [first.id, second.id],
    observedSources: [
      { kind: 'event', id: first.id, version: first.version },
      { kind: 'event', id: second.id, version: second.version },
    ],
    reason: 'redo', mode: 'target',
  })
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
})

it('applies two same-target changes in one batch and accepts its own intermediate target value', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '同批同目标')
  const task = memory.tasks.save({ title: '同批同目标', plan: '', sources: [], todos: [],
    notes: [editedNote('lin', 'language', '旧要求')] })
  const select: Selector = async () => sameTargetSelection(task.id, evidence.id)
  const deferred = deferCalls()
  const result = await organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { defer: deferred.defer })
    .organize({ reason: 'idle' })
  expect(result.status).toBe('organized')
  expect(result.changeIds).toHaveLength(2)
  expect(result.deferredIds).toBeUndefined()
  expect(deferred.calls).toEqual([])
  const notes = memory.tasks.read(task.id).task.notes.filter(note => note.id === managedEntryId('lin', 'language'))
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('第二次')
  expect(memory.changes.history()).toHaveLength(2)
})

it('continues a same-target batch after an interruption using its actually written intermediate value', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '同批中途恢复')
  const task = memory.tasks.save({ title: '同批中途恢复', plan: '', sources: [], todos: [], notes: [] })
  const select: Selector = async () => sameTargetSelection(task.id, evidence.id)
  let calls = 0
  const flaky = {
    get: (id: string) => memory.changes.get(id),
    target: (...args: Parameters<MemoryChanges['target']>) => memory.changes.target(...args),
    apply: (...args: Parameters<MemoryChanges['apply']>) => {
      calls += 1
      if (calls === 2) throw new Error('interrupted second apply')
      return memory.changes.apply(...args)
    },
  } as unknown as MemoryChanges
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { changes: flaky })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted second apply')
  expect(organizer.snapshot().pending?.operations).toHaveLength(2)
  expect(memory.changes.history()).toHaveLength(1)
  const intermediate = memory.tasks.read(task.id).task.notes.filter(note => note.id === managedEntryId('lin', 'language'))
  expect(intermediate).toHaveLength(1)
  expect(intermediate[0]!.text).toBe('第一次')
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.changeIds).toHaveLength(2)
  expect(recovered.deferredIds).toBeUndefined()
  expect(deferred.calls).toEqual([])
  const notes = memory.tasks.read(task.id).task.notes.filter(note => note.id === managedEntryId('lin', 'language'))
  expect(notes).toHaveLength(1)
  expect(notes[0]!.text).toBe('第二次')
  expect(memory.changes.history()).toHaveLength(2)
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('continues same-target ongoing changes after an interruption despite the card relinking its evidence event', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '以后用中文')
  const person = memory.people.save({ name: '小林', description: '', relations: [], requirements: [
    { id: 'language', text: '旧要求', eventIds: [evidence.id] }] })
  const select: Selector = async () => ({ items: [], changes: [
    { kind: 'fact', scope: 'ongoing', personId: person.card.id, property: 'language', text: '以后用中文一',
      evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z', reason: '第一次要求' },
    { kind: 'change', scope: 'ongoing', personId: person.card.id, property: 'language', text: '以后用中文二',
      evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z', reason: '第二次要求' },
  ] })
  let calls = 0
  const flaky = {
    get: (id: string) => memory.changes.get(id),
    target: (...args: Parameters<MemoryChanges['target']>) => memory.changes.target(...args),
    apply: (...args: Parameters<MemoryChanges['apply']>) => {
      calls += 1
      if (calls === 2) throw new Error('interrupted second apply')
      return memory.changes.apply(...args)
    },
  } as unknown as MemoryChanges
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { changes: flaky })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted second apply')
  expect(memory.changes.history()).toHaveLength(1)
  expect(memory.people.read(person.card.id).card.requirements[0]?.text).toBe('以后用中文一')
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.changeIds).toHaveLength(2)
  expect(recovered.deferredIds).toBeUndefined()
  expect(deferred.calls).toEqual([])
  expect(memory.people.read(person.card.id).card.requirements[0]?.text).toBe('以后用中文二')
  expect(memory.changes.history()).toHaveLength(2)
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('refuses the pending operation when a shared source was edited after an earlier operation was applied', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '中断前的来源')
  const task = memory.tasks.save({ title: '同来源恢复', plan: '', sources: [], todos: [], notes: [] })
  let calls = 0
  const flaky = {
    get: (id: string) => memory.changes.get(id),
    target: (...args: Parameters<MemoryChanges['target']>) => memory.changes.target(...args),
    apply: (...args: Parameters<MemoryChanges['apply']>) => {
      if (++calls === 2) throw new Error('stop before second write')
      return memory.changes.apply(...args)
    },
  } as unknown as MemoryChanges
  const organizer = organizerFor(root, memory, async () => sameTargetSelection(task.id, evidence.id),
    { threshold: 1, batchSize: 10 }, { changes: flaky })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('stop before second write')
  memory.events.record({ ...evidence.event, text: '停机后人工修正来源' })
  const deferred = deferCalls()
  const recovered = await organizerFor(root, memory, async () => { throw new Error('must recover') },
    { threshold: 1, batchSize: 10 }, { defer: deferred.defer }).organize({ reason: 'idle' })
  expect(recovered.changeIds).toHaveLength(1)
  expect(recovered.deferredIds).toHaveLength(1)
  expect(memory.tasks.read(task.id).task.notes[0]?.text).toBe('第一次')
  expect(memory.changes.history()).toHaveLength(1)
  expect(deferred.calls[0]?.sourceIds).toEqual([evidence.id])
})

it('does not treat an applied journal value as written after its target was hand-edited', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', 'applied 后手改')
  const task = memory.tasks.save({ title: 'applied 后手改', plan: '', sources: [], todos: [], notes: [] })
  const select: Selector = async () => sameTargetSelection(task.id, evidence.id)
  let calls = 0
  const flaky = {
    get: (id: string) => memory.changes.get(id),
    target: (...args: Parameters<MemoryChanges['target']>) => memory.changes.target(...args),
    apply: (...args: Parameters<MemoryChanges['apply']>) => {
      calls += 1
      if (calls === 2) throw new Error('interrupted second apply')
      return memory.changes.apply(...args)
    },
  } as unknown as MemoryChanges
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { changes: flaky })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted second apply')
  const edited = editedNote('lin', 'language', '手改覆盖中间值')
  saveNotes(task.id, [edited])
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.changeIds).toHaveLength(1)
  expect(memory.tasks.read(task.id).task.notes).toEqual([edited])
  expect(memory.changes.history()).toHaveLength(1)
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    target: { kind: 'task', id: task.id, part: 'notes', taskId: task.id },
    mode: 'target', reason: 'redo',
  })
  expect(recovered.deferredIds).toEqual([deferred.calls[0]!.operationId])
})

it('defers remember operations whose evidence changed without creating entries', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '独立来源')
  const second = webEvent(memory, 'jarvis', 'm2', '2026-11-10T00:00:01.000Z', '任务来源')
  const task = memory.tasks.save({ title: '来源变化', plan: '', sources: [], todos: [], notes: [] })
  const selection: Selection = { items: [
    { kind: 'agreement', text: '独立约定', eventIds: [first.id] },
    { kind: 'todo', text: '任务待办', taskId: task.id, eventIds: [second.id] },
  ], changes: [] }
  const select: Selector = async () => selection
  let writes = 0
  const interruptingShortTerm = {
    list: () => memory.shortTerm.list(),
    remember: (input: ShortTermInput, internalId?: string) => {
      writes += 1
      if (writes === 1) throw new Error('interrupted remember')
      return memory.shortTerm.remember(input, internalId)
    },
  } as unknown as ShortTerm
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 },
    { shortTerm: interruptingShortTerm })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted remember')
  expect(organizer.snapshot().pending?.operations).toHaveLength(2)
  expect(memory.shortTerm.list()).toEqual([])
  memory.events.record({ kind: first.event.kind, at: first.event.at, text: '改过的独立来源', source: first.event.source })
  memory.events.record({ kind: second.event.kind, at: second.event.at, text: '改过的任务来源', source: second.event.source })
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.itemIds).toEqual([])
  expect(memory.shortTerm.list()).toEqual([])
  expect(deferred.calls).toHaveLength(2)
  const independent = deferred.calls.find(call => call.target.kind === 'event')
  expect(independent?.target).toEqual({ kind: 'event', id: first.id })
  expect(independent?.mode).toBe('reselect')
  expect(independent?.sourceIds).toEqual([first.id])
  expect(independent?.observedSources).toEqual([{ kind: 'event', id: first.id, version: first.version,
    selectionVersion: expect.stringMatching(/^[0-9a-f]{64}$/) }])
  const bound = deferred.calls.find(call => call.target.kind === 'task')
  expect(bound?.target).toEqual({ kind: 'task', id: task.id, part: 'todos', taskId: task.id })
  expect(bound?.mode).toBe('reselect')
  expect(bound?.sourceIds).toEqual([second.id])
  expect(recovered.deferredIds).toHaveLength(2)
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
})

it('re-defers without loss or duplicates when the cursor publication fails after a defer', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', 'defer 后 cursor 失败')
  const task = memory.tasks.save({ title: 'defer 后 cursor 失败', plan: '', sources: [], todos: [], notes: [] })
  let release!: (selection: Selection) => void
  const gate = new Promise<Selection>(resolve => { release = resolve })
  const select: Selector = async () => gate
  const deferred = deferCalls()
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { defer: deferred.defer })
  stateFaults.active = 'cursor'
  const organizing = organizer.organize({ reason: 'idle' })
  const edited = editedNote('lin', 'language', 'defer 时的手改')
  saveNotes(task.id, [edited])
  release({ items: [{ kind: 'agreement', text: '保留的约定', eventIds: [evidence.id] }], changes: [
    { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
      text: '旧模型要求', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z',
      reason: '用户要求' },
  ] })
  await expect(organizing).rejects.toThrow('simulated state cursor publish failure')
  stateFaults.active = null
  const interrupted = readStateFile(root)
  expect(interrupted.cursor).toBe(0)
  expect(interrupted.pending?.operations).toHaveLength(2)
  expect(deferred.calls).toHaveLength(1)
  const firstDeferred = deferred.calls[0]!
  const savedItem = () => memory.shortTerm.list().find(view => view.text === '保留的约定')!
  expect(savedItem()).toBeDefined()
  expect(memory.changes.history()).toEqual([])
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.cursor).toBe(evidence.seq)
  expect(memory.shortTerm.list().filter(view => view.text === '保留的约定')).toHaveLength(1)
  expect(recovered.itemIds).toEqual([savedItem().id])
  expect(memory.changes.history()).toEqual([])
  expect(memory.tasks.read(task.id).task.notes).toEqual([edited])
  expect(deferred.calls).toHaveLength(2)
  expect(deferred.calls[1]).toEqual(firstDeferred)
  expect(recovered.deferredIds).toEqual([firstDeferred.operationId])
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('defers a legacy pending change that has no observed evidence instead of writing it', async () => {
  const evidence = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '旧 pending')
  const task = memory.tasks.save({ title: '旧 pending', plan: '', sources: [], todos: [], notes: [] })
  const change = { kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
    text: '旧 pending 要求', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-01T00:00:00.000Z',
    reason: '用户要求' }
  writeFileSync(statePath(root), JSON.stringify({ cursor: 0, pending: { throughSeq: evidence.seq,
    operations: [{ id: 'legacy-change-operation', type: 'change', input: change }] } }, null, 2) + '\n')
  const deferred = deferCalls()
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 },
    { defer: deferred.defer }).organize({ reason: 'turn' })
  expect(recovered.status).toBe('recovered')
  expect(recovered.changeIds).toEqual([])
  expect(memory.tasks.read(task.id).task.notes).toEqual([])
  expect(memory.changes.history()).toEqual([])
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({
    operationId: 'legacy-change-operation',
    target: { kind: 'task', id: task.id, part: 'notes', taskId: task.id },
    sourceIds: [evidence.id], observedSources: [], reason: 'redo', mode: 'target',
  })
  expect(readStateFile(root)).toEqual({ cursor: evidence.seq })
})

it('recovers the pending batch with its dropped entries and the method version used for its experiences', async () => {
  const first = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '第一条经验来源')
  const second = webEvent(memory, 'user', 'm2', '2026-11-10T00:00:01.000Z', '第二条约定来源')
  const dropped = [{ list: 'items' as const, index: 2, reasons: ['Unknown task t9'] }]
  const selection: Selection = { methodVersion: 'trial-v2', dropped, items: [
    { kind: 'experience', text: '经验一', eventIds: [first.id] },
    { kind: 'agreement', text: '约定二', eventIds: [second.id] },
  ], changes: [] }
  const select: Selector = async () => selection
  let writes = 0
  const interruptingShortTerm = {
    list: () => memory.shortTerm.list(),
    remember: (input: ShortTermInput, internalId?: string) => {
      writes += 1
      if (writes === 2) throw new Error('interrupted remember')
      return memory.shortTerm.remember(input, internalId)
    },
  } as unknown as ShortTerm
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 },
    { shortTerm: interruptingShortTerm })
  await expect(organizer.organize({ reason: 'idle' })).rejects.toThrow('interrupted remember')
  const pending = organizer.snapshot().pending
  expect(pending?.dropped).toEqual(dropped)
  expect(pending?.methodVersion).toBe('trial-v2')
  expect(pending?.operations[0]).toMatchObject({ type: 'remember',
    input: { kind: 'experience', text: '经验一', methodVersion: 'trial-v2' } })
  expect(pending?.operations[1]).toMatchObject({ type: 'remember', input: { kind: 'agreement', text: '约定二' } })
  expect(pending?.operations[1]?.input).not.toHaveProperty('methodVersion')
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 })
    .organize({ reason: 'turn' })
  expect(recovered).toMatchObject({ status: 'recovered', methodVersion: 'trial-v2', dropped })
  expect(memory.shortTerm.read(recovered.itemIds[0]!).methodVersion).toBe('trial-v2')
  expect(memory.shortTerm.read(recovered.itemIds[1]!).methodVersion).toBeUndefined()
})

it('recovers a legacy pending experience as builtin-v1 without reading any later active method', async () => {
  const event = webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '旧 pending 来源')
  writeFileSync(statePath(root), JSON.stringify({ cursor: 0, pending: { throughSeq: event.seq,
    operations: [{ id: 'legacy-experience-operation', type: 'remember',
      input: { kind: 'experience', text: '旧经验', sources: [{ kind: 'event', id: event.id }] },
      observed: { sources: [{ kind: 'event', id: event.id, version: event.version }], target: null } }] } },
  null, 2) + '\n')
  const throwingSelect: Selector = async () => { throw new Error('selector must not run during recovery') }
  const recovered = await organizerFor(root, memory, throwingSelect, { threshold: 99, batchSize: 1 })
    .organize({ reason: 'turn' })
  expect(recovered).toMatchObject({ status: 'recovered', methodVersion: 'builtin-v1' })
  expect(memory.shortTerm.read('legacy-experience-operation').methodVersion).toBe('builtin-v1')
  expect(readStateFile(root)).toEqual({ cursor: event.seq })
})

it('recovers an archived task remember through durable review and still applies the independent experience once', async () => {
  const first = webEvent(memory, 'user', 'archived-source-1', '2026-11-10T00:00:00.000Z', '项目约定')
  const second = webEvent(memory, 'jarvis', 'archived-source-2', '2026-11-10T00:00:01.000Z', '另有可保留的经验')
  const task = memory.tasks.save({ id: 'archived-project', title: '已归档项目', plan: '原计划', sources: [], todos: [],
    notes: [{ id: 'original-note', text: '原归档内容' }] })
  const archive = archiveTask(task.id)
  const sources = [first, second].map(event => ({ kind: 'event' as const, id: event.id, version: event.version }))
  // Match the real legacy pending shape: source observations exist, but the batch has no methodVersion.
  const state: OrganizerState = { cursor: 0, pending: { throughSeq: second.seq, operations: [
    { id: 'archived-task-remember', type: 'remember', input: { kind: 'agreement', text: '迟到的项目约定', taskId: task.id,
      sources: sources.map(({ kind, id }) => ({ kind, id })) }, observed: { sources, target: null } },
    { id: 'independent-experience', type: 'remember', input: { kind: 'experience', text: '独立经验应继续落库',
      sources: [{ kind: 'event', id: second.id }] }, observed: { sources: [sources[1]!], target: null } },
  ] } }
  writeFileSync(statePath(root), JSON.stringify(state), 'utf8')
  const reviewDeps = { usedBy: () => [], read: () => { throw new Error('A defer handoff must not read or write the archived target') } }
  let reviews = new MemoryReviews(root, reviewDeps)
  const defer = vi.fn((input: OrganizerDeferred) => reviews.defer({ operationId: input.operationId,
    target: input.target, mode: input.mode,
    sources: input.sourceIds.map(id => input.observedSources.find(source => source.id === id) ?? { kind: 'event', id }) }))
  const select = vi.fn<Selector>(async () => { throw new Error('Recovery must not call the selector') })
  const recovering = () => organizerFor(root, memory, select, { threshold: 99, batchSize: 1 }, { defer })
  const unavailable = vi.spyOn(reviews, 'defer').mockImplementationOnce(() => { throw new Error('review queue unavailable') })
  await expect(recovering().organize({ reason: 'sleep' })).rejects.toThrow('review queue unavailable')
  unavailable.mockRestore()
  expect(readStateFile(root)).toEqual(state)
  expect(memory.shortTerm.list()).toEqual([])

  stateFaults.active = 'cursor'
  await expect(recovering().organize({ reason: 'sleep' })).rejects.toThrow('simulated state cursor publish failure')
  stateFaults.active = null
  expect(readStateFile(root)).toEqual(state)
  const savedReview = reviews.pending()[0]!
  expect(savedReview).toMatchObject({ status: 'pending', reason: 'redo', taskIds: [task.id],
    target: { kind: 'task', id: task.id, part: 'notes' }, sources,
    deferred: [{ operationId: 'archived-task-remember', mode: 'reselect', sources }] })
  expect(memory.shortTerm.read('independent-experience')).toMatchObject({ text: '独立经验应继续落库', methodVersion: 'builtin-v1' })
  // Reopen the actual durable queue and replay the same pending batch; neither the review nor the independent item duplicates.
  reviews = new MemoryReviews(root, reviewDeps)
  const result = await recovering().organize({ reason: 'idle' })
  expect(result).toMatchObject({ status: 'recovered', cursor: second.seq, methodVersion: 'builtin-v1',
    itemIds: ['independent-experience'], changeIds: [], deferredIds: ['archived-task-remember'], reviewIds: [savedReview.id] })
  expect(reviews.pending()).toEqual([savedReview])
  expect(memory.shortTerm.list().map(item => item.id)).toEqual(['independent-experience'])
  expect(memory.tasks.isArchived(task.id)).toBe(true)
  expect(memory.tasks.list()).toEqual([])
  expect(readFileSync(archive.taskPath, 'utf8')).toBe(archive.taskBytes)
  expect(readFileSync(archive.archivePath, 'utf8')).toBe(archive.archiveBytes)
  expect(readStateFile(root)).toEqual({ cursor: second.seq })
  expect(select).not.toHaveBeenCalled()
})

it('defers remember and change targets archived while selection runs without restoring or writing the archive', async () => {
  const evidence = webEvent(memory, 'user', 'archive-in-flight', '2026-11-10T00:00:00.000Z', '项目整理事实')
  const task = memory.tasks.save({ id: 'archive-in-flight', title: '模型调用中归档', plan: '', sources: [], todos: [], notes: [] })
  const selection = Promise.withResolvers<Selection>()
  const select = vi.fn<Selector>(() => selection.promise)
  const deferred = deferCalls()
  const organizer = organizerFor(root, memory, select, { threshold: 1, batchSize: 10 }, { defer: deferred.defer })
  const organizing = organizer.organize({ reason: 'idle' })
  expect(select).toHaveBeenCalledOnce()
  const archive = archiveTask(task.id)
  selection.resolve({ items: [
    { kind: 'todo', taskId: task.id, text: '迟到的项目待办', eventIds: [evidence.id] },
    { kind: 'agreement', text: '仍可保存的独立约定', eventIds: [evidence.id] },
  ], changes: [{ kind: 'fact', scope: 'task', personId: 'lin', property: 'language', taskId: task.id,
    text: '中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-10T00:00:00.000Z', reason: '用户要求' }] })
  const result = await organizing
  expect(result).toMatchObject({ status: 'organized', cursor: evidence.seq, changeIds: [] })
  expect(result.itemIds).toHaveLength(1)
  expect(result.deferredIds).toHaveLength(2)
  expect(deferred.calls).toEqual([
    expect.objectContaining({ mode: 'reselect', target: { kind: 'task', id: task.id, taskId: task.id, part: 'todos' }, sourceIds: [evidence.id] }),
    expect.objectContaining({ mode: 'target', target: { kind: 'task', id: task.id, taskId: task.id, part: 'notes' }, sourceIds: [evidence.id] }),
  ])
  expect(memory.shortTerm.list().map(item => item.text)).toEqual(['仍可保存的独立约定'])
  expect(memory.changes.history()).toEqual([])
  expect(memory.tasks.isArchived(task.id)).toBe(true)
  expect(readFileSync(archive.taskPath, 'utf8')).toBe(archive.taskBytes)
  expect(readFileSync(archive.archivePath, 'utf8')).toBe(archive.archiveBytes)
})

it('defers an unfinished change journal after its task is archived and keeps the journal as evidence', async () => {
  const evidence = webEvent(memory, 'user', 'archived-journal-source', '2026-11-10T00:00:00.000Z', '本项目用中文')
  const task = memory.tasks.save({ id: 'archived-journal-task', title: '已记录未写回', plan: '', sources: [], todos: [], notes: [] })
  const select: Selector = async () => ({ items: [], changes: [{ kind: 'fact', scope: 'task', personId: 'lin', property: 'language',
    taskId: task.id, text: '中文', evidenceEventIds: [evidence.id], effectiveAt: '2026-11-10T00:00:00.000Z', reason: '用户要求' }] })
  const interrupted = vi.spyOn(memory.tasks, 'save').mockImplementationOnce(() => { throw new Error('interrupted task write') })
  await expect(organizerFor(root, memory, select).organize({ reason: 'idle' })).rejects.toThrow('interrupted task write')
  interrupted.mockRestore()
  const history = memory.changes.history()
  expect(history[0]!.application?.status).toBe('pending')
  const archive = archiveTask(task.id), deferred = deferCalls()
  const recovered = await organizerFor(root, memory, async () => { throw new Error('must recover') },
    { threshold: 1, batchSize: 10 }, { defer: deferred.defer }).organize({ reason: 'sleep' })
  expect(recovered).toMatchObject({ status: 'recovered', cursor: evidence.seq, itemIds: [], changeIds: [] })
  expect(deferred.calls).toHaveLength(1)
  expect(deferred.calls[0]).toMatchObject({ mode: 'target', sourceIds: [evidence.id],
    target: { kind: 'task', id: task.id, taskId: task.id, part: 'notes' } })
  expect(memory.changes.history()).toEqual(history)
  expect(memory.tasks.isArchived(task.id)).toBe(true)
  expect(readFileSync(archive.taskPath, 'utf8')).toBe(archive.taskBytes)
  expect(readFileSync(archive.archivePath, 'utf8')).toBe(archive.archiveBytes)
})

it('keeps the runId of the batch that started when another trigger shares its pass', async () => {
  webEvent(memory, 'user', 'm1', '2026-11-10T00:00:00.000Z', '共享批次')
  const contexts: ({ reason: string; runId?: string } | undefined)[] = []
  let release!: (selection: Selection) => void
  const gate = new Promise<Selection>(resolve => { release = resolve })
  const select: Selector = async (_input, _signal, context) => { contexts.push(context); return gate }
  const organizer = organizerFor(root, memory, select)
  const first = organizer.organize({ reason: 'turn', runId: 'run-1' })
  const second = organizer.organize({ reason: 'idle', runId: 'run-2' })
  expect(second).toBe(first)
  release({ items: [], changes: [], methodVersion: 'trial-v2' })
  const [left, right] = await Promise.all([first, second])
  expect(contexts).toEqual([{ reason: 'turn', runId: 'run-1' }])
  expect(left.methodVersion).toBe('trial-v2')
  expect(right.methodVersion).toBe('trial-v2')
})
