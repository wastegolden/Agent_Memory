/**
 * The activation chain over a real MemoryMethods and typed chat rows: a proposal changes no active method, only the
 * owner's real web message recorded after the stored assistant question activates the candidate, and the pointer
 * survives a restart while an unconfirmed or rejected comparison leaves the builtin method active.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MethodActivation, MethodActivationConflict,
  type ChatMessageRef, type MethodActivationDeps, type MethodComparison, type OwnerMessage,
} from '../../src/core/method-activation.ts'
import { MemoryMethods } from '../../src/core/methods.ts'

let base: string
let methods: MemoryMethods
let activated: MethodActivation
let nextSeq: number
const rows = new Map<string, ChatMessageRef>()
const triggers = new Map<string, { kind: 'owner'; messageId: string } | { kind: 'internal' }>()
const comparisons = new Map<string, MethodComparison>()

const memoryRoot = (): string => join(base, 'memory')

/** Append one chat row in conversation order, as ChatStore makes them. */
const message = (role: ChatMessageRef['role'], id: string): ChatMessageRef => {
  nextSeq += 1
  const saved: ChatMessageRef = { seq: nextSeq, role, id }
  rows.set(id, saved)
  return saved
}
/** Save one user message and the web trigger the main control would supply for it. */
const owner = (id: string): OwnerMessage => {
  const saved = message('user', id)
  const triggerId = `web:${id}`
  triggers.set(triggerId, { kind: 'owner', messageId: id })
  return { triggerId, messageId: id, seq: saved.seq }
}
/** An internal event trigger: the main control's ownerMessage returns undefined for it. */
const internal = (id: string): string => {
  triggers.set(id, { kind: 'internal' })
  return id
}
/** A trigger whose lookup points at `messageId`, even when that row is not a person's message. */
const ownerOf = (triggerId: string, messageId: string): OwnerMessage => {
  triggers.set(triggerId, { kind: 'owner', messageId })
  const saved = rows.get(messageId)!
  return { triggerId, messageId, seq: saved.seq }
}

/** The typed fixture in the exact shape the main control supplies to the service. */
const depsFor = (library: MemoryMethods = methods): MethodActivationDeps => ({
  methods: library,
  getComparison: id => comparisons.get(id),
  ownerMessage: triggerId => {
    const trigger = triggers.get(triggerId)
    if (!trigger || trigger.kind !== 'owner') return undefined
    const saved = rows.get(trigger.messageId)
    return saved === undefined ? undefined : { triggerId, messageId: trigger.messageId, seq: saved.seq }
  },
  message: id => rows.get(id),
})
const open = (library: MemoryMethods = methods): MethodActivation => new MethodActivation(memoryRoot(), depsFor(library))

/** Store one completed comparison against the builtin method and `candidateVersion`, `trial-v2` by default. */
const completed = (id: string, candidateVersion = 'trial-v2'): MethodComparison => {
  const comparison: MethodComparison = { id, status: 'completed', baselineVersion: 'builtin-v1', candidateVersion }
  comparisons.set(id, comparison)
  return comparison
}

/** Write an active pointer independently of the service, as an earlier confirmed activation would leave it. */
const activatePointer = (version: string): void => {
  writeFileSync(join(memoryRoot(), 'methods', 'active.json'),
    JSON.stringify({ version, comparisonId: 'manual', confirmedBy: 'manual', at: '2026-11-13T00:00:00.000Z' }) + '\n', 'utf8')
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'method-activation-'))
  rows.clear()
  triggers.clear()
  comparisons.clear()
  nextSeq = 0
  methods = new MemoryMethods(memoryRoot())
  methods.createCandidate('trial-v2', '优先测试经验。')
  activated = open()
})
afterEach(() => { rmSync(base, { recursive: true, force: true }) })

