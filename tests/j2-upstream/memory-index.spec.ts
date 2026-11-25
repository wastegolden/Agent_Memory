/** The rebuildable memory index: SQLite metadata that follows upserts, can be deleted and rebuilt from the authoritative files, and answers every filter from a real index. */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MemoryIndex, type IndexedMemory, type MemoryEventQuery, type MemoryReference } from '../../src/core/index.ts'

let directory: string
let root: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-index-'))
  root = join(directory, '记忆', 'memory')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

/** One indexable record; the index never reads the path, it only records where the authoritative file is. */
const record = (kind: string, id: string, references?: MemoryReference[]): IndexedMemory =>
  ({ kind, id, path: join(root, kind, `${id}.json`), version: `version-${id}`, ...(references === undefined ? {} : { references }) })

/** An event record with the fields the event filters use. */
const event = (id: string, seq: number, at: string, fields: {
  kind?: string; taskId?: string; projectId?: string; personIds?: string[]; sources?: IndexedMemory['sources']
} = {}): IndexedMemory => ({
  kind: 'event',
  id,
  path: join(root, 'events', `${id}.json`),
  version: `version-${id}`,
  sources: fields.sources ?? [{ kind: 'message', id: `message-${id}` }],
  event: {
    kind: fields.kind ?? 'user', at, seq,
    ...(fields.taskId === undefined ? {} : { taskId: fields.taskId }),
    ...(fields.projectId === undefined ? {} : { projectId: fields.projectId }),
    ...(fields.personIds === undefined ? {} : { personIds: fields.personIds }),
  },
})

/** Every observable answer the index gives, so a rebuilt index can be compared with the original one. */
const answers = (index: MemoryIndex) => ({
  event: index.get('event', 'e1'),
  events: index.queryEvents(),
  project: index.queryEvents({ projectId: 'p1' }),
  source: index.findBySource({ kind: 'message', id: 'message-e1' }),
  used: index.usedBy('event', 'e1'),
  max: index.maxEventSeq(),
})

it('keeps identical answers after its file is deleted and the index is rebuilt from the authoritative records', () => {
  const records: IndexedMemory[] = [
    event('e1', 1, '2026-11-01T00:00:00Z', { taskId: 't1', projectId: 'p1', personIds: ['alice', 'bob'] }),
    event('e2', 2, '2026-11-02T00:00:00Z', { kind: 'worker', taskId: 't1',
      sources: [{ kind: 'message', id: 'message-e2' }, { kind: 'worker-report', id: 'report-2' }] }),
    { kind: 'task', id: 't1', path: join(root, 'tasks', 't1.json'), version: 'version-t1',
      references: [{ kind: 'event', id: 'e1', part: 'source' }] },
    { kind: 'short-term', id: 's1', path: join(root, 'short-term', 's1.json'), version: 'version-s1',
      sources: [{ kind: 'event', id: 'e1' }],
      references: [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }] },
  ]
  const first = new MemoryIndex(root)
  let before: ReturnType<typeof answers> | undefined
  try {
    for (const item of records) first.upsert(item)
    before = answers(first)
    expect(before.events.map(item => item.id)).toEqual(['e1', 'e2'])
    expect(before.used).toEqual([
      { kind: 'short-term', id: 's1', part: 'sources', taskId: 't1' },
      { kind: 'task', id: 't1', part: 'source' },
    ])
    expect(existsSync(join(root, 'index.sqlite'))).toBe(true)
  } finally { first.close() }
  // The index file is disposable: delete it, then rebuild from the authoritative records and get the same answers.
  rmSync(join(root, 'index.sqlite'))
  expect(existsSync(join(root, 'index.sqlite'))).toBe(false)
  const second = new MemoryIndex(root)
  try {
    expect(second.queryEvents()).toEqual([])
    second.rebuild(records)
    expect(answers(second)).toEqual(before)
  } finally { second.close() }
})

