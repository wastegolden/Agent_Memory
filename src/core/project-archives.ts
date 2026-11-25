/** Project archives: one complete tasks-library bundle, explicit whole-file attachments, and a task-list location index that keeps original IDs readable after a project leaves the active list. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { publishFile } from './files.ts'
import type { ShortTermArchiveLocation } from './short-term.ts'
import { MemoryStore, type MemoryRecord, type MemorySource } from './store.ts'
import { archivePlanOf, taskArchiveIdOf, type TaskArchive } from './task-reduction.ts'
import { TaskIdSchema, type ArchivedAttachment, type ArchivedReducedItem, type ArchivedTask, type ArchiveReferences,
  type ProjectArchiveBundle, type TaskAttachment, type TaskList, type TaskLists } from './task-lists.ts'

/** One project archive as the caller sees it: its identity, reason, listed tasks, references and record on disk. */
export interface ArchiveMetadata {
  archiveId: string
  projectId: string
  kind: 'snapshot' | 'archive'
  reason?: 'paused' | 'closed'
  createdAt: string
  taskIds: string[]
  references?: ArchiveReferences
  path: string
  version: string
}
/** What restore reports for one attachment: copied back, left as it was, or a conflict that kept the original. */
export interface AttachmentRestore {
  taskId: string
  id: string
  path: string
  archivePath: string
  status: 'restored' | 'unchanged' | 'conflict'
  reason?: 'different-content' | 'missing-archive'
}
/** What restore changed: the tasks back in the active list, or the conflicts that left the archive state untouched. */
export interface RestoreResult {
  archiveId: string
  projectId: string
  taskIds: string[]
  restored: boolean
  attachments: AttachmentRestore[]
}
/** One archive read back whole: the bundle every listed task and attachment came from, with its record version. */
export interface ArchiveView {
  archiveId: string
  bundle: ProjectArchiveBundle
  path: string
  version: string
}
/** One attachment restore step prepared by a read-only conflict scan. */
interface CopyStep { taskId: string; attachment: ArchivedAttachment; action: 'copy' | 'skip' }
/** The read-only attachment plan: everything that would be copied or skipped, and every conflict found. */
interface AttachmentPlan { conflicts: AttachmentRestore[]; steps: CopyStep[] }

