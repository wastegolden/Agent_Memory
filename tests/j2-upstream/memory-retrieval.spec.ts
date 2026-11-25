import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { retrievalTools } from '../../src/core/adapters/retrieval.ts'
import type { Ticket } from '../../src/core/ports/ticket-model.ts'
import { Documents } from '../../src/core/documents.ts'
import { MemoryEvents, type MemoryEvent } from '../../src/core/events.ts'
import { Experiences, type ExperienceView, type JudgeExperienceResult } from '../../src/core/experiences.ts'
import { MemoryIndex } from '../../src/core/index.ts'
import { PersonCards } from '../../src/core/people.ts'
import { MemoryRetrieval, type ReopenedSelection, type RetrievalQuery } from '../../src/core/retrieval.ts'
import { ShortTerm, type ShortTermView } from '../../src/core/short-term.ts'
import type { MemoryRecord } from '../../src/core/store.ts'
import { TaskLists } from '../../src/core/task-lists.ts'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const original = (path: string, text: string): string => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text, 'utf8')
  return path
}
/** The confirmed experience behind one high-confidence review. */
const confirmed = (result: JudgeExperienceResult): ExperienceView => {
  if (result.status !== 'confirmed') throw new Error('Expected a confirmed experience')
  return result.experience
}

/** The smallest Ticket the Engine card joins need: an open ticket with a mandate and an origin. */
const ticket = (id: string, title: string, extra: Partial<Ticket> = {}): Ticket => ({
  id, title, decisionId: `decision-${id}`,
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'web', id: 'owner' }, scope: '' },
  channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  ...extra,
} as unknown as Ticket)

interface Fixtures {
  p1CardPath: string
  p1Event: MemoryEvent
  p2Event: MemoryEvent
  t1Event: MemoryEvent
  t2Event: MemoryEvent
  projectEvent: MemoryEvent
  p1Term: ShortTermView
  p2Term: ShortTermView
  t1Term: ShortTermView
  t2Term: ShortTermView
  unboundTerm: ShortTermView
  budget: MemoryRecord
  budgetPath: string
  other: MemoryRecord
  experience: MemoryRecord
  archiveT1: MemoryRecord
  archiveT2: MemoryRecord
}

