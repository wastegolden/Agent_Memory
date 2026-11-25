/** Project archives snapshot and archive the listed tasks whole, keep original IDs readable, and restore them without overwriting other attachments. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { Ticket } from '../../src/core/ports/ticket-model.ts'
import { reduceMemory } from '../../src/core/adapters/memory-reduction.ts'
import { ProjectArchives } from '../../src/core/project-archives.ts'
import { ShortTerm } from '../../src/core/short-term.ts'
import { MemoryStore } from '../../src/core/store.ts'
import { TaskLists } from '../../src/core/task-lists.ts'
import { TaskReduction } from '../../src/core/task-reduction.ts'

const AT = '2026-09-09T00:00:00.000Z'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })
const freshRoot = (): string => { const path = mkdtempSync(join(tmpdir(), 'project-archives-')); directories.push(path); return path }

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
/** One explicit attachment file under the memory root's fixture files directory. */
function attachmentFixture(root: string, name: string, content: string): string {
  const directory = join(root, 'files')
  mkdirSync(directory, { recursive: true })
  const path = join(directory, name)
  writeFileSync(path, content, 'utf8')
  return path
}
const archiveFiles = (root: string): string[] => readdirSync(join(root, 'tasks')).filter(name => name.startsWith('archive-'))
const itemIndexOf = (root: string): Record<string, { reason: string; archiveId: string; taskId?: string; part?: string }> =>
  JSON.parse(readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')) as
    Record<string, { reason: string; archiveId: string; taskId?: string; part?: string }>

it('snapshots the listed tasks without moving anything out of the active list', () => {
  const root = freshRoot()
  const attachment = attachmentFixture(root, 'brief.txt', '附件原文')
  const tasks = lists(root, [ticket('p'), ticket('t1')])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [{ kind: 'feishu', id: 'm0' }],
    attachments: [{ id: 'att-p', path: attachment, name: '说明' }],
    todos: [{ id: 'todo-p', text: '项目待办', done: false }], notes: [{ id: 'note-p', text: '项目便签' }] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [] })
  const before = tasks.list().map(read => [read.task.id, readFileSync(read.path, 'utf8')] as const).sort()
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.snapshot('p', ['p', 't1'])

  expect(meta).toMatchObject({ projectId: 'p', kind: 'snapshot', taskIds: ['p', 't1'] })
  expect(meta.reason).toBeUndefined()
  expect(tasks.list().map(read => [read.task.id, readFileSync(read.path, 'utf8')] as const).sort()).toEqual(before)
  expect(tasks.isArchived('p')).toBe(false)
  expect(tasks.isArchived('t1')).toBe(false)
  expect(existsSync(join(root, 'short-term', 'archived-tasks.json'))).toBe(false)
  expect(existsSync(join(root, 'short-term', 'item-index.json'))).toBe(false)
  const view = archives.read(meta.archiveId)
  expect(view.bundle).toMatchObject({ projectId: 'p', kind: 'snapshot', taskIds: ['p', 't1'] })
  const project = view.bundle.tasks.find(task => task.taskId === 'p')
  expect(project).toMatchObject({ title: '项目', plan: '项目计划', sources: [{ kind: 'feishu', id: 'm0' }],
    todos: [{ id: 'todo-p', text: '项目待办', done: false }], notes: [{ id: 'note-p', text: '项目便签' }] })
  const copied = view.bundle.attachments.find(entry => entry.id === 'att-p')!
  expect(copied).toMatchObject({ taskId: 'p', id: 'att-p', name: '说明', path: attachment })
  expect(readFileSync(copied.archivePath, 'utf8')).toBe('附件原文')
  expect(archiveFiles(root)).toEqual([meta.archiveId + '.json'])
  // The active short-term entries still read from the task files.
  expect(new ShortTerm(root, tasks).read('todo-p')).toMatchObject({ text: '项目待办',
    owner: { kind: 'task', taskId: 'p', entryId: 'todo-p' } })
})

