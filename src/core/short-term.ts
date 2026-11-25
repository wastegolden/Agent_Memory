/** Short-term memory as one view over the task files and the independent Markdown items: task-bound content never has a copy. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { publishFile } from './files.ts'
import type { MemoryReference } from './index.ts'
import { decodeShortTerm, encodeShortTerm } from './markdown.ts'
import type { TaskList, TaskLists } from './task-lists.ts'
import { taskArchiveIdOf } from './task-reduction.ts'
import { MemoryStore, type MemorySource } from './store.ts'

/** The four kinds the unified view can report; `note` is what a task's ordinary note reads as. */
export type ShortTermKind = 'agreement' | 'todo' | 'experience' | 'note'
/** What `remember` accepts: the three selected kinds. Ordinary task notes are read, never remembered as `note`. */
export interface ShortTermInput {
  kind: 'agreement' | 'todo' | 'experience'
  text: string
  taskId?: string
  recipient?: string
  methodVersion?: string
  sources: MemorySource[]
}
/** One independent item's stored record, as `encodeShortTerm` and the archive hold it. */
export interface ShortTermItem extends ShortTermInput { id: string; createdAt: string }
/** The content fields of one unified-view entry, wherever its single owner holds them. */
export interface ShortTermEntry {
  id: string
  kind: ShortTermKind
  text: string
  taskId?: string
  recipient?: string
  methodVersion?: string
  sources: MemorySource[]
  createdAt: string
}
/** Where one entry is stored: a task's section, an independent Markdown item, or an archive record. */
export type ShortTermOwner =
  | { kind: 'task'; taskId: string; entryId: string }
  | { kind: 'item'; id: string }
  | { kind: 'archive'; archiveId: string; entryId: string }
/** One active entry of the unified view, with the authoritative file it was read from and that file's version. */
export interface ShortTermView extends ShortTermEntry {
  path: string
  version: string
  owner: ShortTermOwner
}
/** Why an item left the active view: it repeated an earlier item, Jarvis replaced it, its task item is done, or its project was archived. */
export type ShortTermArchiveReason = 'duplicate' | 'superseded' | 'completed' | 'archived'
/**
 * One locating row of `short-term/item-index.json`: the archive record that now holds an archived entry.
 * `part` and `taskId` are set when the archived entry came from a task file, whose archive holds todos and notes.
 */
export interface ShortTermArchiveIndex {
  id: string
  reason: ShortTermArchiveReason
  archiveId: string
  replacedBy?: string
  part?: TaskEntryPart
  taskId?: string
}
/** One index row without its key, which is the entry ID itself. */
export type ShortTermArchiveLocation = Omit<ShortTermArchiveIndex, 'id'>
/** Explicit replacements Jarvis gave to `reduce`: item `by` replaces item `id`. */
export interface ShortTermReduceInput { superseded?: Array<{ id: string; by: string }> }
/** What `reduce` changed: the active view size before and after, the archived IDs, and the index entries it added. */
export interface ShortTermReduceResult { beforeChars: number; afterChars: number; archivedIds: string[]; index: ShortTermArchiveIndex[] }

