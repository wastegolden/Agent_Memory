/** On-demand review of one older experience against the memory method that is active now. */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemoryModelContext as Context } from './ports/model.ts'
import { z } from 'zod'
import { resolveRoleModel } from './ports/model.ts'
import type { MemoryRoleModel as RoleModel } from './ports/model.ts'
import type { ExperienceView } from './experiences.ts'
import type { MemoryEvent } from './events.ts'
import { publishFile } from './files.ts'
import type { MemoryMethod } from './methods.ts'

/** The role one cited event plays in the experience being reviewed. */
export type ExperienceReviewFactRole = 'original' | 'final' | 'correction'

/**
 * One real event a review reads: the role it plays, the event ID, the version actually read from its file, and the
 * event facts themselves. The version is what makes source changes invalidate an earlier proof.
 */
export interface ExperienceReviewFact {
  readonly role: ExperienceReviewFactRole
  readonly id: string
  readonly version: string
  readonly event: MemoryEvent['event']
}

/** The frozen input of one review: the complete experience view, the active method, and every cited real event. */
export interface ExperienceReviewInput {
  readonly experience: ExperienceView
  readonly method: MemoryMethod
  readonly events: readonly ExperienceReviewFact[]
}

/** The only model verdict: whether the method supports this experience against the cited facts, and why. */
export interface ExperienceReviewVerdict { readonly supported: boolean; readonly reason: string }

/** What the service reads: the active method, one experience, its real events, and the caller's one review call. */
export interface ExperienceMethodReviewDeps {
  readonly methods: { active(): MemoryMethod }
  readonly experiences: { read(id: string): ExperienceView }
  readonly events: { get(id: string): MemoryEvent }
  /** The caller-owned model review: it receives the frozen input and may fail for a model, quota or abort reason. */
  review(input: ExperienceReviewInput, signal?: AbortSignal): Promise<ExperienceReviewVerdict>
}

/** What one `ensure` call decided for the requested experience. */
export interface ExperienceMethodReviewResult {
  readonly status: 'current' | 'reviewed' | 'pending-review'
  /** The usable experience, present only for `current` and a supported `reviewed` result. */
  readonly experience?: ExperienceView
  readonly reason?: string
  /** The active method version this decision was made against. */
  readonly methodVersion: string
  /** The saved proof this result read or wrote; absent when the review failed before one could be written. */
  readonly proofId?: string
}

/** One source version recorded in a proof: the role, the event ID and the authoritative file version. */
export interface ExperienceReviewSourceVersion {
  readonly role: ExperienceReviewFactRole
  readonly eventId: string
  readonly version: string
}
/** One saved review proof: the experience and method versions, every source version, the input hash and the verdict. */
export interface ExperienceReviewProof {
  readonly proofId: string
  readonly experienceId: string
  readonly experienceVersion: string
  readonly experienceMethodVersion: string
  readonly methodVersion: string
  readonly sourceVersions: readonly ExperienceReviewSourceVersion[]
  readonly hash: string
  readonly supported: boolean
  readonly reason: string
  readonly reviewedAt: string
}

/** Token usage the review model call reported in one usage chunk. */
export interface ExperienceReviewUsage {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Optional controls for one review model call, wired by the caller to its own maintenance/replay budget. */
export interface ReviewExperienceOptions {
  /** Called immediately before the one model call; throwing refuses the call. */
  beforeCall?: () => void
  /** The most tokens the one model call may produce. */
  maxTokens?: number
  /** Called once with the usage the model reported, including when a later finish or stream fails. */
  onUsage?: (usage: ExperienceReviewUsage) => void
}

/** The one JSON verdict a review may return; the reason is required so an unsupported verdict stays explainable. */
const ReviewVerdictSchema = z.object({
  supported: z.boolean(),
  reason: z.string().trim().min(1),
}).strict()

const REVIEW_PROOF_DIRECTORY = 'experience-reviews'
const createSha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Freeze a value and every nested object or array in place, so no review callback can mutate its frozen input. */
function freezeDeep<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child)
    Object.freeze(value)
  }
  return value
}

/** Copy the event fields that constitute the real fact, so freezing the input cannot freeze library-owned state. */
function eventOf(event: MemoryEvent): MemoryEvent['event'] {
  const source = { kind: event.event.source.kind, id: event.event.source.id,
    ...(event.event.source.path === undefined ? {} : { path: event.event.source.path }) }
  return {
    kind: event.event.kind,
    at: event.event.at,
    text: event.event.text,
    source,
    ...(event.event.taskId === undefined ? {} : { taskId: event.event.taskId }),
    ...(event.event.projectId === undefined ? {} : { projectId: event.event.projectId }),
    ...(event.event.personIds === undefined ? {} : { personIds: [...event.event.personIds] }),
    ...(event.event.log === undefined ? {} : { log: { ...event.event.log } }),
  }
}

/** One frozen fact for a role, built from the event read at its authoritative version. */
function factOf(role: ExperienceReviewFactRole, event: MemoryEvent): ExperienceReviewFact {
  return freezeDeep<ExperienceReviewFact>({ role, id: event.id, version: event.version, event: eventOf(event) })
}