it('archives a paused project out of the active list and keeps its original IDs readable', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p'), ticket('t1'), ticket('other')])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [{ kind: 'feishu', id: 'm0' }],
    todos: [], notes: [{ id: 'note-p', text: '项目便签' }] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [{ id: 'note-1', text: '保留排序' }] })
  tasks.save({ id: 'other', title: '其他项目', plan: '其他计划', sources: [],
    todos: [{ id: 'other-1', text: '其他待办', done: false }], notes: [] })
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.archive('p', ['p', 't1'], 'paused',
    { supervisorSessionId: 'session-p', workerSessionIds: ['worker-1'] })

  expect(meta).toMatchObject({ projectId: 'p', kind: 'archive', reason: 'paused', taskIds: ['p', 't1'],
    references: { supervisorSessionId: 'session-p', workerSessionIds: ['worker-1'] } })
  expect(tasks.list().map(read => read.task.id).sort()).toEqual(['other'])
  expect(tasks.isArchived('p')).toBe(true)
  expect(tasks.isArchived('t1')).toBe(true)
  expect(tasks.isArchived('other')).toBe(false)
  // The original files stay on disk as the preserved root data.
  expect(existsSync(join(tasks.root, 'p.md'))).toBe(true)
  expect(existsSync(join(tasks.root, 't1.md'))).toBe(true)
  // Reading by the original task ID resolves the complete archived content.
  const read = tasks.read('t1')
  expect(read.path).toBe(join(root, 'tasks', meta.archiveId + '.json'))
  expect(read.task).toMatchObject({ id: 't1', title: '任务', plan: '任务计划',
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [{ id: 'note-1', text: '保留排序' }] })
  // A generic save cannot take an archived task back into the active list.
  expect(() => tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [], todos: [], notes: [] }))
    .toThrow(/archived/)
  // Original short-term entries stay readable from the bundle.
  const shortTerm = new ShortTerm(root, tasks)
  expect(shortTerm.read('todo-1')).toMatchObject({ text: '检查', taskId: 't1',
    owner: { kind: 'archive', archiveId: meta.archiveId, entryId: 'todo-1' } })
  expect(shortTerm.read('note-1')).toMatchObject({ text: '保留排序', taskId: 't1',
    owner: { kind: 'archive', archiveId: meta.archiveId, entryId: 'note-1' } })
  expect(itemIndexOf(root)['todo-1']).toMatchObject({ reason: 'archived', archiveId: meta.archiveId, part: 'todos' })
  // Only the listed tasks were archived; the other project still reads from its own file.
  expect(tasks.read('other').path).toBe(join(tasks.root, 'other.md'))
  expect(shortTerm.read('other-1')).toMatchObject({ text: '其他待办', owner: { kind: 'task', taskId: 'other' } })
  expect(archives.read(meta.archiveId).bundle.references).toEqual(meta.references)
})

it('copies explicit attachments and restores them without overwriting different content', () => {
  const root = freshRoot()
  const brief = attachmentFixture(root, 'brief.txt', '附件原文')
  const edited = attachmentFixture(root, 'edited.txt', '原始内容')
  const tasks = lists(root, [ticket('p'), ticket('t1')])
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '', sources: [], todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [],
    attachments: [{ id: 'brief', path: brief, name: '说明' }, { id: 'edited', path: edited }] })
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.archive('p', ['p', 't1'], 'paused')

  const manifest = archives.read(meta.archiveId).bundle.attachments
  expect(manifest.map(entry => entry.id)).toEqual(['brief', 'edited'])
  expect(manifest.map(entry => readFileSync(entry.archivePath, 'utf8'))).toEqual(['附件原文', '原始内容'])
  expect(manifest.every(entry => entry.sha256.length === 64)).toBe(true)
  const archivedIndex = readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')
  rmSync(brief)
  writeFileSync(edited, '本地修改')

  const blocked = archives.restore(meta.archiveId)

  expect(blocked).toMatchObject({ archiveId: meta.archiveId, projectId: 'p', restored: false })
  expect(blocked.attachments).toEqual([{ taskId: 't1', id: 'edited', path: edited,
    archivePath: manifest[1]!.archivePath, status: 'conflict', reason: 'different-content' }])
  // A conflict changes nothing: the checklist, the item pointers and the archive stay as they were.
  expect(tasks.isArchived('t1')).toBe(true)
  expect(readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')).toBe(archivedIndex)
  expect(existsSync(brief)).toBe(false)
  expect(readFileSync(edited, 'utf8')).toBe('本地修改')

  writeFileSync(edited, '原始内容')
  const restored = archives.restore(meta.archiveId)

  expect(restored).toMatchObject({ restored: true })
  expect(restored.attachments).toEqual([
    { taskId: 't1', id: 'brief', path: brief, archivePath: manifest[0]!.archivePath, status: 'restored' },
    { taskId: 't1', id: 'edited', path: edited, archivePath: manifest[1]!.archivePath, status: 'unchanged' },
  ])
  expect(readFileSync(brief, 'utf8')).toBe('附件原文')
  expect(readFileSync(edited, 'utf8')).toBe('原始内容')
  expect(tasks.isArchived('t1')).toBe(false)
  expect(tasks.list().map(read => read.task.id).sort()).toEqual(['p', 't1'])
  const shortTerm = new ShortTerm(root, tasks)
  expect(shortTerm.read('todo-1')).toMatchObject({ text: '检查',
    owner: { kind: 'task', taskId: 't1', entryId: 'todo-1' } })
  expect(itemIndexOf(root)['todo-1']).toBeUndefined()
  // The archived copies remain traceable after the restore.
  expect(existsSync(manifest[0]!.archivePath)).toBe(true)
  expect(archives.read(meta.archiveId).bundle.taskIds).toEqual(['p', 't1'])
})

