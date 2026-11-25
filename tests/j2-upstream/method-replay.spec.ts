/** Replay cases, isolated method comparisons and the one real shared selection entry. */
import type { MemoryModelContext as Context } from '../../src/core/ports/model.ts'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openLocalJ2, type LocalJ2 as MemoryModule } from '../../src/core/local-service.ts'
import type { EventMemoryInput, EventMemorySelection } from '../../src/core/compaction-selection.ts'
import { MethodReplay, type MethodReplaySelectOptions } from '../../src/core/method-replay.ts'
import { MemoryMethods } from '../../src/core/methods.ts'
import { memoryPath } from '../../src/core/store.ts'

const background = { provider: 'background', model: 'memory', reasoningEffort: 'max' }
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
interface StreamRequest { messages: { content: { text: string }[] }[]; maxTokens?: number }
/** The four input groups with mutable arrays, so a test can prove a captured case never follows the live source. */
type FixtureInput = {
  events: EventMemoryInput['events'][number][]
  existing: EventMemoryInput['existing'][number][]
  tasks: EventMemoryInput['tasks'][number][]
  people: EventMemoryInput['people'][number][]
}

const sourceEvent = (id: string, seq: number, text: string): EventMemoryInput['events'][number] => ({
  id, seq, event: { kind: 'user', at: '2026-11-10T00:00:00.000Z', text,
    source: { kind: 'web-message', id: 'source-' + id } },
})
/** The four frozen groups: two source events, one existing entry, one task and one person requirement. */
const frozenInput = (): FixtureInput => ({
  events: [sourceEvent('20261110-aaaa', 1, '冻结来源一'), sourceEvent('20261110-bbbb', 2, '冻结来源二')],
  existing: [{ id: 'entry-1', kind: 'agreement', text: '已有条目',
    sources: [{ kind: 'event', id: '20261110-aaaa' }] }],
  tasks: [{ id: 'task-1', title: '任务一' }],
  people: [{ id: 'person-1', name: '张三',
    requirements: [{ id: 'requirement-1', text: '长期要求', eventIds: ['20261110-bbbb'] }] }],
})

let base: string
const modules: MemoryModule[] = []
const memoryRoot = (): string => memoryPath(join(base, 'state'))

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'method-replay-'))
  modules.length = 0
})
afterEach(async () => {
  for (const module of modules.splice(0)) await module.close()
  rmSync(base, { recursive: true, force: true })
})

/** Every file under a directory, so a write can be detected by comparing the tree before and after a run. */
function filesUnder(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) found.push(...filesUnder(path))
    else found.push(path)
  }
  return found
}

/** Open one real MemoryModule over the temporary state; the Store surfaces it reads have harmless empty defaults. */
function open(context: Context): MemoryModule {
  const module = openLocalJ2(memoryRoot(), {model: {context, route: () => background}})
  modules.push(module)
  return module
}

/** The controller's capture, mirrored from the organizer's frozen-input projection over the real libraries. */
function captureFromModule(module: MemoryModule): (eventIds: string[]) => EventMemoryInput {
  return (eventIds: string[]): EventMemoryInput => ({
    events: eventIds.map(id => {
      const read = module.events.get(id)
      return { id: read.id, seq: read.seq, event: { kind: read.event.kind, at: read.event.at, text: read.event.text,
        source: { kind: read.event.source.kind, id: read.event.source.id },
        ...(read.event.taskId === undefined ? {} : { taskId: read.event.taskId }) } }
    }),
    existing: module.shortTerm.list().map(view => ({
      id: view.id, kind: view.kind, text: view.text,
      ...(view.taskId === undefined ? {} : { taskId: view.taskId }),
      ...(view.recipient === undefined ? {} : { recipient: view.recipient }),
      sources: view.sources.map(source => ({ kind: source.kind, id: source.id })),
    })),
    tasks: module.taskLists.list().map(read => ({ id: read.task.id, title: read.task.title })),
    people: module.people.list().map(card => ({ id: card.id, name: card.name,
      requirements: card.requirements.map(requirement => ({ id: requirement.id, text: requirement.text,
        eventIds: [...requirement.eventIds] })) })),
  })
}

