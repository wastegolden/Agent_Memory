/** Cross-library memory retrieval by person, task, project or text, with selections saved as frozen snapshots. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Documents } from './documents.ts'
import type { MemoryEvent, MemoryEvents } from './events.ts'
import type { Experiences, ExperienceView } from './experiences.ts'
import { publishFile } from './files.ts'
import type { MemoryIndex, MemoryReference } from './index.ts'
import type { PersonCards, PersonView } from './people.ts'
import type { ShortTerm } from './short-term.ts'
import type { MemoryRecord, MemorySource } from './store.ts'
import type { TaskLists } from './task-lists.ts'

/** Conditions the main Session searched by, and why it selected them; only given conditions select anything. */
export interface RetrievalQuery {
  personIds?: string[]
  taskIds?: string[]
  projectId?: string
  text?: string
  reason: string
}
/** The one project a scoped retrieval is limited to; a query adds conditions but never widens it. */
export interface RetrievalScope { projectId: string }
/** One selected memory item, the concrete conditions that matched it, its real sources and its version on disk. */
export interface SelectionItem {
  kind: 'person' | 'event' | 'task' | 'short-term' | 'document' | 'archive' | 'experience'
  id: string
  text: string
  reason: string
  sources: MemorySource[]
  version: string
  path?: string
}
/** The snapshot saved when a selection was made; it never changes when the sources change later. */
export interface MemorySelection { id: string; at: string; query: RetrievalQuery; items: SelectionItem[] }
/** A saved item reopened against its source: the version and text now on disk, and whether the version moved. */
export interface ReopenedItem extends SelectionItem { currentVersion: string; changed: boolean; currentText: string }
/** A saved selection and its items as they read now; the saved snapshot itself is not rewritten. */
export interface ReopenedSelection { selection: MemorySelection; items: ReopenedItem[] }
/** The memory libraries retrieval reads; every source stays authoritative on disk. */
export interface RetrievalDeps {
  events: MemoryEvents
  people: PersonCards
  shortTerm: ShortTerm
  tasks: TaskLists
  documents: Documents
  /** The confirmed-experience library; when present, experience text and every real source come from its views. */
  experiences?: Experiences
}
/**
 * The unified kinds retrieval reports and answers `usedBy` for. Person, event, task, short-term and selection are their own
 * index kinds; document, archive and experience live in the plural `documents`, `tasks` and `experiences` index libraries.
 */