it('includes entries TaskReduction already moved and restores them with their original IDs', () => {
  const root = freshRoot()
  const brief = attachmentFixture(root, 'brief.txt', '文件内容')
  const tasks = lists(root, [ticket('p'), ticket('t1', true)])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '完整计划', sources: [{ kind: 'feishu', id: 'm1' }],
    attachments: [{ id: 'brief', path: brief }],
    todos: [{ id: 'read-1', text: '检查构建', done: true }, { id: 'done-2', text: '发布', done: true }],
    notes: [{ id: 'note-1', text: '保留排序' }] })
  new TaskReduction(root, tasks).reduce()
  // The collapsed list keeps the attachment registry; its full plan and entries live in the reduction archive.
  expect(tasks.read('t1').task).toMatchObject({ plan: 'Archived details: tasks/task-t1', todos: [], notes: [],
    attachments: [{ id: 'brief', path: brief }] })
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.archive('p', ['p', 't1'], 'closed')

  const archived = archives.read(meta.archiveId).bundle.tasks.find(task => task.taskId === 't1')!
  expect(archived).toMatchObject({ plan: '完整计划', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'read-1', text: '检查构建', done: true }, { id: 'done-2', text: '发布', done: true }],
    notes: [{ id: 'note-1', text: '保留排序' }] })
  expect(new Set(archived.todos.map(todo => todo.id)).size).toBe(archived.todos.length)
  expect(archives.read(meta.archiveId).bundle.attachments.map(entry => entry.id)).toEqual(['brief'])
  const shortTerm = new ShortTerm(root, tasks)
  expect(shortTerm.read('read-1')).toMatchObject({ text: '检查构建',
    owner: { kind: 'archive', archiveId: meta.archiveId, entryId: 'read-1' } })
  // TaskReduction's own archive record stays on disk and readable.
  expect(existsSync(join(root, 'tasks', 'task-t1.json'))).toBe(true)

  const restored = archives.restore(meta.archiveId)

  expect(restored.restored).toBe(true)
  expect(tasks.read('t1').task).toMatchObject({ id: 't1', plan: '完整计划', sources: [{ kind: 'feishu', id: 'm1' }],
    todos: [{ id: 'read-1', done: true }, { id: 'done-2', done: true }], notes: [{ id: 'note-1' }] })
  expect(shortTerm.read('read-1')).toMatchObject({ text: '检查构建',
    owner: { kind: 'task', taskId: 't1', entryId: 'read-1' } })
  const index = itemIndexOf(root)
  expect(index['read-1']).toBeUndefined()
  expect(index['done-2']).toBeUndefined()
  expect(index['note-1']).toBeUndefined()
})

