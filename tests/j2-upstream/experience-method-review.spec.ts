/** On-demand review of old experiences: one record per ensure, proof reuse by exact versions, and failed calls that never block a retry. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryModelContext as Context } from '../../src/core/ports/model.ts'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryEvents } from '../../src/core/events.ts'
import { Experiences, type ExperienceView } from '../../src/core/experiences.ts'
import { ExperienceMethodReview, reviewExperience, type ExperienceMethodReviewDeps,
  type ExperienceReviewInput, type ExperienceReviewVerdict } from '../../src/core/experience-method-review.ts'
import { MemoryIndex } from '../../src/core/index.ts'
import { MemoryMethods } from '../../src/core/methods.ts'
import { ShortTerm } from '../../src/core/short-term.ts'
import { TaskLists } from '../../src/core/task-lists.ts'

const background = { provider: 'background', model: 'memory', reasoningEffort: 'max' }
interface StreamRequest {
  messages: { content: { text: string }[] }[]
  provider?: string
  model?: string
  reasoningEffort?: string
  maxTokens?: number
  signal?: AbortSignal
}
interface OldExperience {
  view: ExperienceView
  sourceIds: string[]
  finalIds: string[]
  correctionIds: string[]
}
interface RecordingDeps {
  deps: ExperienceMethodReviewDeps
  readIds: string[]
  eventIds: string[]
}

let base: string
let root: string
let index: MemoryIndex
let events: MemoryEvents
let methods: MemoryMethods
let experiences: Experiences
let seq: number

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'experience-method-review-'))
  root = join(base, 'memory')
  index = new MemoryIndex(root, { memory: true })
  events = new MemoryEvents(root, index)
  const tasks = new TaskLists(root, () => undefined, index)
  const shortTerm = new ShortTerm(root, tasks)
  experiences = new Experiences(root, shortTerm, events)
  methods = new MemoryMethods(root)
  seq = 0
})
afterEach(() => {
  index.close()
  rmSync(base, { recursive: true, force: true })
})

/** Save the active pointer the later confirmed activation step writes; this package never activates a candidate itself. */
const activate = (version: string): void => {
  writeFileSync(join(root, 'methods', 'active.json'), `${JSON.stringify({ version })}\n`, 'utf8')
}
const stamp = (): string => `2026-11-13T00:00:${String(++seq).padStart(2, '0')}.000Z`
const user = (id: string, text: string) =>
  events.record({ kind: 'user', at: stamp(), text, source: { kind: 'web-message', id } })
/** One old experience with an original source, a final fact and one correction history entry. */
function oldExperience(label: string, methodVersion = 'old-v1'): OldExperience {
  const source = user(`source-${label}`, `${label} 的原始来源`)
  const final = user(`final-${label}`, `${label} 的最终确认`)
  const item = experiences.tentative({ text: `${label} 的旧经验`, eventIds: [source.id], methodVersion })
  const confirmed = experiences.judge({ id: item.id, confidence: 'high', finalEventIds: [final.id],
    reason: `${label} 用户确认`, methodVersion })
  if (confirmed.status !== 'confirmed') throw new Error('Expected a confirmed experience')
  const correction = user(`correction-${label}`, `${label} 的纠错`)
  const view = experiences.correct({ id: confirmed.experience.id, text: `${label} 的旧经验（已纠错）`,
    eventId: correction.id, reason: `${label} 用户纠错` })
  return { view, sourceIds: [source.id], finalIds: [final.id], correctionIds: [correction.id] }
}
/** A supporting review callback with typed call arguments, so the tests can inspect the frozen input. */
const supportingReview = (reason = '证据充分') =>
  vi.fn(async (_input: ExperienceReviewInput, _signal?: AbortSignal): Promise<ExperienceReviewVerdict> =>
    ({ supported: true, reason }))
/** Wrap the real libraries so a test can prove which records and events one ensure touches. */
function recordingDeps(review: ExperienceMethodReviewDeps['review']): RecordingDeps {
  const readIds: string[] = []
  const eventIds: string[] = []
  return {
    readIds,
    eventIds,
    deps: {
      methods,
      experiences: { read: id => { readIds.push(id); return experiences.read(id) } },
      events: { get: id => { eventIds.push(id); return events.get(id) } },
      review,
    },
  }
}
const proofPath = (experienceId: string): string =>
  join(root, 'methods', 'experience-reviews', encodeURIComponent(experienceId) + '.json')
