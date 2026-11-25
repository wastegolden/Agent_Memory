/** Human-readable file storage for Jarvis memory: four independent libraries whose JSON records can be read and edited by hand, with a shared or in-memory index behind source lookup. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { publishFile } from './files.ts'
import { MemoryIndex, type IndexedMemory } from './index.ts'

/** The four independent memory libraries, each stored in its own directory under the memory root. */
export const memoryLibraries = ['events', 'tasks', 'documents', 'experiences'] as const
/** One memory library: event facts, archived tasks, documents, or experiences. */
export type MemoryLibrary = (typeof memoryLibraries)[number]
/** Where a record came from: its kind and ID, plus the path of the original text when one exists. */
export interface MemorySource { kind: string; id: string; path?: string }
/** A record to write: its source and content, under an optional caller-chosen safe single-file ID that defaults to a generated one. */
export interface MemoryInput { id?: string; source: MemorySource; content: string }
/** A stored memory record, exactly as its JSON file holds it. */
export interface MemoryRecord { id: string; createdAt: string; updatedAt: string; source: MemorySource; version: string; content: string }
/** A source-index match: the library and ID that locate the record, and the version of the content actually on disk. */
export interface MemoryIndexItem { library: MemoryLibrary; id: string; version: string }

/** The version of memory content: the SHA-256 digest of its UTF-8 text, so edited content has a different version. */
const contentVersion = (content: string): string => createHash('sha256').update(content, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** Whether a parsed file holds the generic record fields a library file must have. */
const isMemoryRecord = (value: unknown): value is MemoryRecord => {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<MemoryRecord>
  return typeof candidate.id === 'string' && typeof candidate.createdAt === 'string'
    && typeof candidate.updatedAt === 'string' && typeof candidate.content === 'string'
    && typeof candidate.source === 'object' && candidate.source !== null
    && typeof candidate.source.kind === 'string' && typeof candidate.source.id === 'string'
    && (candidate.source.path === undefined || typeof candidate.source.path === 'string')
}
/** Whether two sources name the same original; the optional path is part of a record's own source, not of a lookup. */
const sameSource = (left: MemorySource, right: MemorySource): boolean =>
  left.kind === right.kind && left.id === right.id && left.path === right.path
const namesSource = (source: MemorySource, target: { kind: string; id: string }): boolean =>
  source.kind === target.kind && source.id === target.id

/**
 * Direct file storage for memory records: one human-readable JSON file per record, in an `events`, `tasks`, `documents`
 * or `experiences` directory under an absolute root. The index is rebuildable metadata only, so a record edited by hand
 * is reported with its edited content, source and version on the next read.
 */
export class MemoryStore {
  private readonly index: MemoryIndex
  /**
   * Opens the store at absolute directory `root`, creating the four library directories when they are missing. A supplied
   * index — as `{ index }` or directly — is shared with the caller (an event stream reuses the store's index); otherwise
   * the store keeps an in-memory one.
   * @throws When `root` is not absolute, so stored records never depend on the process working directory.
   */
  constructor(readonly root: string, options: { index?: MemoryIndex } | MemoryIndex = {}) {
    if (!isAbsolute(root)) throw new Error(`Memory root must be absolute: ${root}`)
    this.index = options instanceof MemoryIndex ? options : options.index ?? new MemoryIndex(root, { memory: true })
    for (const library of memoryLibraries) mkdirSync(join(root, library), { recursive: true })
    this.scan()
  }
  /**
   * Writes `input.content` as record `input.id` in `library`, creating the file or replacing its source, content,
   * updatedAt and version; a repeated put keeps the createdAt saved first. The file is published before the index follows.
   * @returns The record saved, with a generated ID when the input had none.
   */
  put(library: MemoryLibrary, input: MemoryInput): MemoryRecord {
    const id = input.id ?? randomUUID()
    const path = this.file(library, id)
    const previous = this.saved(path)
    const now = new Date().toISOString()
    const record: MemoryRecord = { id, createdAt: previous?.createdAt ?? now, updatedAt: now, source: input.source,
      version: contentVersion(input.content), content: input.content }
    publishFile(path, `${JSON.stringify(record, null, 2)}\n`)
    this.index.upsert(this.indexed(library, record, path))
    this.index.clearDiagnostic(path)
    return record
  }
  /**
   * Reads record `id` in `library` from its file and reports the version of the content actually stored, so content edited
   * by hand is visible on the next read; an edited record refreshes its indexed source and version.
   * @throws When no record file exists there, or it is not a generic record.
   */
  get(library: MemoryLibrary, id: string): MemoryRecord {
    const path = this.file(library, id)
    const text = readFileSync(path, 'utf8')
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch (error) {
      this.index.report(path, `invalid JSON: ${reasonOf(error)}`)
      throw new Error(`Invalid memory record ${path}: ${reasonOf(error)}`)
    }
    if (!isMemoryRecord(value)) {
      this.index.report(path, 'invalid memory record')
      throw new Error(`Invalid memory record ${path}: not a file library record`)
    }
    const record: MemoryRecord = { ...value, version: contentVersion(value.content) }
    const indexed = this.index.get(library, id)
    const currentSource = indexed?.sources?.[0]
    if (!indexed || indexed.version !== record.version || currentSource === undefined || !sameSource(currentSource, record.source))
      this.index.upsert(this.indexed(library, record, path))
    this.index.clearDiagnostic(path)
    return record
  }
  /**
   * Every generic record in `library`, read from disk; application event files in a month subdirectory are not generic
   * records, so only this library directory's own JSON files are read. A damaged file is reported and left out.
   */
  list(library: MemoryLibrary): MemoryRecord[] {
    const directory = join(this.root, library)
    const records: MemoryRecord[] = []
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
      try {
        records.push(this.get(library, entry.name.slice(0, -'.json'.length)))
      } catch (error) {
        this.index.report(join(directory, entry.name), reasonOf(error))
      }
    }
    return records
  }
  /**
   * Records whose sources name `source`, answered by the index rather than by walking the libraries. Application events
   * are reported under the `events` library, and generic hits are reread so an edited source and version are current.
   */
  findBySource(source: { kind: string; id: string }): MemoryIndexItem[] {
    const found: MemoryIndexItem[] = []
    for (const hit of this.index.findBySource(source)) {
      if (hit.kind === 'event') {
        found.push({ library: 'events', id: hit.id, version: hit.version })
        continue
      }
      if (!(memoryLibraries as readonly string[]).includes(hit.kind)) continue
      const library = hit.kind as MemoryLibrary
      let record: MemoryRecord
      try {
        record = this.get(library, hit.id)
      } catch (error) {
        this.index.report(hit.path, reasonOf(error))
        continue
      }
      if (!namesSource(record.source, source)) continue
      found.push({ library, id: record.id, version: record.version })
    }
    return found.sort((a, b) => memoryLibraries.indexOf(a.library) - memoryLibraries.indexOf(b.library)
      || a.id.localeCompare(b.id))
  }
  /** Reads only the generic library root's own JSON files once, so opening a library never walks the event month files. */
  private scan(): void {
    for (const library of memoryLibraries) {
      const directory = join(this.root, library)
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.startsWith('.')) continue
        try {
          this.get(library, entry.name.slice(0, -'.json'.length))
        } catch (error) {
          this.index.report(join(directory, entry.name), reasonOf(error))
        }
      }
    }
  }
  /** The saved file's record, when there is one, so a repeated put can keep its createdAt. */
  private saved(path: string): MemoryRecord | undefined {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as MemoryRecord : undefined
  }
  /** The index metadata of a generic record: its library names its kind, so the four libraries never collide. */
  private indexed(library: MemoryLibrary, record: MemoryRecord, path: string): IndexedMemory {
    return { kind: library, id: record.id, path, version: record.version, sources: [record.source] }
  }
  /** The absolute path of the JSON file for record `id` in `library`. */
  private file(library: MemoryLibrary, id: string): string {
    return join(this.root, library, `${id}.json`)
  }
}

/** The default memory directory beside a Runtime state file: the `memory` directory in `stateDir`'s parent. */
export const memoryPath = (stateDir: string): string => join(dirname(stateDir), 'memory')