let directory: string
let root: string
let index: MemoryIndex
let events: MemoryEvents
let tasks: TaskLists
let shortTerm: ShortTerm
let documents: Documents
let people: PersonCards
let retrieval: MemoryRetrieval
let f: Fixtures

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-retrieval-'))
  root = join(directory, '记忆', 'memory')
  index = new MemoryIndex(root)
  events = new MemoryEvents(root, index)
  const project = ticket('proj-1', '项目一', { stages: [{ id: 'stage-1', title: '阶段一' }] })
  const child = ticket('child-1', '子任务一', { project: { ticketId: 'proj-1' } })
  const otherChild = ticket('child-2', '子任务二', { project: { ticketId: 'proj-2' } })
  const tickets = new Map<string, Ticket>()
  for (const item of [project, child, otherChild]) tickets.set(item.id, item)
  tasks = new TaskLists(root, id => tickets.get(id), index)
  for (const item of [project, child, otherChild]) tasks.ensure(item)
  tasks.save({ id: 't1', title: '任务一', plan: '只做任务一', sources: [{ kind: 'trigger', id: 'trigger-1' }], todos: [], notes: [] })
  tasks.save({ id: 't2', title: '任务二', plan: '只做任务二', sources: [{ kind: 'trigger', id: 'trigger-2' }], todos: [], notes: [] })
  const p1Event = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '小林说他更关注预算。',
    source: { kind: 'web-message', id: 'm-p1' }, personIds: ['p1'] })
  const p2Event = events.record({ kind: 'user', at: '2026-11-10T00:00:01Z', text: '小王说他更关注排期。',
    source: { kind: 'web-message', id: 'm-p2' }, personIds: ['p2'] })
  const t1Event = events.record({ kind: 'worker', at: '2026-11-10T00:00:02Z', text: '任务一构建通过。',
    source: { kind: 'worker-report', id: 'r-t1' }, taskId: 't1' })
  const t2Event = events.record({ kind: 'worker', at: '2026-11-10T00:00:03Z', text: '任务二构建通过。',
    source: { kind: 'worker-report', id: 'r-t2' }, taskId: 't2' })
  const projectEvent = events.record({ kind: 'worker', at: '2026-11-10T00:00:04Z', text: '项目一的阶段总结。',
    source: { kind: 'worker-report', id: 'r-proj-1' }, projectId: 'proj-1' })
  people = new PersonCards(root, events)
  people.save({ id: 'p1', name: '小林', description: '负责预算的小林。',
    requirements: [{ id: 'req-1', text: '预算优先', eventIds: [p1Event.id] }], relations: [] })
  people.save({ id: 'p2', name: '小王', description: '负责排期的小王。',
    requirements: [{ id: 'req-2', text: '排期优先', eventIds: [p2Event.id] }], relations: [] })
  shortTerm = new ShortTerm(root, tasks)
  const p1Term = shortTerm.remember({ kind: 'agreement', text: '给小林的预算说明。', recipient: 'p1',
    sources: [{ kind: 'web-message', id: 'm-p1' }] })
  const p2Term = shortTerm.remember({ kind: 'agreement', text: '给小王的排期说明。', recipient: 'p2',
    sources: [{ kind: 'web-message', id: 'm-p2' }] })
  const t1Term = shortTerm.remember({ kind: 'agreement', text: '任务一的便签。', taskId: 't1',
    sources: [{ kind: 'trigger', id: 'trigger-1' }] })
  const t2Term = shortTerm.remember({ kind: 'agreement', text: '任务二的约定。', taskId: 't2',
    sources: [{ kind: 'trigger', id: 'trigger-2' }] })
  const unboundTerm = shortTerm.remember({ kind: 'experience', text: '未绑定经验。', sources: [] })
  documents = new Documents(root, index)
  const budgetPath = original(join(directory, '资料', '预算.md'), '预算正文第一版。')
  const budget = documents.indexFile(budgetPath, 'formal')
  const other = documents.indexFile(original(join(directory, '资料', '排期.md'), '排期正文。'), 'internal')
  const experience = events.store.put('experiences', { id: 'exp-1', source: { kind: 'ticket', id: 't9' }, content: '预算审批的经验。' })
  events.store.put('experiences', { id: 'exp-2', source: { kind: 'ticket', id: 't10' }, content: '无关经验。' })
  const archiveT1 = events.store.put('tasks', { id: 'archive-t1', source: { kind: 'task', id: 't1' },
    content: `${JSON.stringify({ task: { id: 't1', title: '任务一', plan: '只做任务一' } }, null, 2)}\n` })
  const archiveT2 = events.store.put('tasks', { id: 'archive-t2', source: { kind: 'task', id: 't2' },
    content: `${JSON.stringify({ taskId: 't2', title: '任务二' }, null, 2)}\n` })
  const p1CardPath = join(root, 'people', 'p1.md')
  retrieval = new MemoryRetrieval(root, { events, people, shortTerm, tasks, documents })
  f = { p1CardPath, p1Event, p2Event, t1Event, t2Event, projectEvent, p1Term, p2Term, t1Term, t2Term, unboundTerm,
    budget, budgetPath, other, experience, archiveT1, archiveT2 }
})

afterEach(() => { index.close(); rmSync(directory, { recursive: true, force: true }) })

