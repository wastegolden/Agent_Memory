/** Confirmed experiences: a tentative short-term lesson becomes a lasting record only on a real final fact, by entry and by archive. */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket } from '../../src/core/ports/ticket-model.ts'
import { MemoryEvents } from '../../src/core/events.ts'
import { Experiences, type ExperienceView, type JudgeExperienceResult } from '../../src/core/experiences.ts'
import { MemoryIndex } from '../../src/core/index.ts'
import { ProjectArchives } from '../../src/core/project-archives.ts'
import { ShortTerm } from '../../src/core/short-term.ts'
import { MemoryStore } from '../../src/core/store.ts'
import { TaskLists } from '../../src/core/task-lists.ts'
import { TaskReduction } from '../../src/core/task-reduction.ts'

let root: string
let index: MemoryIndex
let events: MemoryEvents
let tasks: TaskLists
let shortTerm: ShortTerm
let experiences: Experiences
let seq: number
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'memory-experiences-'))
  index = new MemoryIndex(root, { memory: true })
  events = new MemoryEvents(root, index)
  tasks = new TaskLists(root, () => undefined, index)
  shortTerm = new ShortTerm(root, tasks)
  experiences = new Experiences(root, shortTerm, events)
  seq = 0
})
afterEach(() => {
  index.close()
  rmSync(root, { recursive: true, force: true })
})

const stamp = (): string => `2026-09-09T00:00:${String(++seq).padStart(2, '0')}.000Z`
const user = (id: string, text = `消息 ${id}`) =>
  events.record({ kind: 'user', at: stamp(), text, source: { kind: 'web-message', id } })
const ticketEnded = (taskId: string, id: string) => {
  const at = stamp()
  const payload = { type: 'ticket.ended', data: { ticketId: taskId, by: 'executor', outcome: 'completed' } }
  return events.record({ kind: 'worker', at, text: JSON.stringify(payload),
    source: { kind: 'engine-event', id: JSON.stringify([payload.type, at, payload.data]) }, taskId })
}
const workerReport = (taskId: string, id: string) =>
  events.record({ kind: 'worker', at: stamp(), text: '工具成功', source: { kind: 'worker-report', id }, taskId })
const jarvis = (id: string) =>
  events.record({ kind: 'jarvis', at: stamp(), text: '已派工', source: { kind: 'activity', id } })
const confirmed = (result: JudgeExperienceResult): ExperienceView => {
  if (result.status !== 'confirmed') throw new Error('Expected a confirmed experience')
  return result.experience
}
const itemIndex = (): Record<string, Record<string, unknown>> => {
  const path = join(root, 'short-term', 'item-index.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>> : {}
}
const endedTicket = (id: string): Ticket => ({
  id,
  title: `任务 ${id}`,
  decisionId: `decision-${id}`,
  mandate: { strength: 'explicit', policyVersion: 'test', actor: { source: 'feishu', id: 'ou_alice' },
    scope: '测试范围', basis: { via: 'listed', sender: 'ou_alice' } },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: '2026-09-09T00:00:00.000Z',
  updatedAt: '2026-09-09T00:00:00.000Z',
  origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] },
  ended: { at: '2026-09-09T00:00:00.000Z', by: 'executor', outcome: 'completed' },
})

it('promotes a standalone tentative experience and removes only its own Markdown and index rows', () => {
  const source = user('u1')
  const final = user('u2')
  const neighbour = experiences.tentative({ text: '另一条待确认', eventIds: [source.id] })
  const item = experiences.tentative({ text: '独立经验', eventIds: [source.id], methodVersion: 'm2' })
  expect(item).toMatchObject({ kind: 'experience', text: '独立经验', methodVersion: 'm2',
    sources: [{ kind: 'event', id: source.id }], owner: { kind: 'item', id: item.id } })
  expect(readFileSync(item.path, 'utf8')).toContain('methodVersion: "m2"')

  expect(experiences.judge({ id: item.id, confidence: 'tentative', reason: '证据不足', finalEventIds: [] }))
    .toMatchObject({ status: 'tentative', item: { id: item.id, text: '独立经验' } })
  expect(existsSync(item.path)).toBe(true)

  const confirmedView = confirmed(experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id],
    reason: '用户确认', methodVersion: 'judge-must-not-overwrite' }))
  expect(confirmedView).toMatchObject({ id: item.id, text: '独立经验', eventIds: [source.id],
    finalEventIds: [final.id], reason: '用户确认', methodVersion: 'm2', origin: 'inferred', history: [] })
  expect(confirmedView.path).toBe(join(root, 'experiences', item.id + '.json'))
  expect(existsSync(item.path)).toBe(false)
  expect(() => shortTerm.read(item.id)).toThrow()
  expect(shortTerm.list().map(view => view.id)).toEqual([neighbour.id])
  expect(experiences.list().map(view => view.id)).toEqual([item.id])
  expect(events.index.usedBy('event', source.id)).toContainEqual({ kind: 'experiences', id: item.id })
  expect(events.index.usedBy('event', final.id)).toContainEqual({ kind: 'experiences', id: item.id })
})