it('rebuilds the whole index in one synchronous pass, dropping records the authoritative set no longer has', () => {
  const first = event('e1', 1, '2026-11-01T00:00:00Z')
  const task: IndexedMemory = { kind: 'task', id: 't1', path: join(root, 'tasks', 't1.json'), version: 'version-t1' }
  const index = new MemoryIndex(root)
  try {
    index.upsert(event('stale', 9, '2026-11-09T00:00:00Z'))
    index.rebuild([first, task])
    expect(index.get('event', 'stale')).toBeUndefined()
    expect(index.get('event', 'e1')).toEqual(first)
    expect(index.queryEvents().map(item => item.id)).toEqual(['e1'])
    expect(index.maxEventSeq()).toBe(1)
    index.rebuild([])
    expect([index.get('event', 'e1'), index.get('event', 'stale'), index.queryEvents(), index.maxEventSeq()]).toEqual([undefined, undefined, [], 0])
  } finally { index.close() }
})

it('replaces sources and references on every upsert, deduplicating repeats and dropping the earlier answers', () => {
  const index = new MemoryIndex(root)
  const path = join(root, 'short-term', 's1.json')
  const saved: IndexedMemory = { kind: 'short-term', id: 's1', path, version: 'v1',
    sources: [{ kind: 'event', id: 'e1' }, { kind: 'message', id: 'm1', path: 'chat/m1.md' }, { kind: 'event', id: 'e1' }],
    references: [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }, { kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }] }
  try {
    index.upsert(saved)
    index.upsert(saved)
    expect(index.get('short-term', 's1')).toEqual({
      kind: 'short-term', id: 's1', path, version: 'v1',
      sources: [{ kind: 'event', id: 'e1' }, { kind: 'message', id: 'm1', path: 'chat/m1.md' }],
      references: [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }],
    })
    expect(index.findBySource({ kind: 'event', id: 'e1' }).map(item => item.id)).toEqual(['s1'])
    expect(index.findBySource({ kind: 'message', id: 'm1' }).map(item => item.id)).toEqual(['s1'])
    expect(index.usedBy('event', 'e1')).toEqual([{ kind: 'short-term', id: 's1', part: 'sources', taskId: 't1' }])
    // A later upsert replaces the earlier metadata: sources and references it no longer lists stop matching.
    index.upsert({ kind: 'short-term', id: 's1', path, version: 'v2', sources: [{ kind: 'file', id: 'doc' }],
      references: [{ kind: 'person', id: 'alice' }] })
    expect(index.findBySource({ kind: 'event', id: 'e1' })).toEqual([])
    expect(index.findBySource({ kind: 'message', id: 'm1' })).toEqual([])
    expect(index.findBySource({ kind: 'file', id: 'doc' }).map(item => item.id)).toEqual(['s1'])
    expect(index.usedBy('event', 'e1')).toEqual([])
    expect(index.usedBy('person', 'alice')).toEqual([{ kind: 'short-term', id: 's1' }])
    expect(index.get('short-term', 's1')).toEqual({ kind: 'short-term', id: 's1', path, version: 'v2',
      sources: [{ kind: 'file', id: 'doc' }], references: [{ kind: 'person', id: 'alice' }] })
  } finally { index.close() }
})

it('removes a record and its outgoing references without touching the records it pointed at', () => {
  const e1 = event('e1', 1, '2026-11-01T00:00:00Z')
  const shortTerm: IndexedMemory = { kind: 'short-term', id: 's1', path: join(root, 'short-term', 's1.json'), version: 'version-s1',
    sources: [{ kind: 'event', id: 'e1' }], references: [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }] }
  const document: IndexedMemory = { kind: 'document', id: 'd1', path: join(root, 'documents', 'd1.json'), version: 'version-d1',
    references: [{ kind: 'event', id: 'e1', part: 'source' }] }
  const index = new MemoryIndex(root)
  try {
    index.rebuild([e1, shortTerm, document])
    expect(index.usedBy('event', 'e1').map(item => `${item.kind}:${item.id}`).sort()).toEqual(['document:d1', 'short-term:s1'])
    index.remove('short-term', 's1')
    expect(index.get('short-term', 's1')).toBeUndefined()
    expect(index.findBySource({ kind: 'event', id: 'e1' })).toEqual([])
    expect(index.usedBy('event', 'e1')).toEqual([{ kind: 'document', id: 'd1', part: 'source' }])
    expect(index.get('event', 'e1')).toEqual(e1)
    expect(index.queryEvents().map(item => item.id)).toEqual(['e1'])
    index.remove('event', 'e1')
    expect(index.get('event', 'e1')).toBeUndefined()
    expect(index.queryEvents()).toEqual([])
    expect(index.maxEventSeq()).toBe(0)
    // References other records make are their own metadata, so the document's pointer stays until the document is removed.
    expect(index.usedBy('event', 'e1')).toEqual([{ kind: 'document', id: 'd1', part: 'source' }])
    expect(index.get('document', 'd1')).toEqual(document)
  } finally { index.close() }
})

