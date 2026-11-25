/** Jarvis changing its own persona card: one authoritative card, every change citing real events and a specific reason, and a bottom-line change waiting for the owner's later web message. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { PersonaCard } from './ports/persona.ts'
import type { PersonaHost } from './ports/persona.ts'
import type { MemoryEvents } from './events.ts'
import { publishFile } from './files.ts'
import type { IndexedMemory, MemoryIndex, MemoryReference } from './index.ts'

/** The index identity of the one authoritative card: records that depend on it reference this target. */
const PERSONA_KIND = 'persona'
const PERSONA_ID = 'jarvis'
/** A level-2 heading line; the bottom line ends where the next section begins. */
const HEADING = /^##[ \t]+.*$/m
/** The heading whose body is what Jarvis must never do: any change to that body needs the owner's confirmation. */
const BOTTOM_LINE = /^##[ \t]+底线[ \t]*$/m
/** What a pending proposal asks the owner, and how Jarvis must relay it before confirming. */
const QUESTION = '这次角色卡改动涉及底线，需要用户确认后才能写入。'
const INSTRUCTION = '请把要改的具体内容和理由告诉用户，并说明涉及底线；先不要写入。等用户在下一条网页消息里明确同意后，再用那条消息的 trigger_id 调用 persona_confirm 确认这个提案；用户没有明确同意时不要确认。'

/** One saved change, exactly as its JSON file holds it; `pending` is a proposal waiting for the owner's answer. */
export interface PersonaChangeRecord {
  id: string
  status: 'pending' | 'applied'
  createdAt: string
  /** The complete new card body; the pending proposal's exact text, which a confirmation writes unchanged. */
  text: string
  /** The card version the change started from, rechecked before a confirmation writes. */
  baseVersion: string
  /** The specific reason Jarvis gives for the change. */
  reason: string
  /** The stored events that justify it; every id names an event that existed when the change was entered. */
  evidenceEventIds: string[]
  /** Whether the change concerns the bottom line, by Jarvis' declaration or by the section body moving. */
  bottomLine: boolean
  /** Whether the `## 底线` section body, or the section itself, changed. */
  sectionChanged: boolean
  question?: string
  appliedAt?: string
  afterVersion?: string
  /** The owner's web message that confirmed a bottom-line proposal. */
  triggerId?: string
}

/** What one requested change says: the complete new card, the version it read, why, and the event facts. */
export interface PersonaChangeInput {
  text: string
  baseVersion: string
  reason: string
  evidenceEventIds: string[]
  /** Jarvis' own declaration that the change concerns what it must never do, even outside the 底线 section. */
  bottomLine?: boolean
}

/** The current card and the proposals still waiting for the owner. */
export interface PersonaChangeView {
  card: PersonaCard
  pending: PersonaChangeRecord[]
}

/** The answer to a change: written now, or saved as a concrete proposal and the question to ask the user first. */
export type PersonaChangeResult =
  | { status: 'applied'; card: PersonaCard; change: PersonaChangeRecord }
  | { status: 'needs_confirmation'; card: PersonaCard; change: PersonaChangeRecord; question: string; instruction: string }

/** What one persona change depends on: the card port, the event facts, the shared index and the owner's saved messages. */
export interface PersonaChangeDeps {
  /** The Runtime's persona port; the card file stays authoritative and is the only persona written. */
  persona: PersonaHost
  /** The absolute path the card port reads and writes, named by the persona index row. */
  path: string
  events: Pick<MemoryEvents, 'get' | 'record'>
  /** The one shared index: the version publication, and never a second change reporter. */
  index: Pick<MemoryIndex, 'get' | 'upsert'>
  /** The minimal confirmation lookup: the owner's saved message by id, its source, humanity and time. */
  messages: { get(id: string): { source: string; human: boolean; at: string } | undefined }
}

/** The body of the `## 底线` section: from its heading to the next level-2 heading, or undefined when the card has none. */
function bottomLineBody(text: string): string | undefined {
  const heading = BOTTOM_LINE.exec(text)
  if (heading === null) return undefined
  const rest = text.slice(heading.index + heading[0].length)
  const next = HEADING.exec(rest)
  return next === null ? rest : rest.slice(0, next.index)
}

/** Whether two card bodies differ in their bottom line, including a section that was removed or added. */
const bottomLineChanged = (before: string, after: string): boolean => bottomLineBody(before) !== bottomLineBody(after)

/** Whether the index already holds this card version, path and evidence set, so an unchanged read writes nothing. */
const indexMatches = (indexed: IndexedMemory | undefined, path: string, version: string, references: MemoryReference[]): boolean =>
  indexed !== undefined && indexed.path === path && indexed.version === version
  && JSON.stringify(indexed.references ?? []) === JSON.stringify(references)

/**
 * One persona card at `<memoryRoot>/persona-changes` records its changes: an ordinary change applies at once, while a
 * change to the bottom line is saved whole as a pending proposal and applied only after the owner's later web message.
 * Every written change becomes an event fact and publishes the card's version to the one persona index row; the memory
 * module's version listener turns that publication into a review of the records that reference the card.
 */