it('promotes a task-bound experience against its matching ticket.ended and keeps neighbouring todos and notes', () => {
  const source = user('u1')
  const final = ticketEnded('t1', 'engine-1')
  tasks.save({ id: 't1', title: '任务', plan: '计划', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [{ id: 'note-1', text: '邻居便签' }] })
  const item = experiences.tentative({ text: '任务经验', eventIds: [source.id], taskId: 't1' })
  expect(readFileSync(tasks.read('t1').path, 'utf8')).toContain('"methodVersion":"builtin-v1"')

  const confirmedView = confirmed(experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [final.id], reason: '任务结束' }))
  expect(confirmedView).toMatchObject({ id: item.id, methodVersion: 'builtin-v1', origin: 'inferred',
    finalEventIds: [final.id] })
  const after = tasks.read('t1').task
  expect(after.notes.map(note => note.id)).toEqual(['note-1'])
  expect(after.todos.map(todo => todo.id)).toEqual(['todo-1'])
  expect(after.sources).toEqual([{ kind: 'feishu', id: 'm1' }])
  expect(existsSync(join(tasks.root, 't1.md'))).toBe(true)
  expect(shortTerm.read('note-1')).toMatchObject({ text: '邻居便签', owner: { kind: 'task', taskId: 't1' } })
  expect(() => shortTerm.read(item.id)).toThrow()
})

it('refuses high confidence without a real final fact and rejects a mismatched worker task', () => {
  const source = user('u1')
  tasks.save({ id: 't1', title: '任务', plan: '', sources: [], todos: [], notes: [] })
  const item = experiences.tentative({ text: '待确认', eventIds: [source.id], taskId: 't1' })
  expect(() => experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [], reason: '空' }))
    .toThrow(/final/)
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [workerReport('t1', 'r1').id], reason: '普通工具成功' })).toThrow(/final/)
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [jarvis('j1').id], reason: '普通事实' })).toThrow(/final/)
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [ticketEnded('t2', 'engine-2').id], reason: '别的任务' })).toThrow(/task/)
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: ['missing-event'], reason: '不存在' })).toThrow()
  expect(shortTerm.read(item.id).text).toBe('待确认')
  expect(experiences.list()).toEqual([])

  const final = user('u2')
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [final.id, workerReport('t1', 'r2').id], reason: '混入报告' })).toThrow(/final/)
  expect(() => experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [final.id, jarvis('j2').id], reason: '混入过程记录' })).toThrow(/final/)
  expect(experiences.list()).toEqual([])
  expect(confirmed(experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id],
    reason: '用户确认' })).id).toBe(item.id)
})

it('rebuilds every source, final and correction reference from the saved experience after reopening', () => {
  const sources = [user('s1'), user('s2')]
  const finals = [ticketEnded('t1', 'f1'), user('f2')]
  const corrections = [user('c1'), user('c2')]
  const item = experiences.tentative({ text: '原文', eventIds: sources.map(event => event.id), methodVersion: 'trial-v4' })
  experiences.judge({ id: item.id, confidence: 'high', finalEventIds: finals.map(event => event.id), reason: '最终确认' })
  experiences.correct({ id: item.id, text: '修订一', eventId: corrections[0]!.id, reason: '第一次' })
  experiences.correct({ id: item.id, text: '修订二', eventId: corrections[1]!.id, reason: '第二次' })
  index.remove('experiences', item.id)
  const reopened = new Experiences(root, new ShortTerm(root, new TaskLists(root, () => undefined, index)), events)
  expect(reopened.read(item.id)).toMatchObject({ text: '修订二', methodVersion: 'trial-v4',
    eventIds: sources.map(event => event.id), finalEventIds: finals.map(event => event.id),
    history: [{ text: '原文', eventId: corrections[0]!.id }, { text: '修订一', eventId: corrections[1]!.id }] })
  events.store.get('experiences', item.id)
  for (const event of [...sources, ...finals, ...corrections]) {
    expect(index.usedBy('event', event.id)).toContainEqual({ kind: 'experiences', id: item.id })
  }
})