it('filters events in SQLite by every condition, in sequence order, and sees an event recorded late', () => {
  const index = new MemoryIndex(root)
  const ids = (query: MemoryEventQuery = {}): string[] => index.queryEvents(query).map(item => item.id)
  try {
    expect(index.maxEventSeq()).toBe(0)
    index.upsert(event('e1', 1, '2026-11-01T00:00:00Z', { taskId: 't1', projectId: 'p1', personIds: ['alice', 'bob'], sources: [{ kind: 'message', id: 'm1' }] }))
    index.upsert(event('e2', 2, '2026-11-02T00:00:00Z', { kind: 'jarvis', taskId: 't1', projectId: 'p2', personIds: ['bob'], sources: [{ kind: 'activity', id: 'a1' }] }))
    index.upsert(event('e3', 3, '2026-11-03T00:00:00Z', { kind: 'worker', taskId: 't2', projectId: 'p1', personIds: ['carol'],
      sources: [{ kind: 'message', id: 'm2' }, { kind: 'worker-report', id: 'r1' }] }))
    // A non-event record is never returned by the event query.
    index.upsert(record('task', 't1', [{ kind: 'event', id: 'e1', part: 'source' }]))
    expect(ids()).toEqual(['e1', 'e2', 'e3'])
    expect(ids({ kind: 'user' })).toEqual(['e1'])
    expect(ids({ kind: 'jarvis' })).toEqual(['e2'])
    expect(ids({ kind: 'worker' })).toEqual(['e3'])
    expect(ids({ taskId: 't1' })).toEqual(['e1', 'e2'])
    expect(ids({ projectId: 'p1' })).toEqual(['e1', 'e3'])
    expect(ids({ personId: 'bob' })).toEqual(['e1', 'e2'])
    expect(ids({ sourceKind: 'message' })).toEqual(['e1', 'e3'])
    expect(ids({ sourceKind: 'worker-report' })).toEqual(['e3'])
    expect(ids({ sourceId: 'm2' })).toEqual(['e3'])
    expect(ids({ sourceKind: 'message', sourceId: 'm2' })).toEqual(['e3'])
    // from/to include their endpoints.
    expect(ids({ from: '2026-11-02T00:00:00Z', to: '2026-11-03T00:00:00Z' })).toEqual(['e2', 'e3'])
    expect(ids({ from: '2026-11-02T00:00:00Z' })).toEqual(['e2', 'e3'])
    expect(ids({ to: '2026-11-01T00:00:00Z' })).toEqual(['e1'])
    expect(ids({ afterSeq: 2 })).toEqual(['e3'])
    expect(ids({ afterSeq: 0 })).toEqual(['e1', 'e2', 'e3'])
    expect(ids({ kind: 'worker', taskId: 't2', projectId: 'p1', personId: 'carol', sourceKind: 'message',
      from: '2026-11-03T00:00:00Z', to: '2026-11-03T00:00:00Z', afterSeq: 2 })).toEqual(['e3'])
    expect(ids({ kind: 'user', taskId: 't2' })).toEqual([])
    expect(index.maxEventSeq()).toBe(3)
    // Nothing after sequence 3 yet; a late event with a higher sequence appears once it is indexed.
    expect(ids({ afterSeq: 3 })).toEqual([])
    index.upsert(event('e4', 7, '2026-11-04T00:00:00Z', { taskId: 't2', projectId: 'p1', personIds: ['alice'] }))
    expect(ids({ afterSeq: 3 })).toEqual(['e4'])
    expect(ids()).toEqual(['e1', 'e2', 'e3', 'e4'])
    expect(index.maxEventSeq()).toBe(7)
  } finally { index.close() }
})

it('answers source lookups from indexed metadata without reading or creating the memory file', () => {
  const index = new MemoryIndex(root)
  const file = join(root, 'events', 'e1.json')
  try {
    index.upsert(event('e1', 1, '2026-11-01T00:00:00Z', { sources: [{ kind: 'message', id: 'm1' }] }))
    expect(existsSync(file)).toBe(false)
    expect(index.findBySource({ kind: 'message', id: 'm1' }).map(item => item.id)).toEqual(['e1'])
    expect(index.queryEvents({ sourceKind: 'message', sourceId: 'm1' }).map(item => item.id)).toEqual(['e1'])
    expect(existsSync(file)).toBe(false)
  } finally { index.close() }
})

