/**
 * Method activation: a completed replay comparison proposes a candidate method, the main Session asks the owner a
 * question, and only the owner's later real web message can activate that candidate. Proposals live under
 * `methods/activations`; the active pointer is written only after confirmation, so a candidate never enables itself.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { publishFile } from './files.ts'
import type { MemoryMethods } from './methods.ts'

/** The minimum a completed or failed method comparison tells this service; the replay service supplies the rest. */
export interface MethodComparison {
  id: string
  status: 'completed' | 'failed'
  baselineVersion: string
  candidateVersion: string
}

/** The original chat fields a confirmation reads: order, author and the message id. */
export interface ChatMessageRef { seq: number; role: 'user' | 'assistant'; id: string }

/** The owner's saved web message named by the trigger of an explicit confirm or reject call. */
export interface OwnerMessage { triggerId: string; messageId: string; seq: number }

/**
 * What the main control supplies: the method library, the replay comparison lookup, and the two reads that prove a
 * trigger is the owner's real web message and that a chat message exists.
 */
export interface MethodActivationDeps {
  methods: MemoryMethods
  getComparison(id: string): MethodComparison | undefined
  ownerMessage(triggerId: string): OwnerMessage | undefined
  message(messageId: string): ChatMessageRef | undefined
}

/** Where one proposal stands: waiting for the owner, activated, or refused by the owner. */
export type MethodActivationStatus = 'pending' | 'confirmed' | 'rejected'

/** One durable proposal. It carries no authority until `confirm` writes the active pointer. */
export interface MethodActivationProposal {
  comparisonId: string
  status: MethodActivationStatus
  baselineVersion: string
  candidateVersion: string
  /** The main Session input the proposal answered; the question reply is recorded against it. */
  questionTriggerId: string
  /** The assistant chat message that asked the owner, once the main Session's reply was sent. */
  questionMessageId?: string
  /** The `seq` of that assistant message, so the owner's answer can be proven to come after it. */
  questionSeq?: number
  /** The owner's saved web-message trigger that confirmed or rejected the proposal. */
  confirmationTriggerId?: string
  requestedAt: string
  /** When the owner's message confirmed or rejected the proposal. */
  decidedAt?: string
}

/** The durable active pointer. `MemoryMethods` reads its `version`; the other fields record why it was activated. */
export interface ActiveMethod { version: string; comparisonId: string; confirmedBy: string; at: string }

/** What a confirmation returns: the activation written (or replayed) and the proposal that recorded it. */
export interface MethodActivationResult { active: ActiveMethod; proposal: MethodActivationProposal }

/** The proposal or confirmation conflicts with what is stored, or the named message is no valid credential. */
export class MethodActivationConflict extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MethodActivationConflict'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isStatus = (value: unknown): value is MethodActivationStatus =>
  value === 'pending' || value === 'confirmed' || value === 'rejected'
const reasonOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
/** An optional string field of a stored proposal, or undefined when the file omits it. */
const optionalString = (value: unknown, field: string, path: string): string | undefined => {
  if (value === undefined) return undefined
  if (!isNonEmptyString(value)) throw new MethodActivationConflict(`Invalid ${field} in ${path}`)
  return value
}
/** An optional chat `seq` field of a stored proposal, which the chat store numbers from 1. */
const optionalSequence = (value: unknown, path: string): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
    throw new MethodActivationConflict(`Invalid questionSeq in ${path}`)
  return value
}

/**
 * The proposal library and the confirmed active pointer. Construction creates the activations directory only; it
 * never writes the pointer, and no method here can activate a version without `confirm`'s owner-message checks.
 */
export class MethodActivation {
  /** The memory root this service reads and writes, whose `methods` directory the method library owns. */
  readonly root: string
  private readonly activationDir: string
  private readonly activePath: string

  /** Opens the proposal library under `memoryRoot`; `deps.methods` must be the library over the same memory root. */
  constructor(memoryRoot: string, private readonly deps: MethodActivationDeps) {
    this.root = join(memoryRoot, 'methods')
    this.activationDir = join(this.root, 'activations')
    this.activePath = join(this.root, 'active.json')
    mkdirSync(this.activationDir, { recursive: true })
  }

