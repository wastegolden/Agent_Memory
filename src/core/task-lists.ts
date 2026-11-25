/** Editable task plans and attached notes: human-editable Markdown files stay authoritative, and a rebuildable index locates their sources, entries and owner task. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { Ticket } from './ports/ticket-model.ts'
import { ticketCard } from './ports/ticket-card.ts'
import { publishFile } from './files.ts'
import { MemoryIndex, type IndexedMemory, type MemoryReference } from './index.ts'
import { decodeTask, encodeTask } from './markdown.ts'
import type { MemorySource } from './store.ts'

/** IDs are file names; validate external tool input once before using the store. */
export const TaskIdSchema = z.string().regex(/^[\p{L}\p{N}_-]+$/u)
const SourceSchema = z.object({ kind: z.string(), id: z.string(), path: z.string().optional() }).strict()
/** One explicitly registered task attachment: an absolute source file copied whole into a project archive. */
export const TaskAttachmentSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1).refine(value => isAbsolute(value), 'attachment path must be absolute'),
  name: z.string().optional(),
}).strict()
/** One explicit attachment of a task list: its registry identity, absolute source path and optional display name. */
export type TaskAttachment = z.infer<typeof TaskAttachmentSchema>
/** The editable body of a task file. Runtime status always comes from the Engine. */
export const TaskListInputSchema = z.object({
  id: TaskIdSchema.optional(),
  title: z.string().min(1),
  plan: z.string(),
  sources: z.array(SourceSchema),
  todos: z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean(), dueAt: z.string().optional(),
    kind: z.literal('todo').optional(), sources: z.array(SourceSchema).optional(), createdAt: z.string().optional(),
    recipient: z.string().optional() }).strict()),
  notes: z.array(z.object({ id: z.string(), text: z.string(), recipient: z.string().optional(),
    sources: z.array(SourceSchema).optional(), kind: z.enum(['note', 'agreement', 'experience']).optional(),
    createdAt: z.string().optional(), dueAt: z.string().optional(), methodVersion: z.string().optional() }).strict()),
  attachments: z.array(TaskAttachmentSchema).optional(),
}).strict()
export type TaskListInput = z.infer<typeof TaskListInputSchema>
/** A task list's durable identity and editable content; the per-entry metadata is optional here so older input stays valid. */
export type TaskList = Omit<TaskListInput, 'id'> & { id: string; updatedAt: string }

/** Session references kept in a project archive so a later restart can resume the project (wired in S2-6). */
export interface ArchiveReferences { supervisorSessionId: string; workerSessionIds: string[] }
/** Where one archived task's authoritative content lives: the ID of its record in the tasks memory library. */
export interface TaskArchiveLocation { archiveId: string }
/** One attachment copied into a project archive: its registry identity, original absolute path and archived copy. */
export interface ArchivedAttachment {
  taskId: string
  id: string
  name?: string
  path: string
  archivePath: string
  sha256: string
}
/** One task as a project archive bundle holds it: the whole editable list, independent of what the active file now holds. */
export interface ArchivedTask {
  taskId: string
  title: string
  plan: string
  sources: TaskListInput['sources']
  todos: TaskListInput['todos']
  notes: TaskListInput['notes']
  attachments: TaskAttachment[]
  updatedAt: string
}
/** Why `ShortTerm.reduce` moved one entry out of its only owner: its todo finished, it repeated another entry, or a replacement superseded it. */
export type ReducedItemReason = 'completed' | 'duplicate' | 'superseded'
/**
 * One short-term entry `ShortTerm.reduce` already moved into an independent `item-*` archive record: kept whole with
 * the reason and replacement reference, so an old ID stays traceable without becoming a valid instruction again.
 */
export interface ArchivedReducedItem {
  taskId: string
  id: string
  kind: 'agreement' | 'todo' | 'experience' | 'note'
  text: string
  recipient?: string
  sources: TaskListInput['sources']
  createdAt: string
  reason: ReducedItemReason
  archiveId: string
  replacedBy?: string
}
/** One project archive bundle as its MemoryStore tasks record holds it: every listed task, its copied attachments and the reduced history. */
export interface ProjectArchiveBundle {
  projectId: string
  kind: 'snapshot' | 'archive'
  reason?: 'paused' | 'closed'
  createdAt: string
  taskIds: string[]
  references?: ArchiveReferences
  tasks: ArchivedTask[]
  attachments: ArchivedAttachment[]
  reducedItems?: ArchivedReducedItem[]
}

/** One todo or note as the index sees it: which section of the task file it lives in, its sources and its content version. */
interface TaskEntry { id: string; part: 'todos' | 'notes'; sources: MemorySource[]; version: string }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** The version of one entry: the hash of its section and full content, so moving a todo to the notes also refreshes it. */
const entryVersion = (part: 'todos' | 'notes', entry: unknown): string => sha256(JSON.stringify([part, entry]))

/**
 * File-authoritative task lists under `<memoryRoot>/short-term/tasks/<id>.md`. Reads decode Markdown, join the current
 * Engine status by ID and never copy that status into the file; the index records the task's sources, the short-term
 * entries it owns and each entry's owner, so a later unified short-term view can read one index.
 */