it('records direct user teaching and one correction, keeping method version, sources and revision references', () => {
  const teach = user('u1', '以后先跑测试')
  const corrected = user('u2', '还要跑类型检查')
  const direct = experiences.direct({ text: '先跑测试', eventId: teach.id, methodVersion: 'teach-v1' })
  expect(direct).toMatchObject({ origin: 'user', eventIds: [teach.id], finalEventIds: [],
    methodVersion: 'teach-v1', reason: 'direct', history: [] })
  const other = experiences.direct({ text: '另一条', eventId: user('u3').id })

  const revised = experiences.correct({ id: direct.id, text: '先跑测试和类型检查',
    eventId: corrected.id, reason: '用户补充' })
  expect(revised).toMatchObject({ id: direct.id, text: '先跑测试和类型检查', eventIds: [teach.id],
    finalEventIds: [], methodVersion: 'teach-v1', origin: 'user' })
  expect(revised.history).toEqual([{ at: expect.any(String), text: '先跑测试',
    eventId: corrected.id, reason: '用户补充' }])
  expect(experiences.read(other.id).text).toBe('另一条')
  expect(experiences.list().map(view => view.id).sort()).toEqual([direct.id, other.id].sort())
  expect(events.index.usedBy('event', teach.id)).toContainEqual({ kind: 'experiences', id: direct.id })
  expect(events.index.usedBy('event', corrected.id)).toContainEqual({ kind: 'experiences', id: direct.id })
  expect(() => experiences.correct({ id: direct.id, text: 'x', eventId: workerReport('t1', 'r2').id,
    reason: 'x' })).toThrow(/user/)
  expect(experiences.read(direct.id).methodVersion).toBe('teach-v1')

  const reopened = new Experiences(root, shortTerm, events)
  expect(reopened.read(direct.id).history).toEqual(revised.history)
  expect(reopened.read(direct.id).methodVersion).toBe('teach-v1')
  expect(() => experiences.direct({ text: 'x', eventId: jarvis('j2').id })).toThrow(/user/)
})

it('removes a promoted note from a project archive bundle and restores without reviving it', () => {
  const source = user('u1')
  const final = user('u2')
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [],
    todos: [{ id: 'todo-p', text: '项目待办', done: false }], notes: [{ id: 'note-p', text: '项目便签' }] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [{ id: 'note-1', text: '邻居便签' }] })
  const item = experiences.tentative({ text: '归档经验', eventIds: [source.id], taskId: 't1', methodVersion: 'archive-v1' })
  const archives = new ProjectArchives(root, tasks)
  const meta = archives.archive('p', ['p', 't1'], 'paused')
  expect(shortTerm.read(item.id)).toMatchObject({ methodVersion: 'archive-v1',
    owner: { kind: 'archive', archiveId: meta.archiveId } })

  const confirmedView = confirmed(experiences.judge({ id: item.id, confidence: 'high',
    finalEventIds: [final.id], reason: '用户确认' }))
  expect(confirmedView.methodVersion).toBe('archive-v1')
  const bundle = archives.read(meta.archiveId).bundle
  expect(bundle.tasks.find(task => task.taskId === 'p')!.todos.map(todo => todo.id)).toEqual(['todo-p'])
  const archived = bundle.tasks.find(task => task.taskId === 't1')!
  expect(archived.notes.map(note => note.id)).toEqual(['note-1'])
  expect(archived.todos.map(todo => todo.id)).toEqual(['todo-1'])
  expect(itemIndex()[item.id]).toBeUndefined()
  expect(events.index.get('short-term', item.id)).toBeUndefined()
  expect(() => shortTerm.read(item.id)).toThrow()

  expect(archives.restore(meta.archiveId).restored).toBe(true)
  expect(tasks.read('t1').task.notes.map(note => note.id)).toEqual(['note-1'])
  expect(tasks.read('p').task.todos.map(todo => todo.id)).toEqual(['todo-p'])
  expect(() => shortTerm.read(item.id)).toThrow()
  expect(shortTerm.read('note-1')).toMatchObject({ owner: { kind: 'task', taskId: 't1' } })
})

