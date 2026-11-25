/** The event stream: flat month files stay authoritative, IDs and sequences survive edits and rebuilds, and every filter runs in SQLite. */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryEvents, type EventQuery } from '../../src/core/events.ts'
import { MemoryIndex } from '../../src/core/index.ts'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'jarvis-events-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

it('stores flat event files under a month directory and reads three origins back through the compatibility record', () => {
  const events = new MemoryEvents(root)
  const user = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '请检查构建',
    source: { kind: 'web-message', id: 'm1' }, personIds: ['owner'] })
  const jarvis = events.record({ kind: 'jarvis', at: '2026-11-10T00:00:01Z', text: '已派工',
    source: { kind: 'activity', id: 'a1' }, taskId: 't1' })
  const worker = events.record({ kind: 'worker', at: '2026-11-10T00:00:02Z', text: '构建通过',
    source: { kind: 'worker-report', id: 'r1' }, taskId: 't1', projectId: 'p1',
    log: { sessionId: 'worker-t1', resource: 'ticket/t1/transcript' } })
  // The ID carries the first event date, the file lives under its month, and the sequence starts at one.
  expect(user.id).toMatch(/^20261110-[0-9a-f]{64}$/)
  expect(user.path).toBe(join(root, 'events', '2026-11', `${user.id}.json`))
  expect(user.seq).toBe(1)
  // The authoritative file is flat: metadata beside the event fields, no nested `event` and no JSON string `content`.
  const flat = JSON.parse(readFileSync(user.path, 'utf8')) as Record<string, unknown>
  expect(flat).toEqual({ id: user.id, seq: 1, createdAt: user.createdAt, updatedAt: user.updatedAt, ...user.event })
  expect(flat.event).toBeUndefined()
  expect(flat.content).toBeUndefined()
  expect(flat.source).toEqual({ kind: 'web-message', id: 'm1' })
  // The returned record keeps the old compatibility source and content fields and adds `seq` and `path`.
  expect(user.source).toEqual({ kind: 'event-user', id: 'm1' })
  expect(user.content).toBe(JSON.stringify(user.event))
  expect(user.version).toBe(sha256(readFileSync(user.path, 'utf8')))
  // The index knows the original source and the compatibility source, with every field the filters read.
  expect(events.index.get('event', user.id)).toMatchObject({ path: user.path, version: user.version,
    sources: [{ kind: 'web-message', id: 'm1' }, { kind: 'event-user', id: 'm1' }],
    event: { kind: 'user', at: '2026-11-10T00:00:00Z', seq: 1, personIds: ['owner'] } })
  expect(events.index.queryEvents({ sourceKind: 'web-message', sourceId: 'm1' }).map(event => event.id)).toEqual([user.id])
  // Recording the same source and kind again keeps the identity instead of appending another event.
  expect(events.record(user.event).id).toBe(user.id)
  expect(events.list().map(record => record.source.kind)).toEqual(['event-user', 'event-jarvis', 'event-worker'])
  expect(events.list({ personId: 'owner' }).map(record => record.id)).toEqual([user.id])
  expect(events.list({ taskId: 't1' }).map(record => record.id)).toEqual([jarvis.id, worker.id])
  expect(events.list({ kind: 'worker', projectId: 'p1' })).toEqual([worker])
  // A reopen scans the flat files once and reads the same facts back.
  const reopened = new MemoryEvents(root)
  expect(reopened.list().map(record => record.id)).toEqual([user.id, jarvis.id, worker.id])
  expect(reopened.get(worker.id).event.log).toEqual({ sessionId: 'worker-t1', resource: 'ticket/t1/transcript' })
})