it('answers every filter through a real SQLite index and defines the columns those filters need', () => {
  const index = new MemoryIndex(root)
  try {
    index.rebuild([
      event('e1', 1, '2026-11-01T00:00:00Z', { taskId: 't1', projectId: 'p1', personIds: ['alice'] }),
      event('e2', 2, '2026-11-02T00:00:00Z', { kind: 'worker', taskId: 't2', projectId: 'p2', personIds: ['bob'] }),
      record('task', 't1', [{ kind: 'event', id: 'e1', part: 'source' }]),
    ])
  } finally { index.close() }
  // A dedicated test connection reads the query plans while the index itself is closed.
  const db = new DatabaseSync(join(root, 'index.sqlite'))
  try {
    const plan = (sql: string, ...parameters: (string | number)[]): string =>
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters).map(row => String(row.detail)).join('\n')
    const events = `SELECT m.kind, m.id FROM memory m WHERE m.kind = 'event' AND m.event_seq IS NOT NULL`
    const plans = {
      record: plan('SELECT kind, id FROM memory WHERE kind = ? AND id = ?', 'event', 'e1'),
      eventKind: plan(`${events} AND m.event_kind = ? ORDER BY m.event_seq`, 'user'),
      eventTask: plan(`${events} AND m.event_task_id = ? ORDER BY m.event_seq`, 't1'),
      eventProject: plan(`${events} AND m.event_project_id = ? ORDER BY m.event_seq`, 'p1'),
      eventTime: plan(`${events} AND m.event_at >= ? AND m.event_at <= ? ORDER BY m.event_seq`, '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
      afterSeq: plan(`${events} AND m.event_seq > ? ORDER BY m.event_seq`, 1),
      person: plan(`${events} AND EXISTS (SELECT 1 FROM memory_person p
        WHERE p.record_kind = m.kind AND p.record_id = m.id AND p.person_id = ?) ORDER BY m.event_seq`, 'alice'),
      sourceFilter: plan(`${events} AND EXISTS (SELECT 1 FROM memory_source s
        WHERE s.record_kind = m.kind AND s.record_id = m.id AND s.kind = ?) ORDER BY m.event_seq`, 'message'),
      sourceLookup: plan(`SELECT m.kind, m.id FROM memory m JOIN memory_source s
        ON s.record_kind = m.kind AND s.record_id = m.id WHERE s.kind = ? AND s.id = ?`, 'message', 'message-e1'),
      usedBy: plan('SELECT from_kind, from_id, part, task_id FROM memory_reference WHERE target_kind = ? AND target_id = ?', 'event', 'e1'),
    }
    for (const detail of Object.values(plans)) expect(detail).toMatch(/USING (COVERING )?INDEX/)
    expect(plans.person).toContain('memory_person')
    expect(plans.sourceLookup).toContain('memory_source_lookup')
    expect(plans.usedBy).toContain('memory_reference_target')
    // The indexes exist with the exact columns each filter needs.
    const indexColumns = (table: string): string[][] => db.prepare('SELECT name FROM pragma_index_list(?)').all(table)
      .map(listed => db.prepare('SELECT name FROM pragma_index_info(?) ORDER BY seqno').all(String(listed.name))
        .map(column => String(column.name)))
    expect(indexColumns('memory')).toEqual(expect.arrayContaining([
      ['kind', 'event_seq'],
      ['event_kind', 'event_seq'],
      ['event_at'],
      ['event_task_id', 'event_seq'],
      ['event_project_id', 'event_seq'],
    ]))
    expect(indexColumns('memory_source')).toContainEqual(['kind', 'id'])
    expect(indexColumns('memory_person')).toContainEqual(['person_id'])
    expect(indexColumns('memory_reference')).toContainEqual(['target_kind', 'target_id'])
  } finally { db.close() }
})

