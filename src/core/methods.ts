/** Immutable memory methods: versioned selection instructions kept as files under the memory root. */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { publishFile } from './files.ts'

/** The code-fixed method every selection uses until a confirmed activation names another one. */
export const BUILTIN_METHOD_VERSION = 'builtin-v1'
/** One immutable selection method: its version, the instructions appended to the fixed selector prompt and its creation time. */
export interface MemoryMethod { version: string; instructions: string; createdAt?: string }

/** The builtin method carries no extra instructions, so the fixed selection prompt stays exactly as it is. */
const BUILTIN_METHOD: MemoryMethod = Object.freeze({ version: BUILTIN_METHOD_VERSION, instructions: '' })

/** The JSON shape of the active version pointer. This package only reads it; a later confirmed activation writes it. */
interface ActivePointer { version: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The memory methods library: one candidate file per immutable method record, plus the active version pointer.
 * A candidate is created but never activated here: `active()` keeps returning `builtin-v1` until some later,
 * separately confirmed activation writes the pointer, and this package exposes no activation switch.
 */
export class MemoryMethods {
  readonly root: string
  private readonly candidates: string
  private readonly activePath: string
  /** Opens the library under `memoryRoot`, creating the candidate directory so the first write needs no extra setup. */
  constructor(memoryRoot: string) {
    this.root = join(memoryRoot, 'methods')
    this.candidates = join(this.root, 'candidates')
    this.activePath = join(this.root, 'active.json')
    mkdirSync(this.candidates, { recursive: true })
  }
  /** The method one selection must use now: the explicitly active version, or the code-fixed builtin when none was activated. */
  active(): MemoryMethod {
    const pointer = this.readActive()
    if (pointer === undefined) return BUILTIN_METHOD
    const method = this.get(pointer.version)
    if (method === undefined) throw new Error(`Active memory method ${pointer.version} does not exist`)
    return method
  }
  /** One stored method by version; the builtin never reads the disk, and a candidate record never changes after creation. */
  get(version: string): MemoryMethod | undefined {
    if (version === BUILTIN_METHOD_VERSION) return BUILTIN_METHOD
    const path = this.candidatePath(version)
    if (!existsSync(path)) return undefined
    const parsed = this.parse(version, path)
    return Object.freeze({ version, instructions: parsed.instructions,
      ...(parsed.createdAt === undefined ? {} : { createdAt: parsed.createdAt }) })
  }
  /**
   * Store one candidate method. This never changes `active()`: the version pointer written by the later confirmed
   * activation is the only thing that can select a candidate, and no such switch exists in this package.
   */
  createCandidate(version: string, instructions: string): MemoryMethod {
    if (version === BUILTIN_METHOD_VERSION)
      throw new Error(`Memory method ${BUILTIN_METHOD_VERSION} is fixed by the code`)
    if (version.length === 0) throw new Error('A memory method needs a version')
    const path = this.candidatePath(version)
    if (existsSync(path)) throw new Error(`Memory method ${version} already exists and cannot be changed`)
    const method: MemoryMethod = { version, instructions, createdAt: new Date().toISOString() }
    publishFile(path, JSON.stringify(method, null, 2) + '\n')
    return Object.freeze(method)
  }
  /** The file of one candidate: the version is percent-encoded so one version is always one portable filename. */
  private candidatePath(version: string): string { return join(this.candidates, encodeURIComponent(version) + '.json') }
  /** One candidate record, checked so a broken file fails with its own path instead of becoming a silent default. */
  private parse(version: string, path: string): { instructions: string; createdAt?: string } {
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new Error(`Invalid memory method ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(parsed)) throw new Error(`Invalid memory method ${path}`)
    const { version: storedVersion, instructions, createdAt } = parsed
    if (storedVersion !== version || typeof instructions !== 'string'
      || (createdAt !== undefined && typeof createdAt !== 'string'))
      throw new Error(`Invalid memory method ${path}`)
    return { instructions, ...(createdAt === undefined ? {} : { createdAt }) }
  }
  /** The saved active pointer, or undefined when no method was activated yet; a malformed pointer is an error. */
  private readActive(): ActivePointer | undefined {
    if (!existsSync(this.activePath)) return undefined
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(readFileSync(this.activePath, 'utf8'))
    } catch (error) {
      throw new Error(`Invalid active memory method pointer ${this.activePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!isRecord(parsed)) throw new Error(`Invalid active memory method pointer ${this.activePath}`)
    const { version } = parsed
    if (typeof version !== 'string' || version.length === 0)
      throw new Error(`Invalid active memory method pointer ${this.activePath}`)
    return { version }
  }
}