/** A plain copy of the experience view, so the frozen review input never aliases the library's own arrays. */
function experienceOf(view: ExperienceView): ExperienceView {
  return {
    id: view.id,
    text: view.text,
    eventIds: [...view.eventIds],
    finalEventIds: [...view.finalEventIds],
    reason: view.reason,
    methodVersion: view.methodVersion,
    origin: view.origin,
    history: view.history.map(entry => ({ ...entry })),
    path: view.path,
    version: view.version,
  }
}

/** A plain copy of one method, so the review input records the active instructions it actually read. */
function methodOf(method: MemoryMethod): MemoryMethod {
  return { version: method.version, instructions: method.instructions,
    ...(method.createdAt === undefined ? {} : { createdAt: method.createdAt }) }
}

/** The identity of one frozen review input: experience version, active method, and every referenced event version. */
function reviewHash(input: ExperienceReviewInput): string {
  return createSha256(JSON.stringify({
    experience: { id: input.experience.id, version: input.experience.version,
      methodVersion: input.experience.methodVersion },
    method: { version: input.method.version, instructions: input.method.instructions },
    events: input.events.map(fact => ({ role: fact.role, id: fact.id, version: fact.version })),
  }))
}

/** The fixed rules of the one review prompt: evidence only, no invented facts, and one strict JSON answer. */
function reviewRules(): string {
  return 'Review one already-confirmed experience against the memory method that is active now. '
    + 'The experience view and the real events below are the only evidence: never use earlier conversation, never invent or alter an event, and never rewrite the experience. '
    + 'A user event is a user fact; your verdict is a model judgement, not a new fact, so do not turn your conclusion into a fact. '
    + 'Correction events prove what the user corrected, not an unrelated claim. '
    + 'Return supported true only when the original, final and correction facts actually support keeping this experience under the method instructions; '
    + 'if evidence is missing, contradictory or insufficient, return supported false and name what is missing. '
    + 'Return only JSON of this shape: {"supported":true|false,"reason":"..."}'
}

/** The one prompt carries the method instructions first, then the frozen experience and every cited real fact. */
function reviewPrompt(input: ExperienceReviewInput): string {
  return reviewRules()
    + '\nActive memory method version: ' + input.method.version
    + (input.method.instructions.length === 0 ? '' : '\nMethod instructions: ' + input.method.instructions)
    + '\nExperience: ' + JSON.stringify(input.experience)
    + '\nReal events: ' + JSON.stringify(input.events)
}

/**
 * Run the one model review a caller wires as its `review` callback. The caller passes the real `roles.background`
 * route and its own budget controls; this function never selects a default model, spawns a shell or mutates facts.
 * Method instructions and the frozen real facts form one prompt, one strict JSON answer is parsed once, and the usage
 * chunk is reported in `finally` even when the stream fails afterwards.
 */