export class PersonaChanges {
  readonly root: string
  /** Opens the change records at `memoryRoot`, creating the directory when it is missing. */
  constructor(memoryRoot: string, private readonly deps: PersonaChangeDeps) {
    this.root = join(memoryRoot, 'persona-changes')
    mkdirSync(this.root, { recursive: true })
  }
  /** The card and the proposals waiting for the owner; a hand-edited card is published here, never rewritten by the read. */
  read(): PersonaChangeView {
    const card = this.deps.persona.read()
    this.publish(card)
    return { card, pending: this.pending() }
  }
  /**
   * Writes an ordinary change at once, or saves a complete proposal and the question to ask when the change touches the
   * bottom line (declared by the caller or detected in the `## 底线` section). Evidence is checked before anything is written.
   */
  change(input: PersonaChangeInput): PersonaChangeResult {
    const current = this.deps.persona.read()
    if (input.baseVersion !== current.version)
      throw new Error(`Persona card is version ${current.version}, not ${input.baseVersion}: reread the card and propose again`)
    if (input.evidenceEventIds.length === 0) throw new Error('A persona change needs at least one evidence event')
    for (const eventId of input.evidenceEventIds) this.deps.events.get(eventId)
    const sectionChanged = bottomLineChanged(current.text, input.text)
    const bottomLine = input.bottomLine === true || sectionChanged
    const record: PersonaChangeRecord = {
      id: randomUUID(), status: 'pending', createdAt: new Date().toISOString(), text: input.text,
      baseVersion: current.version, reason: input.reason, evidenceEventIds: [...input.evidenceEventIds],
      bottomLine, sectionChanged, ...(bottomLine ? { question: QUESTION } : {}),
    }
    if (bottomLine) {
      this.save(record)
      return { status: 'needs_confirmation', card: current, change: record, question: QUESTION, instruction: INSTRUCTION }
    }
    return { status: 'applied', card: this.write(record), change: this.get(record.id) }
  }
  /**
   * Writes a saved proposal only while it is pending, its base version is still the card, and `triggerId` names the
   * owner's saved web message sent after the proposal: the proposal's exact body is applied, never a replacement.
   */
  confirm(input: { proposalId: string; triggerId: string }): { status: 'applied'; card: PersonaCard; change: PersonaChangeRecord } {
    const proposal = this.get(input.proposalId)
    if (proposal.status !== 'pending') throw new Error(`Persona proposal ${input.proposalId} is not pending`)
    const message = this.deps.messages.get(input.triggerId)
    if (message === undefined || message.source !== 'web' || !message.human)
      throw new Error('trigger_id must name the owner\'s saved web message')
    if (!(Date.parse(message.at) > Date.parse(proposal.createdAt)))
      throw new Error('trigger_id must name a message the owner sent after the proposal')
    const current = this.deps.persona.read()
    if (current.version !== proposal.baseVersion)
      throw new Error(`Persona card is version ${current.version}, not the proposal's ${proposal.baseVersion}: reread the card and propose again`)
    return { status: 'applied', card: this.write(proposal, input.triggerId), change: this.get(proposal.id) }
  }
  /** Saves the record's text as the card, records the change event, publishes the version and marks the record applied. */
  private write(record: PersonaChangeRecord, triggerId?: string): PersonaCard {
    // The card read before the write becomes the index baseline, so the written version is a real move the listener reports.
    this.publish(this.deps.persona.read())
    const card = this.deps.persona.save(record.text)
    const at = new Date().toISOString()
    this.deps.events.record({
      kind: 'jarvis', at,
      text: JSON.stringify({
        type: 'persona-change', change_id: record.id, reason: record.reason,
        evidence_event_ids: [...record.evidenceEventIds], before_version: record.baseVersion, after_version: card.version,
        bottom_line: record.bottomLine, section_changed: record.sectionChanged,
        ...(triggerId === undefined ? {} : { confirmed_by: triggerId }),
      }),
      // One source per change, so no later change overwrites this change's event fact.
      source: { kind: 'persona-change', id: record.id },
    })
    const { question: _question, ...applied } = record
    this.save({ ...applied, status: 'applied', appliedAt: at, afterVersion: card.version,
      ...(triggerId === undefined ? {} : { triggerId }) })
    this.publish(card)
    return card
  }
  /** Publishes the card's version and evidence to the one persona index row; a first insert is no change report. */
  private publish(card: PersonaCard): void {
    const references: MemoryReference[] = this.evidenceIds().map(id => ({ kind: 'event', id }))
    if (indexMatches(this.deps.index.get(PERSONA_KIND, PERSONA_ID), this.deps.path, card.version, references)) return
    this.deps.index.upsert({ kind: PERSONA_KIND, id: PERSONA_ID, path: this.deps.path, version: card.version, references })
  }
  /** The evidence of every applied change, in order and once each, so a read's index baseline keeps the earlier sources. */
  private evidenceIds(): string[] {
    const ids: string[] = []
    for (const record of this.all()) {
      if (record.status !== 'applied') continue
      for (const eventId of record.evidenceEventIds) if (!ids.includes(eventId)) ids.push(eventId)
    }
    return ids
  }
  /** The proposals still waiting for the owner, oldest first. */
  private pending(): PersonaChangeRecord[] {
    return this.all().filter(record => record.status === 'pending')
  }
  /** Every saved change, oldest first. */
  private all(): PersonaChangeRecord[] {
    return readdirSync(this.root).filter(name => name.endsWith('.json') && !name.startsWith('.'))
      .map(name => this.get(name.slice(0, -'.json'.length)))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  }
  /** One saved change by id; its file is the authoritative record. */
  private get(id: string): PersonaChangeRecord {
    return JSON.parse(readFileSync(join(this.root, `${id}.json`), 'utf8')) as PersonaChangeRecord
  }
  /** Publishes one change file whole, so a reader sees either the earlier record or the new one. */
  private save(record: PersonaChangeRecord): void {
    publishFile(join(this.root, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
}