it('keeps diagnostics by path, replaces a reason and clears one when its file is repaired', () => {
  const index = new MemoryIndex(root)
  try {
    expect(index.diagnostics()).toEqual([])
    index.report('memory/events/b.json', 'invalid JSON')
    index.report('memory/events/a.json', 'missing content')
    expect(index.diagnostics()).toEqual([
      { path: 'memory/events/a.json', reason: 'missing content' },
      { path: 'memory/events/b.json', reason: 'invalid JSON' },
    ])
    index.report('memory/events/b.json', 'file removed')
    index.clearDiagnostic('memory/events/a.json')
    expect(index.diagnostics()).toEqual([{ path: 'memory/events/b.json', reason: 'file removed' }])
    index.clearDiagnostic('memory/events/unknown.json')
    expect(index.diagnostics()).toEqual([{ path: 'memory/events/b.json', reason: 'file removed' }])
  } finally { index.close() }
})

it('closes the database handle so the index directory can be released', () => {
  const index = new MemoryIndex(root)
  try {
    index.upsert(event('e1', 1, '2026-11-01T00:00:00Z'))
    expect(index.get('event', 'e1')).toBeDefined()
  } finally { index.close() }
  expect(() => rmSync(root, { recursive: true, force: true })).not.toThrow()
  expect(existsSync(root)).toBe(false)
})
it('drives selective person and source queries from their indexes, without an outer event-range scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-selective-plan-'))
  const index = new MemoryIndex(root, { memory: true })
  try {
    index.rebuild(Array.from({ length: 1000 }, (_, i) => ({ kind: 'event', id: `e${i}`, path: `e${i}.json`, version: 'v',
      sources: [{ kind: 'message', id: i < 10 ? 'target' : `m${i}` }],
      event: { kind: 'user', at: '2026-11-10', seq: i + 1, personIds: [i < 10 ? 'target' : `p${i}`] } })))
    const db = (index as unknown as { db: DatabaseSync }).db
    const prepare = db.prepare.bind(db)
    const statements: string[] = []
    db.prepare = ((sql: string) => { statements.push(sql); return prepare(sql) }) as typeof db.prepare
    expect(index.queryEvents({ personId: 'target' })).toHaveLength(10)
    expect(index.queryEvents({ sourceKind: 'message', sourceId: 'target' })).toHaveLength(10)
    const queries = statements.filter(sql => sql.startsWith('SELECT m.kind, m.id FROM memory m'))
    expect(queries).toHaveLength(2)
    for (const [i, sql] of queries.entries()) {
      const params = i === 0 ? ['target'] : ['message', 'target']
      const plan = prepare('EXPLAIN QUERY PLAN ' + sql).all(...params).map(row => String(row.detail)).join('\n')
      expect(plan).not.toContain('memory_kind_event_seq')
      expect(plan).toContain(i === 0 ? 'memory_person_lookup' : 'memory_source_lookup')
    }
    const refs = prepare("EXPLAIN QUERY PLAN SELECT * FROM memory_reference WHERE from_kind = ? AND from_id = ?")
      .all('short-term', 's1').map(row => String(row.detail)).join('\n')
    expect(refs).toContain('memory_reference_from')
  } finally { index.close(); rmSync(root, { recursive: true, force: true }) }
})
it('notifies a committed version change with the new and previously indexed metadata, and stops after unsubscribing', () => {
  const index = new MemoryIndex(root)
  const reported: { current: IndexedMemory; previous: IndexedMemory }[] = []
  const versions: string[] = []
  const stopReported = index.onVersionChange((current, previous) => { reported.push({ current, previous }) })
  const stopVersions = index.onVersionChange((current, previous) => { versions.push(`${previous.version}->${current.version}`) })
  const path = join(root, 'tasks', 't1.json')
  const first: IndexedMemory = { kind: 'task', id: 't1', path, version: 'v1', references: [{ kind: 'event', id: 'e1', part: 'source' }] }
  const sameVersion: IndexedMemory = { ...first, path: join(root, 'tasks', 't1-moved.json'), references: [{ kind: 'event', id: 'e9' }] }
  const second: IndexedMemory = { ...first, version: 'v2' }
  const third: IndexedMemory = { ...first, version: 'v3' }
  try {
    index.upsert(first)
    // A first insert and a same-version upsert (even one that changes other metadata) are not version changes.
    index.upsert(sameVersion)
    expect(reported).toEqual([])
    expect(versions).toEqual([])
    expect(index.get('task', 't1')).toEqual(sameVersion)
    index.upsert(second)
    expect(reported).toEqual([{ current: second, previous: sameVersion }])
    index.upsert(third)
    expect(reported).toEqual([{ current: second, previous: sameVersion }, { current: third, previous: second }])
    expect(versions).toEqual(['v1->v2', 'v2->v3'])
    // Rebuilding replaces versions without notifying: it is a fresh authoritative snapshot, not an incremental change.
    index.rebuild([{ ...first, version: 'v0' }])
    expect(reported).toHaveLength(2)
    expect(versions).toHaveLength(2)
    expect(index.get('task', 't1')?.version).toBe('v0')
    // Unsubscribing removes only that listener, immediately.
    stopReported()
    index.upsert({ ...first, version: 'v4' })
    expect(reported).toHaveLength(2)
    expect(versions).toEqual(['v1->v2', 'v2->v3', 'v0->v4'])
    stopVersions()
    index.upsert({ ...first, version: 'v5' })
    expect(reported).toHaveLength(2)
    expect(versions).toHaveLength(3)
  } finally { index.close() }
})
it('lets a version-change listener read the committed record and its incoming references inside the callback', () => {
  const index = new MemoryIndex(root)
  // A second connection only sees committed rows, so reading through it proves the notifying upsert has already committed.
  const reader = new DatabaseSync(join(root, 'index.sqlite'))
  const path = join(root, 'short-term', 's1.json')
  const older: IndexedMemory = { kind: 'short-term', id: 's1', path, version: 'v1',
    sources: [{ kind: 'event', id: 'e1' }], references: [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }] }
  const newer: IndexedMemory = { kind: 'short-term', id: 's1', path, version: 'v2',
    sources: [{ kind: 'event', id: 'e1' }], references: [{ kind: 'event', id: 'e2', part: 'sources', taskId: 't1' }] }
  const observed: {
    current: IndexedMemory
    previous: IndexedMemory
    indexed: IndexedMemory | undefined
    newUsedBy: MemoryReference[]
    oldUsedBy: MemoryReference[]
    committedVersion: string | undefined
    committedReferences: string[]
  }[] = []
  const stop = index.onVersionChange((current, previous) => {
    const committed = reader.prepare('SELECT version FROM memory WHERE kind = ? AND id = ?').get('short-term', 's1')
    const references = reader.prepare('SELECT target_id FROM memory_reference WHERE from_kind = ? AND from_id = ? ORDER BY rowid')
      .all('short-term', 's1')
    observed.push({
      current,
      previous,
      indexed: index.get('short-term', 's1'),
      newUsedBy: index.usedBy('event', 'e2'),
      oldUsedBy: index.usedBy('event', 'e1'),
      committedVersion: committed === undefined ? undefined : String(committed.version),
      committedReferences: references.map(reference => String(reference.target_id)),
    })
  })
  try {
    index.upsert(older)
    index.upsert(newer)
    expect(observed).toEqual([{
      current: newer,
      previous: older,
      indexed: newer,
      newUsedBy: [{ kind: 'short-term', id: 's1', part: 'sources', taskId: 't1' }],
      oldUsedBy: [],
      committedVersion: 'v2',
      committedReferences: ['e2'],
    }])
  } finally { stop(); reader.close(); index.close() }
})
it('does not read the previous record for upserts when no listener is registered', () => {
  const index = new MemoryIndex(root)
  const saved = record('task', 't1')
  try {
    index.upsert(saved)
    // Capture the SELECTs the write path would use to read the previous metadata.
    const db = (index as unknown as { db: DatabaseSync }).db
    const prepare = db.prepare.bind(db)
    const memoryReads: string[] = []
    db.prepare = ((sql: string) => {
      if (/^\s*SELECT/i.test(sql) && /\bFROM memory\b/.test(sql)) memoryReads.push(sql)
      return prepare(sql)
    }) as typeof db.prepare
    index.upsert({ ...saved, version: 'version-t1-2' })
    index.upsert({ ...saved, version: 'version-t1-3' })
    expect(memoryReads).toEqual([])
    // The probe can see that read once a listener makes the previous metadata observable.
    const stop = index.onVersionChange(() => {})
    index.upsert({ ...saved, version: 'version-t1-4' })
    const readsWithListener = memoryReads.length
    expect(readsWithListener).toBeGreaterThan(0)
    stop()
    index.upsert({ ...saved, version: 'version-t1-5' })
    expect(memoryReads).toHaveLength(readsWithListener)
  } finally { index.close() }
})