it('captures the four input groups once and never lets a later source change reach a rerun', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('candidate-v2', '候选指令')
  const live = frozenInput()
  const capture = vi.fn((): FixtureInput => live)
  const received: EventMemoryInput[] = []
  const select = vi.fn(async (input: EventMemoryInput, options: MethodReplaySelectOptions)
    : Promise<EventMemorySelection & { methodVersion: string }> => {
    received.push(JSON.parse(JSON.stringify(input)) as EventMemoryInput)
    return { items: [], changes: [], methodVersion: options.methodVersion }
  })
  const replay = new MethodReplay(root, { methods, capture, select })
  replay.createCase({ id: 'case-frozen', title: '冻结考题', kind: 'typical',
    eventIds: [live.events[0]!.id, live.events[1]!.id] })
  expect(capture).toHaveBeenCalledOnce()
  // The live sources keep moving after the capture; the case and every later run must keep the frozen input.
  live.events.push(sourceEvent('20261110-cccc', 3, '后来来源'))
  live.existing[0]!.text = '后来改写的条目'
  live.tasks.push({ id: 'task-2', title: '后来任务' })
  live.people[0]!.requirements[0]!.text = '后来改写的要求'
  const frozen = frozenInput()
  expect(replay.readCase('case-frozen').input).toEqual(frozen)
  expect(replay.listCases().map(item => item.id)).toEqual(['case-frozen'])
  await replay.run({ caseId: 'case-frozen', baselineVersion: 'builtin-v1', candidateVersion: 'candidate-v2' })
  expect(received).toEqual([frozen, frozen])
  expect(capture).toHaveBeenCalledOnce()
  expect(Object.isFrozen(replay.readCase('case-frozen'))).toBe(true)
  expect(Object.isFrozen(replay.readCase('case-frozen').input.events)).toBe(true)
  expect(() => replay.createCase({ id: 'case-frozen', title: '重复', kind: 'typical', eventIds: [] }))
    .toThrow(/already exists/)
})

it('runs both fixed versions serially on isolated clones through the one selector', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('candidate-v2', '候选指令')
  const source = frozenInput()
  const received: EventMemoryInput[] = []
  const optionsSeen: MethodReplaySelectOptions[] = []
  const select = vi.fn(async (input: EventMemoryInput, options: MethodReplaySelectOptions)
    : Promise<EventMemorySelection & { methodVersion: string }> => {
    received.push(input)
    optionsSeen.push(options)
    // The first side damages its own input; the second side must still see the frozen case untouched.
    if (received.length === 1) {
      input.events[0]!.event.text = '第一版改坏的来源'
      input.existing[0]!.text = '第一版改坏的条目'
    }
    return { items: [], changes: [], methodVersion: options.methodVersion }
  })
  const replay = new MethodReplay(root, { methods, capture: () => source, select })
  replay.createCase({ id: 'case-clone', title: '克隆隔离', kind: 'typical', eventIds: [source.events[0]!.id] })
  const signal = new AbortController().signal
  const record = await replay.run({ caseId: 'case-clone', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2', runId: 'run-7', signal })
  expect(select).toHaveBeenCalledTimes(2)
  expect(received[0]).not.toBe(received[1])
  expect(received[1]).toEqual(frozenInput())
  expect(replay.readCase('case-clone').input).toEqual(frozenInput())
  expect(optionsSeen[0]).toMatchObject({ methodVersion: 'builtin-v1', reason: 'replay',
    runId: 'replay-' + record.id })
  expect(optionsSeen[1]).toMatchObject({ methodVersion: 'candidate-v2', reason: 'replay',
    runId: 'replay-' + record.id })
  expect(optionsSeen[0]!.signal).toBe(signal)
  expect(optionsSeen[1]!.signal).toBe(signal)
  expect(record.requestedRunId).toBe('run-7')
  expect(record.status).toBe('completed')
  const comparisons = replay.listComparisons().length
  await expect(replay.run({ caseId: 'case-clone', candidateVersion: 'missing-v9' })).rejects.toThrow(/missing-v9/)
  expect(replay.listComparisons()).toHaveLength(comparisons)
})

it('pins the method active at run start when no baseline version is named', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('active-v2', '当前激活指令')
  methods.createCandidate('candidate-v3', '候选指令')
  writeFileSync(join(root, 'methods', 'active.json'), JSON.stringify({ version: 'active-v2' }) + '\n', 'utf8')
  const replay = new MethodReplay(root, { methods, capture: () => frozenInput(),
    select: async (_input: EventMemoryInput, options: MethodReplaySelectOptions) =>
      ({ items: [], changes: [], methodVersion: options.methodVersion }) })
  replay.createCase({ id: 'case-active', title: '激活基线', kind: 'typical', eventIds: ['20261110-aaaa'] })
  const record = await replay.run({ caseId: 'case-active', candidateVersion: 'candidate-v3' })
  expect(record.baseline).toEqual({ version: 'active-v2', instructionsHash: sha256('当前激活指令') })
  expect(record.candidate).toEqual({ version: 'candidate-v3', instructionsHash: sha256('候选指令') })
  expect(methods.active().version).toBe('active-v2')
})