describe('method activation', () => {
  it('refuses a confirmation before a real assistant question was recorded', () => {
    const comparison = completed('cmp-unshown')
    const suggestion = internal('internal:suggest-1')
    const answer = owner('answer-1')
    activated.propose(comparison.id, suggestion)

    expect(() => activated.confirm(comparison.id, answer.triggerId)).toThrow(MethodActivationConflict)
    expect(activated.get(comparison.id)).toMatchObject({ status: 'pending', questionTriggerId: suggestion })
    expect(activated.get(comparison.id)!.questionMessageId).toBeUndefined()
    expect(activated.readActive()).toBeUndefined()
    expect(methods.active().version).toBe('builtin-v1')

    // Only a stored assistant message is a question; a user row or an unknown id records nothing.
    message('user', 'not-a-question')
    activated.questionSent(suggestion, 'not-a-question')
    activated.questionSent(suggestion, 'not-saved')
    expect(activated.get(comparison.id)!.questionMessageId).toBeUndefined()
    expect(() => activated.confirm(comparison.id, answer.triggerId)).toThrow(/asked the owner no question/)
  })

  it('refuses the original trigger, earlier messages, internal events and assistant replies after the question', () => {
    const comparison = completed('cmp-credential')
    const source = owner('source-1')
    const early = owner('early-1')
    activated.propose(comparison.id, source.triggerId)
    const question = message('assistant', 'question-1')
    activated.questionSent(source.triggerId, question.id)
    const wrongRole = message('assistant', 'assistant-2')
    const wrongTrigger = ownerOf('web:assistant-2', wrongRole.id)
    const internalEvent = internal('internal:event-1')
    const answer = owner('answer-1')

    expect(activated.get(comparison.id)).toMatchObject({ questionMessageId: question.id, questionSeq: question.seq })
    for (const triggerId of [source.triggerId, early.triggerId, internalEvent, wrongTrigger.triggerId])
      expect(() => activated.confirm(comparison.id, triggerId)).toThrow(MethodActivationConflict)
    expect(activated.get(comparison.id)!.status).toBe('pending')
    expect(activated.readActive()).toBeUndefined()
    expect(methods.active().version).toBe('builtin-v1')

    const result = activated.confirm(comparison.id, answer.triggerId)
    expect(result.active).toEqual({ version: 'trial-v2', comparisonId: comparison.id,
      confirmedBy: answer.triggerId, at: expect.any(String) })
    expect(result.proposal).toMatchObject({ status: 'confirmed', confirmationTriggerId: answer.triggerId })
    expect(methods.active()).toMatchObject({ version: 'trial-v2', instructions: '优先测试经验。' })
  })

  it('activates only on the owner\'s later real message and keeps the activation across a restart', () => {
    const comparison = completed('cmp-confirm')
    const suggestion = internal('internal:suggest-1')
    activated.propose(comparison.id, suggestion)
    const question = message('assistant', 'question-1')
    activated.questionSent(suggestion, question.id)
    expect(methods.active().version).toBe('builtin-v1')
    const answer = owner('answer-1')

    const result = activated.confirm(comparison.id, answer.triggerId)
    expect(result.active).toEqual({ version: 'trial-v2', comparisonId: 'cmp-confirm',
      confirmedBy: answer.triggerId, at: expect.any(String) })
    expect(result.proposal).toMatchObject({ status: 'confirmed', confirmationTriggerId: answer.triggerId,
      decidedAt: result.active.at })
    const activePath = join(memoryRoot(), 'methods', 'active.json')
    expect(JSON.parse(readFileSync(activePath, 'utf8'))).toEqual(result.active)
    expect(JSON.parse(readFileSync(join(memoryRoot(), 'methods', 'activations', 'cmp-confirm.json'), 'utf8')))
      .toEqual(result.proposal)

    // A new process over the same files reads the same activation and proposal.
    const restartedMethods = new MemoryMethods(memoryRoot())
    const restarted = open(restartedMethods)
    expect(restarted.readActive()).toEqual(result.active)
    expect(restartedMethods.active()).toMatchObject({ version: 'trial-v2', instructions: '优先测试经验。' })
    expect(restarted.get(comparison.id)).toEqual(result.proposal)

    // The same owner message replays the original result without rewriting the pointer.
    const before = readFileSync(activePath, 'utf8')
    expect(restarted.confirm(comparison.id, answer.triggerId)).toEqual(result)
    expect(readFileSync(activePath, 'utf8')).toBe(before)
    expect(() => restarted.confirm(comparison.id, 'web:another')).toThrow(MethodActivationConflict)
  })

  it('rejects with the same later owner message and keeps the active method', () => {
    const comparison = completed('cmp-reject')
    const suggestion = internal('internal:suggest-1')
    activated.propose(comparison.id, suggestion)
    const early = owner('early-1')
    expect(() => activated.reject(comparison.id, early.triggerId)).toThrow(/asked the owner no question/)
    const question = message('assistant', 'question-1')
    activated.questionSent(suggestion, question.id)
    expect(() => activated.reject(comparison.id, early.triggerId)).toThrow(/after the question/)
    const answer = owner('answer-1')

    const rejected = activated.reject(comparison.id, answer.triggerId)
    expect(rejected).toMatchObject({ status: 'rejected', confirmationTriggerId: answer.triggerId,
      decidedAt: expect.any(String) })
    expect(activated.readActive()).toBeUndefined()
    expect(methods.active().version).toBe('builtin-v1')
    expect(activated.reject(comparison.id, answer.triggerId)).toEqual(rejected)
    expect(() => activated.confirm(comparison.id, answer.triggerId)).toThrow(MethodActivationConflict)
  })

  it('refuses failed comparisons, missing methods and a baseline that is no longer active', () => {
    comparisons.set('cmp-failed', { id: 'cmp-failed', status: 'failed', baselineVersion: 'builtin-v1',
      candidateVersion: 'trial-v2' })
    expect(() => activated.propose('cmp-failed', 'internal:suggest-1')).toThrow(MethodActivationConflict)
    expect(activated.get('cmp-failed')).toBeUndefined()

    expect(() => activated.propose('cmp-unknown', 'internal:suggest-1')).toThrow(/Unknown method comparison/)
    expect(activated.get('cmp-unknown')).toBeUndefined()

    completed('cmp-missing', 'trial-v9')
    expect(() => activated.propose('cmp-missing', 'internal:suggest-1')).toThrow(/trial-v9/)
    expect(activated.get('cmp-missing')).toBeUndefined()

    methods.createCandidate('trial-v3', '另一版指令')
    activatePointer('trial-v3')
    completed('cmp-stale')
    expect(() => activated.propose('cmp-stale', 'internal:suggest-1')).toThrow(MethodActivationConflict)
    expect(activated.get('cmp-stale')).toBeUndefined()
    expect(methods.active().version).toBe('trial-v3')
  })

  it('replays the same proposal and lists stored proposals for tools', () => {
    completed('cmp-a')
    completed('cmp-b')
    const first = activated.propose('cmp-a', internal('internal:a'))
    expect(activated.propose('cmp-a', internal('internal:a'))).toEqual(first)
    expect(() => activated.propose('cmp-a', internal('internal:other'))).toThrow(MethodActivationConflict)
    const second = activated.propose('cmp-b', internal('internal:b'))

    expect(activated.list()).toEqual([first, second])
    expect(activated.get('cmp-missing')).toBeUndefined()
    expect(activated.readActive()).toBeUndefined()
    expect(JSON.parse(readFileSync(join(memoryRoot(), 'methods', 'activations', 'cmp-a.json'), 'utf8')))
      .toEqual(first)
  })
})
