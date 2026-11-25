/** Person cards: human-editable Markdown files about people, whose permanent requirements and relations cite event facts both ways. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryEvents } from './events.ts'
import { publishFile } from './files.ts'
import type { MemoryIndex, MemoryReference } from './index.ts'
import { decodePerson, encodePerson, type PersonMarkdownCard, type PersonMarkdownInput } from './markdown.ts'

/** A requirement that applies from now on to one person, with the event facts it came from. */
export interface PersonRequirement { id: string; text: string; eventIds: string[] }
/** A relation from one person to another, with the event facts that describe it and the stable file ID a decoded card has. */
export interface PersonRelation { id?: string; personId: string; description: string; eventIds: string[] }
/** The editable body of a person card; the runtime ID and save time are added on save. */
export interface PersonInput { id?: string; name: string; description: string; requirements: PersonRequirement[]; relations: PersonRelation[] }
/** A saved person card, exactly as its Markdown file holds it. */
export type PersonCard = Omit<PersonInput, 'id'> & { id: string; updatedAt: string }
/** One card read from disk, with its file location, content version and the event IDs currently linked to its person. */
export interface PersonView { card: PersonCard; path: string; version: string; eventIds: string[] }

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

/**
 * Person cards under `<memoryRoot>/people`, one human-editable Markdown file per person. Anyone can be saved, including
 * someone who never spoke, and no account table is consulted: the files are authoritative and may be edited by hand.
 * The index records which events each requirement and relation cites, so an event's people are found both ways.
 */
export class PersonCards {
  readonly root: string
  /** The index this store writes and reads: the event stream's index unless the caller supplies another one. */
  constructor(memoryRoot: string, private readonly events: MemoryEvents, readonly index: MemoryIndex = events.index) {
    this.root = join(memoryRoot, 'people')
    mkdirSync(this.root, { recursive: true })
  }
  /**
   * Replaces the card for `input.id`, or creates one under a generated ID, and links its person to every event its
   * requirements and relations cite. A cited event must already exist, so a card never invents its own evidence.
   */
  save(input: PersonInput): PersonView {
    const id = input.id ?? randomUUID()
    const eventIds = [...new Set([...input.requirements, ...input.relations].flatMap(item => item.eventIds))]
    for (const eventId of eventIds) this.events.get(eventId)
    const card: PersonMarkdownInput = { ...input, id, updatedAt: new Date().toISOString() }
    const path = this.file(id)
    const content = encodePerson(card)
    publishFile(path, content)
    const decoded = decodePerson(content, path)
    this.refresh(decoded.value, path, sha256(content))
    this.index.clearDiagnostic(path)
    for (const eventId of eventIds) this.linkPerson(id, eventId)
    return this.read(id)
  }
  /** Reads the card file now, so manual edits count, with the event IDs currently linked to `id`. */
  read(id: string): PersonView {
    const path = this.file(id)
    try {
      let content = readFileSync(path, 'utf8')
      const decoded = decodePerson(content, path)
      if (decoded.changed) {
        publishFile(path, decoded.content)
        content = decoded.content
      }
      const version = sha256(content)
      const card = decoded.value
      this.refresh(card, path, version)
      this.index.clearDiagnostic(path)
      const linked = this.events.list({ personId: id })
        .filter(event => (event.event.personIds ?? []).includes(id)).map(event => event.id)
      const cited = [...card.requirements, ...card.relations].flatMap(item => item.eventIds)
      return { card, path, version, eventIds: [...new Set([...linked, ...cited])] }
    } catch (error) {
      this.index.remove('person', id)
      this.index.report(path, reasonOf(error))
      throw error instanceof Error && error.message.includes(path)
        ? error
        : new Error(`Invalid person card ${path}: ${reasonOf(error)}`)
    }
  }
  /** Every card file read from disk; a broken card is reported by path and left out. */
  list(): PersonCard[] {
    const cards: PersonCard[] = []
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md') || entry.name.startsWith('.')) continue
      try { cards.push(this.read(entry.name.slice(0, -'.md'.length)).card) } catch { /* read reported it */ }
    }
    return cards
  }
  /**
   * Links existing card `personId` and existing event `eventId`: the event keeps its kind, source and ID and gains this
   * person, and the card reports the event from now on. Repeating the link leaves one entry per person.
   */
  linkEvent(personId: string, eventId: string): PersonView {
    this.read(personId)
    this.linkPerson(personId, eventId)
    return this.read(personId)
  }
  /**
   * The person IDs recorded on event `eventId` and the existing cards among them. Current cards are read first so a
   * hand-edited citation refreshes the index, then the event's people are merged with the people whose cards cite it;
   * a broken card is isolated and never hides the others.
   */
  forEvent(eventId: string): { personIds: string[]; cards: PersonCard[] } {
    const cards = this.list()
    const { event } = this.events.get(eventId)
    const personIds = [...new Set([...(event.personIds ?? []),
      ...this.index.usedBy('event', eventId).filter(reference => reference.kind === 'person').map(reference => reference.id)])]
    return { personIds, cards: cards.filter(card => personIds.includes(card.id)) }
  }
  /** The authoritative Markdown path of person `id`. */
  private file(id: string): string { return join(this.root, `${id}.md`) }
  /** Index one card's event citations: each requirement and relation contributes its event IDs, keyed by its stable ID. */
  private refresh(card: PersonMarkdownCard, path: string, version: string): void {
    const known = this.index.get('person', card.id)
    if (known && known.path === path && known.version === version) return
    const references: MemoryReference[] = []
    for (const requirement of card.requirements) {
      for (const eventId of requirement.eventIds) {
        references.push({ kind: 'event', id: eventId, part: requirement.id })
      }
    }
    for (const relation of card.relations) {
      for (const eventId of relation.eventIds) {
        references.push({ kind: 'event', id: eventId, part: relation.id })
      }
    }
    this.index.upsert({ kind: 'person', id: card.id, path, version, references })
  }
  /** Record `personId` on existing event `eventId`, keeping the event's kind, source and ID and adding the person once. */
  private linkPerson(personId: string, eventId: string): void {
    const { event } = this.events.get(eventId)
    this.events.record({ ...event, personIds: [...new Set([...(event.personIds ?? []), personId])] })
  }
}