it('records both actual outputs, the fixed versions, their diff and every event source', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('candidate-v2', '优先经验')
  const input = frozenInput()
  const baselineSelection: EventMemorySelection = {
    items: [{ kind: 'experience', text: '基线经验', eventIds: ['20261110-bbbb', '20261110-aaaa'] }],
    changes: [{ kind: 'fact', scope: 'ongoing', personId: 'person-1', property: 'timezone', text: '偏好上午',
      evidenceEventIds: ['20261110-bbbb'], effectiveAt: '2026-11-10T00:00:00.000Z', reason: '基线理由' }],
  }
  const candidateSelection: EventMemorySelection = {
    items: [{ kind: 'todo', text: '候选待办', eventIds: ['20261110-bbbb'] }],
    changes: [],
  }
  const select = vi.fn(async (_input: EventMemoryInput, options: MethodReplaySelectOptions)
    : Promise<EventMemorySelection & { methodVersion: string }> => ({
    ...(options.methodVersion === 'builtin-v1' ? baselineSelection : candidateSelection),
    methodVersion: options.methodVersion,
  }))
  const replay = new MethodReplay(root, { methods, capture: () => input, select })
  replay.createCase({ id: 'case-diff', title: '差异考题', kind: 'counterexample',
    eventIds: [input.events[0]!.id, input.events[1]!.id] })
  const record = await replay.run({ caseId: 'case-diff', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2' })
  expect(record.status).toBe('completed')
  expect(record.eventIds).toEqual(['20261110-aaaa', '20261110-bbbb'])
  expect(record.baseline).toEqual({ version: 'builtin-v1', instructionsHash: sha256('') })
  expect(record.candidate).toEqual({ version: 'candidate-v2', instructionsHash: sha256('优先经验') })
  expect(record.baselineResult).toEqual({ status: 'completed', methodVersion: 'builtin-v1',
    output: {
      items: [{ kind: 'experience', text: '基线经验', eventIds: ['20261110-aaaa', '20261110-bbbb'] }],
      changes: baselineSelection.changes,
    },
    citedEventIds: ['20261110-aaaa', '20261110-bbbb'] })
  expect(record.candidateResult).toEqual({ status: 'completed', methodVersion: 'candidate-v2',
    output: candidateSelection,
    citedEventIds: ['20261110-bbbb'] })
  expect(record.diff).toEqual({
    addedItems: [{ kind: 'todo', text: '候选待办', eventIds: ['20261110-bbbb'] }],
    removedItems: [{ kind: 'experience', text: '基线经验', eventIds: ['20261110-aaaa', '20261110-bbbb'] }],
    addedChanges: [],
    removedChanges: baselineSelection.changes,
  })
  const reopened = new MethodReplay(root, { methods, capture: () => input, select })
  expect(reopened.readComparison(record.id)).toEqual(record)
  expect(reopened.listComparisons().map(item => item.id)).toEqual([record.id])
})

it('runs the same case again under a new comparison ID and its own replay attribution', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('candidate-v2', '候选指令')
  const runIds: string[] = []
  const select = vi.fn(async (_input: EventMemoryInput, options: MethodReplaySelectOptions)
    : Promise<EventMemorySelection & { methodVersion: string }> => {
    runIds.push(options.runId)
    return { items: [], changes: [], methodVersion: options.methodVersion }
  })
  const replay = new MethodReplay(root, { methods, capture: () => frozenInput(), select })
  replay.createCase({ id: 'case-repeat', title: '重复考题', kind: 'typical', eventIds: ['20261110-aaaa'] })
  const first = await replay.run({ caseId: 'case-repeat', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2' })
  const second = await replay.run({ caseId: 'case-repeat', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2' })
  expect(first.id).not.toBe(second.id)
  expect(runIds).toEqual(['replay-' + first.id, 'replay-' + first.id,
    'replay-' + second.id, 'replay-' + second.id])
  expect(select).toHaveBeenCalledTimes(4)
  const listed = replay.listComparisons()
  expect(listed).toHaveLength(2)
  expect(listed.map(item => item.id).sort()).toEqual([first.id, second.id].sort())
  expect(listed.every(item => item.caseId === 'case-repeat')).toBe(true)
  expect(listed.every(item => item.status === 'completed')).toBe(true)
})

it('keeps a failed second call as a failed comparison with the completed first side intact', async () => {
  const root = join(base, 'replay')
  const methods = new MemoryMethods(root)
  methods.createCandidate('candidate-v2', '候选指令')
  const select = vi.fn(async (_input: EventMemoryInput, options: MethodReplaySelectOptions)
    : Promise<EventMemorySelection & { methodVersion: string }> => {
    if (options.methodVersion === 'candidate-v2') throw new Error('候选选择失败')
    return { items: [{ kind: 'agreement', text: '第一版结果', taskId: 'task-1',
      eventIds: ['20261110-aaaa'] }], changes: [], methodVersion: options.methodVersion }
  })
  const replay = new MethodReplay(root, { methods, capture: () => frozenInput(), select })
  replay.createCase({ id: 'case-failure', title: '失败考题', kind: 'counterexample',
    eventIds: ['20261110-aaaa'] })
  const record = await replay.run({ caseId: 'case-failure', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2' })
  expect(record.status).toBe('failed')
  expect(record.error).toBe('candidate selection failed: 候选选择失败')
  expect(record.baselineResult).toMatchObject({ status: 'completed', methodVersion: 'builtin-v1',
    citedEventIds: ['20261110-aaaa'],
    output: { items: [{ kind: 'agreement', text: '第一版结果', taskId: 'task-1',
      eventIds: ['20261110-aaaa'] }], changes: [] } })
  expect(record.candidateResult).toEqual({ status: 'failed', error: '候选选择失败' })
  expect(record.diff).toBeUndefined()
  expect(record.finishedAt).toEqual(expect.any(String))
  expect(select).toHaveBeenCalledTimes(2)
  expect(replay.readComparison(record.id)).toEqual(record)
})

it('drives both method prompts through the real shared selectMemory entry without a memory, cursor or active write', async () => {
  const prompts: string[] = []
  let sourceId = ''
  const stream = vi.fn(async function* (request: StreamRequest) {
    prompts.push(request.messages[0]!.content[0]!.text)
    const output: EventMemorySelection = prompts.length === 1
      ? { items: [{ kind: 'experience', text: '基线经验', eventIds: [sourceId] }], changes: [] }
      : { items: [], changes: [] }
    yield { type: 'text-delta', text: JSON.stringify(output), index: 0 }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  const module = open(ctx)
  module.methods.createCandidate('candidate-v2', '回放候选指令')
  const event = module.events.record({ kind: 'user', at: '2026-11-10T00:00:00.000Z', text: '真实回放来源',
    source: { kind: 'web-message', id: 'web-1' } })
  sourceId = event.id
  const root = memoryRoot()
  const replay = new MethodReplay(root, { methods: module.methods, capture: captureFromModule(module),
    select: (input: EventMemoryInput, options: MethodReplaySelectOptions) =>
      module.selectMemory(input, options) })
  replay.createCase({ id: 'case-real', title: '真实通路', kind: 'typical', eventIds: [event.id] })
  const before = filesUnder(root)
  const record = await replay.run({ caseId: 'case-real', baselineVersion: 'builtin-v1',
    candidateVersion: 'candidate-v2' })
  const after = filesUnder(root)
  expect(prompts).toHaveLength(2)
  expect(prompts[0]).not.toContain('Method instructions:')
  expect(prompts[1]).toContain('Method instructions: 回放候选指令')
  expect(prompts[0]).toContain('真实回放来源')
  expect(prompts[1]).toContain('真实回放来源')
  expect(record.status).toBe('completed')
  expect(record.baseline).toEqual({ version: 'builtin-v1', instructionsHash: sha256('') })
  expect(record.candidate).toEqual({ version: 'candidate-v2', instructionsHash: sha256('回放候选指令') })
  expect(record.baselineResult).toMatchObject({ status: 'completed', methodVersion: 'builtin-v1' })
  expect(record.candidateResult).toMatchObject({ status: 'completed', methodVersion: 'candidate-v2' })
  expect(record.diff).toEqual({
    addedItems: [],
    removedItems: [{ kind: 'experience', text: '基线经验', eventIds: [event.id] }],
    addedChanges: [],
    removedChanges: [],
  })
  expect(module.methods.active().version).toBe('builtin-v1')
  expect(module.shortTerm.list()).toHaveLength(0)
  expect(module.taskLists.list()).toHaveLength(0)
  expect(module.people.list()).toHaveLength(0)
  expect(module.organizer.snapshot()).toEqual({ cursor: 0 })
  expect(existsSync(join(root, 'methods', 'active.json'))).toBe(false)
  expect(existsSync(join(root, 'short-term', 'item-index.json'))).toBe(false)
  const normalized = after.map(file => file.replaceAll('\\', '/'))
  expect(normalized.some(file => /\/(short-term|tasks|people|experiences)\//.test(file))).toBe(false)
  const added = after.filter(file => !before.includes(file)).map(file => file.replaceAll('\\', '/'))
  expect(added).toHaveLength(1)
  expect(added[0]!).toMatch(/\/methods\/comparisons\/comparison-[^/]+\.json$/)
})