describe('retrieval scope', () => {
  it('selects only the requested person, their evidence and recipient records, and saves real reasons, sources and versions', () => {
    const selection = retrieval.retrieve({ personIds: ['p1'], reason: '准备与小林的会议' })
    expect(selection.id).not.toBe('')
    expect(Number.isFinite(Date.parse(selection.at))).toBe(true)
    expect(selection.query).toEqual({ personIds: ['p1'], reason: '准备与小林的会议' })
    const person = selection.items.find(item => item.kind === 'person')!
    expect(person).toMatchObject({ id: 'p1', version: sha256(readFileSync(f.p1CardPath, 'utf8')), path: f.p1CardPath })
    expect(person.sources).toEqual([{ kind: 'person', id: 'p1', path: f.p1CardPath }, { kind: 'event', id: f.p1Event.id }])
    expect(person.text).toContain('预算优先')
    const event = selection.items.find(item => item.kind === 'event')!
    expect(selection.items.filter(item => item.kind === 'event')).toHaveLength(1)
    expect(event).toMatchObject({ id: f.p1Event.id, text: '小林说他更关注预算。', version: events.get(f.p1Event.id).version,
      sources: [events.get(f.p1Event.id).source] })
    const term = selection.items.find(item => item.kind === 'short-term')!
    expect(term).toMatchObject({ id: f.p1Term.id, text: '给小林的预算说明。', version: shortTerm.read(f.p1Term.id).version,
      sources: f.p1Term.sources })
    // The scope stays on p1: no p2 records, no unrelated task, project, document or archive records.
    expect(selection.items.some(item => item.id === 'p2' || item.id === f.p2Event.id || item.id === f.p2Term.id)).toBe(false)
    expect(selection.items.some(item => item.id === 't1' || item.id === 't2' || item.id === 'proj-1')).toBe(false)
    expect(selection.items.every(item => item.kind === 'person' || item.kind === 'event' || item.kind === 'short-term')).toBe(true)
    expect(selection.items.every(item => item.reason.includes('准备与小林的会议'))).toBe(true)
    expect(person.reason).toContain('personIds')
    expect(event.reason).toContain('personIds')
    expect(term.reason).toContain('recipient')
    expect(JSON.parse(readFileSync(join(root, 'selections', `${selection.id}.json`), 'utf8'))).toEqual(selection)
  })

  it('selects only the requested task across its list, short-term records, events and archived task', () => {
    const selection = retrieval.retrieve({ taskIds: ['t1'], reason: '继续任务一' })
    const task = selection.items.find(item => item.kind === 'task')!
    expect(task).toMatchObject({ id: 't1', version: tasks.read('t1').version, sources: tasks.read('t1').task.sources,
      path: tasks.read('t1').path })
    expect(selection.items.filter(item => item.kind === 'task')).toHaveLength(1)
    const term = selection.items.find(item => item.kind === 'short-term')!
    expect(term).toMatchObject({ id: f.t1Term.id, version: shortTerm.read(f.t1Term.id).version, sources: f.t1Term.sources })
    const event = selection.items.find(item => item.kind === 'event')!
    expect(event).toMatchObject({ id: f.t1Event.id, version: events.get(f.t1Event.id).version, sources: [events.get(f.t1Event.id).source] })
    const archive = selection.items.find(item => item.kind === 'archive')!
    const archived = events.store.get('tasks', 'archive-t1')
    expect(archive).toMatchObject({ id: 'archive-t1', text: archived.content, version: archived.version, sources: [archived.source] })
    expect(selection.items.some(item => item.id === 't2' || item.id === f.t2Event.id || item.id === f.t2Term.id)).toBe(false)
    expect(selection.items.some(item => item.id === 'archive-t2' || item.id === f.p1Event.id)).toBe(false)
    expect(task.reason).toContain('taskIds')
    expect(term.reason).toContain('taskId')
    expect(event.reason).toContain('taskId')
    expect(archive.reason).toContain('归档')
  })

  it('selects a project task, its runtime project children and its events, not other tasks', () => {
    const note = shortTerm.remember({ kind: 'agreement', taskId: 'child-1', text: '子任务待用材料', sources: [] })
    const childEvent = events.record({ kind: 'worker', at: '2026-11-10T01:00:00Z', text: '子任务报告',
      taskId: 'child-1', source: { kind: 'worker-report', id: 'child-report' } })
    const archive = events.store.put('tasks', { id: 'child-archive', source: { kind: 'task', id: 'child-1' }, content: '子任务归档原文' })
    const selection = retrieval.retrieve({ projectId: 'proj-1', reason: '项目一周报' })
    expect(selection.items.filter(item => item.kind === 'task').map(item => item.id).sort()).toEqual(['child-1', 'proj-1'])
    expect(selection.items.filter(item => item.kind === 'event').map(item => item.id).sort())
      .toEqual([f.projectEvent.id, childEvent.id].sort())
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'short-term', id: note.id }))
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'archive', id: archive.id, text: '子任务归档原文' }))
    expect(selection.items.some(item => item.id === 't1' || item.id === 't2' || item.id === 'child-2')).toBe(false)
    expect(selection.items.find(item => item.id === 'child-1')!.reason).toContain('project_id')
    expect(selection.items.find(item => item.id === 'proj-1')!.reason).toContain('projectId')
    expect(selection.items.every(item => item.reason.includes('项目一周报'))).toBe(true)
  })

  it('checks every source, final and correction event before a confirmed experience enters a project-scoped search', () => {
    const experiences = new Experiences(root, shortTerm, events)
    const scoped = new MemoryRetrieval(root, { events, people, shortTerm, tasks, documents, experiences })
    const projectSource = events.record({ kind: 'worker', at: '2026-11-10T06:00:00Z', text: '项目一经验来源。',
      source: { kind: 'worker-report', id: 'r-exp-project' }, projectId: 'proj-1' })
    const projectFinal = events.record({ kind: 'worker', at: '2026-11-10T06:00:01Z',
      text: JSON.stringify({ type: 'ticket.ended', data: { ticketId: 'proj-1', by: 'executor', outcome: 'completed' } }),
      source: { kind: 'engine-event', id: 'engine-exp-project' }, projectId: 'proj-1' })
    const foreignFinal = events.record({ kind: 'worker', at: '2026-11-10T06:00:02Z',
      text: JSON.stringify({ type: 'ticket.ended', data: { ticketId: 'proj-2', by: 'executor', outcome: 'completed' } }),
      source: { kind: 'engine-event', id: 'engine-exp-foreign' }, projectId: 'proj-2' })
    const privateSource = events.record({ kind: 'user', at: '2026-11-10T06:00:03Z', text: '主私聊原文：经验来源。',
      source: { kind: 'web-message', id: 'm-exp-private' }, projectId: 'proj-1' })
    const goodCorrection = events.record({ kind: 'user', at: '2026-11-10T06:00:04Z', text: '项目一补充。',
      source: { kind: 'feishu-message', id: 'feishu-exp-correction' }, projectId: 'proj-1' })
    const foreignCorrection = events.record({ kind: 'user', at: '2026-11-10T06:00:05Z', text: '项目二原文：外部补充。',
      source: { kind: 'feishu-message', id: 'feishu-exp-foreign' }, projectId: 'proj-2' })

    const goodTentative = experiences.tentative({ text: '项目一可复用经验', eventIds: [projectSource.id],
      methodVersion: 'project-v1' })
    confirmed(experiences.judge({ id: goodTentative.id, confidence: 'high', finalEventIds: [projectFinal.id],
      reason: '项目收尾' }))
    expect(experiences.correct({ id: goodTentative.id, text: '项目一修订经验', eventId: goodCorrection.id,
      reason: '用户补充' }).methodVersion).toBe('project-v1')
    const good = experiences.read(goodTentative.id)
    const mixed = experiences.tentative({ text: '跨项目混合经验', eventIds: [projectSource.id] })
    confirmed(experiences.judge({ id: mixed.id, confidence: 'high', finalEventIds: [projectFinal.id, foreignFinal.id],
      reason: '混合确认' }))
    const privateItem = experiences.tentative({ text: '私聊来源经验', eventIds: [projectSource.id, privateSource.id] })
    confirmed(experiences.judge({ id: privateItem.id, confidence: 'high', finalEventIds: [projectFinal.id],
      reason: '私聊来源' }))
    const historyItem = experiences.tentative({ text: '历史越界经验', eventIds: [projectSource.id] })
    confirmed(experiences.judge({ id: historyItem.id, confidence: 'high', finalEventIds: [projectFinal.id],
      reason: '历史确认' }))
    experiences.correct({ id: historyItem.id, text: '历史越界修订经验', eventId: foreignCorrection.id, reason: '外部补充' })

    // Only the experience whose every source, final and history event belongs to this project is selected.
    const selection = scoped.retrieve({ text: '经验', reason: '项目经验' }, { projectId: 'proj-1' })
    const found = selection.items.filter(item => item.kind === 'experience')
    expect(found.map(item => item.id)).toEqual([goodTentative.id])
    expect(found[0]).toMatchObject({ text: '项目一修订经验', version: good.version,
      sources: [{ kind: 'event', id: projectSource.id }, { kind: 'event', id: projectFinal.id },
        { kind: 'event', id: goodCorrection.id }] })
    expect(JSON.stringify(selection)).not.toContain('主私聊原文')
    expect(JSON.stringify(selection)).not.toContain('项目二原文')
    expect(scoped.item('experience', goodTentative.id, { projectId: 'proj-1' })).toMatchObject({ kind: 'experience',
      text: '项目一修订经验', version: good.version })
    expect(scoped.item('experience', mixed.id, { projectId: 'proj-1' })).toBeUndefined()
    expect(scoped.item('experience', privateItem.id, { projectId: 'proj-1' })).toBeUndefined()
    expect(scoped.item('experience', historyItem.id, { projectId: 'proj-1' })).toBeUndefined()
    expect(index.get('experiences', goodTentative.id)!.references!.map(reference => reference.id))
      .toEqual([projectSource.id, projectFinal.id, goodCorrection.id])

    // A scoped reopen keeps every snapshot source and compares the current library version.
    const reopened = scoped.read(selection.id, { projectId: 'proj-1' })
    expect(reopened.items.find(item => item.kind === 'experience')).toMatchObject({ id: goodTentative.id,
      changed: false, currentText: '项目一修订经验', version: good.version,
      sources: [{ kind: 'event', id: projectSource.id }, { kind: 'event', id: projectFinal.id },
        { kind: 'event', id: goodCorrection.id }] })

    // A later in-project correction is detected on reopen, and the correction never changes the method version.
    const late = events.record({ kind: 'user', at: '2026-11-10T06:00:06Z', text: '项目一再次补充。',
      source: { kind: 'feishu-message', id: 'feishu-exp-correction-2' }, projectId: 'proj-1' })
    const revised = experiences.correct({ id: goodTentative.id, text: '项目一最终经验', eventId: late.id, reason: '再次补充' })
    expect(revised.methodVersion).toBe('project-v1')
    const changed = scoped.read(selection.id, { projectId: 'proj-1' })
      .items.find(item => item.kind === 'experience')!
    expect(changed).toMatchObject({ changed: true, text: '项目一修订经验', currentText: '项目一最终经验',
      version: good.version, currentVersion: revised.version,
      sources: [{ kind: 'event', id: projectSource.id }, { kind: 'event', id: projectFinal.id },
        { kind: 'event', id: goodCorrection.id }] })
    expect(index.get('experiences', goodTentative.id)!.references!.map(reference => reference.id))
      .toEqual([projectSource.id, projectFinal.id, goodCorrection.id, late.id])
  })

  it('selects a project\'s events even when the project itself has no task file', () => {
    const event = events.record({ kind: 'worker', at: '2026-11-10T01:05:00Z', text: '没有任务文件的项目事件。',
      source: { kind: 'worker-report', id: 'r-proj-missing' }, projectId: 'proj-missing' })
    const selection = retrieval.retrieve({ projectId: 'proj-missing', reason: '项目事件不依赖任务文件' })
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'event', id: event.id }))
    expect(selection.items.some(item => item.kind === 'task')).toBe(false)
  })

  it('returns nothing when no condition is given instead of loading whole libraries', () => {
    expect(retrieval.retrieve({ reason: '不指定来源' }).items).toEqual([])
    expect(retrieval.retrieve({ personIds: [], taskIds: [], projectId: '', text: '', reason: '空条件' }).items).toEqual([])
  })

  it('skips a requested task with no list file and still selects its matching records', () => {
    const event = events.record({ kind: 'worker', at: '2026-11-10T02:00:00Z', text: '缺失任务的事件。',
      source: { kind: 'worker-report', id: 'r-missing' }, taskId: 'missing-task' })
    const selection = retrieval.retrieve({ taskIds: ['missing-task'], reason: '缺失任务' })
    expect(selection.items.some(item => item.kind === 'task')).toBe(false)
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'event', id: event.id }))
  })

  it('finds an archived task by its recorded source task', () => {
    const selection = retrieval.retrieve({ taskIds: ['t2'], reason: '复盘任务二' })
    const archive = selection.items.find(item => item.kind === 'archive')!
    expect(archive).toMatchObject({ id: 'archive-t2', text: f.archiveT2.content, version: f.archiveT2.version,
      sources: [f.archiveT2.source] })
  })

  it('selects document full texts, experiences and the current editable views by text', () => {
    const selection = retrieval.retrieve({ text: '预算', reason: '找预算资料' })
    const document = selection.items.find(item => item.kind === 'document')!
    expect(document).toMatchObject({ id: f.budget.id, text: '预算正文第一版。', version: documents.read(f.budget.id).version,
      path: f.budgetPath, sources: [documents.read(f.budget.id).source] })
    expect(selection.items.filter(item => item.kind === 'document')).toHaveLength(1)
    const experience = selection.items.find(item => item.kind === 'experience')!
    expect(experience).toMatchObject({ id: f.experience.id, text: '预算审批的经验。', version: f.experience.version })
    expect(selection.items.filter(item => item.kind === 'experience')).toHaveLength(1)
    // The current card and short-term text match too, so a hand edit is found without an event-library scan.
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'person', id: 'p1' }))
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'short-term', id: f.p1Term.id }))
    expect(selection.items.some(item => item.kind === 'task' || item.kind === 'event')).toBe(false)
    expect(document.reason).toContain('Documents.search')
    expect(experience.reason).toContain('experiences')
    expect(selection.items.find(item => item.kind === 'person')!.reason).toContain('people')
  })
})

