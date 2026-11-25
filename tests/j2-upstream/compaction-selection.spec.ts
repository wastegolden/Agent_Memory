/** Event selection uses the configured background route and checks model output at its entry boundary. */
import type { MemoryModelContext as Context } from '../../src/core/ports/model.ts'
import { expect, it, vi } from 'vitest'
import { selectEventMemory, type EventMemoryInput } from '../../src/core/compaction-selection.ts'

/** A background stream that records its prompt, answers with `answer` and finishes as `reason` says. */
function fakeStream(answer: string, reason: { kind: string } = { kind: 'stop' }) {
  let prompt = ''
  const stream = vi.fn(async function* (request: { messages: { content: { text: string }[] }[] }) {
    prompt = request.messages[0]!.content[0]!.text
    yield { type: 'text-delta', text: answer, index: 0 }
    yield { type: 'finish', reason }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  return { ctx, stream, prompt: () => prompt }
}

const events: EventMemoryInput['events'] = [
  { id: '20261110-user-1', seq: 1, event: { kind: 'user', at: '2026-11-10T08:00:00.000Z',
    text: '以后日报都用中文', source: { kind: 'web', id: 'message-1' } } },
  { id: '20261110-worker-2', seq: 2, event: { kind: 'worker', at: '2026-11-10T09:00:00.000Z',
    text: '筛选组件测试完成', source: { kind: 'worker', id: 'worker-1' }, taskId: 't1' } },
]
const tasks: EventMemoryInput['tasks'] = [{ id: 't1', title: '筛选' }]
const people: EventMemoryInput['people'] = [{ id: 'alice', name: 'Alice',
  requirements: [{ id: 'report_language', text: '日报用英文', eventIds: ['20261110-user-1'] }] }]
const existing: EventMemoryInput['existing'] = [{ id: 'entry-1', kind: 'agreement', text: '保留排序',
  sources: [{ kind: 'session', id: 'main-session' }] }]
const input: EventMemoryInput = { events, existing, tasks, people }
const background = { provider: 'background', model: 'memory', reasoningEffort: 'max' }

it('selects task items and directed changes from the event batch through the configured background route', async () => {
  const answer = JSON.stringify({
    items: [
      { kind: 'todo', text: '明天给结果', taskId: 't1', eventIds: ['20261110-user-1'] },
      { kind: 'experience', text: '组合测试可能发现遗漏', eventIds: ['20261110-worker-2'] },
    ],
    changes: [
      { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用中文',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T08:00:00+08:00', reason: '用户明确要求' },
      { kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-worker-2'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '任务内约定' },
    ],
  })
  const { ctx, stream, prompt } = fakeStream(answer)
  const signal = new AbortController().signal
  expect(await selectEventMemory(ctx, background, input, signal)).toEqual({
    items: [
      { kind: 'todo', text: '明天给结果', taskId: 't1', eventIds: ['20261110-user-1'] },
      { kind: 'experience', text: '组合测试可能发现遗漏', eventIds: ['20261110-worker-2'] },
    ],
    changes: [
      { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用中文',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00.000Z', reason: '用户明确要求' },
      { kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-worker-2'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '任务内约定' },
    ],
  })
  expect(stream).toHaveBeenCalledWith(expect.objectContaining({ ...background, signal }))
  const text = prompt()
  for (const expected of ['20261110-user-1', '20261110-worker-2', '以后日报都用中文', '保留排序',
    'entry-1', 'main-session', '筛选', 'Alice', '日报用英文']) expect(text).toContain(expected)
  expect(text).toContain('"sources"')
})

it('accepts an empty selection', async () => {
  const { ctx } = fakeStream('{"items":[],"changes":[]}')
  expect(await selectEventMemory(ctx, background, { events: [], existing: [], tasks: [], people: [] }))
    .toEqual({ items: [], changes: [] })
})

it('records invalid entries with missing evidence, foreign events, malformed fields or wrong targets and scopes', async () => {
  const invalid = [
    { items: [{ kind: 'todo', text: 'x' }], changes: [] },
    { items: [{ kind: 'todo', text: 'x', eventIds: [] }], changes: [] },
    { items: [{ kind: 'todo', text: 'x', eventIds: ['missing-event'] }], changes: [] },
    { items: [{ kind: 'todo', text: 'x', taskId: 't9', eventIds: ['20261110-user-1'] }], changes: [] },
    { items: [{ kind: 'agreement', text: 'x', eventIds: ['20261110-user-1'], recipient: 'Alice' }], changes: [] },
    { items: [{ kind: 'agreement', text: 42, eventIds: ['20261110-user-1'] }], changes: [] },
    { items: [], changes: [{ kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language',
      text: 'x', effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language',
      text: 'x', evidenceEventIds: ['missing-event'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', taskId: 't9', reason: 'r' }] },
    { items: [], changes: [{ kind: 'change', scope: 'ongoing', personId: 'alice', property: 'report_language',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', taskId: 't1', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'ongoing', personId: 'nobody', property: 'p',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'bad property',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'task', personId: 'bob:bad', property: 'p',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', taskId: 't1', reason: 'r' }] },
    { items: [], changes: [{ kind: 'correction', scope: 'ongoing', personId: 'alice', property: 'report_language',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'unclear', personId: 'alice', property: 'report_language',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T00:00:00Z', reason: 'r' }] },
    { items: [], changes: [{ kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window',
      text: 'x', evidenceEventIds: ['20261110-user-1'], effectiveAt: 'tomorrow', taskId: 't1', reason: 'r' }] },
  ]
  for (const selection of invalid) {
    const { ctx } = fakeStream(JSON.stringify(selection))
    expect(await selectEventMemory(ctx, background, input)).toEqual({ items: [], changes: [], dropped: [{
      list: selection.items.length ? 'items' : 'changes', index: 0, reasons: [expect.stringMatching(/\S/)],
    }] })
  }
})

it('keeps valid siblings and reports all reasons at their original list indices', async () => {
  const item = { kind: 'todo', text: '明天给结果', eventIds: ['20261110-user-1'] }
  const change = { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用中文',
    evidenceEventIds: ['20261110-worker-2'], effectiveAt: '2026-11-10T09:00:00.000Z', reason: '用户明确要求' }
  const { ctx } = fakeStream(JSON.stringify({
    items: [{ ...item, taskId: 't9', eventIds: ['missing'] }, item, null],
    changes: [change, { ...change, scope: 'task', personId: 'two:segments' }, { ...change, extra: true }],
  }))
  expect(await selectEventMemory(ctx, background, input)).toEqual({ items: [item], changes: [change], dropped: [
    { list: 'items', index: 0, reasons: [expect.stringContaining('Event missing is not part of this batch'),
      expect.stringContaining('Unknown task t9')] },
    { list: 'items', index: 2, reasons: [expect.stringContaining('expected object')] },
    { list: 'changes', index: 1, reasons: [expect.stringContaining('A task-scoped change needs taskId'),
      expect.stringContaining('A task-directed personId must be one managed segment')] },
    { list: 'changes', index: 2, reasons: [expect.stringContaining('extra')] },
  ] })
})

it.each(['null', '[]', '{"items":[]}', '{"changes":[]}', '{"items":{},"changes":[]}', '{"items":[],"changes":null}'])(
  'rejects an invalid selection envelope %s', async answer => {
    const { ctx } = fakeStream(answer)
    await expect(selectEventMemory(ctx, background, input)).rejects.toThrow()
  })

it('merges repeated plain items and drops content already stored, including an independent promise task', async () => {
  const existingWithTodo: EventMemoryInput['existing'] = [...existing,
    { id: 'todo-1', kind: 'todo', text: '给结论', taskId: 'todo-1', sources: [] }]
  const answer = JSON.stringify({
    items: [
      { kind: 'todo', text: '明天给结果', taskId: 't1', eventIds: ['20261110-user-1'] },
      { kind: 'todo', text: ' 明天给结果 ', taskId: 't1', eventIds: ['20261110-worker-2', '20261110-user-1'] },
      { kind: 'agreement', text: '保留排序', eventIds: ['20261110-user-1'] },
      { kind: 'todo', text: '给结论', eventIds: ['20261110-worker-2'] },
      { kind: 'experience', text: '组合测试可能发现遗漏', eventIds: ['20261110-worker-2'] },
    ],
    changes: [],
  })
  const { ctx } = fakeStream(answer)
  expect(await selectEventMemory(ctx, background, { ...input, existing: existingWithTodo })).toEqual({
    items: [
      { kind: 'todo', text: '明天给结果', taskId: 't1', eventIds: ['20261110-user-1', '20261110-worker-2'] },
      { kind: 'experience', text: '组合测试可能发现遗漏', eventIds: ['20261110-worker-2'] },
    ],
    changes: [],
  })
})

it('merges repeated changes, keeps all evidence and drops an already recorded requirement', async () => {
  const withManagedNote: EventMemoryInput['existing'] = [...existing,
    { id: 'memory:carol:deploy_window', kind: 'agreement', text: '周五发布', taskId: 't1', recipient: 'carol', sources: [] }]
  const answer = JSON.stringify({
    items: [],
    changes: [
      { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用中文',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T08:00:00+08:00', reason: '用户明确要求' },
      { kind: 'change', scope: 'ongoing', personId: 'alice', property: 'report_language', text: ' 日报用中文 ',
        evidenceEventIds: ['20261110-worker-2'], effectiveAt: '2026-11-10T09:00:00.000Z', reason: '重复的说法' },
      { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用英文',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T08:00:00+08:00', reason: '已经存在' },
      { kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-worker-2'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '任务内约定' },
      { kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '重复' },
      { kind: 'fact', scope: 'task', personId: 'carol', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-user-1'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '已经存在' },
    ],
  })
  const { ctx } = fakeStream(answer)
  expect(await selectEventMemory(ctx, background, { ...input, existing: withManagedNote })).toEqual({
    items: [],
    changes: [
      { kind: 'fact', scope: 'ongoing', personId: 'alice', property: 'report_language', text: '日报用中文',
        evidenceEventIds: ['20261110-user-1', '20261110-worker-2'], effectiveAt: '2026-11-10T00:00:00.000Z', reason: '用户明确要求' },
      { kind: 'fact', scope: 'task', personId: 'bob', property: 'deploy_window', text: '周五发布',
        evidenceEventIds: ['20261110-worker-2', '20261110-user-1'], effectiveAt: '2026-11-10T09:00:00.000Z', taskId: 't1', reason: '任务内约定' },
    ],
  })
})

it('propagates a non-stop finish and malformed JSON before anything is written', async () => {
  const stopped = fakeStream('{"items":[],"changes":[]}', { kind: 'length' })
  await expect(selectEventMemory(stopped.ctx, background, input)).rejects.toThrow(/did not finish/)
  const broken = fakeStream('not json')
  await expect(selectEventMemory(broken.ctx, background, input)).rejects.toThrow()
})

it('keeps the builtin prompt exactly the fixed prompt and reports its code-fixed version', async () => {
  const legacy = fakeStream('{"items":[],"changes":[]}')
  await selectEventMemory(legacy.ctx, background, input)
  const builtin = fakeStream('{"items":[],"changes":[]}')
  const result = await selectEventMemory(builtin.ctx, background, input, undefined,
    { method: { version: 'builtin-v1', instructions: '' } })
  expect(builtin.prompt()).toBe(legacy.prompt())
  expect(result).toEqual({ items: [], changes: [], methodVersion: 'builtin-v1' })
})

it('appends method instructions after the fixed rules without relaxing the JSON or evidence constraints', async () => {
  const instructions = '优先保存与测试有关的事实。'
  const { ctx, prompt } = fakeStream('{"items":[],"changes":[]}')
  const result = await selectEventMemory(ctx, background, input, undefined,
    { method: { version: 'trial-v2', instructions } })
  const text = prompt()
  expect(result).toEqual({ items: [], changes: [], methodVersion: 'trial-v2' })
  expect(text).toContain('Method instructions: ' + instructions)
  expect(text.indexOf(instructions)).toBeGreaterThan(text.indexOf('Use empty arrays when nothing should be saved.'))
  expect(text.indexOf(instructions)).toBeLessThan(text.indexOf('Existing short-term memory:'))
  for (const fixed of ['Return only JSON of this shape', 'Every item needs at least one eventId', 'Event batch:'])
    expect(text).toContain(fixed)
})

it('never takes the method version from model output', async () => {
  const { ctx } = fakeStream(JSON.stringify({ items: [], changes: [], methodVersion: 'model-v2' }))
  await expect(selectEventMemory(ctx, background, input, undefined,
    { method: { version: 'fixed-v1', instructions: '' } })).rejects.toThrow()
})

it('calls beforeCall before the model and reports forwarded maxTokens and usage chunks', async () => {
  const calls: string[] = []
  const usage = vi.fn()
  const stream = vi.fn(async function* (request: { maxTokens?: number }) {
    calls.push('stream:' + String(request.maxTokens))
    yield { type: 'text-delta', text: '{"items":[],"changes":[]}', index: 0 }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  await selectEventMemory(ctx, background, input, undefined,
    { beforeCall: () => calls.push('before'), maxTokens: 128, onUsage: usage })
  expect(calls).toEqual(['before', 'stream:128'])
  expect(usage).toHaveBeenCalledWith({ inputTokens: 5, outputTokens: 7 })
  expect(stream).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 128 }))
})

it.each(['length', 'stream-error'])('keeps actual usage on %s and refuses before opening a stream', async kind => {
  const usage = vi.fn()
  const stream = vi.fn(async function* () {
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } }
    if (kind === 'stream-error') throw new Error('stream failed')
    yield { type: 'finish', reason: { kind: 'length' } }
  })
  const ctx = { llm: { resolveCallConfig: async (value: unknown) => value, stream } } as unknown as Context
  await expect(selectEventMemory(ctx, background, input, undefined, { onUsage: usage })).rejects.toThrow()
  expect(usage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 5, outputTokens: 7, failed: true }))
  stream.mockClear()
  await expect(selectEventMemory(ctx, background, input, undefined,
    { beforeCall: () => { throw new Error('limit') } })).rejects.toThrow('limit')
  expect(stream).not.toHaveBeenCalled()
})