it('keeps the first ID, sequence, path and createdAt when the same source is recorded again in another month', () => {
  const events = new MemoryEvents(root)
  const first = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '第一版',
    source: { kind: 'web-message', id: 'm1' } })
  const query = vi.spyOn(events.index, 'queryEvents')
  const later = events.record({ kind: 'user', at: '2026-12-01T00:00:00Z', text: '第二版',
    source: { kind: 'web-message', id: 'm1' } })
  const queries = query.mock.calls.map(([conditions]) => conditions)
  query.mockRestore()
  // The same source is found through the SQLite index, never by walking the month directories.
  expect(queries).toContainEqual({ sourceKind: 'web-message', sourceId: 'm1' })
  expect(later.id).toBe(first.id)
  expect(later.seq).toBe(first.seq)
  expect(later.path).toBe(first.path)
  expect(later.createdAt).toBe(first.createdAt)
  expect(Date.parse(later.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt))
  expect(later.event.at).toBe('2026-12-01T00:00:00Z')
  expect(later.event.text).toBe('第二版')
  // The file stays in the first month and under the first date even though the event time moved.
  expect(existsSync(join(root, 'events', '2026-11', `${first.id}.json`))).toBe(true)
  expect(existsSync(join(root, 'events', '2026-12'))).toBe(false)
  expect(JSON.parse(readFileSync(first.path, 'utf8'))).toMatchObject({ id: first.id, seq: first.seq,
    at: '2026-12-01T00:00:00Z', text: '第二版' })
  expect(events.list({ sourceKind: 'web-message', sourceId: 'm1' })).toEqual([later])
  // A different event kind from the same source is its own event with its own sequence.
  const jarvis = events.record({ kind: 'jarvis', at: '2026-12-01T00:00:00Z', text: '已处理',
    source: { kind: 'web-message', id: 'm1' } })
  expect(jarvis.id).not.toBe(first.id)
  expect(jarvis.seq).toBe(2)
  const reopened = new MemoryEvents(root)
  expect(reopened.get(first.id)).toEqual(later)
})

it('shows an old-time event recorded late to an afterSeq cursor while the default order stays by event time', () => {
  const events = new MemoryEvents(root)
  const first = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '先入库',
    source: { kind: 'web-message', id: 'm1' } })
  const second = events.record({ kind: 'user', at: '2026-11-11T00:00:00Z', text: '后入库',
    source: { kind: 'web-message', id: 'm2' } })
  const late = events.record({ kind: 'user', at: '2026-10-01T00:00:00Z', text: '旧时间晚入库',
    source: { kind: 'web-message', id: 'm3' } })
  expect([first.seq, second.seq, late.seq]).toEqual([1, 2, 3])
  expect(events.list().map(event => event.id)).toEqual([late.id, first.id, second.id])
  expect(events.list({ afterSeq: second.seq }).map(event => event.id)).toEqual([late.id])
  expect(events.list({ afterSeq: 0 }).map(event => event.seq)).toEqual([1, 2, 3])
  expect(events.list({ from: '2026-11-01T00:00:00Z', to: '2026-11-30T00:00:00Z' }).map(event => event.id))
    .toEqual([first.id, second.id])
  const reopened = new MemoryEvents(root)
  expect(reopened.list({ afterSeq: second.seq })).toEqual([late])
})

