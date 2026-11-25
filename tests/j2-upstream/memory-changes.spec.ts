import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryChanges, type ChangeApplyResult, type ChangeInput, type ChangeResult, type MemoryChange } from '../../src/core/changes.ts'
import { MemoryEvents } from '../../src/core/events.ts'
import { PersonCards } from '../../src/core/people.ts'
import { TaskLists } from '../../src/core/task-lists.ts'

let root: string
let events: MemoryEvents
let changes: MemoryChanges
let people: PersonCards
let tasks: TaskLists
let evidence: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jarvis-changes-'))
  events = new MemoryEvents(root)
  changes = new MemoryChanges(root, events)
  people = new PersonCards(root, events)
  tasks = new TaskLists(root, () => undefined)
  evidence = events.record({ kind: 'user', at: '2026-01-01T00:00:00Z', text: '我喜欢红茶',
    source: { kind: 'web-message', id: 'm1' }, personIds: ['owner'] }).id
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function make(part: Partial<ChangeInput> & Pick<ChangeInput, 'kind' | 'text'>): ChangeInput {
  const input: ChangeInput = { kind: part.kind, scope: part.scope ?? 'ongoing', personId: part.personId ?? 'owner',
    property: part.property ?? 'drink', text: part.text, evidenceEventIds: part.evidenceEventIds ?? [evidence],
    effectiveAt: part.effectiveAt ?? '2026-01-01T00:00:00Z', reason: part.reason ?? '用户要求' }
  if (part.targetId) input.targetId = part.targetId
  if (part.taskId) input.taskId = part.taskId
  return input
}
function recorded(result: ChangeResult): MemoryChange {
  if (result.status !== 'recorded') throw new Error(result.question)
  return result.record
}
function applied(result: ChangeApplyResult): { record: MemoryChange; current: MemoryChange | null; target: ReturnType<MemoryChanges['target']> } {
  if (result.status !== 'recorded') throw new Error(result.question)
  return result
}
const currentAt = (at: string) => changes.current({ personId: 'owner', property: 'drink', scope: 'ongoing', at })
/** A time safely before the test's clock, so a change applies to the target when it is recorded. */
const past = '2020-01-01T00:00:00Z'

it('keeps an earlier value readable at its own date after a later change', () => {
  const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶' })))
  recorded(changes.record(make({ kind: 'change', text: '喜欢绿茶', effectiveAt: '2026-02-01T00:00:00Z' })))
  expect(currentAt('2026-01-15T00:00:00Z')?.text).toBe('喜欢红茶')
  expect(currentAt('2026-02-15T00:00:00Z')?.text).toBe('喜欢绿茶')
  expect(currentAt('2025-12-31T00:00:00Z')).toBeNull()
  expect(changes.history()).toHaveLength(2)
  expect(fact.evidenceEventIds).toEqual([evidence])
})

it('backdates a correction, keeps the source entry and evidence, and leaves a later change in effect', () => {
  const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶' })))
  const later = recorded(changes.record(make({ kind: 'change', text: '喜欢绿茶', effectiveAt: '2026-02-01T00:00:00Z' })))
  const correction = recorded(changes.record(make({ kind: 'correction', text: '喜欢乌龙茶',
    targetId: fact.id, effectiveAt: '2026-03-01T00:00:00Z', reason: '当时听错' })))
  expect(correction.effectiveAt).toBe(fact.effectiveAt)
  expect(currentAt('2026-01-15T00:00:00Z')?.text).toBe('喜欢乌龙茶')
  expect(currentAt('2026-02-15T00:00:00Z')?.text).toBe('喜欢绿茶')
  const history = changes.history({ personId: 'owner' })
  expect(history).toHaveLength(3)
  expect(history.find(change => change.id === fact.id)).toEqual(fact)
  expect(history.find(change => change.id === correction.id)).toMatchObject({ targetId: fact.id, evidenceEventIds: [evidence] })
  expect(history.find(change => change.id === later.id)?.text).toBe('喜欢绿茶')
})

it('follows chained corrections back to the same original period', () => {
  vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-05-01T00:00:00.000Z')
  const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶' })))
  const first = recorded(changes.record(make({ kind: 'correction', text: '喜欢乌龙茶', targetId: fact.id })))
  recorded(changes.record(make({ kind: 'correction', text: '喜欢黑茶', targetId: first.id, effectiveAt: '2026-05-01T00:00:00Z' })))
  expect(currentAt('2026-01-15T00:00:00Z')?.text).toBe('喜欢黑茶')
  vi.restoreAllMocks()
})