it('keeps one event item when several conditions select the same event', () => {
  const shared = events.record({ kind: 'user', at: '2026-11-10T03:00:00Z', text: '同一条事件同时关联人物、任务与项目。',
    source: { kind: 'web-message', id: 'm-shared' }, personIds: ['p1'], taskId: 't1', projectId: 'proj-1' })
  const selection = retrieval.retrieve({ personIds: ['p1'], taskIds: ['t1'], projectId: 'proj-1', reason: '多条件检索' })
  const matches = selection.items.filter(item => item.kind === 'event' && item.id === shared.id)
  expect(matches).toHaveLength(1)
  expect(matches[0]!.reason).toContain('personIds')
  expect(matches[0]!.reason).toContain('taskId')
  expect(matches[0]!.reason).toContain('projectId')
  expect(matches[0]!.sources).toEqual([events.get(shared.id).source])
  expect(new Set(selection.items.map(item => `${item.kind}:${item.id}`)).size).toBe(selection.items.length)
})

describe('usedBy and diagnostics', () => {
  it('answers usedBy for an event a task note, an independent item and a saved selection all reference', () => {
    const shared = events.record({ kind: 'user', at: '2026-11-10T04:00:00Z', text: '共用的证据。',
      source: { kind: 'web-message', id: 'm-shared-used' }, personIds: ['p1'] })
    const note = shortTerm.remember({ kind: 'agreement', text: '任务里的约定。', taskId: 't1',
      sources: [{ kind: 'event', id: shared.id }] })
    const item = shortTerm.remember({ kind: 'experience', text: '独立的经验。', sources: [{ kind: 'event', id: shared.id }] })
    const selection = retrieval.retrieve({ personIds: ['p1'], taskIds: ['t1'], reason: '引用同一事件' })
    expect(selection.items.some(entry => entry.kind === 'event' && entry.id === shared.id)).toBe(true)
    const used = retrieval.usedBy('event', shared.id)
    // The task note's own short-term row and the independent item's row are both references from short-term memory.
    expect(used).toContainEqual({ kind: 'short-term', id: note.id, part: 'notes', taskId: 't1' })
    expect(used).toContainEqual({ kind: 'short-term', id: item.id, part: 'sources' })
    expect(used).toContainEqual({ kind: 'selection', id: selection.id })
    expect(used).toContainEqual({ kind: 'task', id: 't1', part: 'notes', taskId: 't1' })
  })

  it('moves an edited entry source to the new event while the old selection keeps the original reference', () => {
    const first = events.record({ kind: 'user', at: '2026-11-10T04:10:00Z', text: '旧来源事件。',
      source: { kind: 'web-message', id: 'm-source-x' }, personIds: ['p1'] })
    const second = events.record({ kind: 'user', at: '2026-11-10T04:11:00Z', text: '新来源事件。',
      source: { kind: 'web-message', id: 'm-source-y' }, personIds: ['p1'] })
    const item = shortTerm.remember({ kind: 'experience', text: '来源会被手改。', sources: [{ kind: 'event', id: first.id }] })
    const selection = retrieval.retrieve({ text: '来源会被手改', reason: '保存旧来源' })
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'short-term', id: item.id,
      sources: [{ kind: 'event', id: first.id }] }))
    expect(retrieval.usedBy('event', first.id)).toContainEqual({ kind: 'short-term', id: item.id, part: 'sources' })
    // A person editor changes the item's source line from the first event to the second.
    const path = shortTerm.read(item.id).path
    writeFileSync(path, readFileSync(path, 'utf8')
      .replace(`"id":"${first.id}"`, `"id":"${second.id}"`), 'utf8')
    expect(shortTerm.read(item.id).sources).toEqual([{ kind: 'event', id: second.id }])
    expect(retrieval.usedBy('event', first.id)).not.toContainEqual(expect.objectContaining({ kind: 'short-term', id: item.id }))
    expect(retrieval.usedBy('event', first.id)).toContainEqual({ kind: 'selection', id: selection.id })
    expect(retrieval.usedBy('event', second.id)).toContainEqual({ kind: 'short-term', id: item.id, part: 'sources' })
    // The frozen snapshot keeps the old sources; only its current read reports the change.
    const reopened = retrieval.read(selection.id)
    const snapshot = reopened.items.find(entry => entry.id === item.id)!
    expect(snapshot.sources).toEqual([{ kind: 'event', id: first.id }])
    expect(snapshot.changed).toBe(true)
    expect(reopened.selection).toEqual(selection)
  })

  it('reports a broken card and still selects a good card from the same query, clearing it once repaired', () => {
    const badPath = join(root, 'people', 'broken.md')
    writeFileSync(badPath, '这不是人物卡\n', 'utf8')
    const selection = retrieval.retrieve({ personIds: ['broken', 'p1'], reason: '坏卡不阻断好卡' })
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'person', id: 'p1' }))
    expect(selection.items.some(item => item.kind === 'person' && item.id === 'broken')).toBe(false)
    expect(retrieval.diagnostics()).toEqual([expect.objectContaining({ path: badPath })])
    people.save({ id: 'broken', name: '修好的人', description: '修好后的描述。', requirements: [], relations: [] })
    expect(retrieval.diagnostics()).toEqual([])
    expect(retrieval.retrieve({ personIds: ['broken'], reason: '修复后检索' }).items)
      .toContainEqual(expect.objectContaining({ kind: 'person', id: 'broken' }))
  })

  it('skips a broken task file and keeps the good task from the same query', () => {
    const badPath = join(root, 'short-term', 'tasks', 'broken.md')
    writeFileSync(badPath, '这不是任务文件\n', 'utf8')
    const event = events.record({ kind: 'worker', at: '2026-11-10T04:20:00Z', text: '坏任务旁的报告。',
      source: { kind: 'worker-report', id: 'r-broken-task' }, taskId: 'broken' })
    const selection = retrieval.retrieve({ taskIds: ['broken', 't1'], reason: '坏任务不阻断好任务' })
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'task', id: 't1' }))
    expect(selection.items.some(item => item.kind === 'task' && item.id === 'broken')).toBe(false)
    // Its events still match by task ID, and the broken file is diagnosable rather than silent.
    expect(selection.items).toContainEqual(expect.objectContaining({ kind: 'event', id: event.id }))
    expect(retrieval.diagnostics()).toEqual([expect.objectContaining({ path: badPath })])
  })
})

