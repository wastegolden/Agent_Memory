/** Short-term reduction merges repeats, applies explicit replacements and archives finished todos without leaving a copy. */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Ticket } from '../../src/core/ports/ticket-model.ts'
import { MemoryStore } from '../../src/core/store.ts'
import { ShortTerm } from '../../src/core/short-term.ts'
import { TaskLists } from '../../src/core/task-lists.ts'
import { TaskReduction } from '../../src/core/task-reduction.ts'

let root: string
let tasks: TaskLists
let memory: ShortTerm
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'short-term-reduction-'))
  tasks = new TaskLists(root, () => undefined)
  memory = new ShortTerm(root, tasks)
})
afterEach(() => { rmSync(root, { recursive: true, force: true }) })
const source = { kind: 'web-message', id: 'message-1' }
const otherSource = { kind: 'web-message', id: 'message-2' }
const sources = [source]
const tick = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 5))
const itemFiles = (): string[] => readdirSync(join(root, 'short-term', 'items')).sort()
const archiveOf = (id: string): Record<string, unknown> =>
  JSON.parse(new MemoryStore(root).get('tasks', archiveIdOf(id)).content) as Record<string, unknown>
const indexOf = (): Record<string, unknown> => JSON.parse(readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8'))
const archiveIdOf = (id: string): string => (indexOf()[id] as { archiveId: string }).archiveId

const AT = '2026-09-09T00:00:00.000Z'
/** A minimal Ticket fixture: an ended ticket collapses its task list into the archive. */
function ticket(id: string, ended = false): Ticket {
  const base: Ticket = { id, title: `任务 ${id}`, decisionId: `decision-${id}`,
    mandate: { strength: 'explicit', policyVersion: 'test', actor: { source: 'feishu', id: 'ou_alice' }, scope: '测试范围',
      basis: { via: 'listed', sender: 'ou_alice' } },
    channels: [], assignments: [], inputs: [], undelivered: [], createdAt: AT, updatedAt: AT,
    origin: { triggerId: `trigger-${id}`, triggerIds: [`trigger-${id}`] } }
  return ended ? { ...base, ended: { at: AT, by: 'executor', outcome: 'completed' } } : base
}

it('merges duplicate task notes into the earliest entry, combines sources and archives the rest with a short index', async () => {
  const task = tasks.save({ title: '筛选', plan: '', sources, todos: [], notes: [] })
  const text = '要保留的冗长约定'.repeat(40)
  const first = memory.remember({ kind: 'agreement', text, taskId: task.id, recipient: 'xiaolin', sources })
  await tick()
  const second = memory.remember({ kind: 'agreement', text, taskId: task.id, recipient: 'xiaolin', sources: [otherSource] })
  await tick()
  const third = memory.remember({ kind: 'agreement', text, taskId: task.id, recipient: 'xiaolin', sources })
  const result = memory.reduce()
  expect(result.archivedIds).toEqual([second.id, third.id])
  expect(result.index).toEqual([
    { id: second.id, reason: 'duplicate', archiveId: archiveIdOf(second.id) },
    { id: third.id, reason: 'duplicate', archiveId: archiveIdOf(third.id) },
  ])
  expect(result.afterChars).toBeLessThan(result.beforeChars)
  expect(memory.list().map(item => item.id)).toEqual([first.id])
  expect(memory.read(first.id).sources).toEqual([source, otherSource])
  const survivor = tasks.read(task.id).task.notes.find(note => note.id === first.id)!
  expect(survivor.sources).toEqual([source, otherSource])
  expect(tasks.read(task.id).task.notes.map(note => note.id)).toEqual([first.id])
  expect(itemFiles()).toEqual([])
  expect(archiveOf(second.id)).toMatchObject({ item: { id: second.id, text, kind: 'agreement',
    taskId: task.id, recipient: 'xiaolin', sources: [otherSource] }, reason: 'duplicate' })
  expect(indexOf()[second.id]).toEqual({ reason: 'duplicate', archiveId: archiveIdOf(second.id) })
})
it('keeps equal text apart across kind, task and recipient', async () => {
  const taskA = tasks.save({ title: 'A', plan: '', sources, todos: [], notes: [] })
  const taskB = tasks.save({ title: 'B', plan: '', sources, todos: [], notes: [] })
  const text = '同名约定'
  const one = memory.remember({ kind: 'agreement', text, taskId: taskA.id, recipient: 'xiaolin', sources })
  await tick()
  const two = memory.remember({ kind: 'agreement', text, taskId: taskB.id, recipient: 'xiaolin', sources })
  await tick()
  const three = memory.remember({ kind: 'agreement', text, taskId: taskA.id, recipient: 'xiaowang', sources })
  await tick()
  const four = memory.remember({ kind: 'experience', text, taskId: taskA.id, recipient: 'xiaolin', sources })
  const result = memory.reduce()
  expect(result.archivedIds).toEqual([])
  expect(memory.list().map(item => item.id)).toEqual([one.id, two.id, three.id, four.id])
  expect(tasks.read(taskA.id).task.notes.map(note => note.id)).toEqual([one.id, three.id, four.id])
  expect(tasks.read(taskB.id).task.notes.map(note => note.id)).toEqual([two.id])
})
it('archives an explicit replacement only inside the same kind, task and recipient', async () => {
  const task = tasks.save({ title: '筛选', plan: '', sources, todos: [], notes: [] })
  const otherTask = tasks.save({ title: '另一任务', plan: '', sources, todos: [], notes: [] })
  const old = memory.remember({ kind: 'agreement', text: '旧约定', taskId: task.id, recipient: 'xiaolin', sources })
  await tick()
  const replacement = memory.remember({ kind: 'agreement', text: '新约定', taskId: task.id, recipient: 'xiaolin', sources: [otherSource] })
  await tick()
  const other = memory.remember({ kind: 'agreement', text: '别人的约定', taskId: task.id, recipient: 'xiaowang', sources })
  await tick()
  const otherTaskItem = memory.remember({ kind: 'agreement', text: '另一任务的约定', taskId: otherTask.id, recipient: 'xiaolin', sources })
  expect(() => memory.reduce({ superseded: [{ id: old.id, by: other.id }] })).toThrow()
  expect(() => memory.reduce({ superseded: [{ id: old.id, by: otherTaskItem.id }] })).toThrow()
  expect(memory.list().map(item => item.id)).toEqual([old.id, replacement.id, other.id, otherTaskItem.id])
  const result = memory.reduce({ superseded: [{ id: old.id, by: replacement.id }] })
  expect(result.archivedIds).toEqual([old.id])
  expect(result.index).toEqual([{ id: old.id, reason: 'superseded', archiveId: archiveIdOf(old.id), replacedBy: replacement.id }])
  expect(memory.list().map(item => item.id)).toEqual([replacement.id, other.id, otherTaskItem.id])
  expect(tasks.read(task.id).task.notes.map(note => note.id)).toEqual([replacement.id, other.id])
  expect(archiveOf(old.id)).toMatchObject({ item: { id: old.id, text: '旧约定' }, reason: 'superseded',
    replacedBy: replacement.id })
})
it('archives a todo confirmed done, removes it from the task list and keeps an unfinished todo active', async () => {
  const task = tasks.save({ title: '发布', plan: '', sources, todos: [], notes: [] })
  const done = memory.remember({ kind: 'todo', text: '已完成的检查', taskId: task.id, sources })
  await tick()
  const open = memory.remember({ kind: 'todo', text: '未完成的检查', taskId: task.id, sources })
  const list = tasks.read(task.id).task
  tasks.save({ ...list, todos: list.todos.map(todo => todo.id === done.id ? { ...todo, done: true } : todo) })
  const result = memory.reduce()
  expect(result.archivedIds).toEqual([done.id])
  expect(result.index).toEqual([{ id: done.id, reason: 'completed', archiveId: archiveIdOf(done.id) }])
  expect(memory.list().map(item => item.id)).toEqual([open.id])
  // The completed todo leaves the task list; the unfinished one and its task file stay.
  expect(tasks.read(task.id).task.todos.map(todo => todo.id)).toEqual([open.id])
  expect(tasks.index.get('short-term', done.id)).toBeUndefined()
  expect(archiveOf(done.id)).toMatchObject({ item: { id: done.id }, reason: 'completed' })
  const reopened = new ShortTerm(root, tasks)
  expect(reopened.read(done.id)).toMatchObject({ text: '已完成的检查',
    owner: { kind: 'archive', archiveId: archiveIdOf(done.id), entryId: done.id } })
})
it('removes only the duplicate done todo from the task list and keeps the survivor and unfinished todos', async () => {
  const task = tasks.save({ title: '组合测试', plan: '', sources, todos: [], notes: [] })
  const survivor = memory.remember({ kind: 'todo', text: '补组合测试', taskId: task.id, sources })
  await tick()
  const duplicate = memory.remember({ kind: 'todo', text: '补组合测试', taskId: task.id, sources: [otherSource] })
  expect(memory.reduce().archivedIds).toEqual([])
  expect(tasks.read(task.id).task.todos.map(todo => todo.id)).toEqual([survivor.id, duplicate.id])
  const list = tasks.read(task.id).task
  tasks.save({ ...list, todos: list.todos.map(todo => todo.id === duplicate.id ? { ...todo, done: true } : todo) })
  const result = memory.reduce()
  expect(result.archivedIds).toEqual([duplicate.id])
  expect(result.index).toEqual([{ id: duplicate.id, reason: 'duplicate', archiveId: archiveIdOf(duplicate.id) }])
  expect(memory.list().map(item => item.id)).toEqual([survivor.id])
  expect(tasks.read(task.id).task.todos.map(todo => todo.id)).toEqual([survivor.id])
  expect(memory.read(survivor.id).sources).toEqual([source, otherSource])
  expect(memory.reduce().archivedIds).toEqual([])
  expect(new MemoryStore(root).list('tasks').filter(record => record.id === archiveIdOf(duplicate.id))).toHaveLength(1)
})
it('does not let an explicit replacement delete an unfinished todo', async () => {
  const task = tasks.save({ title: '后续', plan: '', sources, todos: [], notes: [] })
  const oldTodo = memory.remember({ kind: 'todo', text: '旧事项', taskId: task.id, sources })
  await tick()
  const newTodo = memory.remember({ kind: 'todo', text: '新事项', taskId: task.id, sources })
  const result = memory.reduce({ superseded: [{ id: oldTodo.id, by: newTodo.id }] })
  expect(result.archivedIds).toEqual([])
  expect(memory.list().map(item => item.id)).toEqual([oldTodo.id, newTodo.id])
  expect(tasks.read(task.id).task.todos.map(todo => todo.id)).toEqual([oldTodo.id, newTodo.id])
})
it('archives every completed duplicate and leaves no mirror in the items directory or second full copy', () => {
  const task = tasks.save({ title: '检查', plan: '', sources, todos: [], notes: [] })
  const text = '检查完成并保留完整原文'.repeat(20)
  memory.remember({ kind: 'todo', text, taskId: task.id, sources })
  memory.remember({ kind: 'todo', text, taskId: task.id, sources })
  const list = tasks.read(task.id).task
  tasks.save({ ...list, todos: list.todos.map(todo => ({ ...todo, done: true })) })
  const result = memory.reduce()
  expect(result.archivedIds).toHaveLength(2)
  expect(memory.list()).toEqual([])
  expect(tasks.read(task.id).task.todos).toEqual([])
  expect(readFileSync(tasks.read(task.id).path, 'utf8')).not.toContain(text)
  expect(itemFiles()).toEqual([])
  expect(memory.reduce().archivedIds).toEqual([])
  const copies = new MemoryStore(root).list('tasks').filter(record => record.content.includes(text))
  expect(copies).toHaveLength(2)
  for (const record of copies) expect(record.content.split(text)).toHaveLength(2)
  expect(new TaskReduction(root, tasks).reduce().archived).toEqual([])
})
it('reopens archived items through the short index and reflects manual edits of Markdown and archive', async () => {
  const first = memory.remember({ kind: 'experience', text: '重复经验', sources })
  await tick()
  const extra = memory.remember({ kind: 'experience', text: '重复经验', sources: [otherSource] })
  memory.reduce()
  expect(itemFiles()).toEqual([first.id + '.md'])
  const reopened = new ShortTerm(root, tasks)
  expect(reopened.list().map(item => item.id)).toEqual([first.id])
  const archived = reopened.read(extra.id)
  expect(archived).toMatchObject({ id: extra.id, text: '重复经验', sources: [otherSource],
    owner: { kind: 'archive', archiveId: archiveIdOf(extra.id), entryId: extra.id } })
  expect(archived.path).toBe(join(root, 'tasks', archiveIdOf(extra.id) + '.json'))
  const active = reopened.read(first.id)
  writeFileSync(active.path, readFileSync(active.path, 'utf8').replace('重复经验', '人工修正后的经验'))
  expect(reopened.read(first.id).text).toBe('人工修正后的经验')
  expect(reopened.read(first.id).version).not.toBe(active.version)
  const record = JSON.parse(readFileSync(archived.path, 'utf8')) as { content: string }
  const content = JSON.parse(record.content) as { item: { text: string } }
  content.item.text = '归档后人工修正'
  record.content = JSON.stringify(content)
  writeFileSync(archived.path, JSON.stringify(record))
  expect(reopened.read(extra.id).text).toBe('归档后人工修正')
})
it('keeps both archive routes readable by original ID when ShortTerm reduces before TaskReduction', () => {
  const local = new TaskLists(root, id => id === 't1' ? ticket('t1', true) : undefined)
  local.save({ id: 't1', title: '收尾', plan: '继续收尾', sources,
    todos: [{ id: 'todo-a', text: '完成的检查', done: true, sources: [source] }],
    notes: [{ id: 'note-1', text: '保留排序', recipient: 'Worker', sources: [otherSource] }] })
  const view = new ShortTerm(root, local)
  expect(view.reduce().archivedIds).toEqual(['todo-a'])
  expect(new TaskReduction(root, local).reduce().archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])

  const reopened = new ShortTerm(root, local)
  expect(reopened.read('todo-a')).toMatchObject({ text: '完成的检查', sources: [source],
    owner: { kind: 'archive', archiveId: archiveIdOf('todo-a'), entryId: 'todo-a' } })
  expect(reopened.read('note-1')).toMatchObject({ text: '保留排序', recipient: 'Worker', sources: [otherSource],
    owner: { kind: 'archive', archiveId: 'task-t1', entryId: 'note-1' } })
  expect(view.read('note-1').owner).toMatchObject({ kind: 'archive', archiveId: 'task-t1' })
  const records = new MemoryStore(root).list('tasks')
  expect(records.filter(record => record.content.includes('完成的检查'))).toHaveLength(1)
  expect(records.filter(record => record.content.includes('保留排序'))).toHaveLength(1)
})
it('keeps both archive routes readable by original ID when TaskReduction reduces first', () => {
  const local = new TaskLists(root, id => id === 't1' ? ticket('t1', true) : undefined)
  local.save({ id: 't1', title: '收尾', plan: '继续收尾', sources,
    todos: [{ id: 'todo-a', text: '完成的检查', done: true, sources: [source] }],
    notes: [{ id: 'note-1', text: '保留排序', recipient: 'Worker', sources: [otherSource] }] })
  const view = new ShortTerm(root, local)
  expect(new TaskReduction(root, local).reduce().archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  expect(view.read('todo-a')).toMatchObject({ text: '完成的检查', sources: [source], taskId: 't1',
    owner: { kind: 'archive', archiveId: 'task-t1', entryId: 'todo-a' } })
  expect(view.read('note-1')).toMatchObject({ text: '保留排序', recipient: 'Worker',
    owner: { kind: 'archive', archiveId: 'task-t1', entryId: 'note-1' } })
  expect(view.list()).toEqual([])
  expect(view.reduce().archivedIds).toEqual([])

  const reopened = new ShortTerm(root, new TaskLists(root, id => id === 't1' ? ticket('t1', true) : undefined))
  expect(reopened.read('todo-a').text).toBe('完成的检查')
  expect(reopened.read('note-1').text).toBe('保留排序')
  const records = new MemoryStore(root).list('tasks')
  expect(records.filter(record => record.content.includes('完成的检查'))).toHaveLength(1)
  expect(records.filter(record => record.content.includes('保留排序'))).toHaveLength(1)
})