it('asks which scope applies when it is unclear and writes nothing', () => {
  const result = changes.record(make({ kind: 'change', text: '以后别提醒我', scope: 'unclear' }))
  expect(result).toEqual({ status: 'needs_clarification', question: '这个要求只适用于这次任务，还是以后都适用？' })
  expect(readdirSync(join(root, 'changes'))).toEqual([])
  expect(currentAt('2026-01-15T00:00:00Z')).toBeNull()
})

it('keeps a task-scoped value out of ongoing memory and other people', () => {
  recorded(changes.record(make({ kind: 'fact', text: '这次任务用红茶', scope: 'task', taskId: 't1' })))
  recorded(changes.record(make({ kind: 'fact', text: '以后用绿茶' })))
  recorded(changes.record(make({ kind: 'fact', text: '朋友用白茶', personId: 'friend' })))
  expect(changes.current({ personId: 'owner', property: 'drink', scope: 'task', taskId: 't1', at: '2026-01-15T00:00:00Z' })?.text)
    .toBe('这次任务用红茶')
  expect(currentAt('2026-01-15T00:00:00Z')?.text).toBe('以后用绿茶')
  expect(changes.current({ personId: 'friend', property: 'drink', scope: 'ongoing', at: '2026-01-15T00:00:00Z' })?.text)
    .toBe('朋友用白茶')
  expect(changes.current({ personId: 'owner', property: 'drink', scope: 'task', taskId: 't2', at: '2026-01-15T00:00:00Z' }))
    .toBeNull()
})

it('validates evidence, task scope and correction targets once at entry', () => {
  expect(() => changes.record(make({ kind: 'fact', text: '无证据', evidenceEventIds: [] }))).toThrow('evidence')
  expect(() => changes.record(make({ kind: 'fact', text: '假证据', evidenceEventIds: ['missing'] }))).toThrow()
  expect(() => changes.record(make({ kind: 'fact', text: '缺任务', scope: 'task' }))).toThrow('taskId')
  const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶' })))
  expect(() => changes.record(make({ kind: 'correction', text: '没有目标' }))).toThrow('targetId')
  expect(() => changes.record(make({ kind: 'correction', text: '目标不符', targetId: fact.id, personId: 'friend' })))
    .toThrow('match')
  expect(changes.history()).toHaveLength(1)
})

it('reads a reopened history and hand edits from disk', () => {
  const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶' })))
  const reopened = new MemoryChanges(root, new MemoryEvents(root))
  expect(reopened.current({ personId: 'owner', property: 'drink', scope: 'ongoing', at: '2026-01-15T00:00:00Z' })?.text)
    .toBe('喜欢红茶')
  const file = join(root, 'changes', fact.id + '.json')
  const saved = JSON.parse(readFileSync(file, 'utf8')) as MemoryChange
  saved.text = '喜欢白茶'
  writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
  expect(reopened.history()[0]?.text).toBe('喜欢白茶')
  expect(reopened.current({ personId: 'owner', property: 'drink', scope: 'ongoing', at: '2026-01-15T00:00:00Z' })?.text)
    .toBe('喜欢白茶')
  expect(reopened.history()[0]?.evidenceEventIds).toEqual([evidence])
})