describe('selection read', () => {
  it('finds changed document originals, edited person, task and short-term text, keeps each original item, and reopens from disk', () => {
    const selection = retrieval.retrieve({ personIds: ['p1'], taskIds: ['t1'], text: '预算', reason: '会前核对' })
    const selectionFile = join(root, 'selections', `${selection.id}.json`)
    const snapshot = JSON.parse(readFileSync(selectionFile, 'utf8'))
    const beforeDocument = selection.items.find(item => item.kind === 'document')!
    const beforePerson = selection.items.find(item => item.kind === 'person')!
    const beforeTask = selection.items.find(item => item.kind === 'task' && item.id === 't1')!
    // Change the document original, the person card and the task note by hand, then reopen the selection with a new instance.
    original(f.budgetPath, '预算正文第二版。')
    writeFileSync(f.p1CardPath, readFileSync(f.p1CardPath, 'utf8').replace('负责预算的小林。', '人工修订后的小林描述。'), 'utf8')
    const taskPath = tasks.read('t1').path
    writeFileSync(taskPath, readFileSync(taskPath, 'utf8').replace('任务一的便签。', '任务一的手改便签。'), 'utf8')
    const reopened = new MemoryRetrieval(root, { events, people, shortTerm, tasks, documents })
    const read: ReopenedSelection = reopened.read(selection.id)
    expect(read.selection).toEqual(snapshot)
    const document = read.items.find(item => item.kind === 'document')!
    expect(document).toMatchObject({ changed: true, currentVersion: sha256('预算正文第二版。'), currentText: '预算正文第二版。',
      version: beforeDocument.version, text: '预算正文第一版。' })
    const person = read.items.find(item => item.kind === 'person')!
    expect(person.changed).toBe(true)
    expect(person.currentText).toContain('人工修订后的小林描述。')
    expect(person.currentVersion).toBe(sha256(readFileSync(f.p1CardPath, 'utf8')))
    expect(person.version).toBe(beforePerson.version)
    const task = read.items.find(item => item.kind === 'task' && item.id === 't1')!
    expect(task).toMatchObject({ changed: true, currentVersion: tasks.read('t1').version })
    expect(task.currentText).toContain('任务一的手改便签。')
    expect(task.version).toBe(beforeTask.version)
    const term = read.items.find(item => item.kind === 'short-term' && item.id === f.t1Term.id)!
    expect(term).toMatchObject({ changed: true, currentText: '任务一的手改便签。' })
    // A fresh search reads the edited files, while the saved snapshot keeps its original text and versions.
    const current = reopened.retrieve({ taskIds: ['t1'], reason: '手改后检索' })
    expect(current.items.find(item => item.kind === 'task')!.text).toContain('任务一的手改便签。')
    expect(current.items.find(item => item.id === f.t1Term.id)!.text).toBe('任务一的手改便签。')
    expect(JSON.parse(readFileSync(selectionFile, 'utf8'))).toEqual(snapshot)
    expect(read.selection.items.find(item => item.kind === 'document')!.text).toBe('预算正文第一版。')
  })
})