it('keeps every entry reduceMemory already reduced when the project archive is written afterwards', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p'), ticket('t1', true), ticket('other')])
  const origin = { kind: 'feishu', id: 'm1' }
  const otherOrigin = { kind: 'feishu', id: 'm2' }
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [origin], todos: [
    { id: 'todo-done', text: '已完成的检查', done: true, kind: 'todo', sources: [origin], createdAt: '2026-09-09T00:00:01.000Z' },
    { id: 'todo-dup-1', text: '重复待办', done: true, kind: 'todo', createdAt: '2026-09-09T00:00:02.000Z' },
    { id: 'todo-dup-2', text: '重复待办', done: true, kind: 'todo', createdAt: '2026-09-09T00:00:03.000Z' },
  ], notes: [
    { id: 'note-old', text: '旧约定', kind: 'agreement', recipient: 'xiaolin', sources: [origin],
      createdAt: '2026-09-09T00:00:04.000Z' },
    { id: 'note-new', text: '新约定', kind: 'agreement', recipient: 'xiaolin', sources: [otherOrigin],
      createdAt: '2026-09-09T00:00:05.000Z' },
    { id: 'note-dup-1', text: '重复便签', kind: 'note', createdAt: '2026-09-09T00:00:06.000Z' },
    { id: 'note-dup-2', text: '重复便签', kind: 'note', createdAt: '2026-09-09T00:00:07.000Z' },
  ] })
  tasks.save({ id: 'other', title: '其他项目', plan: '其他计划', sources: [],
    todos: [{ id: 'other-done', text: '其他完成', done: true, kind: 'todo', createdAt: '2026-09-09T00:00:08.000Z' }], notes: [] })
  const shortTerm = new ShortTerm(root, tasks)
  const independent = shortTerm.remember({ kind: 'experience', text: '独立经验', sources: [origin] })
  const independentRepeat = shortTerm.remember({ kind: 'experience', text: '独立经验', sources: [otherOrigin] })

  // The real reduceMemory order: ShortTerm moves the finished/replaced/repeated entries, then TaskReduction collapses.
  const reduced = reduceMemory(shortTerm, new TaskReduction(root, tasks), [{ id: 'note-old', by: 'note-new' }])
  expect(reduced.tasks.archived).toEqual([{ taskId: 't1', archiveId: 'task-t1' }])
  const reducedIndex = itemIndexOf(root)
  const oldNoteLocation = reducedIndex['note-old']!
  expect(oldNoteLocation).toMatchObject({ reason: 'superseded', replacedBy: 'note-new' })
  expect(reducedIndex['todo-done']).toMatchObject({ reason: 'completed' })
  expect(reducedIndex['other-done']).toMatchObject({ reason: 'completed' })
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.archive('p', ['p', 't1'], 'closed')

  const bundle = archives.read(meta.archiveId).bundle
  const project = bundle.tasks.find(task => task.taskId === 'p')!
  expect(project).toMatchObject({ title: '项目', todos: [], notes: [] })
  const archived = bundle.tasks.find(task => task.taskId === 't1')!
  // The complete list returns under the original IDs, with the sources each entry had.
  expect(archived.todos.map(todo => todo.id)).toEqual(['todo-done', 'todo-dup-1', 'todo-dup-2'])
  expect(archived.todos[0]).toMatchObject({ text: '已完成的检查', done: true, sources: [origin] })
  expect(archived.notes.map(note => note.id)).toEqual(['note-new', 'note-dup-1'])
  expect(archived.sources).toEqual([origin])
  // The five item-* entries belong to t1 and only t1; another task and an independent item never come in.
  const reducedItems = bundle.reducedItems ?? []
  expect(reducedItems.map(item => item.id)).toEqual(['todo-done', 'todo-dup-1', 'todo-dup-2', 'note-old', 'note-dup-2'])
  expect(reducedItems.every(item => item.taskId === 't1')).toBe(true)
  expect(reducedItems.find(item => item.id === 'note-old')).toMatchObject({ reason: 'superseded',
    replacedBy: 'note-new', text: '旧约定', sources: [origin], archiveId: oldNoteLocation.archiveId })
  expect(reducedItems.find(item => item.id === 'note-dup-2')).toMatchObject({ reason: 'duplicate', text: '重复便签' })
  expect(reducedItems.find(item => item.id === 'todo-dup-2')).toMatchObject({ reason: 'duplicate' })
  expect(reducedItems.find(item => item.id === 'todo-done')).toMatchObject({ reason: 'completed', id: 'todo-done' })
  expect(reducedItems.some(item => item.id === 'other-done' || item.id === independent.id
    || item.id === independentRepeat.id)).toBe(false)
  // Both archive routes read back by original ID: the project bundle holds the todos, the item records the notes.
  expect(tasks.read('t1').task.todos.map(todo => todo.id)).toEqual(['todo-done', 'todo-dup-1', 'todo-dup-2'])
  expect(tasks.read('t1').task.notes.map(note => note.id)).toEqual(['note-new', 'note-dup-1'])
  const view = new ShortTerm(root, tasks)
  expect(view.read('todo-done')).toMatchObject({ text: '已完成的检查',
    owner: { kind: 'archive', archiveId: meta.archiveId, entryId: 'todo-done' } })
  expect(view.read('note-old')).toMatchObject({ text: '旧约定', sources: [origin],
    owner: { kind: 'archive', archiveId: oldNoteLocation.archiveId, entryId: 'note-old' } })
  expect(view.read('note-dup-2')).toMatchObject({ text: '重复便签',
    owner: { kind: 'archive', archiveId: reducedIndex['note-dup-2']!.archiveId, entryId: 'note-dup-2' } })

  expect(archives.restore(meta.archiveId).restored).toBe(true)

  const restored = tasks.read('t1').task
  // The completed todo list restores whole; the replaced and repeated notes are not revived as valid instructions.
  expect(restored.todos.map(todo => todo.id)).toEqual(['todo-done', 'todo-dup-1', 'todo-dup-2'])
  expect(restored.todos.every(todo => todo.done)).toBe(true)
  expect(restored.notes.map(note => note.id)).toEqual(['note-new', 'note-dup-1'])
  const reopened = new ShortTerm(root, tasks)
  expect(reopened.read('todo-done')).toMatchObject({ owner: { kind: 'task', taskId: 't1', entryId: 'todo-done' } })
  expect(reopened.read('note-old')).toMatchObject({ text: '旧约定', owner: { kind: 'archive', entryId: 'note-old' } })
  expect(reopened.read('note-dup-2')).toMatchObject({ text: '重复便签', owner: { kind: 'archive', entryId: 'note-dup-2' } })
  // Reduced history keeps its reason, replacement and old-ID location after the restore.
  const afterRestore = itemIndexOf(root)
  expect(afterRestore['note-old']).toMatchObject({ reason: 'superseded', replacedBy: 'note-new',
    archiveId: oldNoteLocation.archiveId })
  expect(afterRestore['note-dup-2']).toMatchObject({ reason: 'duplicate',
    archiveId: reducedIndex['note-dup-2']!.archiveId })
  expect(afterRestore['todo-done']).toBeUndefined()
  // The other task kept working: only its reduced entry moved, and the restore never touched it.
  expect(tasks.isArchived('other')).toBe(false)
  expect(tasks.read('other').task.todos).toEqual([])
})