const readProof = (experienceId: string): Record<string, unknown> =>
  JSON.parse(readFileSync(proofPath(experienceId), 'utf8')) as Record<string, unknown>
const proofExists = (experienceId: string): boolean => existsSync(proofPath(experienceId))

it('reviews only the requested old experience and reads only its own cited events', async () => {
  methods.createCandidate('current-v2', '只保留有真实证据的经验')
  activate('current-v2')
  const a = oldExperience('a')
  const b = oldExperience('b')
  const review = supportingReview('A 的真实事实支持')
  const { deps, readIds, eventIds } = recordingDeps(review)
  const result = await new ExperienceMethodReview(root, deps).ensure(a.view.id)

  expect(result.status).toBe('reviewed')
  expect(result.experience).toMatchObject({ id: a.view.id, text: a.view.text, version: a.view.version,
    methodVersion: 'old-v1' })
  expect(result.methodVersion).toBe('current-v2')
  expect(result.proofId).toBeDefined()
  expect(review).toHaveBeenCalledOnce()
  const input = review.mock.calls[0]![0]
  expect(input.experience).toMatchObject({ id: a.view.id, version: a.view.version,
    methodVersion: 'old-v1', text: a.view.text })
  expect(input.method).toMatchObject({ version: 'current-v2', instructions: '只保留有真实证据的经验' })
  expect(input.events.map(fact => fact.role)).toEqual(['original', 'final', 'correction'])
  expect(input.events.map(fact => fact.id)).toEqual([...a.sourceIds, ...a.finalIds, ...a.correctionIds])
  for (const fact of input.events) expect(events.get(fact.id).version).toBe(fact.version)
  expect(Object.isFrozen(input)).toBe(true)
  expect(Object.isFrozen(input.experience)).toBe(true)
  expect(Object.isFrozen(input.events)).toBe(true)
  expect(readIds.every(id => id === a.view.id)).toBe(true)
  expect(readIds).not.toContain(b.view.id)
  for (const id of [...b.sourceIds, ...b.finalIds, ...b.correctionIds]) expect(eventIds).not.toContain(id)
  expect(proofExists(b.view.id)).toBe(false)
  const proof = readProof(a.view.id)
  expect(proof).toMatchObject({
    experienceId: a.view.id,
    experienceVersion: a.view.version,
    experienceMethodVersion: 'old-v1',
    methodVersion: 'current-v2',
    hash: result.proofId,
    supported: true,
    reason: 'A 的真实事实支持',
  })
  expect(proof.sourceVersions).toEqual(input.events.map(fact =>
    ({ role: fact.role, eventId: fact.id, version: fact.version })))
  // The review never rewrites the experience itself or activates a method on its own.
  expect(methods.active().version).toBe('current-v2')
  expect(experiences.read(a.view.id)).toMatchObject({ text: a.view.text, version: a.view.version,
    eventIds: a.view.eventIds, finalEventIds: a.view.finalEventIds, history: a.view.history })
})

it('returns current without reading events or starting a review when the active method already matches', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const source = user('current-source', '当前经验的来源')
  const view = experiences.direct({ text: '当前经验', eventId: source.id, methodVersion: 'current-v2' })
  const review = supportingReview()
  const { deps, eventIds } = recordingDeps(review)
  const result = await new ExperienceMethodReview(root, deps).ensure(view.id)

  expect(result).toMatchObject({ status: 'current', methodVersion: 'current-v2',
    experience: { id: view.id, text: '当前经验' } })
  expect(review).not.toHaveBeenCalled()
  expect(eventIds).toEqual([])
  expect(proofExists(view.id)).toBe(false)
})

it('reuses a matching proof after a restart without another review call', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const a = oldExperience('restart')
  const firstReview = supportingReview('第一次复核通过')
  const first = await new ExperienceMethodReview(root, recordingDeps(firstReview).deps).ensure(a.view.id)
  expect(first.status).toBe('reviewed')
  expect(first.proofId).toBeDefined()
  expect(firstReview).toHaveBeenCalledOnce()

  // Reopen the memory libraries and construct a fresh service over the same authoritative files.
  index.close()
  index = new MemoryIndex(root, { memory: true })
  events = new MemoryEvents(root, index)
  const tasks = new TaskLists(root, () => undefined, index)
  experiences = new Experiences(root, new ShortTerm(root, tasks), events)
  methods = new MemoryMethods(root)
  const secondReview = vi.fn(async (_input: ExperienceReviewInput,
    _signal?: AbortSignal): Promise<ExperienceReviewVerdict> => {
    throw new Error('a matching proof must answer without calling the model')
  })
  const restarted = new ExperienceMethodReview(root, { methods, experiences, events, review: secondReview })
  const second = await restarted.ensure(a.view.id)

  expect(second.status).toBe('reviewed')
  expect(second.proofId).toBe(first.proofId)
  expect(second.experience).toMatchObject({ id: a.view.id, text: a.view.text, version: a.view.version })
  expect(secondReview).not.toHaveBeenCalled()
})