it('removes one promoted note from a reduced project archive, keeping reduced history and neighbours', () => {
  const source = user('u1')
  const final = user('u2')
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '', sources: [], todos: [{ id: 'todo-1', text: '检查', done: false }],
    notes: [
      { id: 'keep-1', text: '重复约定', kind: 'agreement', sources: [{ kind: 'event', id: source.id }] },
      { id: 'keep-2', text: '重复约定', kind: 'agreement', sources: [{ kind: 'event', id: source.id }] },
    ] })
  const item = experiences.tentative({ text: '待提升经验', eventIds: [source.id], taskId: 't1' })
  const reduced = shortTerm.reduce()
  expect(reduced.archivedIds).toHaveLength(1)
  const duplicateId = reduced.archivedIds[0]!
  const archives = new ProjectArchives(root, tasks)
  const meta = archives.archive('p', ['p', 't1'], 'closed')
  const before = archives.read(meta.archiveId).bundle
  expect(before.reducedItems?.map(entry => entry.id)).toEqual([duplicateId])

  confirmed(experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id], reason: '用户确认' }))
  const after = archives.read(meta.archiveId).bundle
  expect(after.reducedItems).toEqual(before.reducedItems)
  const archived = after.tasks.find(task => task.taskId === 't1')!
  expect(archived.notes).toHaveLength(1)
  expect(archived.notes[0]).toMatchObject({ kind: 'agreement', text: '重复约定' })
  expect(archived.notes.some(note => note.id === item.id)).toBe(false)
  expect(archived.todos.map(todo => todo.id)).toEqual(['todo-1'])
  expect(() => shortTerm.read(item.id)).toThrow()

  expect(archives.restore(meta.archiveId).restored).toBe(true)
  const restored = tasks.read('t1').task
  expect(restored.notes).toHaveLength(1)
  expect(restored.notes[0]).toMatchObject({ kind: 'agreement', text: '重复约定' })
  expect(restored.todos.map(todo => todo.id)).toEqual(['todo-1'])
  expect(() => shortTerm.read(item.id)).toThrow()
  // The reduced duplicate remains archived history, not a revived valid entry.
  expect(shortTerm.read(duplicateId)).toMatchObject({ owner: { kind: 'archive', entryId: duplicateId } })
})

it('empties a reduced item-* history record into a promoted container without the tentative body', () => {
  const source = user('u1')
  const final = user('u2')
  const task = tasks.save({ id: 't1', title: '任务', plan: '', sources: [], todos: [], notes: [] })
  const item = experiences.tentative({ text: '会被归档的经验', eventIds: [source.id], taskId: task.id })
  const replacement = experiences.tentative({ text: '保留的经验', eventIds: [source.id], taskId: task.id })
  shortTerm.reduce({ superseded: [{ id: item.id, by: replacement.id }] })
  const archivedView = shortTerm.read(item.id)
  expect(archivedView).toMatchObject({ owner: { kind: 'archive', archiveId: expect.stringMatching(/^item-/) } })
  const archiveId = (archivedView.owner as { archiveId: string }).archiveId

  confirmed(experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id], reason: '用户确认' }))
  const container = JSON.parse(new MemoryStore(root).get('tasks', archiveId).content) as Record<string, unknown>
  expect(container).toMatchObject({ reason: 'superseded', replacedBy: replacement.id, promotedTo: item.id })
  expect(container.item).toBeUndefined()
  expect(itemIndex()[item.id]).toBeUndefined()
  expect(events.index.get('short-term', item.id)).toBeUndefined()
  expect(() => shortTerm.read(item.id)).toThrow()
  expect(shortTerm.read(replacement.id).text).toBe('保留的经验')
})

it('removes only the promoted reduced experience from the current project bundle and its item archive', () => {
  const source = user('u1')
  const final = user('u2')
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '', sources: [], todos: [], notes: [] })
  const item = experiences.tentative({ text: '旧经验', eventIds: [source.id], taskId: 't1', methodVersion: 'reduced-v2' })
  const other = experiences.tentative({ text: '另一旧经验', eventIds: [source.id], taskId: 't1' })
  const replacement = experiences.tentative({ text: '新经验', eventIds: [source.id], taskId: 't1' })
  shortTerm.reduce({ superseded: [{ id: item.id, by: replacement.id }, { id: other.id, by: replacement.id }] })
  const archiveId = itemIndex()[item.id]!.archiveId as string
  const archives = new ProjectArchives(root, tasks)
  const meta = archives.archive('p', ['p', 't1'], 'paused')
  const neighbour = archives.read(meta.archiveId).bundle.reducedItems!.find(entry => entry.id === other.id)
  expect(archives.read(meta.archiveId).bundle.reducedItems!.some(entry => entry.id === item.id)).toBe(true)
  expect(confirmed(experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id],
    reason: '用户确认' })).methodVersion).toBe('reduced-v2')
  expect(archives.read(meta.archiveId).bundle.reducedItems).toEqual([neighbour])
  expect(JSON.parse(events.store.get('tasks', archiveId).content)).toMatchObject({
    promotedTo: item.id, reason: 'superseded', replacedBy: replacement.id,
  })
  expect(archives.restore(meta.archiveId).restored).toBe(true)
  const reopened = new ShortTerm(root, new TaskLists(root, () => undefined, index))
  reopened.reconcile()
  expect(() => reopened.read(item.id)).toThrow()
  expect(reopened.read(other.id).text).toBe('另一旧经验')
  expect(reopened.read(replacement.id).text).toBe('新经验')
})