it('keeps the latest reduced todo once and leaves superseded notes in history when archiving again after restore', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p'), ticket('t1', true)])
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '完整计划', sources: [],
    todos: [{ id: 'done', text: '旧检查结果', done: true }],
    notes: [{ id: 'old-note', text: '旧约定', kind: 'agreement' }] })
  const reduction = new TaskReduction(root, tasks)
  reduction.reduce()
  const archives = new ProjectArchives(root, tasks)
  const first = archives.archive('p', ['p', 't1'], 'closed')
  archives.restore(first.archiveId)
  const restored = tasks.read('t1').task
  tasks.save({ ...restored, todos: restored.todos.map(todo => ({ ...todo, text: '修正后的检查结果' })),
    notes: [...restored.notes, { id: 'new-note', text: '新约定', kind: 'agreement' }] })
  reduceMemory(new ShortTerm(root, tasks), reduction, [{ id: 'old-note', by: 'new-note' }])

  const second = archives.archive('p', ['p', 't1'], 'closed')
  const bundle = archives.read(second.archiveId).bundle
  const archived = bundle.tasks.find(task => task.taskId === 't1')!
  expect.soft(archived.todos.map(todo => todo.id)).toEqual(['done'])
  expect.soft(archived.todos[0]!.text).toBe('修正后的检查结果')
  expect.soft(archived.notes.map(note => note.id)).toEqual(['new-note'])
  expect(bundle.reducedItems?.find(item => item.id === 'old-note')).toMatchObject({
    reason: 'superseded', replacedBy: 'new-note', text: '旧约定' })

  expect(archives.restore(second.archiveId).restored).toBe(true)
  expect(tasks.read('t1').task.todos).toMatchObject([{ id: 'done', text: '修正后的检查结果', done: true }])
  expect(tasks.read('t1').task.todos).toHaveLength(1)
  expect(tasks.read('t1').task.notes.map(note => note.id)).toEqual(['new-note'])
  expect(new ShortTerm(root, tasks).read('old-note')).toMatchObject({
    text: '旧约定', owner: { kind: 'archive', entryId: 'old-note' } })
  expect(itemIndexOf(root)['old-note']).toMatchObject({ reason: 'superseded', replacedBy: 'new-note' })
  expect(archives.read(first.archiveId).bundle.tasks.find(task => task.taskId === 't1')!.notes[0]!.id).toBe('old-note')
})