export async function reviewExperience(ctx: Context, model: RoleModel, input: ExperienceReviewInput,
  signal?: AbortSignal, options: ReviewExperienceOptions = {}): Promise<ExperienceReviewVerdict> {
  const selection = await resolveRoleModel(ctx, model)
  const prompt = reviewPrompt(input)
  options.beforeCall?.()
  let text = ''
  let usage: ExperienceReviewUsage | undefined
  try {
    for await (const chunk of ctx.llm.stream({ ...selection, ...(signal ? { signal } : {}),
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish' && chunk.reason.kind !== 'stop')
        throw new Error(`Experience review did not finish: ${JSON.stringify(chunk.reason)}`)
    }
  } finally {
    if (usage !== undefined) options.onUsage?.(usage)
  }
  const verdict = ReviewVerdictSchema.parse(JSON.parse(text))
  if (verdict.supported && input.events.length === 0)
    throw new Error('Experience review returned supported without any real event evidence')
  return verdict
}

/**
 * The on-demand review of one older experience against the active method. `ensure` reads only the requested experience
 * and its own cited events. An experience already on the active method is current; otherwise one frozen input and hash
 * are built and one caller-owned review is made. A matching saved proof answers without another model call, while a
 * thrown call writes no proof and therefore never blocks the next retry. The experience file itself is never written:
 * an edit that lands during a review leaves the result pending and keeps the earlier proof.
 */
export class ExperienceMethodReview {
  private readonly proofs: string
  /** Creates the proof directory under `<memoryRoot>/methods`, so a first review needs no extra setup. */
  constructor(memoryRoot: string, private readonly deps: ExperienceMethodReviewDeps) {
    this.proofs = join(memoryRoot, 'methods', REVIEW_PROOF_DIRECTORY)
    mkdirSync(this.proofs, { recursive: true })
  }
  /**
   * Decide whether one experience is usable under the active method. A matching proof is reused only for the same
   * experience version, method version and every cited event version; a changed method or source therefore reviews
   * again, and no other experience or event is read.
   */
  async ensure(id: string, signal?: AbortSignal): Promise<ExperienceMethodReviewResult> {
    const experience = this.deps.experiences.read(id)
    const method = this.deps.methods.active()
    if (experience.methodVersion === method.version)
      return { status: 'current', experience, methodVersion: method.version }
    const input = this.frozenInput(experience, method)
    const hash = reviewHash(input)
    const known = this.loadProof(experience.id)
    // A completed verdict, supported or not, is a result for exactly this input and is reused; a thrown call is not cached.
    if (known !== undefined && known.hash === hash && known.experienceId === experience.id
      && known.experienceVersion === experience.version && known.methodVersion === method.version) {
      return known.supported
        ? { status: 'reviewed', experience, methodVersion: method.version, proofId: known.proofId }
        : { status: 'pending-review', reason: known.reason, methodVersion: method.version, proofId: known.proofId }
    }
    let verdict: ExperienceReviewVerdict
    try {
      verdict = await this.deps.review(input, signal)
    } catch (error) {
      // A transient model, quota or abort failure writes nothing: the next ensure may try the same input again.
      return { status: 'pending-review', reason: reasonOf(error), methodVersion: method.version }
    }
    const current = this.currentState(experience, input.events)
    if (current === undefined) {
      // Never replace the earlier proof when a human edit or source update landed while the model was running.
      return { status: 'pending-review', methodVersion: method.version,
        reason: 'The experience or one of its source events changed during review; the review result was not used' }
    }
    const proof: ExperienceReviewProof = {
      proofId: hash,
      experienceId: experience.id,
      experienceVersion: experience.version,
      experienceMethodVersion: experience.methodVersion,
      methodVersion: method.version,
      sourceVersions: input.events.map(fact => ({ role: fact.role, eventId: fact.id, version: fact.version })),
      hash,
      supported: verdict.supported,
      reason: verdict.reason,
      reviewedAt: new Date().toISOString(),
    }
    publishFile(this.proofPath(experience.id), `${JSON.stringify(proof, null, 2)}\n`)
    return verdict.supported
      ? { status: 'reviewed', experience: current, methodVersion: method.version, proofId: hash }
      : { status: 'pending-review', reason: verdict.reason, methodVersion: method.version, proofId: hash }
  }
  /** Read the authoritative experience and every cited event version, or undefined when any of them moved. */
  private currentState(experience: ExperienceView, facts: readonly ExperienceReviewFact[]): ExperienceView | undefined {
    try {
      const current = this.deps.experiences.read(experience.id)
      if (current.version !== experience.version) return undefined
      const expected = new Map<string, string>()
      for (const fact of facts) expected.set(fact.id, fact.version)
      for (const [id, version] of expected) {
        if (this.deps.events.get(id).version !== version) return undefined
      }
      return current
    } catch {
      return undefined
    }
  }
  /** Build and freeze the input: the complete typed view, the active method, and all original/final/correction facts. */
  private frozenInput(experience: ExperienceView, method: MemoryMethod): ExperienceReviewInput {
    const events: ExperienceReviewFact[] = []
    const read = new Map<string, MemoryEvent>()
    const collect = (role: ExperienceReviewFactRole, ids: readonly string[]): void => {
      for (const id of ids) {
        const known = read.get(id)
        const event = known ?? this.deps.events.get(id)
        if (known === undefined) read.set(id, event)
        events.push(factOf(role, event))
      }
    }
    collect('original', experience.eventIds)
    collect('final', experience.finalEventIds)
    collect('correction', experience.history.map(entry => entry.eventId))
    return freezeDeep<ExperienceReviewInput>({
      experience: experienceOf(experience),
      method: methodOf(method),
      events,
    })
  }
  /** One proof file per experience: the newest matching input overwrites it, an earlier proof survives a moved input. */
  private proofPath(experienceId: string): string {
    return join(this.proofs, encodeURIComponent(experienceId) + '.json')
  }
  /** Read the saved proof for one experience; a missing file is undefined, while invalid content names its own path. */
  private loadProof(experienceId: string): ExperienceReviewProof | undefined {
    const path = this.proofPath(experienceId)
    let content: string
    try {
      content = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
    let parsed: unknown = undefined
    try {
      parsed = JSON.parse(content)
    } catch (error) {
      throw new Error(`Invalid experience review proof ${path}: ${reasonOf(error)}`)
    }
    if (!isProof(parsed)) throw new Error(`Invalid experience review proof ${path}`)
    return parsed
  }
}

/** Whether a parsed proof file is one complete saved proof. */
function isProof(value: unknown): value is ExperienceReviewProof {
  if (!isRecord(value)) return false
  if (typeof value.proofId !== 'string' || typeof value.experienceId !== 'string'
    || typeof value.experienceVersion !== 'string' || typeof value.experienceMethodVersion !== 'string'
    || typeof value.methodVersion !== 'string' || typeof value.hash !== 'string'
    || typeof value.supported !== 'boolean' || typeof value.reason !== 'string'
    || typeof value.reviewedAt !== 'string') return false
  const sources = value.sourceVersions
  if (!Array.isArray(sources)) return false
  return sources.every(source => isRecord(source)
    && (source.role === 'original' || source.role === 'final' || source.role === 'correction')
    && typeof source.eventId === 'string' && typeof source.version === 'string')
}
