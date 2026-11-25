/** Authoritative reads behind the review queue: every reference is read through the module that owns its kind, so a snapshot compares the file version a person sees. */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Documents } from './documents.ts'
import type { MemoryEvents } from './events.ts'
import type { Experiences } from './experiences.ts'
import type { MemoryIndex, MemoryReference } from './index.ts'
import type { PersonCards } from './people.ts'
import type { PersonaChanges } from './persona-changes.ts'
import type { MemoryReviewsDeps } from './reviews.ts'
import type { ShortTerm } from './short-term.ts'
import type { TaskLists } from './task-lists.ts'

/** The memory libraries a review read consults, plus the one shared index whose reference and selection rows it uses. */
export interface ReviewReaderLibraries {
  events: Pick<MemoryEvents, 'get' | 'store'>
  people: Pick<PersonCards, 'read'>
  tasks: Pick<TaskLists, 'read'>
  shortTerm: Pick<ShortTerm, 'read'>
  documents: Pick<Documents, 'read'>
  index: Pick<MemoryIndex, 'get' | 'usedBy'>
  persona?: Pick<PersonaChanges, 'read'>
  /** The confirmed-experience library; when present, an experience read comes from its view and the index's rich references. */
  experiences?: Pick<Experiences, 'read'>
}
/** One authoritative read: the version a snapshot records, and the internal memory sources that read depends on. */
export interface ReviewRead { version: string; sources: MemoryReference[] }

/** The index kinds that name memory this reader may read again; a web message, trigger or document original stays external. */
const internalKinds = new Set(['event', 'person', 'persona', 'task', 'short-term', 'documents', 'tasks', 'experiences', 'selection'])
/** The aliases retrieval already uses for unified kinds; every other kind keeps its index kind. */
const kindAliases: Record<string, string> = { events: 'event', document: 'documents', archive: 'tasks', experience: 'experiences' }
const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The index kind of one reference: a unified alias, or the kind itself. */
const indexKind = (kind: string): string => kindAliases[kind] ?? kind
/** The version of one target-local part: the entry itself, or the explicit `null` version of an absent entry. */
const partVersion = (part: string, entry: unknown): string => sha256(JSON.stringify([part, entry ?? null]))
/**
 * The sources of one read: only memory this reader can read again, each identified by kind and id alone (the referencing
 * part is not part of a source's identity), once each.
 */
const sourcesOf = (references: readonly { kind: string; id: string }[]): MemoryReference[] => {
  const sources: MemoryReference[] = []
  const seen = new Set<string>()
  for (const reference of references) {
    const kind = indexKind(reference.kind)
    if (!internalKinds.has(kind)) continue
    const key = JSON.stringify([kind, reference.id])
    if (seen.has(key)) continue
    seen.add(key)
    sources.push({ kind, id: reference.id })
  }
  return sources
}

/**
 * The review queue's two capabilities over the real libraries: `usedBy` answers from the shared index alone, and `read`
 * goes back to the owning module, hashing only the reviewed requirement, relation or task section when a reference names
 * one. A confirmed experience is read through its library and keeps the index's rich references to every source, final
 * and correction event. External source kinds are dropped from a read, so a snapshot never reads a web message or a
 * document original as internal memory.
 */
export function reviewReads(libraries: ReviewReaderLibraries): MemoryReviewsDeps {
  return {
    usedBy: (kind: string, id: string) => libraries.index.usedBy(kind, id),
    read: (reference: MemoryReference) => readOf(libraries, reference),
  }
}

/** Reads one reference through its owning module; its task attribution is never part of what is read or hashed. */
function readOf(libraries: ReviewReaderLibraries, reference: MemoryReference): ReviewRead {
  switch (indexKind(reference.kind)) {
    case 'persona': {
      if (reference.id !== 'jarvis' || !libraries.persona) throw new Error('No persona card for this review')
      const { card } = libraries.persona.read()
      return { version: card.version, sources: sourcesOf(libraries.index.get('persona', 'jarvis')?.references ?? []) }
    }
    case 'event': {
      const event = libraries.events.get(reference.id)
      return { version: event.version, sources: sourcesOf([event.event.source]) }
    }
    case 'person': {
      const view = libraries.people.read(reference.id)
      const part = reference.part
      if (part === undefined) {
        const eventIds = [...view.card.requirements, ...view.card.relations].flatMap(item => item.eventIds)
        return { version: view.version, sources: sourcesOf(eventIds.map(id => ({ kind: 'event', id }))) }
      }
      const requirement = view.card.requirements.find(item => item.id === part)
      const relation = requirement === undefined ? view.card.relations.find(item => item.id === part) : undefined
      const entry = requirement ?? relation ?? null
      const eventIds = entry?.eventIds ?? []
      return { version: partVersion(part, entry), sources: sourcesOf(eventIds.map(id => ({ kind: 'event', id }))) }
    }
    case 'task': {
      const read = libraries.tasks.read(reference.id)
      const part = reference.part
      if (part === 'notes' || part === 'todos') {
        const entries: unknown[] = part === 'notes' ? read.task.notes : read.task.todos
        const sources = part === 'notes'
          ? read.task.notes.flatMap(note => note.sources ?? [])
          : read.task.todos.flatMap(todo => todo.sources ?? [])
        return { version: partVersion(part, entries), sources: sourcesOf(sources) }
      }
      if (part === 'sources') return { version: partVersion(part, read.task.sources), sources: sourcesOf(read.task.sources) }
      return { version: read.version, sources: sourcesOf(read.task.sources) }
    }
    case 'short-term': {
      const view = libraries.shortTerm.read(reference.id)
      return { version: view.version, sources: sourcesOf(view.sources) }
    }
    case 'documents': {
      const record = libraries.documents.read(reference.id)
      return { version: record.version, sources: sourcesOf([record.source]) }
    }
    case 'tasks': {
      const record = libraries.events.store.get('tasks', reference.id)
      return { version: record.version, sources: sourcesOf([record.source]) }
    }
    case 'experiences': {
      const experiences = libraries.experiences
      if (experiences === undefined) {
        const record = libraries.events.store.get('experiences', reference.id)
        return { version: record.version, sources: sourcesOf([record.source]) }
      }
      // The library read refreshes the record's rich index rows, so the snapshot covers every source, final and revision event.
      const view = experiences.read(reference.id)
      const indexed = libraries.index.get('experiences', reference.id)
      const fallback: MemoryReference[] = [...view.eventIds, ...view.finalEventIds,
        ...view.history.map(revision => revision.eventId)].map(id => ({ kind: 'event', id }))
      return { version: view.version, sources: sourcesOf(indexed?.references ?? fallback) }
    }
    case 'selection': {
      const indexed = libraries.index.get('selection', reference.id)
      if (indexed === undefined) throw new Error(`no indexed memory selection ${reference.id}`)
      return { version: sha256(readFileSync(indexed.path, 'utf8')), sources: sourcesOf(indexed.references ?? []) }
    }
    default:
      throw new Error(`No authoritative memory read for ${reference.kind}:${reference.id}`)
  }
}