  /**
   * Save one pending proposal for a completed comparison whose baseline is the active method. This writes no active
   * pointer and enables nothing: only `confirm` with the owner's later real message may do that.
   * Replaying the same comparison and question trigger returns the stored proposal; another proposal for the same
   * comparison conflicts.
   * @throws MethodActivationConflict when the comparison is unknown, failed, names a missing method, or its baseline
   * is not active, or when this comparison already holds another proposal.
   */
  propose(comparisonId: string, triggerId: string): MethodActivationProposal {
    if (comparisonId.length === 0) throw new MethodActivationConflict('A method activation needs a comparison id')
    if (triggerId.length === 0) throw new MethodActivationConflict('A method activation needs the question trigger')
    const comparison = this.comparison(comparisonId)
    const known = this.get(comparisonId)
    if (known) {
      if (comparison.status === 'completed' && known.baselineVersion === comparison.baselineVersion
        && known.candidateVersion === comparison.candidateVersion && known.questionTriggerId === triggerId) return known
      throw new MethodActivationConflict(`Method comparison ${comparisonId} already holds another proposal`)
    }
    if (comparison.status !== 'completed')
      throw new MethodActivationConflict(`Method comparison ${comparisonId} is ${comparison.status}, not completed`)
    if (this.deps.methods.get(comparison.baselineVersion) === undefined)
      throw new MethodActivationConflict(`Method ${comparison.baselineVersion} does not exist`)
    if (this.deps.methods.get(comparison.candidateVersion) === undefined)
      throw new MethodActivationConflict(`Candidate method ${comparison.candidateVersion} does not exist`)
    const active = this.deps.methods.active().version
    if (active !== comparison.baselineVersion)
      throw new MethodActivationConflict(`Method comparison ${comparisonId} was replayed against ${comparison.baselineVersion}, `
        + `but the active method is ${active}`)
    const proposal: MethodActivationProposal = {
      comparisonId, status: 'pending', baselineVersion: comparison.baselineVersion,
      candidateVersion: comparison.candidateVersion, questionTriggerId: triggerId,
      requestedAt: new Date().toISOString(),
    }
    return this.save(proposal)
  }

  /**
   * Record the assistant chat message that asked the owner about the proposal `triggerId` answered, after the main
   * Session sent it. A message that is not a saved assistant row changes nothing: only that row can be the question.
   */
  questionSent(triggerId: string, messageId: string): void {
    const question = this.deps.message(messageId)
    if (!question || question.id !== messageId || question.role !== 'assistant') return
    for (const proposal of this.list()) {
      if (proposal.status !== 'pending' || proposal.questionTriggerId !== triggerId) continue
      this.save({ ...proposal, questionMessageId: messageId, questionSeq: question.seq })
    }
  }

  /**
   * Activate the proposal's candidate with the owner's real later web message, which must come after the recorded
   * assistant question, differ from the trigger the proposal answered, and find the baseline still active.
   * Repeating the same confirmation returns the original result without writing again.
   * @throws MethodActivationConflict when the proposal is unknown, unanswered, rejected, or the message is no
   * credential.
   */
  confirm(comparisonId: string, triggerId: string): MethodActivationResult {
    const proposal = this.proposal(comparisonId)
    if (proposal.status === 'confirmed') {
      if (proposal.confirmationTriggerId !== triggerId)
        throw new MethodActivationConflict(`Method comparison ${comparisonId} was confirmed by another owner message`)
      return { active: this.activationOf(proposal), proposal }
    }
    if (proposal.status === 'rejected')
      throw new MethodActivationConflict(`Method comparison ${comparisonId} was rejected`)
    this.ownerCredential(proposal, triggerId)
    const active = this.deps.methods.active().version
    if (active !== proposal.baselineVersion)
      throw new MethodActivationConflict(`Method comparison ${comparisonId} was replayed against ${proposal.baselineVersion}, `
        + `but the active method is ${active}`)
    if (this.deps.methods.get(proposal.candidateVersion) === undefined)
      throw new MethodActivationConflict(`Candidate method ${proposal.candidateVersion} does not exist`)
    const at = new Date().toISOString()
    const activation: ActiveMethod = { version: proposal.candidateVersion, comparisonId, confirmedBy: triggerId, at }
    // The pointer is the one activation write: only here, after every credential check passed.
    publishFile(this.activePath, JSON.stringify(activation, null, 2) + '\n')
    const confirmed = this.save({ ...proposal, status: 'confirmed', confirmationTriggerId: triggerId, decidedAt: at })
    return { active: activation, proposal: confirmed }
  }