it('reviews again when the active method or a cited source changes, and reuses only the same versions', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const a = oldExperience('changed')
  const review = supportingReview('证据充分')
  const service = new ExperienceMethodReview(root, { methods, experiences, events, review })

  expect((await service.ensure(a.view.id)).status).toBe('reviewed')
  expect(review).toHaveBeenCalledTimes(1)
  expect((await service.ensure(a.view.id)).status).toBe('reviewed')
  expect(review).toHaveBeenCalledTimes(1)

  methods.createCandidate('current-v3', '方法三')
  activate('current-v3')
  const byMethod = await service.ensure(a.view.id)
  expect(byMethod).toMatchObject({ status: 'reviewed', methodVersion: 'current-v3' })
  expect(review).toHaveBeenCalledTimes(2)
  expect(review.mock.calls[1]![0].method.version).toBe('current-v3')

  const sourceId = a.sourceIds[0]!
  const updated = events.record({ kind: 'user', at: stamp(), text: 'changed 的原始来源已更新',
    source: { kind: 'web-message', id: 'source-changed' } })
  expect(updated.id).toBe(sourceId)
  const bySource = await service.ensure(a.view.id)
  expect(bySource).toMatchObject({ status: 'reviewed', methodVersion: 'current-v3' })
  expect(review).toHaveBeenCalledTimes(3)
  const sourceFact = review.mock.calls[2]![0].events.find(fact => fact.id === sourceId)
  expect(sourceFact?.version).toBe(updated.version)

  expect((await service.ensure(a.view.id)).status).toBe('reviewed')
  expect(review).toHaveBeenCalledTimes(3)
})

it('returns pending-review without the old body when the method does not support the experience', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const a = oldExperience('unsupported')
  const review = vi.fn(async (_input: ExperienceReviewInput,
    _signal?: AbortSignal): Promise<ExperienceReviewVerdict> =>
    ({ supported: false, reason: '真实事实不足以支持这条经验' }))
  const service = new ExperienceMethodReview(root, { methods, experiences, events, review })

  const result = await service.ensure(a.view.id)
  expect(result.status).toBe('pending-review')
  expect(result.reason).toBe('真实事实不足以支持这条经验')
  expect(result.methodVersion).toBe('current-v2')
  expect(result.experience).toBeUndefined()
  expect('experience' in result).toBe(false)
  expect(JSON.stringify(result)).not.toContain(a.view.text)
  expect(readProof(a.view.id)).toMatchObject({ supported: false, reason: '真实事实不足以支持这条经验' })
  expect(experiences.read(a.view.id)).toMatchObject({ text: a.view.text, version: a.view.version })

  // The same experience, method and event versions reuse the recorded verdict instead of spending another call.
  const again = await service.ensure(a.view.id)
  expect(again.status).toBe('pending-review')
  expect(again.experience).toBeUndefined()
  expect(review).toHaveBeenCalledOnce()
})

it('keeps a failed review pending without a blocking proof, then retries on the next call', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const a = oldExperience('quota')
  let calls = 0
  const review = vi.fn(async (_input: ExperienceReviewInput,
    _signal?: AbortSignal): Promise<ExperienceReviewVerdict> => {
    calls += 1
    if (calls === 1) throw new Error('maintenance quota exhausted')
    return { supported: true, reason: '配额恢复后证据充分' }
  })
  const service = new ExperienceMethodReview(root, { methods, experiences, events, review })

  const pending = await service.ensure(a.view.id)
  expect(pending.status).toBe('pending-review')
  expect(pending.reason).toContain('maintenance quota exhausted')
  expect(pending.experience).toBeUndefined()
  expect(pending.proofId).toBeUndefined()
  expect(proofExists(a.view.id)).toBe(false)

  const reviewed = await service.ensure(a.view.id)
  expect(reviewed.status).toBe('reviewed')
  expect(reviewed.experience?.text).toBe(a.view.text)
  expect(review).toHaveBeenCalledTimes(2)
})