export class TaskLists {
  readonly root: string
  /** The memory root, which also holds the project archive bundles and the archived-task location index. */
  private readonly memoryRoot: string
  /** The index this store writes and reads: supplied by the caller, or private and in-memory without one. */
  readonly index: MemoryIndex
  /** Archived tasks and the bundle that now holds their content, loaded at construction and maintained explicitly. */
  private readonly archived = new Map<string, TaskArchiveLocation>()
  private readonly archiveIndexPath: string
  constructor(memoryRoot: string, private readonly ticket: (id: string) => Ticket | undefined, index?: MemoryIndex) {
    this.root = join(memoryRoot, 'short-term', 'tasks')
    this.memoryRoot = memoryRoot
    this.archiveIndexPath = join(memoryRoot, 'short-term', 'archived-tasks.json')
    this.index = index ?? new MemoryIndex(memoryRoot, { memory: true })
    mkdirSync(this.root, { recursive: true })
    this.reconcile()
  }
  /** Replace an editable task body, or create a promise that has no Worker yet; the returned task reads back the same. */
  save(input: TaskListInput): TaskList {
    const task = { ...input, id: input.id ?? randomUUID(), updatedAt: new Date().toISOString() }
    // An archived task is restored explicitly: a generic save must never take it back into the active list.
    const archived = this.archived.get(task.id)
    if (archived) throw new Error(`Task ${task.id} is archived as ${archived.archiveId}; restore it before saving`)
    const path = this.file(task.id)
    const content = encodeTask(task)
    publishFile(path, content)
    const decoded = decodeTask(content, path)
    this.refresh(decoded.value, path, sha256(content))
    this.index.clearDiagnostic(path)
    return decoded.value
  }
  /** Read the latest Markdown file and the Engine's current status; an archived task reads the bundle that moved it out. */
  read(id: string) {
    const archived = this.archived.get(id)
    if (archived) return this.readArchived(id, archived)
    const path = this.file(id)
    try {
      let content = readFileSync(path, 'utf8')
      const decoded = decodeTask(content, path)
      if (decoded.changed) {
        publishFile(path, decoded.content)
        content = decoded.content
      }
      const version = sha256(content)
      const indexed = this.index.get('task', id)
      if (!indexed || indexed.path !== path || indexed.version !== version) this.refresh(decoded.value, path, version)
      this.index.clearDiagnostic(path)
      const ticket = this.ticket(id)
      return { task: decoded.value, path, version, runtime: ticket ? ticketCard(ticket) : null }
    } catch (error) {
      this.deindex(id)
      this.index.report(path, reasonOf(error))
      throw error instanceof Error && error.message.includes(path)
        ? error
        : new Error(`Invalid task file ${path}: ${reasonOf(error)}`)
    }
  }
  /** Every active-layer Markdown file, including promises that do not yet have a Worker; archived tasks are left out. */
  list() {
    return readdirSync(this.root, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('.'))
      .flatMap(entry => {
        const id = entry.name.slice(0, -'.md'.length)
        if (this.archived.has(id)) return []
        try { return [this.read(id)] } catch { return [] }
      })
  }
  /** Create the list at the Engine ticket ID, preserving any existing human-edited list. */
  ensure(ticket: Ticket): void {
    if (existsSync(this.file(ticket.id))) return
    this.save({ id: ticket.id, title: ticket.title, plan: ticket.mandate.scope,
      sources: ticket.origin.triggerIds.map(id => ({ kind: 'trigger', id })), todos: [], notes: [] })
  }
  /** Whether `id` is archived out of the active list; its file stays and its content reads from the archive bundle. */
  isArchived(id: string): boolean { return this.archived.has(id) }
  /** The archive task `id` currently points at, so an explicit restore can require the exact bundle the task points at. */
  archiveOf(id: string): string | undefined { return this.archived.get(id)?.archiveId }
  /**
   * Reload the archived-task location index so archived tasks resolve to their bundles after a restart. A malformed
   * row is reported and skipped; the authoritative task files and archive bundles stay untouched.
   */
  reconcile(): void {
    this.archived.clear()
    if (!existsSync(this.archiveIndexPath)) {
      this.index.clearDiagnostic(this.archiveIndexPath)
      return
    }
    let stored: unknown
    try {
      stored = JSON.parse(readFileSync(this.archiveIndexPath, 'utf8')) as unknown
    } catch (error) {
      this.index.report(this.archiveIndexPath, reasonOf(error))
      return
    }
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
      this.index.report(this.archiveIndexPath, 'the archived-task index must be an object keyed by task ID')
      return
    }
    const broken: string[] = []
    for (const [taskId, value] of Object.entries(stored)) {
      const archiveId = typeof value === 'object' && value !== null
        && typeof (value as { archiveId?: unknown }).archiveId === 'string' ? (value as { archiveId: string }).archiveId : undefined
      if (archiveId === undefined || archiveId.length === 0) broken.push(taskId)
      else this.archived.set(taskId, { archiveId })
    }
    if (broken.length) this.index.report(this.archiveIndexPath, `invalid archived-task rows: ${broken.join(', ')}`)
    else this.index.clearDiagnostic(this.archiveIndexPath)
  }
  /** Move `taskId` out of the active list into project archive `archiveId`: its file stays, its index rows leave. */
  markArchived(taskId: string, archiveId: string): void {
    this.archived.set(taskId, { archiveId })
    this.publishArchiveIndex()
    this.deindex(taskId)
  }
  /** Remove the archive location of `taskId`; only an explicit restore calls this before saving the task again. */
  markRestored(taskId: string): void {
    if (!this.archived.delete(taskId)) return
    this.publishArchiveIndex()
  }
  /** The authoritative Markdown path of task `id`. */
  private file(id: string): string { return join(this.root, id + '.md') }
  /** Read one archived task from the project archive bundle its location index names; the retained file is never read here. */
  private readArchived(id: string, location: TaskArchiveLocation) {
    const path = join(this.memoryRoot, 'tasks', location.archiveId + '.json')
    try {
      const record = JSON.parse(readFileSync(path, 'utf8')) as { content?: unknown }
      if (typeof record.content !== 'string') throw new Error('archive record has no content')
      const bundle = JSON.parse(record.content) as ProjectArchiveBundle
      const archived = Array.isArray(bundle.tasks) ? bundle.tasks.find(task => task.taskId === id) : undefined
      if (archived === undefined) throw new Error(`archive ${location.archiveId} does not hold task ${id}`)
      const attachments = archived.attachments ?? []
      const task: TaskList = { id, title: archived.title, plan: archived.plan, sources: archived.sources,
        todos: archived.todos, notes: archived.notes, attachments, updatedAt: archived.updatedAt }
      this.index.clearDiagnostic(path)
      const ticket = this.ticket(id)
      return { task: decodeTask(encodeTask(task), path).value, path, version: sha256(record.content), runtime: ticket ? ticketCard(ticket) : null }
    } catch (error) {
      this.index.report(path, reasonOf(error))
      throw error instanceof Error && error.message.includes(path)
        ? error
        : new Error(`Invalid task archive ${path}: ${reasonOf(error)}`)
    }
  }
  /** Publish the archived-task location index; every mark keeps the retained task files where they are. */
  private publishArchiveIndex(): void {
    publishFile(this.archiveIndexPath, JSON.stringify(Object.fromEntries(this.archived), null, 2) + '\n')
  }
  /**
   * Index one task read from `path`: its sources, its owned short-term entries and each entry's sources and owner.
   * Short-term rows of entries that left the task are removed; unchanged entry rows keep their existing metadata.
   */
  private refresh(task: TaskList, path: string, version: string): void {
    const previous = this.index.get('task', task.id)
    const entries: TaskEntry[] = [
      ...task.todos.map(todo => ({ id: todo.id, part: 'todos' as const, sources: todo.sources ?? [],
        version: entryVersion('todos', todo) })),
      ...task.notes.map(note => ({ id: note.id, part: 'notes' as const, sources: note.sources ?? [],
        version: entryVersion('notes', note) })),
    ]
    const references: MemoryReference[] = []
    for (const source of task.sources) {
      references.push({ kind: source.kind, id: source.id, part: 'sources', taskId: task.id })
    }
    for (const entry of entries) {
      references.push({ kind: 'short-term', id: entry.id, part: entry.part, taskId: task.id })
      for (const source of entry.sources) {
        references.push({ kind: source.kind, id: source.id, part: entry.part, taskId: task.id })
      }
    }
    this.index.upsert({ kind: 'task', id: task.id, path, version, sources: task.sources, references })
    const owned = new Set(entries.map(entry => entry.id))
    for (const reference of previous?.references ?? []) {
      if (reference.kind !== 'short-term' || (reference.part !== 'todos' && reference.part !== 'notes')) continue
      if (!owned.has(reference.id) && this.index.get('short-term', reference.id)?.path === path)
        this.index.remove('short-term', reference.id)
    }
    for (const entry of entries) {
      const known = this.index.get('short-term', entry.id)
      if (known && known.path === path && known.version === entry.version) continue
      const record: IndexedMemory = { kind: 'short-term', id: entry.id, path, version: entry.version, sources: entry.sources,
        references: [...entry.sources.map(source => ({ kind: source.kind, id: source.id, part: entry.part, taskId: task.id })),
          { kind: 'task', id: task.id, part: entry.part, taskId: task.id }] }
      this.index.upsert(record)
    }
  }
  /** Remove a task's previous index rows and the short-term rows it owned, so stale references never impersonate it. */
  private deindex(id: string): void {
    const previous = this.index.get('task', id)
    if (!previous) return
    for (const reference of previous.references ?? []) {
      if (reference.kind !== 'short-term' || (reference.part !== 'todos' && reference.part !== 'notes')) continue
      if (this.index.get('short-term', reference.id)?.path === previous.path)
        this.index.remove('short-term', reference.id)
    }
    this.index.remove('task', id)
  }
}