  /**
   * Refuse a pending proposal with the same owner's later real message, checked exactly as confirming is, and leave
   * the active method untouched. A rejected proposal is returned unchanged.
   * @throws MethodActivationConflict when the proposal is confirmed, or the message does not answer its question.
   */
  reject(comparisonId: string, triggerId: string): MethodActivationProposal {
    const proposal = this.proposal(comparisonId)
    if (proposal.status === 'rejected') return proposal
    if (proposal.status === 'confirmed')
      throw new MethodActivationConflict(`Method comparison ${comparisonId} was confirmed and cannot be rejected`)
    this.ownerCredential(proposal, triggerId)
    return this.save({ ...proposal, status: 'rejected', confirmationTriggerId: triggerId, decidedAt: new Date().toISOString() })
  }

  /** One stored proposal, or undefined when this comparison has none; a broken file fails with its path. */
  get(comparisonId: string): MethodActivationProposal | undefined {
    const path = this.proposalPath(comparisonId)
    if (!existsSync(path)) return undefined
    return this.parseProposal(comparisonId, path)
  }

  /** The stored proposals, oldest first; a read only, which tools display. */
  list(): MethodActivationProposal[] {
    const found: MethodActivationProposal[] = []
    for (const name of readdirSync(this.activationDir)) {
      if (!name.endsWith('.json')) continue
      let comparisonId: string
      try {
        comparisonId = decodeURIComponent(name.slice(0, -'.json'.length))
      } catch {
        throw new MethodActivationConflict(`Invalid method activation file name ${name}`)
      }
      found.push(this.parseProposal(comparisonId, join(this.activationDir, name)))
    }
    return found.sort((left, right) => left.requestedAt.localeCompare(right.requestedAt)
      || left.comparisonId.localeCompare(right.comparisonId))
  }

  /** The confirmed active pointer, or undefined when no method was ever confirmed; a broken file is an error. */
  readActive(): ActiveMethod | undefined {
    if (!existsSync(this.activePath)) return undefined
    return this.parseActive(this.activePath)
  }

  /** One comparison from the replay service, which must answer for the id it was asked about. */
  private comparison(comparisonId: string): MethodComparison {
    const comparison = this.deps.getComparison(comparisonId)
    if (!comparison) throw new MethodActivationConflict(`Unknown method comparison ${comparisonId}`)
    if (comparison.id !== comparisonId)
      throw new MethodActivationConflict(`Method comparison ${comparisonId} answered as ${comparison.id}`)
    return comparison
  }

  /** The stored proposal `comparisonId`, which confirm, reject and the reads start from. */
  private proposal(comparisonId: string): MethodActivationProposal {
    const proposal = this.get(comparisonId)
    if (!proposal) throw new MethodActivationConflict(`Unknown method comparison ${comparisonId}`)
    return proposal
  }

  /**
   * Check the owner's real answer to `proposal`: the question is a stored assistant message, the answer is a stored
   * user message that is not the proposal's own trigger and whose `seq` is strictly after the question's.
   */
  private ownerCredential(proposal: MethodActivationProposal, triggerId: string): void {
    if (proposal.questionMessageId === undefined || proposal.questionSeq === undefined)
      throw new MethodActivationConflict(`Method comparison ${proposal.comparisonId} asked the owner no question yet`)
    const question = this.deps.message(proposal.questionMessageId)
    if (!question || question.id !== proposal.questionMessageId || question.role !== 'assistant'
      || question.seq !== proposal.questionSeq)
      throw new MethodActivationConflict(`Method comparison ${proposal.comparisonId} has no stored assistant question message`)
    if (triggerId === proposal.questionTriggerId)
      throw new MethodActivationConflict(`Trigger ${triggerId} is the proposal's own trigger, not the owner's later answer`)
    const owner = this.deps.ownerMessage(triggerId)
    if (!owner) throw new MethodActivationConflict(`Trigger ${triggerId} is not the owner's saved web message`)
    const answer = this.deps.message(owner.messageId)
    if (!answer || answer.id !== owner.messageId || answer.role !== 'user')
      throw new MethodActivationConflict(`Trigger ${triggerId} does not name a stored user message of the web conversation`)
    if (!(answer.seq > proposal.questionSeq))
      throw new MethodActivationConflict(`Trigger ${triggerId} is not a message the owner sent after the question of comparison ${proposal.comparisonId}`)
    if (answer.seq !== owner.seq)
      throw new MethodActivationConflict(`Trigger ${triggerId} reports the wrong position for its owner message`)
  }