it('applies every event filter through the SQLite index and reads only the matched files', () => {
  const index = new MemoryIndex(root)
  const events = new MemoryEvents(root, index)
  try {
    const u1 = events.record({ kind: 'user', at: '2026-11-01T00:00:00Z', text: 'u1',
      source: { kind: 'web-message', id: 'm1' }, taskId: 't1', projectId: 'p1', personIds: ['alice', 'bob'] })
    const j1 = events.record({ kind: 'jarvis', at: '2026-11-02T00:00:00Z', text: 'j1',
      source: { kind: 'activity', id: 'a1' }, taskId: 't1', projectId: 'p2', personIds: ['bob'] })
    const w1 = events.record({ kind: 'worker', at: '2026-11-03T00:00:00Z', text: 'w1',
      source: { kind: 'worker-report', id: 'r1' }, taskId: 't2', projectId: 'p1', personIds: ['carol'] })
    const ids = (query: EventQuery): string[] => events.list(query).map(event => event.id)
    expect(ids({})).toEqual([u1.id, j1.id, w1.id])
    expect(ids({ kind: 'user' })).toEqual([u1.id])
    expect(ids({ kind: 'jarvis' })).toEqual([j1.id])
    expect(ids({ taskId: 't1' })).toEqual([u1.id, j1.id])
    expect(ids({ projectId: 'p1' })).toEqual([u1.id, w1.id])
    expect(ids({ personId: 'bob' })).toEqual([u1.id, j1.id])
    expect(ids({ sourceKind: 'worker-report' })).toEqual([w1.id])
    expect(ids({ sourceId: 'a1' })).toEqual([j1.id])
    expect(ids({ sourceKind: 'web-message', sourceId: 'm1' })).toEqual([u1.id])
    expect(ids({ from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z' })).toEqual([j1.id, w1.id])
    expect(ids({ afterSeq: 1 })).toEqual([j1.id, w1.id])
    expect(ids({ kind: 'user', taskId: 't2' })).toEqual([])
    // One call with every condition reaches SQLite unchanged, and the hit files are the only reads.
    const query = vi.spyOn(events.index, 'queryEvents')
    const combined: EventQuery = { kind: 'worker', taskId: 't2', projectId: 'p1', personId: 'carol',
      sourceKind: 'worker-report', sourceId: 'r1', from: '2026-11-03T00:00:00Z', to: '2026-11-03T00:00:00Z', afterSeq: 1 }
    expect(ids(combined)).toEqual([w1.id])
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith(combined)
    query.mockRestore()
    expect(existsSync(join(root, 'index.sqlite'))).toBe(true)
  } finally { index.close() }
})

it('reads an event from its date-named file without the index, refreshing the index only when the file version changes', () => {
  const index = new MemoryIndex(root)
  const events = new MemoryEvents(root, index)
  try {
    const event = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '原文',
      source: { kind: 'web-message', id: 'm1' } })
    // The index loses the row; the date in the ID still locates the authoritative file.
    events.index.remove('event', event.id)
    expect(events.index.get('event', event.id)).toBeUndefined()
    expect(events.get(event.id)).toEqual(event)
    expect(events.index.get('event', event.id)).toMatchObject({ path: event.path, version: event.version })
    // A hand edit is hashed again and indexed once; reading the unchanged version again writes nothing.
    const saved = JSON.parse(readFileSync(event.path, 'utf8')) as { text: string }
    saved.text = '手工修改后的原文'
    writeFileSync(event.path, `${JSON.stringify(saved, null, 2)}\n`, 'utf8')
    const upsert = vi.spyOn(events.index, 'upsert')
    const edited = events.get(event.id)
    expect(edited.event.text).toBe('手工修改后的原文')
    expect(edited.version).toBe(sha256(readFileSync(event.path, 'utf8')))
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(events.get(event.id).event.text).toBe('手工修改后的原文')
    expect(upsert).toHaveBeenCalledTimes(1)
    upsert.mockRestore()
  } finally { index.close() }
})

it('isolates a damaged event file in list with a diagnostic by path and reports that path from get until it is repaired', () => {
  const events = new MemoryEvents(root)
  const good = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '完好',
    source: { kind: 'web-message', id: 'm1' } })
  const broken = events.record({ kind: 'user', at: '2026-11-10T00:00:01Z', text: '损坏',
    source: { kind: 'web-message', id: 'm2' } })
  writeFileSync(broken.path, '{ not json')
  expect(events.list().map(event => event.id)).toEqual([good.id])
  expect(events.index.diagnostics()).toEqual([{ path: broken.path, reason: expect.any(String) }])
  expect(() => events.get(broken.id)).toThrow(broken.path)
  // A repaired file is read again and its diagnostic cleared.
  const repaired = { id: broken.id, seq: broken.seq, createdAt: broken.createdAt, updatedAt: broken.updatedAt, ...broken.event }
  writeFileSync(broken.path, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8')
  expect(events.list().map(event => event.id)).toEqual([good.id, broken.id])
  expect(events.index.diagnostics()).toEqual([])
})