it.each(['archived', 'restored'] as const)('does not revive an experience promoted while %s on the next archive/restore', phase => {
  tasks = new TaskLists(root, id => id === 't1' ? endedTicket(id) : undefined, index)
  shortTerm = new ShortTerm(root, tasks)
  experiences = new Experiences(root, shortTerm, events)
  const source = user('u1')
  const final = user('u2')
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '原计划', sources: [],
    todos: [{ id: 'done', text: '已完成', done: true }], notes: [{ id: 'keep', text: '保留便签' }] })
  const item = experiences.tentative({ text: '旧减量中的经验', eventIds: [source.id], taskId: 't1' })
  new TaskReduction(root, tasks).reduce()
  const archives = new ProjectArchives(root, tasks)
  const first = archives.archive('p', ['p', 't1'], 'paused')
  if (phase === 'restored') expect(archives.restore(first.archiveId).restored).toBe(true)
  experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id], reason: '用户确认' })
  if (phase === 'archived') expect(archives.restore(first.archiveId).restored).toBe(true)
  const reduction = JSON.parse(events.store.get('tasks', 'task-t1').content) as { notes: { id: string }[] }
  expect(reduction.notes.map(note => note.id)).toEqual(['keep'])
  const next = archives.archive('p', ['p', 't1'], 'paused')
  expect(archives.read(next.archiveId).bundle.tasks.find(task => task.taskId === 't1')!.notes.map(note => note.id))
    .toEqual(['keep'])
  expect(archives.restore(next.archiveId).restored).toBe(true)
  const reopened = new ShortTerm(root, new TaskLists(root, () => undefined, index))
  reopened.reconcile()
  expect(() => reopened.read(item.id)).toThrow()
  expect(reopened.read('keep').text).toBe('保留便签')
  expect(reopened.read('done').text).toBe('已完成')
})

it('removes a promoted note from a TaskReduction archive while keeping its other notes and todos', () => {
  const localRoot = mkdtempSync(join(tmpdir(), 'memory-experiences-reduction-'))
  const localEvents = new MemoryEvents(localRoot)
  try {
    const ended = endedTicket('t1')
    const localTasks = new TaskLists(localRoot, id => id === 't1' ? ended : undefined, localEvents.index)
    const localShortTerm = new ShortTerm(localRoot, localTasks)
    const localExperiences = new Experiences(localRoot, localShortTerm, localEvents)
    const source = localEvents.record({ kind: 'user', at: '2026-09-09T00:00:00.000Z', text: '来源',
      source: { kind: 'web-message', id: 'u1' } })
    const final = localEvents.record({ kind: 'user', at: '2026-09-09T00:00:01.000Z', text: '确认',
      source: { kind: 'web-message', id: 'u2' } })
    localTasks.save({ id: 't1', title: '任务', plan: '完整计划', sources: [],
      todos: [{ id: 'done-1', text: '已完成', done: true }], notes: [{ id: 'note-1', text: '邻居便签' }] })
    const item = localExperiences.tentative({ text: '折叠经验', eventIds: [source.id], taskId: 't1',
      methodVersion: 'fold-v1' })

    new TaskReduction(localRoot, localTasks).reduce()
    expect(localShortTerm.read(item.id)).toMatchObject({ methodVersion: 'fold-v1',
      owner: { kind: 'archive', archiveId: 'task-t1' } })
    const confirmedView = confirmed(localExperiences.judge({ id: item.id, confidence: 'high',
      finalEventIds: [final.id], reason: '用户确认' }))
    expect(confirmedView.methodVersion).toBe('fold-v1')

    const stored = JSON.parse(localEvents.store.get('tasks', 'task-t1').content) as
      { notes: { id: string }[]; todos: { id: string }[] }
    expect(stored.notes.map(note => note.id)).toEqual(['note-1'])
    expect(stored.todos.map(todo => todo.id)).toEqual(['done-1'])
    expect(() => localShortTerm.read(item.id)).toThrow()
    expect(localShortTerm.read('note-1')).toMatchObject({ owner: { kind: 'archive', archiveId: 'task-t1' } })
  } finally {
    localEvents.index.close()
    rmSync(localRoot, { recursive: true, force: true })
  }
})