  /** The activation a confirmed proposal records; a confirmed proposal without it cannot be replayed. */
  private activationOf(proposal: MethodActivationProposal): ActiveMethod {
    if (proposal.confirmationTriggerId === undefined || proposal.decidedAt === undefined)
      throw new MethodActivationConflict(`Method comparison ${proposal.comparisonId} has no recorded confirmation`)
    return { version: proposal.candidateVersion, comparisonId: proposal.comparisonId,
      confirmedBy: proposal.confirmationTriggerId, at: proposal.decidedAt }
  }

  /** One proposal file: the comparison id is percent-encoded so one comparison is one portable filename. */
  private proposalPath(comparisonId: string): string {
    return join(this.activationDir, encodeURIComponent(comparisonId) + '.json')
  }

  /** Save one proposal; each write replaces the whole record, so its fields stay the source of truth. */
  private save(proposal: MethodActivationProposal): MethodActivationProposal {
    publishFile(this.proposalPath(proposal.comparisonId), JSON.stringify(proposal, null, 2) + '\n')
    return proposal
  }

  /** One proposal record, checked so a broken file fails with its own path instead of becoming a silent proposal. */
  private parseProposal(comparisonId: string, path: string): MethodActivationProposal {
    const parsed = this.readJson(path)
    const status = parsed.status
    const baselineVersion = parsed.baselineVersion
    const candidateVersion = parsed.candidateVersion
    const questionTriggerId = parsed.questionTriggerId
    const requestedAt = parsed.requestedAt
    if (parsed.comparisonId !== comparisonId || !isStatus(status) || !isNonEmptyString(baselineVersion)
      || !isNonEmptyString(candidateVersion) || !isNonEmptyString(questionTriggerId)
      || !isNonEmptyString(requestedAt))
      throw new MethodActivationConflict(`Invalid method activation ${path}`)
    const questionMessageId = optionalString(parsed.questionMessageId, 'questionMessageId', path)
    const questionSeq = optionalSequence(parsed.questionSeq, path)
    const confirmationTriggerId = optionalString(parsed.confirmationTriggerId, 'confirmationTriggerId', path)
    const decidedAt = optionalString(parsed.decidedAt, 'decidedAt', path)
    return { comparisonId, status, baselineVersion, candidateVersion, questionTriggerId, requestedAt,
      ...(questionMessageId === undefined ? {} : { questionMessageId }),
      ...(questionSeq === undefined ? {} : { questionSeq }),
      ...(confirmationTriggerId === undefined ? {} : { confirmationTriggerId }),
      ...(decidedAt === undefined ? {} : { decidedAt }) }
  }

  /** The confirmed active pointer, checked field by field because this service is its only writer. */
  private parseActive(path: string): ActiveMethod {
    const parsed = this.readJson(path)
    const version = parsed.version
    const comparisonId = parsed.comparisonId
    const confirmedBy = parsed.confirmedBy
    const at = parsed.at
    if (!isNonEmptyString(version) || !isNonEmptyString(comparisonId) || !isNonEmptyString(confirmedBy)
      || !isNonEmptyString(at))
      throw new MethodActivationConflict(`Invalid active memory method pointer ${path}`)
    return { version, comparisonId, confirmedBy, at }
  }

  /** One JSON object file; a read or parse failure names the path instead of being swallowed. */
  private readJson(path: string): Record<string, unknown> {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch (error) {
      throw new MethodActivationConflict(`Invalid method activation file ${path}: ${reasonOf(error)}`)
    }
    if (!isRecord(parsed)) throw new MethodActivationConflict(`Invalid method activation file ${path}`)
    return parsed
  }
}