const sha256 = (content: string | Buffer): string => createHash('sha256').update(content).digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** Explicit attachments never include credentials or the runtime/user private trees; a match aborts the whole archive. */
const forbiddenAttachment = (path: string): boolean => {
  const normalized = resolve(path).replaceAll('\\', '/').toLowerCase()
  if (normalized.endsWith('/.codex/auth.json') || normalized.endsWith('/codex-dsh-bridge/token.txt')) return true
  const parts = normalized.split('/')
  if ((parts[parts.length - 1] ?? '').toLowerCase() === '.credentials.yaml') return true
  return parts.some((part, index) => {
    const parent = (parts[index - 1] ?? '').toLowerCase()
    return part.toLowerCase() === 'private' && (parent === 'runtime' || parent === 'data')
  })
}
/** Merge source lists, keeping each distinct source once in first-seen order. */
const mergeSources = (sources: MemorySource[]): MemorySource[] => {
  const seen = new Set<string>()
  return sources.filter(source => {
    const key = JSON.stringify([source.kind, source.id, source.path ?? null])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
/** Merge the active list with TaskReduction's archived entries once by ID; the active version wins when both hold an ID. */
const mergeEntries = <T extends { id: string }>(active: T[], archived: T[]): T[] => {
  const seen = new Set(active.map(entry => entry.id))
  return [...active, ...archived.filter(entry => {
    if (seen.has(entry.id)) return false
    seen.add(entry.id)
    return true
  })]
}
/** Why `ShortTerm.reduce` archived one entry, for the item-index rows and bundle history this module keeps. */
const reducedReasonOf = (value: unknown): value is ArchivedReducedItem['reason'] =>
  value === 'completed' || value === 'duplicate' || value === 'superseded'
/** The four short-term entry kinds a bundle's reduced history may hold. */
const reducedKindOf = (value: unknown): value is ArchivedReducedItem['kind'] =>
  value === 'agreement' || value === 'todo' || value === 'experience' || value === 'note'

/**
 * Moves explicitly listed projects between the active task lists and one complete archive bundle under the tasks memory
 * library. `snapshot` writes the bundle and changes nothing active; `archive` writes it fully first, then records each
 * task as archived and locates every todo and note by its original ID; `restore` writes the bundle's tasks back under
 * their original IDs, copies attachments back without overwriting different content, and clears the old item pointers.
 * TaskReduction's task archives and ShortTerm's `item-*` records are folded into the bundle by ID, with a replacement
 * or repeat kept as reduced history; only the tasks still pointing at the requested archive may be restored.
 */
export class ProjectArchives {
  private readonly store: MemoryStore
  private readonly archives: string
  private readonly itemIndexPath: string
  constructor(memoryRoot: string, private readonly tasks: TaskLists) {
    this.store = new MemoryStore(memoryRoot, { index: tasks.index })
    this.archives = join(memoryRoot, 'archives')
    this.itemIndexPath = join(memoryRoot, 'short-term', 'item-index.json')
  }
  /** Record every listed task whole without changing the active lists; the returned metadata locates the bundle. */
  snapshot(projectId: string, taskIds: string[], references?: ArchiveReferences): ArchiveMetadata {
    const prepared = this.prepare('snapshot', projectId, taskIds, undefined, references)
    return this.metadata(prepared.archiveId, prepared.bundle, prepared.record)
  }
  /** Write the complete bundle first, then move the listed tasks out of the active list under their original IDs. */
  archive(projectId: string, taskIds: string[], reason: 'paused' | 'closed', references?: ArchiveReferences): ArchiveMetadata {
    if (reason !== 'paused' && reason !== 'closed') throw new Error(`Unknown archive reason: ${String(reason)}`)
    const prepared = this.prepare('archive', projectId, taskIds, reason, references)
    // The bundle and every attachment are complete before any task leaves the active list.
    this.placeItemIndex(prepared.archiveId, prepared.bundle.tasks, prepared.bundle.reducedItems ?? [])
    for (const task of prepared.bundle.tasks) this.tasks.markArchived(task.taskId, prepared.archiveId)
    return this.metadata(prepared.archiveId, prepared.bundle, prepared.record)
  }
  /** Read one archive bundle in full, so an archived task, todo or note stays traceable by its original ID. */
  read(archiveId: string): ArchiveView {
    if (!TaskIdSchema.safeParse(archiveId).success) throw new Error(`Invalid archive ID: ${archiveId}`)
    const path = join(this.store.root, 'tasks', archiveId + '.json')
    const record = this.store.get('tasks', archiveId)
    let parsed: unknown
    try {
      parsed = JSON.parse(record.content) as unknown
    } catch (error) {
      throw new Error(`Invalid project archive ${path}: ${reasonOf(error)}`)
    }
    if (!isRecord(parsed) || typeof parsed.projectId !== 'string'
      || (parsed.kind !== 'snapshot' && parsed.kind !== 'archive') || !Array.isArray(parsed.tasks)) {
      throw new Error(`Invalid project archive ${path}: not a project archive bundle`)
    }
    return { archiveId, bundle: parsed as unknown as ProjectArchiveBundle, path, version: record.version }
  }
  /**
   * Restore the archived tasks under their original IDs. Only a bundle every listed task still points at is restorable:
   * a snapshot is read-only history, and a repeated or superseded restore is refused before a single byte is written.
   * Attachments are checked next without writing: any existing file with other content (or a missing archived copy)
   * returns `restored: false` and leaves the archive state whole. Otherwise the missing/same attachments are handled,
   * the archive location is removed explicitly, and the tasks are saved whole before their old item-index archive
   * pointers are cleared. ShortTerm's reduced history stays archived: a replaced or repeated note is never revived.
   */
  restore(archiveId: string): RestoreResult {
    const bundle = this.read(archiveId).bundle
    this.checkRestorable(archiveId, bundle)
    const plan = this.attachmentPlan(bundle)
    if (plan.conflicts.length > 0) {
      return { archiveId, projectId: bundle.projectId, taskIds: bundle.taskIds, restored: false, attachments: plan.conflicts }
    }
    const attachments = this.copyBack(plan.steps)
    for (const task of bundle.tasks) {
      // Only restore removes the archived flag; a generic save must never take a task back into the active list.
      this.tasks.markRestored(task.taskId)
      const registered = task.attachments ?? []
      this.tasks.save({ id: task.taskId, title: task.title, plan: task.plan, sources: task.sources,
        todos: task.todos, notes: task.notes,
        ...(registered.length === 0 ? {} : { attachments: registered }) })
    }
    this.clearItemIndex(bundle.tasks)
    return { archiveId, projectId: bundle.projectId, taskIds: bundle.taskIds, restored: true, attachments }
  }
  /**
   * The one current-ownership check a restore gets: a snapshot never moves active data, and every listed task's
   * archive index must name exactly this bundle. A repeated restore or a newer archive has changed that index, so the
   * request is refused here — before attachments, task files or item pointers are touched.
   */
  private checkRestorable(archiveId: string, bundle: ProjectArchiveBundle): void {
    if (bundle.kind === 'snapshot') {
      throw new Error(`Project archive ${archiveId} is a snapshot; snapshots are read-only history and cannot be restored`)
    }
    for (const task of bundle.tasks) {
      const current = this.tasks.archiveOf(task.taskId)
      if (current === archiveId) continue
      throw new Error(`Project archive ${archiveId} is not current for task ${task.taskId}: `
        + (current === undefined ? 'the task was already restored' : `the task is archived as ${current}`)
        + '; refusing to overwrite current data')
    }
  }
  /** Validate the explicit project/task list once, then compose and save the complete bundle. */
  private prepare(kind: 'snapshot' | 'archive', projectId: string, taskIds: string[],
    reason: 'paused' | 'closed' | undefined, references?: ArchiveReferences):
    { archiveId: string; bundle: ProjectArchiveBundle; record: MemoryRecord } {
    this.checkEntry(projectId, taskIds, references)
    // ShortTerm.reduce moved finished todos and repeated/replaced notes out of the tasks before this ran; read them back.
    const reduced = this.reducedItems(taskIds)
    const tasks: ArchivedTask[] = []
    for (const taskId of taskIds) {
      if (this.tasks.isArchived(taskId)) throw new Error(`Task ${taskId} is already archived; restore it before archiving it again`)
      tasks.push(this.archivedTask(this.tasks.read(taskId).task, this.reduction(taskId),
        reduced.filter(item => item.taskId === taskId)))
    }
    // Check every explicitly registered attachment once, before a single attachment file is read or copied.
    for (const task of tasks) for (const attachment of task.attachments) this.checkAttachment(attachment)
    const archiveId = `archive-${projectId}-${randomUUID()}`
    const attachments = this.copyAttachments(archiveId, tasks)
    const bundle: ProjectArchiveBundle = {
      projectId,
      kind,
      ...(reason === undefined ? {} : { reason }),
      createdAt: new Date().toISOString(),
      taskIds: [...taskIds],
      ...(references === undefined ? {} : { references }),
      tasks,
      attachments,
      ...(reduced.length === 0 ? {} : { reducedItems: reduced }),
    }
    const record = this.store.put('tasks', { id: archiveId, source: { kind: 'project', id: projectId },
      content: JSON.stringify(bundle, null, 2) + '\n' })
    return { archiveId, bundle, record }
  }
  /**
   * The whole listed task: its active plan, sources, todos and notes, every entry TaskReduction already archived, and
   * every todo ShortTerm reduced. A replaced or repeated note is deliberately left out of `notes`: it stays in the
   * bundle's reduced history, traceable by its old ID but never reinstated as a valid instruction.
   */
  private archivedTask(task: TaskList, reduction: TaskArchive | undefined, reduced: ArchivedReducedItem[]): ArchivedTask {
    const collapsed = task.plan === archivePlanOf(task.id)
    const historicalNotes = new Set(reduced.filter(item => item.kind !== 'todo'
      && (item.reason === 'duplicate' || item.reason === 'superseded')).map(item => item.id))
    return {
      taskId: task.id,
      title: task.title,
      plan: collapsed && reduction !== undefined ? reduction.plan : task.plan,
      sources: mergeSources([...task.sources, ...(reduction?.sources ?? [])]),
      // The current item-index reduction may follow a restore and edit of an older TaskReduction entry.
      todos: mergeEntries(task.todos, [...reduced.filter(item => item.kind === 'todo').map(item => this.reducedTodo(item)),
        ...(reduction?.todos ?? [])]),
      notes: mergeEntries(task.notes, (reduction?.notes ?? []).filter(note => !historicalNotes.has(note.id))),
      attachments: task.attachments ?? [],
      updatedAt: task.updatedAt,
    }
  }
  /** One finished todo ShortTerm reduced, put back under its original ID with the content it had when it left the task. */
  private reducedTodo(item: ArchivedReducedItem): ArchivedTask['todos'][number] {
    return { id: item.id, text: item.text, done: true, kind: 'todo', sources: item.sources,
      ...(item.createdAt === '' ? {} : { createdAt: item.createdAt }),
      ...(item.recipient === undefined ? {} : { recipient: item.recipient }) }
  }
  /**
   * The entries ShortTerm already wrote to independent `item-*` archive records for exactly the listed tasks, read
   * whole through the existing item index and memory store. Another task's reduced entry and an independent item with
   * no task never enter this project's bundle.
   */
  private reducedItems(taskIds: string[]): ArchivedReducedItem[] {
    const listed = new Set(taskIds)
    const found: ArchivedReducedItem[] = []
    for (const [id, location] of Object.entries(this.readItemIndex())) {
      // TaskReduction rows name a `task-*` archive and arrive through `reduction`; only ShortTerm's records belong here.
      if (!reducedReasonOf(location.reason) || !location.archiveId.startsWith('item-')) continue
      const path = join(this.store.root, 'tasks', location.archiveId + '.json')
      const memory = ((): MemoryRecord | undefined => {
        try {
          return this.store.get('tasks', location.archiveId)
        } catch (error) {
          this.tasks.index.report(path, reasonOf(error))
          throw error
        }
      })()
      if (memory === undefined) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(memory.content) as unknown
      } catch (error) {
        // A complete project archive cannot claim success while an indexed reduced entry is unreadable.
        this.tasks.index.report(path, reasonOf(error))
        throw error
      }
      if (!isRecord(parsed)) continue
      const item = parsed.item
      const reason = parsed.reason
      if (!isRecord(item)) continue
      const entryId = item.id
      const taskId = item.taskId
      const kind = item.kind
      const text = item.text
      const createdAt = item.createdAt
      const recipient = item.recipient
      const replacedBy = parsed.replacedBy
      if (typeof entryId !== 'string' || entryId !== id || !reducedReasonOf(reason)
        || typeof taskId !== 'string' || !listed.has(taskId) || !reducedKindOf(kind) || typeof text !== 'string') continue
      found.push({
        taskId,
        id,
        kind,
        text,
        sources: Array.isArray(item.sources) ? item.sources as MemorySource[] : [],
        createdAt: typeof createdAt === 'string' ? createdAt : memory.createdAt,
        reason,
        archiveId: location.archiveId,
        ...(typeof recipient === 'string' ? { recipient } : {}),
        ...(typeof replacedBy === 'string' ? { replacedBy } : {}),
      })
    }
    return found.sort((left, right) => left.taskId.localeCompare(right.taskId)
      || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
  /** TaskReduction's existing archive record for this task; an unreadable record blocks a complete project archive. */
  private reduction(taskId: string): TaskArchive | undefined {
    const archiveId = taskArchiveIdOf(taskId)
    const path = join(this.store.root, 'tasks', archiveId + '.json')
    if (!existsSync(path)) return undefined
    try {
      return JSON.parse(this.store.get('tasks', archiveId).content) as TaskArchive
    } catch (error) {
      this.tasks.index.report(path, reasonOf(error))
      throw error
    }
  }
  /** Validate the archive entry once: explicit task IDs, projectId among them, and the optional session references. */
  private checkEntry(projectId: string, taskIds: string[], references?: ArchiveReferences): void {
    if (!TaskIdSchema.safeParse(projectId).success) throw new Error(`Invalid project ID: ${projectId}`)
    if (!Array.isArray(taskIds) || taskIds.length === 0) throw new Error('A project archive needs at least one task ID')
    const listed = new Set(taskIds)
    if (listed.size !== taskIds.length) throw new Error('A project archive lists each task ID once')
    for (const taskId of taskIds) {
      if (!TaskIdSchema.safeParse(taskId).success) throw new Error(`Invalid task ID: ${taskId}`)
    }
    if (!listed.has(projectId)) throw new Error(`projectId ${projectId} must be one of taskIds`)
    if (references === undefined) return
    if (typeof references.supervisorSessionId !== 'string' || references.supervisorSessionId.length === 0)
      throw new Error('references.supervisorSessionId must be a nonempty string')
    if (!Array.isArray(references.workerSessionIds)
      || references.workerSessionIds.some(id => typeof id !== 'string' || id.length === 0))
      throw new Error('references.workerSessionIds must be an array of nonempty strings')
  }
  /** Check one explicit attachment: absolute, not a credential/private path, and a regular readable file. */
  private checkAttachment(attachment: TaskAttachment): void {
    if (!isAbsolute(attachment.path)) throw new Error(`Attachment ${attachment.id} path must be absolute: ${attachment.path}`)
    if (forbiddenAttachment(attachment.path)) {
      throw new Error(`Attachment ${attachment.id} is not an ordinary attachment: ${attachment.path}`)
    }
    let regular = false
    try {
      regular = statSync(attachment.path).isFile()
    } catch (error) {
      throw new Error(`Attachment ${attachment.id} cannot be read: ${reasonOf(error)}`)
    }
    if (!regular) throw new Error(`Attachment ${attachment.id} is not a regular file: ${attachment.path}`)
  }
  /** Copy each explicitly registered attachment whole into this archive's own directory and record both paths. */
  private copyAttachments(archiveId: string, tasks: ArchivedTask[]): ArchivedAttachment[] {
    const copied: ArchivedAttachment[] = []
    for (const task of tasks) {
      task.attachments.forEach((attachment, index) => {
        const archivedPath = join(this.archives, archiveId, 'attachments', task.taskId, `${index}-${basename(attachment.path)}`)
        const content = readFileSync(attachment.path)
        mkdirSync(dirname(archivedPath), { recursive: true })
        writeFileSync(archivedPath, content)
        copied.push({ taskId: task.taskId, id: attachment.id,
          ...(attachment.name === undefined ? {} : { name: attachment.name }),
          path: attachment.path, archivePath: archivedPath, sha256: sha256(content) })
      })
    }
    return copied
  }
  /** Read-only attachment comparison: conflicts first, never a write; same content is skipped, a missing original copied. */
  private attachmentPlan(bundle: ProjectArchiveBundle): AttachmentPlan {
    const conflicts: AttachmentRestore[] = []
    const steps: CopyStep[] = []
    for (const attachment of bundle.attachments) {
      const base = { taskId: attachment.taskId, id: attachment.id, path: attachment.path, archivePath: attachment.archivePath }
      if (!existsSync(attachment.archivePath)) {
        conflicts.push({ ...base, status: 'conflict', reason: 'missing-archive' })
        continue
      }
      if (!existsSync(attachment.path)) {
        steps.push({ taskId: attachment.taskId, attachment, action: 'copy' })
        continue
      }
      const current = readFileSync(attachment.path)
      const archived = readFileSync(attachment.archivePath)
      if (current.equals(archived)) steps.push({ taskId: attachment.taskId, attachment, action: 'skip' })
      else conflicts.push({ ...base, status: 'conflict', reason: 'different-content' })
    }
    return { conflicts, steps }
  }
  /** Execute the checked attachment plan: copy a missing original back, or leave an identical original untouched. */
  private copyBack(steps: CopyStep[]): AttachmentRestore[] {
    return steps.map((step): AttachmentRestore => {
      const { taskId, attachment } = step
      if (step.action === 'skip') {
        return { taskId, id: attachment.id, path: attachment.path, archivePath: attachment.archivePath, status: 'unchanged' }
      }
      const content = readFileSync(attachment.archivePath)
      mkdirSync(dirname(attachment.path), { recursive: true })
      writeFileSync(attachment.path, content)
      return { taskId, id: attachment.id, path: attachment.path, archivePath: attachment.archivePath, status: 'restored' }
    })
  }
  /**
   * Locate every todo and note the bundle holds at the project bundle by its original ID, so ShortTerm.read opens it
   * there. A reduced item the bundle keeps only as history (a replaced or repeated note) keeps pointing at its own
   * `item-*` record with the reason and replacement that explain it.
   */
  private placeItemIndex(archiveId: string, tasks: ArchivedTask[], reduced: ArchivedReducedItem[]): void {
    const stored = this.readItemIndex()
    let changed = false
    const place = (id: string, location: ShortTermArchiveLocation): void => {
      const known = stored[id]
      if (known !== undefined && known.reason === location.reason && known.archiveId === location.archiveId
        && known.taskId === location.taskId && known.part === location.part
        && known.replacedBy === location.replacedBy) return
      stored[id] = location
      changed = true
    }
    const bundled = new Set<string>()
    for (const task of tasks) {
      for (const todo of task.todos) {
        bundled.add(todo.id)
        place(todo.id, { reason: 'archived', archiveId, taskId: task.taskId, part: 'todos' })
      }
      for (const note of task.notes) {
        bundled.add(note.id)
        place(note.id, { reason: 'archived', archiveId, taskId: task.taskId, part: 'notes' })
      }
    }
    for (const item of reduced) {
      if (bundled.has(item.id)) continue
      // The row ShortTerm.reduce wrote is already the authoritative pointer: rewrite it only if it went missing.
      const known = stored[item.id]
      if (known !== undefined && known.reason === item.reason && known.archiveId === item.archiveId
        && known.replacedBy === item.replacedBy) continue
      stored[item.id] = { reason: item.reason, archiveId: item.archiveId,
        ...(item.replacedBy === undefined ? {} : { replacedBy: item.replacedBy }) }
      changed = true
    }
    if (changed) publishFile(this.itemIndexPath, JSON.stringify(stored, null, 2) + '\n')
  }
  /**
   * Drop the old archive pointers of the restored active entries, so an archived version can never override the active
   * one. A reduced note the bundle kept as history is not restored and keeps its own archived pointer.
   */
  private clearItemIndex(tasks: ArchivedTask[]): void {
    if (!existsSync(this.itemIndexPath)) return
    const stored = this.readItemIndex()
    let changed = false
    const remove = (id: string): void => {
      if (stored[id] === undefined) return
      delete stored[id]
      changed = true
    }
    for (const task of tasks) {
      for (const todo of task.todos) remove(todo.id)
      for (const note of task.notes) remove(note.id)
    }
    if (changed) publishFile(this.itemIndexPath, JSON.stringify(stored, null, 2) + '\n')
  }
  /** The authoritative short-term archive location index; a malformed one is reported with its path. */
  private readItemIndex(): Record<string, ShortTermArchiveLocation> {
    if (!existsSync(this.itemIndexPath)) return {}
    try {
      return JSON.parse(readFileSync(this.itemIndexPath, 'utf8')) as Record<string, ShortTermArchiveLocation>
    } catch (error) {
      throw new Error(`Invalid short-term index ${this.itemIndexPath}: ${reasonOf(error)}`)
    }
  }
  /** The caller-facing metadata of one saved bundle, pointing at the record every read and restore uses. */
  private metadata(archiveId: string, bundle: ProjectArchiveBundle, record: MemoryRecord): ArchiveMetadata {
    return {
      archiveId,
      projectId: bundle.projectId,
      kind: bundle.kind,
      ...(bundle.reason === undefined ? {} : { reason: bundle.reason }),
      createdAt: bundle.createdAt,
      taskIds: bundle.taskIds,
      ...(bundle.references === undefined ? {} : { references: bundle.references }),
      path: join(this.store.root, 'tasks', archiveId + '.json'),
      version: record.version,
    }
  }
}
