/** Task reduction archives finished details, keeps the unfinished work, and collapses ended tasks into a readable index. */
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Ticket } from '../../src/core/ports/ticket-model.ts'
import { ShortTerm } from '../../src/core/short-term.ts'
import { MemoryStore } from '../../src/core/store.ts'
import { TaskLists } from '../../src/core/task-lists.ts'
import { TaskReduction } from '../../src/core/task-reduction.ts'

const AT = '2026-09-09T00:00:00.000Z'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const freshRoot = (): string => { const path = mkdtempSync(join(tmpdir(), 'task-reduction-')); directories.push(path); return path }

/** A minimal Ticket fixture: the Engine joins its status onto a task list by the same ID. */
function ticket(id: string, ended = false): Ticket {
  const base: Ticket = { id, title: `任务 ${id}`, decisionId: `decision-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'test', actor: { source: 'feishu', id: 'ou_alice' }, scope: '测试范围',
      basis: { via: 'listed', sender: 'ou_alice' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] } }
  return ended ? { ...base, ended: { at: AT, by: 'executor', outcome: 'completed' } } : base
}
/** Task lists whose runtime lookup answers only the tickets a test gives it. */
function lists(root: string, tickets: Ticket[] = []): TaskLists {
  const byId = new Map<string, Ticket>()
  for (const item of tickets) byId.set(item.id, item)
  return new TaskLists(root, id => byId.get(id))
}
const archiveOf = (root: string, id: string): Record<string, unknown> =>
  JSON.parse(new MemoryStore(root).get('tasks', id).content) as Record<string, unknown>
const indexOf = (root: string): unknown => JSON.parse(readFileSync(join(root, 'short-term', 'task-index.json'), 'utf8'))
const itemsOf = (root: string): string[] => readdirSync(join(root, 'short-term', 'items'))

it('archives completed todos, keeps unfinished work on a running task, and keeps the original IDs readable', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t1')])
  tasks.save({ id: 't1', title: '跟进发布', plan: '先检查构建，再发布', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'read-1', text: '检查构建', done: true }, { id: 'open-1', text: '通知用户', done: false }],
    notes: [{ id: 'note-1', text: '保留现有排序', recipient: 'Worker' }] })

  const result = new TaskReduction(root, tasks).reduce()

  expect(result.archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  expect(result.afterChars).toBeLessThan(result.beforeChars)
  const { task, runtime, path } = tasks.read('t1')
  expect(runtime).toMatchObject({ state: 'working/queued' })
  expect(task).toMatchObject({ id: 't1', title: '跟进发布', plan: '先检查构建，再发布', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'open-1', text: '通知用户', done: false }],
    notes: [{ id: 'note-1', text: '保留现有排序', recipient: 'Worker' }] })
  expect(readFileSync(path, 'utf8')).not.toContain('read-1')
  expect(archiveOf(root, 'task-t1')).toMatchObject({ taskId: 't1', title: '跟进发布', plan: '', notes: [],
    sources: [{ kind: 'feishu', id: 'm1' }], todos: [{ id: 'read-1', text: '检查构建', done: true }] })
  expect(indexOf(root)).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  // The archived todo and the still-active note open by their original IDs; no item mirror was written.
  const view = new ShortTerm(root, tasks)
  expect(view.read('read-1')).toMatchObject({ text: '检查构建',
    owner: { kind: 'archive', archiveId: 'task-t1', entryId: 'read-1' } })
  expect(view.read('note-1')).toMatchObject({ text: '保留现有排序', recipient: 'Worker',
    owner: { kind: 'task', taskId: 't1', entryId: 'note-1' } })
  expect(tasks.index.get('short-term', 'read-1')?.path).toBe(join(root, 'tasks', 'task-t1.json'))
  expect(itemsOf(root)).toEqual([])
})

it('trims a task without a Worker but keeps its plan, notes and index', () => {
  const root = freshRoot()
  const tasks = lists(root)
  tasks.save({ id: 'promise-1', title: '等接手的承诺', plan: '等待 Worker 接手', sources: [{ kind: 'feishu', id: 'm2' }],
    todos: [{ id: 'done-1', text: '回复用户', done: true }], notes: [{ id: 'note-1', text: '周五前给结果', recipient: '小王' }] })

  const result = new TaskReduction(root, tasks).reduce()

  expect(result.archived).toEqual([{ taskId: 'promise-1', archiveId: 'task-promise-1' }])
  const { task, runtime } = tasks.read('promise-1')
  expect(runtime).toBeNull()
  expect(task).toMatchObject({ plan: '等待 Worker 接手', sources: [{ kind: 'feishu', id: 'm2' }], todos: [],
    notes: [{ id: 'note-1', text: '周五前给结果', recipient: '小王' }] })
  expect(task.todos).toHaveLength(0)
  expect(new ShortTerm(root, tasks).read('done-1')).toMatchObject({ text: '回复用户',
    owner: { kind: 'archive', archiveId: 'task-promise-1', entryId: 'done-1' } })
})

it('does nothing on a repeated reduce with no new completed work', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t1')])
  tasks.save({ id: 't1', title: '跟进', plan: '计划', sources: [], notes: [],
    todos: [{ id: 'a', text: '完成项', done: true }, { id: 'b', text: '未完成项', done: false }] })
  const reduction = new TaskReduction(root, tasks)
  reduction.reduce()
  const paths = [tasks.read('t1').path, join(root, 'tasks', 'task-t1.json'),
    join(root, 'short-term', 'task-index.json'), join(root, 'short-term', 'item-index.json')]
  const files = paths.map(path => readFileSync(path, 'utf8'))
  const { task } = tasks.read('t1')

  const second = reduction.reduce()

  expect(second.archived).toEqual([])
  expect(second.beforeChars).toBe(JSON.stringify(task).length)
  expect(second.afterChars).toBe(second.beforeChars)
  expect(paths.map(path => readFileSync(path, 'utf8'))).toEqual(files)
})

it('merges later archives into the same record and keeps older todos and sources', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t1')])
  tasks.save({ id: 't1', title: '分批完成', plan: '计划不变', sources: [{ kind: 'feishu', id: 'm1' }], notes: [],
    todos: [{ id: 'a', text: '第一次完成', done: true }, { id: 'b', text: '还没做', done: false }] })
  const reduction = new TaskReduction(root, tasks)
  reduction.reduce()
  expect(new ShortTerm(root, tasks).read('a').text).toBe('第一次完成')

  const first = tasks.read('t1').task
  tasks.save({ ...first, sources: [...first.sources, { kind: 'feishu', id: 'm2' }],
    todos: [{ id: 'b', text: '还没做', done: true }] })
  expect(reduction.reduce().archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  expect(archiveOf(root, 'task-t1')).toMatchObject({
    todos: [{ id: 'a', text: '第一次完成', done: true }, { id: 'b', text: '还没做', done: true }],
    sources: [{ kind: 'feishu', id: 'm1' }, { kind: 'feishu', id: 'm2' }] })
  expect(new ShortTerm(root, tasks).read('b').text).toBe('还没做')

  tasks.save({ ...tasks.read('t1').task, todos: [{ id: 'a', text: '第一次完成（复核）', done: true }] })
  expect(reduction.reduce().archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  expect(archiveOf(root, 'task-t1')).toMatchObject({
    todos: [{ id: 'a', text: '第一次完成（复核）', done: true }, { id: 'b', text: '还没做', done: true }] })
  expect(indexOf(root)).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  expect(tasks.read('t1').task).toMatchObject({ plan: '计划不变', todos: [] })
  expect(new ShortTerm(root, tasks).read('a')).toMatchObject({ text: '第一次完成（复核）',
    owner: { kind: 'archive', archiveId: 'task-t1', entryId: 'a' } })
})

it('archives an ended task whole and leaves a short index that reopens', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t2', true)])
  tasks.save({ id: 't2', title: '实现筛选', plan: '完整计划：先读代码，再写测试', sources: [{ kind: 'trigger', id: 'om_1' }],
    todos: [{ id: 'a', text: '写测试', done: true }, { id: 'b', text: '提交', done: true }],
    notes: [{ id: 'n1', text: '保留原有排序', recipient: 'Worker' }] })

  const result = new TaskReduction(root, tasks).reduce()

  expect(result.archived).toEqual([{ taskId: 't2', archiveId: 'task-t2' }])
  expect(result.afterChars).toBeLessThan(result.beforeChars)
  const { task } = tasks.read('t2')
  expect(task).toMatchObject({ id: 't2', title: '实现筛选', plan: 'Archived details: tasks/task-t2',
    sources: [{ kind: 'trigger', id: 'om_1' }] })
  expect(task.todos).toEqual([])
  expect(task.notes).toEqual([])
  expect(archiveOf(root, 'task-t2')).toMatchObject({ taskId: 't2', title: '实现筛选', plan: '完整计划：先读代码，再写测试',
    sources: [{ kind: 'trigger', id: 'om_1' }],
    todos: [{ id: 'a', text: '写测试', done: true }, { id: 'b', text: '提交', done: true }],
    notes: [{ id: 'n1', text: '保留原有排序', recipient: 'Worker' }] })
  expect(indexOf(root)).toEqual([{ taskId: 't2', archiveId: 'task-t2' }])
  // Both the archived todos and the archived note stay readable by their original IDs.
  const view = new ShortTerm(root, tasks)
  expect(view.read('a')).toMatchObject({ text: '写测试', taskId: 't2',
    owner: { kind: 'archive', archiveId: 'task-t2', entryId: 'a' } })
  expect(view.read('n1')).toMatchObject({ text: '保留原有排序', recipient: 'Worker',
    owner: { kind: 'archive', archiveId: 'task-t2', entryId: 'n1' } })
  expect(tasks.index.get('short-term', 'a')?.path).toBe(join(root, 'tasks', 'task-t2.json'))
  expect(tasks.index.get('short-term', 'n1')?.path).toBe(join(root, 'tasks', 'task-t2.json'))

  const reopened = new TaskLists(root, id => id === 't2' ? ticket('t2', true) : undefined)
  expect(reopened.read('t2').task).toEqual(task)
  const reopenedView = new ShortTerm(root, reopened)
  expect(reopenedView.read('a').text).toBe('写测试')
  expect(reopenedView.read('n1').text).toBe('保留原有排序')
  expect(new TaskReduction(root, reopened).reduce()).toEqual({ beforeChars: JSON.stringify(task).length,
    afterChars: JSON.stringify(task).length, archived: [] })
  // A follow-up completion on the same task must not replace its original plan with the archive pointer.
  reopened.save({ ...task, todos: [{ id: 'follow-up', text: '补充复核', done: true }] })
  new TaskReduction(root, reopened).reduce()
  expect(archiveOf(root, 'task-t2')).toMatchObject({ plan: '完整计划：先读代码，再写测试',
    notes: [{ id: 'n1', text: '保留原有排序', recipient: 'Worker' }],
    todos: [{ id: 'a' }, { id: 'b' }, { id: 'follow-up' }] })
  expect(reopenedView.read('follow-up').text).toBe('补充复核')
})

it('keeps plan, notes and unfinished todos when an ended task still has open work', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t3', true)])
  tasks.save({ id: 't3', title: '收尾', plan: '继续收尾', sources: [{ kind: 'feishu', id: 'm3' }],
    todos: [{ id: 'a', text: '已完成', done: true }, { id: 'b', text: '未完成', done: false }],
    notes: [{ id: 'n1', text: '记得复核', recipient: 'Worker' }] })

  const result = new TaskReduction(root, tasks).reduce()

  expect(result.archived).toEqual([{ taskId: 't3', archiveId: 'task-t3' }])
  const { task } = tasks.read('t3')
  expect(task).toMatchObject({ plan: '继续收尾', sources: [{ kind: 'feishu', id: 'm3' }],
    todos: [{ id: 'b', text: '未完成', done: false }], notes: [{ id: 'n1', text: '记得复核', recipient: 'Worker' }] })
  expect(task.todos).toHaveLength(1)
  expect(archiveOf(root, 'task-t3')).toMatchObject({ todos: [{ id: 'a', text: '已完成', done: true }] })
  // Only the completed todo moved: the unfinished todo and the still-active note stay in the task file.
  const view = new ShortTerm(root, tasks)
  expect(view.read('a')).toMatchObject({ text: '已完成', owner: { kind: 'archive', archiveId: 'task-t3', entryId: 'a' } })
  expect(view.read('b')).toMatchObject({ text: '未完成', owner: { kind: 'task', taskId: 't3', entryId: 'b' } })
  expect(view.read('n1')).toMatchObject({ text: '记得复核', owner: { kind: 'task', taskId: 't3', entryId: 'n1' } })
  expect(archiveOf(root, 'task-t3')).toMatchObject({ plan: '', notes: [] })
})

it('keeps the attachment registry on a collapsed task and its original plan in the archive', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('t4', true)])
  const attachment = { id: 'att-1', path: join(root, 'files', 'brief.txt'), name: '说明' }
  tasks.save({ id: 't4', title: '收尾', plan: '完整计划', sources: [{ kind: 'feishu', id: 'm4' }],
    attachments: [attachment], todos: [{ id: 'a', text: '完成项', done: true }], notes: [{ id: 'n1', text: '便签' }] })

  new TaskReduction(root, tasks).reduce()

  // The collapsed list keeps the attachment registry; the whole plan and entries moved to the archive.
  expect(tasks.read('t4').task).toMatchObject({ plan: 'Archived details: tasks/task-t4', todos: [], notes: [],
    attachments: [attachment] })
  expect(archiveOf(root, 'task-t4')).toMatchObject({ plan: '完整计划',
    todos: [{ id: 'a', text: '完成项', done: true }], notes: [{ id: 'n1', text: '便签' }] })
})