it('runs the real review helper with the background route, method instructions, real facts and usage', async () => {
  methods.createCandidate('current-v2', '只保留用户明确确认且事实支持的经验')
  activate('current-v2')
  const a = oldExperience('helper')
  let prompt = ''
  let request: StreamRequest | undefined
  const stream = vi.fn(async function* (value: StreamRequest) {
    request = value
    prompt = value.messages[0]!.content[0]!.text
    yield { type: 'text-delta', text: JSON.stringify({ supported: true, reason: '真实事实支持这条经验' }), index: 0 }
    yield { type: 'usage', usage: { inputTokens: 31, outputTokens: 9, totalTokens: 40 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  const beforeCall = vi.fn()
  const onUsage = vi.fn()
  const signal = new AbortController().signal
  const service = new ExperienceMethodReview(root, {
    methods,
    experiences,
    events,
    review: (input, reviewSignal) => reviewExperience(ctx, background, input, reviewSignal,
      { beforeCall, onUsage, maxTokens: 128 }),
  })

  const result = await service.ensure(a.view.id, signal)
  expect(result.status).toBe('reviewed')
  expect(stream).toHaveBeenCalledOnce()
  expect(request).toMatchObject({ provider: 'background', model: 'memory', reasoningEffort: 'max', maxTokens: 128 })
  expect(request?.signal).toBe(signal)
  expect(beforeCall).toHaveBeenCalledOnce()
  expect(beforeCall.mock.invocationCallOrder[0]!).toBeLessThan(stream.mock.invocationCallOrder[0]!)
  expect(onUsage).toHaveBeenCalledWith({ inputTokens: 31, outputTokens: 9, totalTokens: 40 })
  expect(prompt).toContain('Method instructions: 只保留用户明确确认且事实支持的经验')
  expect(prompt).toContain(a.sourceIds[0]!)
  expect(prompt).toContain(a.finalIds[0]!)
  expect(prompt).toContain(a.correctionIds[0]!)
  expect(prompt).toContain(a.view.text)
  expect(prompt).toContain('"supported"')
  expect(prompt).toContain('user fact')
})

it('refuses a supported verdict that cites no real event', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const stream = vi.fn(async function* () {
    yield { type: 'text-delta', text: JSON.stringify({ supported: true, reason: '无证据也支持' }), index: 0 }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  const source = user('no-evidence', '来源')
  const view = experiences.direct({ text: '只有经验', eventId: source.id, methodVersion: 'old-v1' })
  const input: ExperienceReviewInput = { experience: view, method: methods.active(), events: [] }

  await expect(reviewExperience(ctx, background, input)).rejects.toThrow(/without any real event evidence/)
})

it('keeps a human correction made during review and does not report the review as confirmed', async () => {
  methods.createCandidate('current-v2', '方法二')
  activate('current-v2')
  const a = oldExperience('manual')
  const firstReview = supportingReview('第一次复核通过')
  const first = await new ExperienceMethodReview(root, recordingDeps(firstReview).deps).ensure(a.view.id)
  expect(first.status).toBe('reviewed')
  const savedProof = readProof(a.view.id)

  methods.createCandidate('current-v3', '方法三')
  activate('current-v3')
  let started!: () => void
  const startedPromise = new Promise<void>(resolve => { started = resolve })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const stream = vi.fn(async function* (_value: StreamRequest) {
    started()
    await gate
    yield { type: 'text-delta', text: JSON.stringify({ supported: true, reason: '方法三支持' }), index: 0 }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  const service = new ExperienceMethodReview(root, { methods, experiences, events,
    review: (input, signal) => reviewExperience(ctx, background, input, signal) })
  const pending = service.ensure(a.view.id)
  await startedPromise
  const correction = user('manual-correction', '用户在执行中纠错')
  const corrected = experiences.correct({ id: a.view.id, text: '人工纠错后的正文', eventId: correction.id,
    reason: '执行中纠错' })
  release()

  const result = await pending
  expect(result.status).toBe('pending-review')
  expect(result.experience).toBeUndefined()
  expect(result.reason).toMatch(/changed during review/)
  expect(experiences.read(a.view.id)).toMatchObject({ text: '人工纠错后的正文', version: corrected.version })
  expect(readProof(a.view.id)).toEqual(savedProof)
})