it('rebuilds IDs and sequences from the flat files after the index is deleted, removing only stale event rows', () => {
  const firstIndex = new MemoryIndex(root)
  const events = new MemoryEvents(root, firstIndex)
  const first = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '一',
    source: { kind: 'web-message', id: 'm1' } })
  const second = events.record({ kind: 'user', at: '2026-11-11T00:00:00Z', text: '二',
    source: { kind: 'web-message', id: 'm2' } })
  const third = events.record({ kind: 'user', at: '2026-11-12T00:00:00Z', text: '三',
    source: { kind: 'web-message', id: 'm3' } })
  const archive = events.store.put('tasks', { id: 'archive-1', source: { kind: 'task', id: 't1' }, content: '归档原文' })
  rmSync(third.path)
  events.reconcile()
  expect(events.list().map(event => event.id)).toEqual([first.id, second.id])
  expect(firstIndex.get('event', third.id)).toBeUndefined()
  // Reconciling the event stream leaves other kinds alone.
  expect(firstIndex.get('tasks', 'archive-1')).toBeDefined()
  expect(firstIndex.maxEventSeq()).toBe(2)
  // Delete the disposable index: reopening rebuilds identity and sequences from the files themselves.
  firstIndex.close()
  rmSync(join(root, 'index.sqlite'))
  const index = new MemoryIndex(root)
  const reopened = new MemoryEvents(root, index)
  try {
    expect(reopened.list().map(event => event.id)).toEqual([first.id, second.id])
    expect(reopened.index.get('tasks', archive.id)).toBeDefined()
    expect(reopened.index.maxEventSeq()).toBe(2)
    const again = reopened.record({ kind: 'user', at: '2026-12-05T00:00:00Z', text: '重写',
      source: { kind: 'web-message', id: 'm1' } })
    expect(again.id).toBe(first.id)
    expect(again.seq).toBe(first.seq)
    // The next new source continues from the rebuilt sequence.
    const next = reopened.record({ kind: 'user', at: '2026-12-05T00:00:00Z', text: '新来源',
      source: { kind: 'web-message', id: 'm9' } })
    expect(next.seq).toBe(3)
  } finally { index.close() }
})

it('does not write an index row for an event whose authoritative file could not be published', () => {
  const events = new MemoryEvents(root)
  // A file where the December month directory would be makes the write fail before any index row exists.
  writeFileSync(join(root, 'events', '2026-12'), 'not a directory')
  const id = `20261201-${sha256(JSON.stringify(['user', 'web-message', 'm1']))}`
  expect(() => events.record({ kind: 'user', at: '2026-12-01T00:00:00Z', text: '写不进去',
    source: { kind: 'web-message', id: 'm1' } })).toThrow()
  expect(events.index.get('event', id)).toBeUndefined()
  expect(events.index.maxEventSeq()).toBe(0)
  expect(events.list()).toEqual([])
})
it('isolates a hand-edited optional field with the wrong type when reopening the stream', () => {
  const events = new MemoryEvents(root)
  const broken = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: 'bad field', source: { kind: 'test', id: 'bad' } })
  const good = events.record({ kind: 'user', at: '2026-11-10T00:00:01Z', text: 'healthy', source: { kind: 'test', id: 'good' } })
  const value = JSON.parse(readFileSync(broken.path, 'utf8'))
  value.personIds = 123
  writeFileSync(broken.path, JSON.stringify(value))
  const reopened = new MemoryEvents(root)
  expect(reopened.list().map(item => item.id)).toEqual([good.id])
  expect(reopened.index.diagnostics()).toContainEqual(expect.objectContaining({ path: broken.path }))
  expect(() => reopened.get(broken.id)).toThrow(broken.path)
})