it('restores only the archive its tasks still point at and refuses repeating or superseding it', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p'), ticket('t1')])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [{ id: 'note-1', text: '原始便签' }] })
  const archives = new ProjectArchives(root, tasks)

  // A snapshot is history: it never rolls the active tasks back.
  const snapshot = archives.snapshot('p', ['p', 't1'])
  const snapshotMarkdown = readFileSync(join(tasks.root, 't1.md'), 'utf8')
  expect(() => archives.restore(snapshot.archiveId)).toThrow(/snapshot/)
  expect(tasks.isArchived('t1')).toBe(false)
  expect(readFileSync(join(tasks.root, 't1.md'), 'utf8')).toBe(snapshotMarkdown)
  expect(existsSync(join(root, 'short-term', 'archived-tasks.json'))).toBe(false)
  expect(existsSync(join(root, 'short-term', 'item-index.json'))).toBe(false)

  const first = archives.archive('p', ['p', 't1'], 'paused')
  expect(archives.restore(first.archiveId).restored).toBe(true)
  // A person edits the restored task after its archive was consumed.
  const edited = tasks.read('t1').task
  tasks.save({ ...edited, notes: [{ id: 'note-edited', text: '恢复后人工修改' }] })
  const editedMarkdown = readFileSync(join(tasks.root, 't1.md'), 'utf8')
  const editedIndex = readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')
  // The very same archive cannot be applied a second time over the newer edits, and writes nothing.
  expect(() => archives.restore(first.archiveId)).toThrow(/not current/)
  expect(tasks.isArchived('t1')).toBe(false)
  expect(readFileSync(join(tasks.root, 't1.md'), 'utf8')).toBe(editedMarkdown)
  expect(readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')).toBe(editedIndex)

  const second = archives.archive('p', ['p', 't1'], 'closed')
  expect(archives.read(second.archiveId).bundle.tasks.find(task => task.taskId === 't1')!.notes.map(note => note.id))
    .toEqual(['note-edited'])
  const archivedMarkdown = readFileSync(join(tasks.root, 't1.md'), 'utf8')
  const archivedIndex = readFileSync(join(root, 'short-term', 'archived-tasks.json'), 'utf8')
  const archivedItemIndex = readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')
  // A stale archive cannot roll the current one back, and leaves the current index and files untouched.
  expect(() => archives.restore(first.archiveId)).toThrow(/not current/)
  expect(tasks.isArchived('p')).toBe(true)
  expect(tasks.read('t1').path).toBe(join(root, 'tasks', second.archiveId + '.json'))
  expect(tasks.read('t1').task.notes.map(note => note.id)).toEqual(['note-edited'])
  expect(readFileSync(join(tasks.root, 't1.md'), 'utf8')).toBe(archivedMarkdown)
  expect(readFileSync(join(root, 'short-term', 'archived-tasks.json'), 'utf8')).toBe(archivedIndex)
  expect(readFileSync(join(root, 'short-term', 'item-index.json'), 'utf8')).toBe(archivedItemIndex)
})

it('recovers archived tasks and entries after a restart without touching another project', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p'), ticket('t1'), ticket('other')])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [], todos: [], notes: [] })
  tasks.save({ id: 't1', title: '任务', plan: '任务计划', sources: [],
    todos: [{ id: 'todo-1', text: '检查', done: false }], notes: [] })
  tasks.save({ id: 'other', title: '其他项目', plan: '其他计划', sources: [],
    todos: [{ id: 'other-1', text: '其他待办', done: false }], notes: [] })
  const meta = new ProjectArchives(root, tasks).archive('p', ['p', 't1'], 'paused')

  // A new process opens the same memory root: the archive location index and item index resolve again.
  const reopened = lists(root, [ticket('p'), ticket('t1'), ticket('other')])
  const shortTerm = new ShortTerm(root, reopened)
  shortTerm.reconcile()

  expect(reopened.list().map(read => read.task.id).sort()).toEqual(['other'])
  expect(reopened.isArchived('t1')).toBe(true)
  expect(reopened.read('t1').task).toMatchObject({ id: 't1', todos: [{ id: 'todo-1', text: '检查' }] })
  expect(shortTerm.read('todo-1')).toMatchObject({ text: '检查',
    owner: { kind: 'archive', archiveId: meta.archiveId, entryId: 'todo-1' } })
  expect(reopened.read('other').path).toBe(join(reopened.root, 'other.md'))
  expect(shortTerm.read('other-1')).toMatchObject({ owner: { kind: 'task', taskId: 'other' } })
  const restarted = new ProjectArchives(root, reopened)
  expect(restarted.read(meta.archiveId).bundle.taskIds).toEqual(['p', 't1'])

  expect(restarted.restore(meta.archiveId).restored).toBe(true)

  expect(reopened.list().map(read => read.task.id).sort()).toEqual(['other', 'p', 't1'])
  expect(shortTerm.read('todo-1')).toMatchObject({ owner: { kind: 'task', taskId: 't1' } })
  expect(shortTerm.read('other-1')).toMatchObject({ owner: { kind: 'task', taskId: 'other' } })
})

