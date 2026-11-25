/** Shrinks task lists by archiving completed todos, and collapses fully finished ended tasks into a one-line index. */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishFile } from './files.ts'
import type { ShortTermArchiveLocation } from './short-term.ts'
import { MemoryStore, type MemorySource } from './store.ts'
import type { TaskList, TaskLists } from './task-lists.ts'

type Todo = TaskList['todos'][number]
type Note = TaskList['notes'][number]
/** One task's archive: its latest identity and sources, every archived todo by ID, and its current notes. */
export interface TaskArchive { taskId: string; title: string; plan: string; sources: MemorySource[]; todos: Todo[]; notes: Note[]; archivedAt: string }
/** What one reduction changed: the task JSON characters before and after, and the archives it wrote. */
export interface TaskReductionResult {
  beforeChars: number
  afterChars: number
  archived: { taskId: string; archiveId: string }[]
}
/** One task has one archive, so later completions merge into the record earlier ones made. */
export const taskArchiveIdOf = (taskId: string): string => `task-${taskId}`
/** The whole plan of a collapsed task, pointing a reader at its archive in the memory tasks library. */
export const archivePlanOf = (taskId: string): string => `Archived details: tasks/${taskArchiveIdOf(taskId)}`

/**
 * Moves finished details out of the active task lists into the memory tasks library, leaving active work readable and
 * short. The archive keeps each original todo and note, and its short-term item index rows let `ShortTerm.read` find
 * the archived entry by its original ID after the task file no longer holds it.
 */
export class TaskReduction {
  private readonly store: MemoryStore
  private readonly indexPath: string
  private readonly itemIndexPath: string
  /** Opens the reduction over the same memory index the TaskLists and short-term view use, so archives are located once. */
  constructor(memoryRoot: string, private readonly tasks: TaskLists) {
    this.store = new MemoryStore(memoryRoot, { index: tasks.index })
    this.indexPath = join(memoryRoot, 'short-term', 'task-index.json')
    this.itemIndexPath = join(memoryRoot, 'short-term', 'item-index.json')
  }
  /** Archives completed todos, trims them from each list, and collapses an ended list whose work has all finished. */
  reduce(): TaskReductionResult {
    const before = this.tasks.list()
    const beforeChars = before.reduce((sum, item) => sum + JSON.stringify(item.task).length, 0)
    const archived: { taskId: string; archiveId: string }[] = []
    for (const { task, runtime } of before) {
      const done = task.todos.filter(todo => todo.done)
      const rest = task.todos.filter(todo => !todo.done)
      if (runtime?.ended && rest.length === 0) {
        const plan = archivePlanOf(task.id)
        if (task.plan === plan && task.todos.length === 0 && task.notes.length === 0) continue
        // Save the whole archive first, locate every removed entry in it, then empty the one task file.
        const entry = this.archive(task, task.todos, true)
        this.locateEntries(entry.archiveId, task.id, task.todos, task.notes)
        archived.push(entry)
        // The attachment registry stays on the collapsed list: it is not part of the reduced task content.
        this.tasks.save({ id: task.id, title: task.title, plan, sources: task.sources, todos: [], notes: [],
          ...(task.attachments === undefined ? {} : { attachments: task.attachments }) })
      } else if (done.length) {
        // Only the completed content moves; unfinished todos and still-active notes stay in the original file.
        const entry = this.archive(task, done)
        this.locateEntries(entry.archiveId, task.id, done, [])
        archived.push(entry)
        this.tasks.save({ ...task, todos: rest })
      }
    }
    const afterChars = this.tasks.list().reduce((sum, item) => sum + JSON.stringify(item.task).length, 0)
    return { beforeChars, afterChars, archived }
  }
  /** Writes `todos` into the task's archive, replacing todos of the same ID and keeping every older archived todo and source. */
  private archive(task: TaskList, todos: Todo[], collapse = false): { taskId: string; archiveId: string } {
    const archiveId = taskArchiveIdOf(task.id)
    const previous = this.store.list('tasks').find(record => record.id === archiveId)
    const prior = previous ? JSON.parse(previous.content) as TaskArchive : undefined
    const archived = [...(prior?.todos ?? [])]
    for (const todo of todos) {
      const at = archived.findIndex(item => item.id === todo.id)
      if (at === -1) archived.push(todo)
      else archived[at] = todo
    }
    const sources = [...(prior?.sources ?? [])]
    for (const source of task.sources) {
      if (!sources.some(item => item.kind === source.kind && item.id === source.id && item.path === source.path)) sources.push(source)
    }
    const notes = new Map((prior?.notes ?? []).map(note => [note.id, note]))
    if (collapse) for (const note of task.notes) notes.set(note.id, note)
    const archivedTask: TaskArchive = { taskId: task.id, title: task.title,
      plan: collapse && task.plan !== archivePlanOf(task.id) ? task.plan : prior?.plan ?? '', sources,
      todos: archived, notes: [...notes.values()], archivedAt: new Date().toISOString() }
    this.store.put('tasks', { id: archiveId, source: { kind: 'task', id: task.id }, content: JSON.stringify(archivedTask, null, 2) + '\n' })
    this.record(task.id, archiveId)
    return { taskId: task.id, archiveId }
  }
  /** Adds the task-to-archive mapping to the short-term index, without rewriting an index that already holds it. */
  private record(taskId: string, archiveId: string): void {
    const entries = existsSync(this.indexPath)
      ? JSON.parse(readFileSync(this.indexPath, 'utf8')) as { taskId: string; archiveId: string }[] : []
    const entry = entries.find(item => item.taskId === taskId)
    if (entry?.archiveId === archiveId) return
    if (entry) entry.archiveId = archiveId
    else entries.push({ taskId, archiveId })
    publishFile(this.indexPath, JSON.stringify(entries, null, 2) + '\n')
  }
  /**
   * Records where the task archive now holds each removed entry, so `ShortTerm.read` opens it by its original ID.
   * The pointer is a location only: the entry's text and sources stay in the one task archive record.
   */
  private locateEntries(archiveId: string, taskId: string, todos: Todo[], notes: Note[]): void {
    if (todos.length === 0 && notes.length === 0) return
    const stored = existsSync(this.itemIndexPath)
      ? JSON.parse(readFileSync(this.itemIndexPath, 'utf8')) as Record<string, ShortTermArchiveLocation> : {}
    let changed = false
    const place = (id: string, part: 'todos' | 'notes'): void => {
      const location: ShortTermArchiveLocation = { reason: 'completed', archiveId, taskId, part }
      const known = stored[id]
      if (known && known.reason === location.reason && known.archiveId === archiveId
        && known.taskId === taskId && known.part === part) return
      stored[id] = location
      changed = true
    }
    for (const todo of todos) place(todo.id, 'todos')
    for (const note of notes) place(note.id, 'notes')
    if (changed) publishFile(this.itemIndexPath, JSON.stringify(stored, null, 2) + '\n')
  }
}