describe('MemoryChanges.apply', () => {
  const seedCard = (text = '喜欢红茶') => people.save({ id: 'owner', name: '主人', description: '',
    requirements: [{ id: 'drink', text, eventIds: [evidence] }], relations: [] })
  const target = { get people() { return people }, get tasks() { return tasks } }

  it('writes one pending history before the card, then a reopened retry completes it', () => {
    seedCard()
    const input = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past }), operationId: 'op-card' }
    const failing = { read: (id: string) => people.read(id),
      save: (_card: Parameters<PersonCards['save']>[0]) => { throw new Error('disk full') } }
    expect(() => changes.apply(input, { people: failing, tasks })).toThrow('disk full')
    const files = readdirSync(join(root, 'changes'))
    expect(files).toHaveLength(1)
    const pending = JSON.parse(readFileSync(join(root, 'changes', files[0]!), 'utf8')) as MemoryChange
    expect(pending.application).toEqual({ status: 'pending', before: { id: 'drink', text: '喜欢红茶', eventIds: [evidence] },
      expected: { id: 'drink', text: '喜欢绿茶', eventIds: [evidence] } })
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢红茶', eventIds: [evidence] }])
    // Reopening reads the same one record and finishes it instead of writing a second history entry.
    const result = applied(new MemoryChanges(root, new MemoryEvents(root)).apply(input, { people, tasks }))
    expect(result.record.id).toBe(pending.id)
    expect(result.record.application).toEqual({ status: 'applied', before: { id: 'drink', text: '喜欢红茶', eventIds: [evidence] },
      expected: { id: 'drink', text: '喜欢绿茶', eventIds: [evidence] } })
    expect(result.current?.text).toBe('喜欢绿茶')
    expect(result.target).toMatchObject({ kind: 'person', id: 'owner', entry: { id: 'drink', text: '喜欢绿茶' } })
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢绿茶', eventIds: [evidence] }])
    expect(readdirSync(join(root, 'changes'))).toHaveLength(1)
  })

  it('finishes a pending record whose expected value the card already holds without writing it again', () => {
    seedCard()
    const input = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past }), operationId: 'op-written' }
    const first = applied(changes.apply(input, { people, tasks }))
    const file = join(root, 'changes', first.record.id + '.json')
    const saved = JSON.parse(readFileSync(file, 'utf8')) as MemoryChange
    saved.application = { ...saved.application!, status: 'pending' }
    writeFileSync(file, JSON.stringify(saved, null, 2) + '\n')
    let saves = 0
    const counted = { read: (id: string) => people.read(id),
      save: (card: Parameters<PersonCards['save']>[0]) => { saves += 1; return people.save(card) } }
    const result = applied(new MemoryChanges(root, new MemoryEvents(root)).apply(input, { people: counted, tasks }))
    expect(saves).toBe(0)
    expect(result.record.application?.status).toBe('applied')
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢绿茶', eventIds: [evidence] }])
    expect(readdirSync(join(root, 'changes'))).toHaveLength(1)
  })

  it('keeps a hand edit made while the operation was pending and marks it applied', () => {
    seedCard()
    const input = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past }), operationId: 'op-pending-manual' }
    const failing = { read: (id: string) => people.read(id),
      save: (_card: Parameters<PersonCards['save']>[0]) => { throw new Error('disk full') } }
    expect(() => changes.apply(input, { people: failing, tasks })).toThrow('disk full')
    const path = people.read('owner').path
    writeFileSync(path, readFileSync(path, 'utf8').replace('喜欢红茶', '喜欢白茶'), 'utf8')
    const result = applied(new MemoryChanges(root, new MemoryEvents(root)).apply(input, { people, tasks }))
    expect(result.record.application?.status).toBe('applied')
    expect(result.current?.text).toBe('喜欢绿茶')
    expect(result.target.entry?.text).toBe('喜欢白茶')
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢白茶', eventIds: [evidence] }])
    expect(readdirSync(join(root, 'changes'))).toHaveLength(1)
  })

  it('replays an applied operation without overwriting a hand edit and reports the actual file value', () => {
    seedCard()
    const input = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past }), operationId: 'op-applied' }
    const first = applied(changes.apply(input, { people, tasks }))
    const path = people.read('owner').path
    writeFileSync(path, readFileSync(path, 'utf8').replace('喜欢绿茶', '喜欢白茶'), 'utf8')
    const edited = readFileSync(path, 'utf8')
    const replay = applied(changes.apply(input, { people, tasks }))
    expect(readFileSync(path, 'utf8')).toBe(edited)
    expect(replay.record.id).toBe(first.record.id)
    expect(replay.current?.text).toBe('喜欢绿茶')
    expect(replay.target.entry?.text).toBe('喜欢白茶')
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢白茶', eventIds: [evidence] }])
    expect(readdirSync(join(root, 'changes'))).toHaveLength(1)
  })

  it('applies a task requirement as one managed note and never duplicates it', () => {
    people.save({ id: 'owner', name: '主人', description: '', requirements: [], relations: [] })
    tasks.save({ id: 't1', title: '交材料', plan: '', sources: [], todos: [], notes: [] })
    const input = { ...make({ kind: 'fact', text: '这次用中文', scope: 'task', taskId: 't1', effectiveAt: past }),
      operationId: 'op-task' }
    const first = applied(changes.apply(input, { people, tasks }))
    const note = tasks.read('t1').task.notes[0]!
    expect(note).toMatchObject({ id: 'memory:owner:drink', text: '这次用中文', recipient: 'owner', kind: 'agreement',
      sources: [{ kind: 'event', id: evidence }] })
    expect(note.createdAt).toBe(first.record.application?.expected?.createdAt)
    expect(first.target).toMatchObject({ kind: 'task', id: 't1', entry: { id: 'memory:owner:drink', text: '这次用中文' } })
    const replay = applied(changes.apply(input, { people, tasks }))
    expect(replay.record.id).toBe(first.record.id)
    expect(tasks.read('t1').task.notes).toHaveLength(1)
    expect(tasks.read('t1').task.notes[0]?.createdAt).toBe(note.createdAt)
    // A hand edit of the managed note survives a later replay of the same operation.
    const path = tasks.read('t1').path
    writeFileSync(path, readFileSync(path, 'utf8').replace('这次用中文', '这次用英文'), 'utf8')
    const afterEdit = applied(changes.apply(input, { people, tasks }))
    expect(afterEdit.target.entry?.text).toBe('这次用英文')
    expect(tasks.read('t1').task.notes).toHaveLength(1)
    expect(tasks.read('t1').task.notes[0]?.text).toBe('这次用英文')
    // A later operation for the same property replaces that one note and keeps its creation time.
    applied(changes.apply({ ...input, text: '之后用英文', operationId: 'op-task-2' }, { people, tasks }))
    const managed = tasks.read('t1').task.notes.filter(item => item.id === 'memory:owner:drink')
    expect(managed).toHaveLength(1)
    expect(managed[0]?.text).toBe('之后用英文')
    expect(managed[0]?.createdAt).toBe(note.createdAt)
  })

  it('applies a correction over a recorded fact/change chain without losing the later change', () => {
    people.save({ id: 'owner', name: '主人', description: '', requirements: [], relations: [] })
    const fact = recorded(changes.record(make({ kind: 'fact', text: '喜欢红茶', effectiveAt: past })))
    recorded(changes.record(make({ kind: 'change', text: '喜欢绿茶', effectiveAt: '2020-06-01T00:00:00Z' })))
    const correction = { ...make({ kind: 'correction', text: '喜欢乌龙茶', targetId: fact.id, effectiveAt: past }),
      operationId: 'op-correct-record' }
    const result = applied(changes.apply(correction, { people, tasks }))
    expect(result.current?.text).toBe('喜欢绿茶')
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢绿茶', eventIds: [evidence] }])
    expect(changes.current({ personId: 'owner', property: 'drink', scope: 'ongoing', at: '2020-03-01T00:00:00Z' })?.text)
      .toBe('喜欢乌龙茶')
  })

  it('keeps a future effective change out of the card while the history query still finds it', () => {
    seedCard()
    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString()
    const input = { ...make({ kind: 'change', text: '喜欢绿茶', effectiveAt: future }), operationId: 'op-future' }
    const result = applied(changes.apply(input, { people, tasks }))
    expect(result.current).toBeNull()
    expect(result.record.application).toEqual({ status: 'applied',
      before: { id: 'drink', text: '喜欢红茶', eventIds: [evidence] }, expected: null })
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢红茶', eventIds: [evidence] }])
    expect(changes.current({ personId: 'owner', property: 'drink', scope: 'ongoing', at: future })?.text).toBe('喜欢绿茶')
  })

  it('asks an unclear scope through apply without writing a record', () => {
    seedCard()
    const input = { ...make({ kind: 'change', text: '以后别提醒我', scope: 'unclear' }), operationId: 'op-unclear' }
    expect(changes.apply(input, target)).toEqual({ status: 'needs_clarification',
      question: '这个要求只适用于这次任务，还是以后都适用？' })
    expect(readdirSync(join(root, 'changes'))).toEqual([])
    expect(people.read('owner').card.requirements).toEqual([{ id: 'drink', text: '喜欢红茶', eventIds: [evidence] }])
  })

  it('validates evidence and the destination before writing any journal', () => {
    const missingCard = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past }), operationId: 'op-no-card' }
    expect(() => changes.apply(missingCard, target)).toThrow()
    expect(readdirSync(join(root, 'changes'))).toEqual([])
    seedCard()
    const missingEvidence = { ...make({ kind: 'fact', text: '喜欢绿茶', effectiveAt: past,
      evidenceEventIds: ['missing'] }), operationId: 'op-no-evidence' }
    expect(() => changes.apply(missingEvidence, target)).toThrow()
    const missingTask = { ...make({ kind: 'fact', text: '这次用中文', scope: 'task', effectiveAt: past }),
      operationId: 'op-no-task' }
    expect(() => changes.apply(missingTask, target)).toThrow('taskId')
    const missingCorrection = { ...make({ kind: 'correction', text: '喜欢绿茶', targetId: 'missing', effectiveAt: past }),
      operationId: 'op-no-correction-target' }
    expect(() => changes.apply(missingCorrection, target)).toThrow()
    expect(readdirSync(join(root, 'changes'))).toEqual([])
  })
})