it('refuses credentials and private-tree attachments before writing any archive', () => {
  const root = freshRoot()
  const tasks = lists(root, [ticket('p')])
  tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [] })
  const secrets = join(root, 'secrets')
  mkdirSync(secrets, { recursive: true })
  const credentials = join(secrets, '.credentials.yaml')
  writeFileSync(credentials, 'secret', 'utf8')
  const runtimePrivate = join(root, 'runtime', 'private')
  mkdirSync(runtimePrivate, { recursive: true })
  const runtimeFile = join(runtimePrivate, 'secret.txt')
  writeFileSync(runtimeFile, 'secret', 'utf8')
  const dataPrivate = join(root, 'data', 'private')
  mkdirSync(dataPrivate, { recursive: true })
  const dataFile = join(dataPrivate, 'secret.txt')
  writeFileSync(dataFile, 'secret', 'utf8')
  const archives = new ProjectArchives(root, tasks)

  for (const path of [credentials, runtimeFile, dataFile,
    root + '/runtime/ordinary/../private/secret.txt',
    root + '/data/ordinary/../private/secret.txt',
    root + '/.codex/auth.json', root + '/codex-dsh-bridge/token.txt']) {
    tasks.save({ id: 'p', title: '项目', plan: '', sources: [], todos: [], notes: [],
      attachments: [{ id: 'secret', path }] })
    expect(() => archives.snapshot('p', ['p'])).toThrow(/not an ordinary attachment/)
    expect(() => archives.archive('p', ['p'], 'paused')).toThrow(/not an ordinary attachment/)
  }

  expect(archiveFiles(root)).toEqual([])
  expect(existsSync(join(root, 'archives'))).toBe(false)
  expect(tasks.isArchived('p')).toBe(false)
  expect(tasks.read('p').task.title).toBe('项目')
})

it('archives only the listed tasks and leaves another project and its attachment untouched', () => {
  const root = freshRoot()
  const otherAttachment = attachmentFixture(root, 'other.txt', '其他附件')
  const tasks = lists(root, [ticket('p'), ticket('other')])
  tasks.save({ id: 'p', title: '项目', plan: '项目计划', sources: [], todos: [], notes: [] })
  tasks.save({ id: 'other', title: '其他项目', plan: '其他计划', sources: [],
    todos: [{ id: 'other-1', text: '其他待办', done: false }], notes: [],
    attachments: [{ id: 'other-att', path: otherAttachment }] })
  const otherMarkdown = readFileSync(join(tasks.root, 'other.md'), 'utf8')
  const archives = new ProjectArchives(root, tasks)

  const meta = archives.archive('p', ['p'], 'closed')

  expect(archives.read(meta.archiveId).bundle.taskIds).toEqual(['p'])
  expect(archives.read(meta.archiveId).bundle.attachments).toEqual([])
  expect(tasks.isArchived('other')).toBe(false)
  expect(tasks.list().map(read => read.task.id).sort()).toEqual(['other'])
  expect(readFileSync(join(tasks.root, 'other.md'), 'utf8')).toBe(otherMarkdown)
  expect(existsSync(join(root, 'archives', meta.archiveId, 'attachments'))).toBe(false)
  expect(new ShortTerm(root, tasks).read('other-1')).toMatchObject({ owner: { kind: 'task', taskId: 'other' } })
  // The bundle is the tasks-library record its metadata points at.
  expect(existsSync(meta.path)).toBe(true)
  expect(new MemoryStore(root).get('tasks', meta.archiveId).source).toEqual({ kind: 'project', id: 'p' })
})