export const memoryKinds = ['person', 'event', 'task', 'short-term', 'document', 'archive', 'experience', 'selection'] as const
export type MemoryKind = (typeof memoryKinds)[number]
/** The record kind each unified memory kind is indexed under. */
const indexedKind: Record<MemoryKind, string> = {
  person: 'person', event: 'event', task: 'task', 'short-term': 'short-term',
  document: 'documents', archive: 'tasks', experience: 'experiences', selection: 'selection',
}
/** The resolved scope of one scoped call: the bound project and the tasks currently assigned to it. */
interface ProjectScope { projectId: string; taskIds: Set<string> }
/** Event sources that are the owner's private conversation; their raw text is never a supervisor's material. */
const privateChatSources = new Set(['web-message', 'chat', 'user', 'assistant'])
/** Source kinds whose original path is never handed to a scoped caller. */
const privateSourceKinds = new Set(['web-message', 'chat', 'user', 'assistant', 'persona'])
/** Filesystem-equivalent spellings share one key, including Windows slash and case differences. */
const pathKey = (path: string): string => {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Selects memory only by the conditions given, writes the selection under `memory/selections/<uuid>.json`, and reopens
 * that snapshot against the current files without changing the original selection. Each selection is indexed in the
 * memory module's one rebuildable index, so `usedBy` answers cross-library reference questions from that index.
 */
export class MemoryRetrieval {
  private readonly selections: string
  private readonly index: MemoryIndex
  /** Raw private storage: event files, the persona card and the chat database are never document originals to read back. */
  private readonly eventsRoot: string
  private readonly personaPath: string
  private readonly chatStorePath: string
  /** Opens retrieval at `memoryRoot`, creating the selection directory; the memory libraries were opened from the same root. */
  constructor(readonly memoryRoot: string, private readonly deps: RetrievalDeps) {
    this.selections = join(memoryRoot, 'selections')
    this.index = deps.events.index
    this.eventsRoot = pathKey(join(memoryRoot, 'events'))
    const base = dirname(memoryRoot)
    this.personaPath = pathKey(join(base, 'persona', 'jarvis.md'))
    this.chatStorePath = pathKey(join(base, 'state', 'orchestrator.sqlite'))
    mkdirSync(this.selections, { recursive: true })
  }
  /**
   * Selects the given people, tasks, project or text matches, saves the snapshot, and returns it. Each current view is
   * read once for this query; a broken person or task file is reported and skipped instead of hiding the other matches.
   */
  retrieve(query: RetrievalQuery, scope?: RetrievalScope): MemorySelection {
    const conditions = (query.personIds?.length ?? 0) > 0 || (query.taskIds?.length ?? 0) > 0
      || Boolean(query.projectId) || Boolean(query.text)
    // Nothing was asked for: save an empty snapshot without reading a whole library.
    if (!conditions) return this.saveSelection(query, [])
    // Read each current view once: people cards, task lists and short-term entries are then matched from these maps.
    const cards = new Map(this.deps.people.list().map(card => [card.id, card] as const))
    const tasks = new Map(this.deps.tasks.list().map(read => [read.task.id, read] as const))
    const shortTerm = this.deps.shortTerm.list()
    const project = scope === undefined ? undefined : this.projectScope(scope, tasks.values())
    const found = new Map<string, { item: Omit<SelectionItem, 'reason'>; conditions: string[] }>()
    /** Adds an item once, merging every condition that selected the same source; a scoped item loses private paths first. */
    const add = (item: Omit<SelectionItem, 'reason'>, condition: string): void => {
      const safe = project === undefined ? item : this.publicItem(item)
      const key = `${safe.kind}:${safe.id}`
      const known = found.get(key)
      if (!known) {
        found.set(key, { item: safe, conditions: [condition] })
        return
      }
      if (!known.conditions.includes(condition)) known.conditions.push(condition)
    }
    const views = new Map<string, PersonView>()
    const personView = (id: string): PersonView | undefined => {
      const known = views.get(id)
      if (known) return known
      try {
        const view = this.deps.people.read(id)
        views.set(id, view)
        return view
      } catch {
        // `people.list()` reported the broken card; one bad card never hides the other matches.
        return undefined
      }
    }
    for (const personId of query.personIds ?? []) {
      // A card that is absent or broken selects nothing: the list already reported its file.
      const view = cards.has(personId) ? personView(personId) : undefined
      if (!view) continue
      add(this.personItem(view), `personIds 包含 ${personId}`)
      for (const eventId of view.eventIds) {
        try {
          const event = this.deps.events.get(eventId)
          if (project === undefined || this.eventInScope(event, project))
            add(this.eventItem(event), `人物卡 ${personId} 的关联事件 ${eventId}`)
        } catch {
          // A cited event whose file is broken is reported by its own read; the card still selects the rest.
        }
      }
      for (const event of this.deps.events.list({ personId })) {
        if (project === undefined || this.eventInScope(event, project))
          add(this.eventItem(event), `事件 personIds 包含 ${personId}`)
      }
      for (const item of shortTerm) {
        if (item.recipient === personId && (project === undefined || this.shortTermInScope(item, project)))
          add(this.shortTermItem(item), `recipient 匹配 ${personId}`)
      }
    }
    const taskConditions = new Map<string, string>()
    for (const id of query.taskIds ?? []) taskConditions.set(id, `taskIds 包含 ${id}`)
    if (query.projectId) {
      taskConditions.set(query.projectId, `projectId 对应的项目任务 ${query.projectId}`)
      for (const read of tasks.values()) {
        if (read.runtime?.project_id === query.projectId)
          taskConditions.set(read.task.id, `runtime.project_id 匹配 ${query.projectId}`)
      }
    }
    const archives = taskConditions.size ? this.deps.events.store.list('tasks') : []
    for (const [taskId, condition] of taskConditions) {
      // A task file that is missing or broken is skipped; its short-term items, events and archive still match by ID.
      const task = tasks.get(taskId)
      if (task && (project === undefined || this.taskInScope(task, project))) add(this.taskItem(task), condition)
      for (const item of shortTerm) {
        if (item.taskId === taskId && (project === undefined || this.shortTermInScope(item, project)))
          add(this.shortTermItem(item), `短期记录 taskId 匹配 ${taskId}`)
      }
      for (const event of this.deps.events.list({ taskId })) {
        if (project === undefined || this.eventInScope(event, project))
          add(this.eventItem(event), `事件 taskId 匹配 ${taskId}`)
      }
      for (const record of archives) {
        const matches = record.source.kind === 'task' || record.source.kind === 'project' ? record.source.id === taskId
          : record.source.kind === 'short-term' && (JSON.parse(record.content) as { item: { taskId?: string } }).item.taskId === taskId
        if (matches && (project === undefined || this.archiveInScope(record, project)))
          add(this.recordItem('archive', record), `归档任务匹配 ${taskId}`)
      }
    }
    if (query.projectId) {
      const projectId = query.projectId
      for (const event of this.deps.events.list({ projectId })) {
        if (project === undefined || this.eventInScope(event, project))
          add(this.eventItem(event), `事件 projectId 匹配 ${projectId}`)
      }
    }
    if (query.text) {
      const text = query.text
      // The current editable views are matched too, so a hand-edited card, plan or short-term entry is found by its text.
      for (const card of cards.values()) {
        if (!JSON.stringify(card).includes(text)) continue
        const view = personView(card.id)
        if (view) add(this.personItem(view), `people 内容包含「${text}」`)
      }
      for (const read of tasks.values()) {
        if (project !== undefined && !this.taskInScope(read, project)) continue
        if (JSON.stringify(read.task).includes(text)) add(this.taskItem(read), `tasks 内容包含「${text}」`)
      }
      for (const item of shortTerm) {
        if (!item.text.includes(text)) continue
        if (project !== undefined && !this.shortTermInScope(item, project)) continue
        add(this.shortTermItem(item), `short-term 内容包含「${text}」`)
      }
      if (project === undefined) {
        for (const hit of this.deps.documents.search(text)) {
          add(this.recordItem('document', this.deps.documents.read(hit.id)), `Documents.search 匹配「${text}」`)
        }
      } else {
        // Registered source metadata is checked first, so a private original is rejected before it is ever read.
        for (const record of this.deps.events.store.list('documents')) {
          if (!this.documentInScope(record)) continue
          const document = this.deps.documents.read(record.id)
          if (!(document.source.path ?? '').includes(text) && !document.content.includes(text)) continue
          add(this.recordItem('document', document), `documents 内容包含「${text}」`)
        }
      }
      const experiences = this.deps.experiences
      if (experiences === undefined) {
        for (const record of this.deps.events.store.list('experiences')) {
          if (record.content.includes(text)) add(this.recordItem('experience', record), `experiences 内容包含「${text}」`)
        }
      } else {
        // A confirmed experience is matched by its current view text, with every real source and revision event retained.
        for (const view of experiences.list()) {
          if (!view.text.includes(text)) continue
          if (project !== undefined && !this.experienceInScope(view, project)) continue
          add(this.experienceItem(view), `experiences 内容包含「${text}」`)
        }
      }
    }
    return this.saveSelection(query, [...found.values()].map(({ item, conditions: matched }) =>
      ({ ...item, reason: [...matched, query.reason].join('；') })))
  }
  /** Writes one selection snapshot and indexes it, returning the same object the file holds. */
  private saveSelection(query: RetrievalQuery, items: SelectionItem[]): MemorySelection {
    const selection: MemorySelection = { id: randomUUID(), at: new Date().toISOString(), query, items }
    const path = join(this.selections, `${selection.id}.json`)
    const content = `${JSON.stringify(selection, null, 2)}\n`
    publishFile(path, content)
    this.indexSelection(selection, path, sha256(content))
    return selection
  }
  /**
   * Reopens saved selection `id`: its snapshot unchanged, plus each selected source's current version and text. With a
   * project scope the snapshot items and their current sources are both checked again, private items are dropped, and the
   * reopened query reports only the bound project instead of the old unrestricted conditions.
   */
  read(id: string, scope?: RetrievalScope): ReopenedSelection {
    const selection = JSON.parse(readFileSync(join(this.selections, `${id}.json`), 'utf8')) as MemorySelection
    if (scope === undefined) {
      return { selection, items: selection.items.map(item => {
        const current = this.current(item)
        return { ...item, currentVersion: current.currentVersion,
          changed: current.currentVersion !== item.version, currentText: current.currentText }
      }) }
    }
    const project = this.projectScope(scope)
    const items: ReopenedItem[] = []
    const kept: SelectionItem[] = []
    for (const item of selection.items) {
      const reopened = this.reopenInScope(item, project)
      if (reopened === undefined) continue
      const { currentVersion: _currentVersion, changed: _changed, currentText: _currentText, ...snapshot } = reopened
      kept.push(snapshot)
      items.push(reopened)
    }
    return { selection: { ...selection, query: { projectId: project.projectId, reason: 'Project-scoped selection' }, items: kept },
      items }
  }
  /**
   * Reads one memory item of `kind`/`id` directly, under the same project scope as a selection: a task fact and every
   * real source of a confirmed experience must belong to the bound project, private chat is refused, and person and
   * document reads stay allowed.
   */
  item(kind: SelectionItem['kind'], id: string, scope: RetrievalScope): SelectionItem | undefined {
    const project = this.projectScope(scope)
    const reason = `直接读取 ${kind} ${id}`
    try {
      switch (kind) {
        case 'person': {
          const view = this.deps.people.read(id)
          return { ...this.publicItem(this.personItem(view)), reason }
        }
        case 'event': {
          const event = this.deps.events.get(id)
          return this.eventInScope(event, project)
            ? { ...this.publicItem(this.eventItem(event)), reason } : undefined
        }
        case 'task': {
          const read = this.deps.tasks.read(id)
          return this.taskInScope(read, project) ? { ...this.publicItem(this.taskItem(read)), reason } : undefined
        }
        case 'short-term': {
          const read = this.deps.shortTerm.read(id)
          return this.shortTermInScope(read, project)
            ? { ...this.publicItem(this.shortTermItem(read)), reason } : undefined
        }
        case 'document': {
          const record = this.deps.events.store.get('documents', id)
          if (!this.documentInScope(record)) return undefined
          return { ...this.publicItem(this.recordItem('document', this.deps.documents.read(id))), reason }
        }
        case 'archive': {
          const record = this.deps.events.store.get('tasks', id)
          return this.archiveInScope(record, project)
            ? { ...this.publicItem(this.recordItem('archive', record)), reason } : undefined
        }
        case 'experience': {
          const experiences = this.deps.experiences
          if (experiences !== undefined) {
            const view = experiences.read(id)
            return this.experienceInScope(view, project)
              ? { ...this.publicItem(this.experienceItem(view)), reason } : undefined
          }
          const record = this.deps.events.store.get('experiences', id)
          return { ...this.publicItem(this.recordItem('experience', record)), reason }
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }
  /**
   * The records that reference `kind`/`id`, after rereading the editable views: a hand edit that changed an entry's
   * sources takes effect here at once. Selections are frozen snapshots, so their references keep their original sources.
   */
  usedBy(kind: MemoryKind, id: string): MemoryReference[] {
    this.deps.people.list()
    this.deps.tasks.list()
    this.deps.shortTerm.reconcile()
    // A confirmed experience's rich references are rebuilt from its view, never reduced to its record's single source.
    this.deps.experiences?.list()
    return this.index.usedBy(indexedKind[kind], id)
  }
  /** Broken or repaired memory files, by path, as the index currently reports them. */
  diagnostics(): { path: string; reason: string }[] { return this.index.diagnostics() }
  /**
   * Indexes every saved selection once at startup, so each selection's references to its items and their sources survive
   * a deleted index. A broken selection file is reported by path and skipped.
   */
  reconcile(): void {
    for (const name of readdirSync(this.selections)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const path = join(this.selections, name)
      try {
        const content = readFileSync(path, 'utf8')
        const selection = JSON.parse(content) as MemorySelection | null
        if (selection === null || typeof selection !== 'object' || typeof selection.id !== 'string' || !Array.isArray(selection.items)) {
          throw new Error('not a memory selection')
        }
        this.indexSelection(selection, path, sha256(content))
        this.index.clearDiagnostic(path)
      } catch (error) {
        this.index.report(path, reasonOf(error))
      }
    }
  }
  /** Index one saved selection: each item's own identity and each of its real sources become references to that selection. */
  private indexSelection(selection: MemorySelection, path: string, version: string): void {
    const references: MemoryReference[] = []
    for (const item of selection.items) {
      references.push({ kind: indexedKind[item.kind], id: item.id })
      for (const source of item.sources) references.push({ kind: source.kind, id: source.id })
    }
    this.index.upsert({ kind: 'selection', id: selection.id, path, version, references })
  }
  /** The project scope state of one call: its bound project and the tasks currently assigned to it. */
  private projectScope(scope: RetrievalScope, reads?: Iterable<ReturnType<TaskLists['read']>>): ProjectScope {
    const taskIds = new Set<string>([scope.projectId])
    for (const read of reads ?? this.deps.tasks.list()) {
      if (read.runtime?.project_id === scope.projectId) taskIds.add(read.task.id)
    }
    return { projectId: scope.projectId, taskIds }
  }
  /** Whether one event fact belongs to the scoped project: its real source must not be private chat and a recorded task owns it. */
  private eventInScope(event: MemoryEvent, scope: ProjectScope): boolean {
    if (privateChatSources.has(event.event.source.kind)) return false
    // A task that moved to another project cannot be revived by the projectId an old event still carries.
    if (event.event.taskId !== undefined) return scope.taskIds.has(event.event.taskId)
    return event.event.projectId === scope.projectId
  }
  /** Whether one task list is currently the project task itself or assigned to the bound project. */
  private taskInScope(read: ReturnType<TaskLists['read']>, scope: ProjectScope): boolean {
    return scope.taskIds.has(read.task.id)
  }
  /** Whether one short-term entry belongs to a task currently in the scoped project. */
  private shortTermInScope(item: ReturnType<ShortTerm['read']>, scope: ProjectScope): boolean {
    return item.taskId !== undefined && scope.taskIds.has(item.taskId)
  }
  /** Whether one task archive belongs to a task currently in the scoped project. */
  private archiveInScope(record: MemoryRecord, scope: ProjectScope): boolean {
    if (record.source.kind === 'project') return record.source.id === scope.projectId
    if (record.source.kind === 'task') return scope.taskIds.has(record.source.id)
    if (record.source.kind !== 'short-term') return false
    try {
      const item = (JSON.parse(record.content) as { item?: { taskId?: string } }).item
      return item?.taskId !== undefined && scope.taskIds.has(item.taskId)
    } catch {
      return false
    }
  }
  /** Whether a document's registered original is safe to read back: its source id and path are both checked before the read. */
  private documentInScope(record: MemoryRecord): boolean {
    const path = record.source.path
    return path !== undefined && !this.forbiddenPath(record.source.id) && !this.forbiddenPath(path)
  }
  /** Raw private storage: the persona card, raw event files and the chat database, plus everything under the event files. */
  private forbiddenPath(path: string): boolean {
    const key = pathKey(path)
    return key === this.personaPath || key === this.chatStorePath
      || key === this.eventsRoot || key.startsWith(this.eventsRoot + sep)
  }
  /** One item before it leaves a scoped retrieval: forbidden sources disappear and private paths are not exposed. */
  private publicItem(item: Omit<SelectionItem, 'reason'>): Omit<SelectionItem, 'reason'> {
    const { path: _path, ...rest } = item
    return { ...rest, text: this.publicText(item.kind, item.text), sources: this.publicSources(item.sources),
      ...(item.path === undefined || this.forbiddenPath(item.path) ? {} : { path: item.path }) }
  }
  /** Task and archive JSON carry source lists inside their text as well as on the outer selection item. */
  private publicText(kind: SelectionItem['kind'], text: string): string {
    if (kind !== 'task' && kind !== 'archive') return text
    return JSON.stringify(JSON.parse(text), (key: string, value: unknown) =>
      key === 'sources' && Array.isArray(value) ? this.publicSources(value as MemorySource[]) : value)
  }
  private publicSources(sources: MemorySource[]): MemorySource[] {
    return sources.flatMap(source => {
      const safe = this.publicSource(source)
      return safe === undefined ? [] : [safe]
    })
  }
  /** One source reference: an id that names private storage is dropped, a private path is stripped, the other fields stay. */
  private publicSource(source: MemorySource): MemorySource | undefined {
    if (this.forbiddenPath(source.id)) return undefined
    if (privateSourceKinds.has(source.kind)) return { kind: source.kind, id: source.id }
    if (source.path !== undefined && this.forbiddenPath(source.path)) return { kind: source.kind, id: source.id }
    return source
  }
  /** Reopens one snapshot item only when its current source still passes the project scope; the snapshot is never read blind. */
  private reopenInScope(item: SelectionItem, scope: ProjectScope): ReopenedItem | undefined {
    // The frozen snapshot itself is checked too: its path must not name private storage even when the current source looks safe.
    if (item.path !== undefined && this.forbiddenPath(item.path)) return undefined
    if (item.kind === 'document' && item.sources.some(source => this.forbiddenPath(source.id)
      || (source.path !== undefined && this.forbiddenPath(source.path)))) return undefined
    const reopen = (currentVersion: string, currentText: string): ReopenedItem => {
      const safe = this.publicItem(item)
      // The old item reason also embeds the old query reason, which may name main-session search conditions.
      return { ...safe, reason: 'Project-scoped selection', currentVersion, changed: currentVersion !== safe.version,
        currentText: this.publicText(item.kind, currentText) }
    }
    try {
      switch (item.kind) {
        case 'person': {
          const read = this.deps.people.read(item.id)
          return reopen(read.version, JSON.stringify(read.card))
        }
        case 'event': {
          const event = this.deps.events.get(item.id)
          return this.eventInScope(event, scope) ? reopen(event.version, event.event.text) : undefined
        }
        case 'task': {
          const read = this.deps.tasks.read(item.id)
          return this.taskInScope(read, scope) ? reopen(read.version, JSON.stringify(read.task)) : undefined
        }
        case 'short-term': {
          const read = this.deps.shortTerm.read(item.id)
          return this.shortTermInScope(read, scope) ? reopen(read.version, read.text) : undefined
        }
        case 'document': {
          const record = this.deps.events.store.get('documents', item.id)
          if (!this.documentInScope(record)) return undefined
          const read = this.deps.documents.read(item.id)
          return reopen(read.version, read.content)
        }
        case 'archive': {
          const record = this.deps.events.store.get('tasks', item.id)
          return this.archiveInScope(record, scope) ? reopen(record.version, record.content) : undefined
        }
        case 'experience': {
          const experiences = this.deps.experiences
          if (experiences !== undefined) {
            const view = experiences.read(item.id)
            return this.experienceInScope(view, scope) ? reopen(view.version, view.text) : undefined
          }
          const record = this.deps.events.store.get('experiences', item.id)
          return reopen(record.version, record.content)
        }
        default:
          return undefined
      }
    } catch {
      return undefined
    }
  }
  /** The current version and text of one selected source, read from its authoritative file. */
  private current(item: SelectionItem): { currentVersion: string; currentText: string } {
    switch (item.kind) {
      case 'person': {
        const read = this.deps.people.read(item.id)
        return { currentVersion: read.version, currentText: JSON.stringify(read.card) }
      }
      case 'event': {
        const event = this.deps.events.get(item.id)
        return { currentVersion: event.version, currentText: event.event.text }
      }
      case 'task': {
        const read = this.deps.tasks.read(item.id)
        return { currentVersion: read.version, currentText: JSON.stringify(read.task) }
      }
      case 'short-term': {
        // The unified short-term view owns the current text, active or archived; the snapshot above never changes.
        const read = this.deps.shortTerm.read(item.id)
        return { currentVersion: read.version, currentText: read.text }
      }
      case 'document': {
        const read = this.deps.documents.read(item.id)
        return { currentVersion: read.version, currentText: read.content }
      }
      case 'archive': {
        const record = this.deps.events.store.get('tasks', item.id)
        return { currentVersion: record.version, currentText: record.content }
      }
      case 'experience': {
        const experiences = this.deps.experiences
        if (experiences !== undefined) {
          const view = experiences.read(item.id)
          return { currentVersion: view.version, currentText: view.text }
        }
        const record = this.deps.events.store.get('experiences', item.id)
        return { currentVersion: record.version, currentText: record.content }
      }
    }
  }
  private personItem(view: PersonView): Omit<SelectionItem, 'reason'> {
    return { kind: 'person', id: view.card.id, text: JSON.stringify(view.card), version: view.version, path: view.path,
      sources: [{ kind: 'person', id: view.card.id, path: view.path },
        ...view.eventIds.map(eventId => ({ kind: 'event', id: eventId }))] }
  }
  private eventItem(event: MemoryEvent): Omit<SelectionItem, 'reason'> {
    return { kind: 'event', id: event.id, text: event.event.text, sources: [event.source], version: event.version,
      ...(event.source.path ? { path: event.source.path } : {}) }
  }
  private taskItem(read: ReturnType<TaskLists['read']>): Omit<SelectionItem, 'reason'> {
    return { kind: 'task', id: read.task.id, text: JSON.stringify(read.task), sources: read.task.sources,
      version: read.version, path: read.path }
  }
  private shortTermItem(item: ReturnType<ShortTerm['read']>): Omit<SelectionItem, 'reason'> {
    return { kind: 'short-term', id: item.id, text: item.text, sources: item.sources, version: item.version, path: item.path }
  }
  private recordItem(kind: 'document' | 'archive' | 'experience', record: MemoryRecord): Omit<SelectionItem, 'reason'> {
    return { kind, id: record.id, text: record.content, sources: [record.source], version: record.version,
      ...(record.source.path ? { path: record.source.path } : {}) }
  }
  /**
   * Every real source event of one confirmed experience, in view order: its original events, its final facts and the
   * user events of its corrections, each retained once. No source is dropped, so a scoped caller checks all of them.
   */
  private experienceSources(view: ExperienceView): MemorySource[] {
    const sources: MemorySource[] = []
    const seen = new Set<string>()
    const add = (id: string): void => {
      if (seen.has(id)) return
      seen.add(id)
      sources.push({ kind: 'event', id })
    }
    for (const id of view.eventIds) add(id)
    for (const id of view.finalEventIds) add(id)
    for (const revision of view.history) add(revision.eventId)
    return sources
  }
  /** One confirmed experience as a selected item: its current text, every real source event and its file version. */
  private experienceItem(view: ExperienceView): Omit<SelectionItem, 'reason'> {
    return { kind: 'experience', id: view.id, text: view.text, sources: this.experienceSources(view),
      version: view.version, path: view.path }
  }
  /**
   * Whether every real source event of one confirmed experience belongs to the scoped project and none is private chat.
   * A project match on one event never admits an experience whose other source, final or correction events are private
   * or belong elsewhere.
   */
  private experienceInScope(view: ExperienceView, scope: ProjectScope): boolean {
    for (const source of this.experienceSources(view)) {
      try {
        if (!this.eventInScope(this.deps.events.get(source.id), scope)) return false
      } catch {
        // A cited event that cannot be read is not evidence that the experience stays inside the scope.
        return false
      }
    }
    return true
  }
}