it('exposes snake_case search and selection tools, the selection union entries, and checks file IDs at the tool boundary', async () => {
  const tools = retrievalTools(retrieval)
  const search = tools.find(entry => entry.name === 'jarvis_memory_search')!
  const selectionTool = tools.find(entry => entry.name === 'jarvis_memory_selection')!
  expect(tools.map(entry => entry.name)).toEqual(['jarvis_memory_search', 'jarvis_memory_selection'])
  expect(search.schema.safeParse({ person_ids: ['p1'], reason: '工具检索' }).success).toBe(true)
  expect(search.schema.safeParse({ person_ids: ['../p1'], reason: '工具检索' }).success).toBe(false)
  expect(search.schema.safeParse({ person_ids: ['p1'] }).success).toBe(false)
  expect(selectionTool.schema.safeParse({ id: '../escape' }).success).toBe(false)
  expect(selectionTool.schema.safeParse({ id: 'selection-1' }).success).toBe(true)
  expect(selectionTool.schema.safeParse({ action: 'used_by', kind: 'event', id: 'event-1' }).success).toBe(true)
  expect(selectionTool.schema.safeParse({ action: 'used_by', kind: 'document', id: 'document-1' }).success).toBe(true)
  expect(selectionTool.schema.safeParse({ action: 'used_by', kind: 'nope', id: 'event-1' }).success).toBe(false)
  expect(selectionTool.schema.safeParse({ action: 'diagnostics' }).success).toBe(true)
  const signal = new AbortController().signal
  const searched = await search.execute({ person_ids: ['p1'], reason: '工具检索' }, signal) as { id: string; query: RetrievalQuery }
  expect(searched.query).toEqual({ personIds: ['p1'], reason: '工具检索' })
  const reopened = await selectionTool.execute({ id: searched.id }, signal) as ReopenedSelection
  expect(reopened.selection.id).toBe(searched.id)
  expect(reopened.items.find(item => item.kind === 'person')!.id).toBe('p1')
  const used = await selectionTool.execute({ action: 'used_by', kind: 'person', id: 'p1' }, signal) as Array<{ kind: string }>
  expect(Array.isArray(used)).toBe(true)
  expect(await selectionTool.execute({ action: 'diagnostics' }, signal)).toEqual([])
  const task = tasks.read('t1').task
  const managedId = 'memory:p1:language'
  tasks.save({ ...task, notes: [...task.notes, { id: managedId, text: '中文', recipient: 'p1', sources: [] }] })
  const selected = retrieval.retrieve({ taskIds: ['t1'], reason: '检查受管理条目的引用' })
  const input = selectionTool.schema.parse({ action: 'used_by', kind: 'short-term', id: managedId })
  expect(await selectionTool.execute(input, signal)).toContainEqual({ kind: 'selection', id: selected.id })
})