/** The two task sections one entry can live in. */
export type TaskEntryPart = 'todos' | 'notes'
type StoredTodo = TaskList['todos'][number]
type StoredNote = TaskList['notes'][number]
type TaskEntry = StoredTodo | StoredNote
/** A task archive record as `TaskReduction` writes it; only the entries are read here. */
interface TaskArchiveRecord { taskId?: string; todos?: StoredTodo[]; notes?: StoredNote[] }
/** A project archive bundle as `ProjectArchives` writes it; its tasks carry the same entries under their original IDs. */
interface ProjectArchiveRecord { tasks?: TaskArchiveRecord[] }
/** The archive record `reduce` writes for one entry of this view. */
interface ShortTermArchiveRecord { item: ShortTermEntry; reason: ShortTermArchiveReason; replacedBy?: string }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** The same entry version `TaskLists` indexes, so the view and the index never disagree about a task entry. */
const entryVersion = (part: TaskEntryPart, entry: unknown): string => sha256(JSON.stringify([part, entry]))
/** Merge source lists, keeping each distinct source once in first-seen order. */
const mergeSources = (sources: MemorySource[]): MemorySource[] => {
  const seen = new Set<string>()
  return sources.filter(source => {
    const key = `${source.kind}\u0000${source.id}\u0000${source.path ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
/** Only the stored content fields, so before and after sizes do not count the view's locating metadata. */
const entryOf = (view: ShortTermView): ShortTermEntry => {
  const { id, kind, text, taskId, recipient, methodVersion, sources, createdAt } = view
  return { id, kind, text, ...(taskId === undefined ? {} : { taskId }),
    ...(recipient === undefined ? {} : { recipient }), ...(methodVersion === undefined ? {} : { methodVersion }),
    sources, createdAt }
}
/** The JSON length of the active entries, so before and after sizes use one measure. */
const contentChars = (views: ShortTermView[]): number =>
  views.reduce((sum, view) => sum + JSON.stringify(entryOf(view)).length, 0)

/**
 * One unified view of the short-term memory: a todo or a note lives only on the task list that owns it, while an
 * independent agreement or experience lives in its own Markdown file. `short-term/item-index.json` locates archived
 * entries in the tasks memory library without holding a second copy of their text. `reduce` merges repeats, applies
 * explicit replacements and archives finished todos, removing each archived entry from its only owner.
 */
export class ShortTerm {
  readonly root: string
  private readonly indexPath: string
  private readonly memory: MemoryStore
  /**
   * Opens the view at `memoryRoot`, sharing the TaskLists index so a task entry is located by one lookup, and reads
   * the task files once so their entries are indexed before the first read.
   */
  constructor(memoryRoot: string, private readonly tasks: Pick<TaskLists, 'read' | 'list' | 'save' | 'index' | 'isArchived' | 'archiveOf'>) {
    this.root = join(memoryRoot, 'short-term', 'items')
    this.indexPath = join(memoryRoot, 'short-term', 'item-index.json')
    this.memory = new MemoryStore(memoryRoot, { index: tasks.index })
    mkdirSync(this.root, { recursive: true })
    this.tasks.list()
  }
  /**
   * Store one selected entry: a task-bound todo joins that task's todos, a task-bound agreement or experience becomes
   * one of its notes, and an unbound todo gets a task list of its own ID; only an independent agreement or experience
   * is written as Markdown. An `internalId` names a stable ID, so replaying the same call returns the existing entry —
   * active or archived — instead of writing it twice.
   */
  remember(input: ShortTermInput, internalId?: string): ShortTermView {
    const id = internalId ?? randomUUID()
    // A stable ID is worth a file rebuild on an index miss; a fresh random ID cannot already exist in a task file.
    const known = this.lookup(id, internalId !== undefined)
    if (known) return known
    const createdAt = new Date().toISOString()
    const item: ShortTermItem = { ...input, id, createdAt }
    if (item.kind === 'todo') {
      if (item.taskId !== undefined) {
        const { task } = this.tasks.read(item.taskId)
        this.tasks.save({ ...task, todos: [...task.todos, {
          id, text: item.text, done: false, kind: 'todo', sources: item.sources, createdAt,
          ...(item.recipient === undefined ? {} : { recipient: item.recipient }),
        }] })
      } else {
        this.tasks.save({ id, title: item.text, plan: '', sources: item.sources, notes: [],
          todos: [{ id, text: item.text, done: false, kind: 'todo', sources: item.sources, createdAt,
            ...(item.recipient === undefined ? {} : { recipient: item.recipient }) }] })
      }
    } else if (item.taskId !== undefined) {
      const { task } = this.tasks.read(item.taskId)
      this.tasks.save({ ...task, notes: [...task.notes, {
        id, text: item.text, kind: item.kind, sources: item.sources, createdAt,
        ...(item.recipient === undefined ? {} : { recipient: item.recipient }),
        ...(item.kind === 'experience' && item.methodVersion !== undefined
          ? { methodVersion: item.methodVersion } : {}),
      }] })
    } else {
      publishFile(this.itemPath(id), encodeShortTerm(item))
    }
    return this.read(id)
  }
  /** Read one active or archived entry by ID; an invalid independent item reports its own file path. */
  read(id: string): ShortTermView {
    const found = this.lookup(id, true)
    if (!found) throw new Error(`Short-term memory ${id} does not exist`)
    return found
  }
  /** Every active entry: all task todos and notes, including hand-written lines, then the independent Markdown items. */
  list(): ShortTermView[] {
    const views: ShortTermView[] = []
    for (const read of this.tasks.list()) {
      for (const todo of read.task.todos) views.push(this.viewOfEntry(todo, 'todos', read.task.id, read.path))
      for (const note of read.task.notes) views.push(this.viewOfEntry(note, 'notes', read.task.id, read.path))
    }
    for (const name of readdirSync(this.root)) {
      if (!name.endsWith('.md') || name.startsWith('.')) continue
      const id = name.slice(0, -'.md'.length)
      try {
        const item = this.readItem(id)
        if (item) views.push(item)
      } catch (error) {
        // One broken independent file never hides the rest of the view.
        this.tasks.index.report(join(this.root, name), reasonOf(error))
      }
    }
    return views.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
  /**
   * Reindexes every entry the authoritative owners hold: the active task and item entries first, then each archived entry
   * the item index locates, so a restart recovers every short-term reference without copying a body into the index.
   */
  reconcile(): void {
    this.list()
    const stored = ((): Record<string, ShortTermArchiveLocation> => {
      try {
        return this.readIndex()
      } catch (error) {
        // A broken locating index is diagnosable and never stops the active entries from being reindexed.
        this.tasks.index.report(this.indexPath, reasonOf(error))
        return {}
      }
    })()
    for (const [id, location] of Object.entries(stored)) {
      try {
        this.fromArchive(id, location)
      } catch (error) {
        // One broken archive row is isolated: its stale row is dropped and its file reported, the others still read.
        this.tasks.index.remove('short-term', id)
        this.tasks.index.report(join(this.memory.root, 'tasks', location.archiveId + '.json'), reasonOf(error))
      }
    }
  }
  /**
   * Merge repeated entries, apply Jarvis's explicit replacements and archive finished todos; each archived entry is
   * saved whole first, then removed from its only owner, so no copy stays behind as active content.
   */
  reduce(input: ShortTermReduceInput = {}): ShortTermReduceResult {
    const items = this.list()
    const beforeChars = contentChars(items)
    const byId = new Map(items.map(item => [item.id, item] as [string, ShortTermView]))
    const replacedBy = new Map<string, string>()
    for (const { id, by } of input.superseded ?? []) {
      const old = byId.get(id)
      const next = byId.get(by)
      if (!old || !next) continue
      if (id === by || old.kind !== next.kind || old.taskId !== next.taskId || old.recipient !== next.recipient)
        throw new Error(`Cannot supersede short-term item ${id} by ${by}: they must differ and share kind, task and recipient`)
      replacedBy.set(id, by)
    }
    const groups = new Map<string, ShortTermView[]>()
    for (const item of items) {
      const key = JSON.stringify([item.kind, item.text, item.taskId ?? null, item.recipient ?? null])
      const group = groups.get(key)
      if (group) group.push(item)
      else groups.set(key, [item])
    }
    type Duplicates = { survivor: ShortTermView; sources: MemorySource[]; extras: ShortTermView[] }
    const duplicateIds = new Set<string>()
    const duplicates: Duplicates[] = []
    const kept = new Set<string>(replacedBy.values())
    for (const group of groups.values()) {
      if (group.length < 2) continue
      const survivor = group[0]!
      const extras = group.slice(1)
      kept.add(survivor.id)
      for (const extra of extras) duplicateIds.add(extra.id)
      duplicates.push({ survivor, sources: mergeSources(group.flatMap(item => item.sources)), extras })
    }
    type ArchivePlan = { item: ShortTermView; reason: ShortTermArchiveReason; replacedBy?: string }
    const plans: ArchivePlan[] = []
    const taskReads = new Map<string, ReturnType<TaskLists['read']>>()
    for (const item of items) {
      const replacement = replacedBy.get(item.id)
      const reason: ShortTermArchiveReason | undefined = replacement ? 'superseded'
        : duplicateIds.has(item.id) ? 'duplicate'
          : item.kind === 'todo' ? 'completed' : undefined
      if (!reason || (!replacement && kept.has(item.id) && item.kind !== 'todo')) continue
      // An unfinished promise is never archived, even when a duplicate or a replacement points at it.
      if (item.kind === 'todo' && !this.todoDone(item, taskReads)) continue
      plans.push({ item, reason, ...(replacement ? { replacedBy: replacement } : {}) })
    }
    const stored = this.readIndex()
    const archivedIds: string[] = []
    const added: ShortTermArchiveIndex[] = []
    for (const plan of plans) {
      // Entry IDs can contain colons (managed requirements); archive filenames use a stable portable identity.
      const archiveId = 'item-' + sha256(plan.item.id)
      const record: ShortTermArchiveRecord = { item: entryOf(plan.item), reason: plan.reason,
        ...(plan.replacedBy ? { replacedBy: plan.replacedBy } : {}) }
      this.memory.put('tasks', { id: archiveId, source: { kind: 'short-term', id: plan.item.id }, content: JSON.stringify(record) })
      const location: ShortTermArchiveLocation = { reason: plan.reason, archiveId,
        ...(plan.replacedBy ? { replacedBy: plan.replacedBy } : {}) }
      stored[plan.item.id] = location
      archivedIds.push(plan.item.id)
      added.push({ id: plan.item.id, ...location })
    }
    if (archivedIds.length) publishFile(this.indexPath, JSON.stringify(stored, null, 2) + '\n')
    const archived = new Set(archivedIds)
    for (const { survivor, sources, extras } of duplicates) {
      if (archived.has(survivor.id) || !extras.every(extra => archived.has(extra.id))) continue
      this.mergeSources(survivor, sources)
    }
    for (const plan of plans) this.removeOwner(plan.item)
    return { beforeChars, afterChars: contentChars(this.list()), archivedIds, index: added }
  }
  /**
   * Remove one tentative experience after its confirmed record was written, by its single owner. A task keeps every
   * neighbouring todo and note, an independent item removes only its own Markdown file, and an archive keeps its
   * container. Also remove the target from the current project bundle and its TaskReduction restore source, so a
   * later archive/restore cannot bring it back. An `item-*` record keeps its reason/replacement and `promotedTo`.
   */
  removeExperience(id: string): void {
    const view = this.read(id)
    if (view.kind !== 'experience') throw new Error(`Short-term memory ${id} is not an experience`)
    const archiveIds = new Set<string>()
    if (view.owner.kind === 'archive') archiveIds.add(view.owner.archiveId)
    if (view.taskId !== undefined) {
      const projectArchive = this.tasks.archiveOf(view.taskId)
      if (projectArchive !== undefined) archiveIds.add(projectArchive)
      const reduction = taskArchiveIdOf(view.taskId)
      if (existsSync(join(this.memory.root, 'tasks', reduction + '.json'))) archiveIds.add(reduction)
    }
    for (const archiveId of archiveIds) {
      const record = this.memory.get('tasks', archiveId)
      const parsed: unknown = JSON.parse(record.content)
      if (!isRecord(parsed)) throw new Error(`Invalid archive ${archiveId}: expected an object`)
      const before = JSON.stringify(parsed)
      if (Array.isArray(parsed.tasks)) {
        const task = (parsed.tasks as TaskArchiveRecord[]).find(task => task.taskId === view.taskId)
        if (task?.notes !== undefined) task.notes = task.notes.filter(note => note.id !== id)
        if (Array.isArray(parsed.reducedItems)) {
          parsed.reducedItems = (parsed.reducedItems as { id: string }[]).filter(item => item.id !== id)
        }
      } else if (isRecord(parsed.item) && parsed.item.id === id) {
        delete parsed.item
        parsed.promotedTo = id
      } else if (parsed.taskId === view.taskId && Array.isArray(parsed.notes)) {
        parsed.notes = (parsed.notes as StoredNote[]).filter(note => note.id !== id)
      }
      if (JSON.stringify(parsed) !== before) {
        this.memory.put('tasks', { id: record.id, source: record.source, content: JSON.stringify(parsed, null, 2) + '\n' })
      } else if (view.owner.kind === 'archive' && archiveId === view.owner.archiveId) {
        throw new Error(`Archive ${archiveId} does not hold experience ${id}`)
      }
    }
    this.removeOwner(view)
    const stored = this.readIndex()
    if (id in stored) {
      delete stored[id]
      publishFile(this.indexPath, JSON.stringify(stored, null, 2) + '\n')
    }
    this.tasks.index.remove('short-term', id)
  }
  /** Locate an entry: its independent Markdown file first, then the task index, then the archive pointer. */
  private lookup(id: string, rebuild: boolean): ShortTermView | undefined {
    const item = this.readItem(id)
    if (item) return item
    const active = this.fromTaskIndex(id)
    if (active) return active
    const archived = this.readIndex()[id]
    if (archived) return this.fromArchive(id, archived)
    if (!rebuild) return undefined
    // A missing or stale index is rebuilt from the task files themselves, never from a copied body.
    this.tasks.list()
    const rebuilt = this.fromTaskIndex(id)
    if (rebuilt) return rebuilt
    const later = this.readIndex()[id]
    return later ? this.fromArchive(id, later) : undefined
  }
  /** The absolute path of one independent Markdown item. */
  private itemPath(id: string): string { return join(this.root, id + '.md') }
  /** Read one independent Markdown item, or `undefined` when it has no file; a bad file reports, drops its row and throws its path. */
  private readItem(id: string): ShortTermView | undefined {
    const path = this.itemPath(id)
    if (!existsSync(path)) return undefined
    try {
      const content = readFileSync(path, 'utf8')
      const decoded = decodeShortTerm(content, path)
      const view = this.viewOfItem(decoded.value, decoded.content, path)
      this.indexEntry(view, decoded.value.sources.map(source => ({ kind: source.kind, id: source.id, part: 'sources' })))
      this.tasks.index.clearDiagnostic(path)
      return view
    } catch (error) {
      // A broken file never keeps impersonating an entry: its stale row is removed and the path stays diagnosable.
      this.tasks.index.remove('short-term', id)
      this.tasks.index.report(path, reasonOf(error))
      throw error instanceof Error && error.message.includes(path)
        ? error
        : new Error(`Invalid short-term item ${path}: ${reasonOf(error)}`)
    }
  }
  /** One independent item as a view, with the content version of its Markdown file. */
  private viewOfItem(item: ShortTermItem, content: string, path: string): ShortTermView {
    return { id: item.id, kind: item.kind, text: item.text, sources: item.sources, createdAt: item.createdAt,
      ...(item.recipient === undefined ? {} : { recipient: item.recipient }),
      ...(item.methodVersion === undefined ? {} : { methodVersion: item.methodVersion }),
      path, version: sha256(content), owner: { kind: 'item', id: item.id } }
  }
  /** Record one independent or archived entry's locating metadata and references, leaving an unchanged row alone. */
  private indexEntry(view: ShortTermView, references: MemoryReference[]): void {
    const known = this.tasks.index.get('short-term', view.id)
    if (known && known.path === view.path && known.version === view.version) return
    this.tasks.index.upsert({ kind: 'short-term', id: view.id, path: view.path, version: view.version,
      sources: view.sources, references })
  }
  /** A task entry located by its `short-term` index row, read again from the task file so manual edits are current. */
  private fromTaskIndex(id: string): ShortTermView | undefined {
    const row = this.tasks.index.get('short-term', id)
    if (!row) return undefined
    // Every reference TaskLists builds for an entry names its owner task, including references from the entry's sources.
    const taskId = row.references?.find(reference => reference.taskId !== undefined
      && (reference.part === 'todos' || reference.part === 'notes'))?.taskId
    if (taskId === undefined || this.tasks.isArchived(taskId)) return undefined
    const read = ((): ReturnType<TaskLists['read']> | undefined => {
      try {
        return this.tasks.read(taskId)
      } catch {
        // A broken or removed task file cannot own the entry the stale row names.
        return undefined
      }
    })()
    if (!read) return undefined
    const todo = read.task.todos.find(entry => entry.id === id)
    if (todo) return this.viewOfEntry(todo, 'todos', taskId, read.path)
    const note = read.task.notes.find(entry => entry.id === id)
    return note ? this.viewOfEntry(note, 'notes', taskId, read.path) : undefined
  }
  /** One task entry as a view; its version is the TaskLists entry version, so no body is copied into the index. */
  private viewOfEntry(entry: TaskEntry, part: TaskEntryPart, taskId: string, path: string): ShortTermView {
    const kind: ShortTermKind = part === 'todos' ? 'todo' : (entry as StoredNote).kind ?? 'note'
    return { id: entry.id, kind, text: entry.text, taskId, sources: entry.sources ?? [], createdAt: entry.createdAt ?? '',
      ...(entry.recipient === undefined ? {} : { recipient: entry.recipient }),
      ...((entry as StoredNote).methodVersion === undefined ? {} : { methodVersion: (entry as StoredNote).methodVersion }),
      path, version: entryVersion(part, entry), owner: { kind: 'task', taskId, entryId: entry.id } }
  }
  /** An archived entry read from the tasks memory library archive its index row points at, then indexed again from that record. */
  private fromArchive(id: string, location: ShortTermArchiveLocation): ShortTermView {
    const path = join(this.memory.root, 'tasks', location.archiveId + '.json')
    const record = this.memory.get('tasks', location.archiveId)
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(record.content)
    } catch (error) {
      throw new Error(`Invalid archive ${path}: ${reasonOf(error)}`)
    }
    if (location.part !== undefined) {
      const bundle = parsed as ProjectArchiveRecord
      const archive: TaskArchiveRecord = Array.isArray(bundle.tasks)
        ? bundle.tasks.find(candidate => candidate.taskId === location.taskId) ?? {}
        : parsed as TaskArchiveRecord
      const part = location.part
      const entries: TaskEntry[] = part === 'todos' ? archive.todos ?? [] : archive.notes ?? []
      const entry = entries.find(candidate => candidate.id === id)
      if (!entry) throw new Error(`Archived task ${location.archiveId} does not hold short-term entry ${id}`)
      const kind: ShortTermKind = part === 'todos' ? 'todo' : (entry as StoredNote).kind ?? 'note'
      const taskId = location.taskId ?? archive.taskId
      const view: ShortTermView = { id, kind, text: entry.text,
        ...(taskId === undefined ? {} : { taskId }), sources: entry.sources ?? [],
        createdAt: entry.createdAt ?? record.createdAt,
        ...(entry.recipient === undefined ? {} : { recipient: entry.recipient }),
        ...((entry as StoredNote).methodVersion === undefined
          ? {} : { methodVersion: (entry as StoredNote).methodVersion }),
        path, version: record.version, owner: { kind: 'archive', archiveId: location.archiveId, entryId: id } }
      this.indexArchived(view, part, taskId)
      return view
    }
    const item = (parsed as { item?: ShortTermEntry }).item
    if (!item || item.id !== id) throw new Error(`Archive ${path} does not hold short-term item ${id}`)
    const view: ShortTermView = { ...item, path, version: record.version, owner: { kind: 'archive', archiveId: location.archiveId, entryId: id } }
    this.indexArchived(view, undefined, item.taskId)
    return view
  }
  /** Index one archived entry from its archive record: its sources, and the task part that owned it when one did. */
  private indexArchived(view: ShortTermView, part: TaskEntryPart | undefined, taskId: string | undefined): void {
    const entryPart = part ?? 'sources'
    const references: MemoryReference[] = view.sources.map(source => ({ kind: source.kind, id: source.id, part: entryPart,
      ...(taskId === undefined ? {} : { taskId }) }))
    if (part !== undefined && taskId !== undefined) references.push({ kind: 'task', id: taskId, part, taskId })
    this.indexEntry(view, references)
    this.tasks.index.clearDiagnostic(view.path)
  }
  /** Whether the task that owns one todo view records it as done. */
  private todoDone(item: ShortTermView, reads: Map<string, ReturnType<TaskLists['read']>>): boolean {
    const owner = item.owner
    if (item.kind !== 'todo' || owner.kind !== 'task') return false
    const taskId = owner.taskId
    let read = reads.get(taskId)
    if (read === undefined) {
      read = this.tasks.read(taskId)
      reads.set(taskId, read)
    }
    return read.task.todos.some(todo => todo.id === item.id && todo.done)
  }
  /** Combine the duplicate group's sources into its surviving entry, wherever its single owner keeps it. */
  private mergeSources(view: ShortTermView, sources: MemorySource[]): void {
    if (view.owner.kind === 'item') {
      const path = this.itemPath(view.id)
      const item = decodeShortTerm(readFileSync(path, 'utf8'), path).value
      publishFile(path, encodeShortTerm({ ...item, sources }))
      return
    }
    if (view.owner.kind !== 'task') return
    const { task } = this.tasks.read(view.owner.taskId)
    if (task.todos.some(todo => todo.id === view.id)) {
      this.tasks.save({ ...task, todos: task.todos.map(todo => todo.id === view.id ? { ...todo, sources } : todo) })
      return
    }
    this.tasks.save({ ...task, notes: task.notes.map(note => note.id === view.id ? { ...note, sources } : note) })
  }
  /** Remove one archived entry from its only owner: its Markdown file (and index row), or the one task section that holds it. */
  private removeOwner(view: ShortTermView): void {
    if (view.owner.kind === 'item') {
      // The archive record already holds the content; the active item file and its locating row are gone with it.
      rmSync(this.itemPath(view.id), { force: true })
      this.tasks.index.remove('short-term', view.id)
      return
    }
    if (view.owner.kind !== 'task') return
    const { task } = this.tasks.read(view.owner.taskId)
    if (task.todos.some(todo => todo.id === view.id)) {
      this.tasks.save({ ...task, todos: task.todos.filter(todo => todo.id !== view.id) })
      return
    }
    if (task.notes.some(note => note.id === view.id)) {
      this.tasks.save({ ...task, notes: task.notes.filter(note => note.id !== view.id) })
    }
  }
  /** The authorising locating index: which archive holds each entry that left the active view. */
  private readIndex(): Record<string, ShortTermArchiveLocation> {
    if (!existsSync(this.indexPath)) return {}
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf8')) as Record<string, ShortTermArchiveLocation>
    } catch (error) {
      throw new Error(`Invalid short-term index ${this.indexPath}: ${reasonOf(error)}`)
    }
  }
}
