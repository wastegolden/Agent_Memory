/** The review queue: changed sources enqueue only the index's referencing records, and a write happens only while every reviewed version and reference still holds. */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryIndex, type IndexedMemory, type MemoryReference } from '../../src/core/index.ts'
import { MemoryReviews, stableReviewId, type MemoryReviewsDeps } from '../../src/core/reviews.ts'

/** One authoritative file as the injected read answers it; a test edits this to simulate a real change on disk. */
interface AuthoritativeFile { version: string; sources: MemoryReference[] }

let directory: string
let root: string
let opened: MemoryIndex[]
let files: Map<string, AuthoritativeFile>

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-reviews-'))
  root = join(directory, 'memory')
  opened = []
  files = new Map()
})
afterEach(() => {
  for (const index of opened) index.close()
  rmSync(directory, { recursive: true, force: true })
})

/** A new in-memory index over this root, closed after the test. */
const openIndex = (): MemoryIndex => {
  const index = new MemoryIndex(root, { memory: true })
  opened.push(index)
  return index
}
/** The authoritative file key: one record per (kind, id), whichever part a reference names. */
const fileKey = (kind: string, id: string): string => JSON.stringify([kind, id])
/** Declares what the injected read reports for one record and the sources it holds now. */
const settle = (kind: string, id: string, version: string, sources: MemoryReference[] = []): void => {
  files.set(fileKey(kind, id), { version, sources })
}
/** A memory record as the index keeps it; the queue only ever sees its references here. */
const record = (kind: string, id: string, references: MemoryReference[]): IndexedMemory =>
  ({ kind, id, path: join(root, kind, `${id}.json`), version: `version-${id}`, references })
/** The injected capabilities over one real index, recording every authoritative read. */
const depsFor = (index: MemoryIndex): { deps: MemoryReviewsDeps; reads: MemoryReference[] } => {
  const reads: MemoryReference[] = []
  const deps: MemoryReviewsDeps = {
    usedBy: (kind: string, id: string) => index.usedBy(kind, id),
    read: (reference: MemoryReference) => {
      reads.push(reference)
      const file = files.get(fileKey(reference.kind, reference.id))
      if (file === undefined) throw new Error(`missing authoritative memory ${reference.kind}:${reference.id}`)
      return file
    },
  }
  return { deps, reads }
}
/** A short-term target s1 attributed to task t1, referencing event e1 and optionally e2, indexed and readable. */
const scenario = (options: { second?: boolean } = {}) => {
  const index = openIndex()
  const references: MemoryReference[] = [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }]
  const sources: MemoryReference[] = [{ kind: 'event', id: 'e1' }]
  if (options.second) {
    references.push({ kind: 'event', id: 'e2', part: 'sources', taskId: 't1' })
    sources.push({ kind: 'event', id: 'e2' })
  }
  index.rebuild([{ kind: 'short-term', id: 's1', path: join(root, 'short-term', 's1.json'), version: 'version-s1', references }])
  settle('short-term', 's1', 'v-s1', sources)
  settle('event', 'e1', 'v1')
  if (options.second) settle('event', 'e2', 'v1')
  const { deps } = depsFor(index)
  return { deps, queue: new MemoryReviews(root, deps), id: stableReviewId({ kind: 'short-term', id: 's1', part: 'sources' }) }
}

it('enqueues only the records the real index reports for a changed source, reading no memory file and creating no dependency directory', () => {
  const index = openIndex()
  index.rebuild([
    record('short-term', 's1', [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }]),
    record('task', 't1', [{ kind: 'event', id: 'e1', part: 'source' }]),
    record('documents', 'd1', [{ kind: 'event', id: 'elsewhere', part: 'source' }]),
  ])
  const { deps, reads } = depsFor(index)
  const queue = new MemoryReviews(root, deps)
  const shortTerm = stableReviewId({ kind: 'short-term', id: 's1', part: 'sources' })
  const task = stableReviewId({ kind: 'task', id: 't1', part: 'source' })
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v1' }).sort()).toEqual([shortTerm, task].sort())
  // Queueing is an index lookup alone: no target file was read and no dependency registry was built.
  expect(reads).toEqual([])
  expect(existsSync(join(root, 'dependencies'))).toBe(false)
  expect(readdirSync(root)).toEqual(['review-queue'])
  expect(readdirSync(join(root, 'review-queue')).sort()).toEqual([`${shortTerm}.json`, `${task}.json`].sort())
  // The task attribution the reference carries is preserved, so a task can read its own pending reviews.
  expect(queue.pending('t1').map(review => review.id)).toEqual([shortTerm])
  expect(queue.pending().map(review => review.id).sort()).toEqual([shortTerm, task].sort())
})

it('queues a target when only one of its two indexed sources changed, then merges affected sources and ignores a repeated same-version report', () => {
  const { queue, id } = scenario({ second: true })
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v1' })).toEqual([id])
  expect(queue.read(id).sources).toEqual([{ kind: 'event', id: 'e1', version: 'v1' }])
  expect(queue.changed({ kind: 'event', id: 'e2', version: 'v1' })).toEqual([id])
  expect(queue.read(id).sources).toEqual([
    { kind: 'event', id: 'e1', version: 'v1' },
    { kind: 'event', id: 'e2', version: 'v1' },
  ])
  expect(queue.read(id).taskIds).toEqual(['t1'])
  // The same source at the same version is not new work: no duplicate entry and no duplicate evidence.
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v1' })).toEqual([])
  expect(queue.read(id).sources).toHaveLength(2)
  // A new version updates that source's evidence once, in place.
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v2' })).toEqual([id])
  expect(queue.read(id).sources).toEqual([
    { kind: 'event', id: 'e1', version: 'v2' },
    { kind: 'event', id: 'e2', version: 'v1' },
  ])
})

it('writes an unchanged review once and resolves it, and a repeated submission of that snapshot is stale', () => {
  const { queue, id } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  const write = vi.fn()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'applied', id, snapshotId: snapshot.snapshotId })
  expect(write).toHaveBeenCalledTimes(1)
  expect(queue.read(id).status).toBe('resolved')
  expect(queue.read(id).appliedAt).toBeTruthy()
  expect(queue.pending()).toEqual([])
  expect(queue.commit(snapshot, write)).toEqual({ status: 'stale', reason: 'resolved', id, snapshotId: snapshot.snapshotId })
  expect(write).toHaveBeenCalledTimes(1)
})

it('keeps queue entries and the latest snapshot readable after a restart, and only the latest snapshot can write', () => {
  const { queue, id, deps } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const superseded = queue.snapshot(id)
  const latest = queue.snapshot(id)
  // One snapshot is kept: the newer one replaced the older, and the older ID stays stale across a restart.
  const restarted = new MemoryReviews(root, deps)
  expect(restarted.read(id).snapshot).toEqual(latest)
  expect(restarted.pending().map(review => review.id)).toEqual([id])
  const write = vi.fn()
  expect(restarted.commit(superseded, write)).toEqual({ status: 'stale', reason: 'superseded', id, snapshotId: superseded.snapshotId })
  expect(write).not.toHaveBeenCalled()
  expect(restarted.commit(latest, write).status).toBe('applied')
  expect(write).toHaveBeenCalledTimes(1)
})

it('refuses a write when one source moved, persisting a pending redo with partial scope', () => {
  const { queue, id } = scenario({ second: true })
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  queue.changed({ kind: 'event', id: 'e2', version: 'v1' })
  const snapshot = queue.snapshot(id)
  settle('event', 'e1', 'v2') // the authoritative source was rewritten after the snapshot
  const write = vi.fn()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'redo', scope: 'partial',
    affected: [{ role: 'source', kind: 'event', id: 'e1', from: 'v1', to: 'v2' }] })
  expect(write).not.toHaveBeenCalled()
  const refused = queue.read(id)
  expect(refused.status).toBe('pending')
  expect(refused.reason).toBe('redo')
  const fresh = queue.snapshot(id)
  expect(queue.commit(fresh, write).status).toBe('applied')
  expect(write).toHaveBeenCalledTimes(1)
})

it('uses the stored snapshot and clears an obsolete conflict when versions require redo', () => {
  const { queue, id } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  const write = vi.fn()
  expect(queue.commit(snapshot, write, { shortTerm: 'new', longTerm: 'old' }).status).toBe('needs_clarification')
  settle('event', 'e1', 'v2')
  snapshot.sources[0]!.version = 'v2'
  expect(queue.commit(snapshot, write).status).toBe('redo')
  expect(write).not.toHaveBeenCalled()
  expect(queue.read(id).question).toBeUndefined()
})

it('persists deferred event groups once and checks every source when only one is the anchor', () => {
  const { queue, deps } = scenario({ second: true })
  const target = { kind: 'event', id: 'e1' }
  const input = { operationId: 'late-one', target, mode: 'reselect' as const,
    sources: [{ kind: 'event', id: 'e1', version: 'v0' }, { kind: 'event', id: 'e2', version: 'v0' }] }
  const id = queue.defer(input)
  const path = join(root, 'review-queue', id + '.json')
  const before = readFileSync(path, 'utf8')
  const restarted = new MemoryReviews(root, deps)
  expect(restarted.defer(input)).toBe(id)
  expect(readFileSync(path, 'utf8')).toBe(before)
  const snapshot = restarted.snapshot(id)
  expect(snapshot.sources.map(source => source.id)).toEqual(['e1', 'e2'])
  settle('event', 'e2', 'v2')
  const write = vi.fn()
  expect(restarted.commit(snapshot, write)).toMatchObject({ status: 'redo', scope: 'partial' })
  expect(write).not.toHaveBeenCalled()
  expect(restarted.read(id).deferred).toHaveLength(1)
})

it('reports all when every source moved', () => {
  const { queue, id } = scenario({ second: true })
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  queue.changed({ kind: 'event', id: 'e2', version: 'v1' })
  const snapshot = queue.snapshot(id)
  settle('event', 'e1', 'v2')
  settle('event', 'e2', 'v2')
  const write = vi.fn()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'redo', scope: 'all', affected: [
    { role: 'source', kind: 'event', id: 'e1', from: 'v1', to: 'v2' },
    { role: 'source', kind: 'event', id: 'e2', from: 'v1', to: 'v2' },
  ] })
  expect(write).not.toHaveBeenCalled()
})

it('reports all and writes nothing when the target was hand-edited, so a new target value is never overwritten', () => {
  const { queue, id } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  settle('short-term', 's1', 'v-s1-edited', [{ kind: 'event', id: 'e1' }]) // new version, same reference
  const write = vi.fn()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'redo', scope: 'all',
    affected: [{ role: 'target', kind: 'short-term', id: 's1', part: 'sources', from: 'v-s1', to: 'v-s1-edited' }] })
  expect(write).not.toHaveBeenCalled()
  expect(queue.read(id).status).toBe('pending')
})

it('reports all when the target reference set changed even though no source version moved', () => {
  const { queue, id } = scenario({ second: true })
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  queue.changed({ kind: 'event', id: 'e2', version: 'v1' })
  const snapshot = queue.snapshot(id)
  settle('short-term', 's1', 'v-s1', [{ kind: 'event', id: 'e1' }, { kind: 'event', id: 'e3' }])
  settle('event', 'e3', 'v1')
  const write = vi.fn()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'redo', scope: 'all', affected: [
    { role: 'source', kind: 'event', id: 'e3', to: 'v1' },
    { role: 'source', kind: 'event', id: 'e2', from: 'v1' },
  ] })
  expect(write).not.toHaveBeenCalled()
})

it('persists a differing short-term and long-term pair as needs_clarification and writes nothing', () => {
  const { queue, id } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  const write = vi.fn()
  const result = queue.commit(snapshot, write, { shortTerm: '短期结果', longTerm: '长期结论' })
  expect(result).toMatchObject({ status: 'needs_clarification', id })
  expect(write).not.toHaveBeenCalled()
  const held = queue.read(id)
  expect(held.status).toBe('needs_clarification')
  expect(held.question).toBeTruthy()
  if (result.status === 'needs_clarification') expect(held.question).toBe(result.question)
  // A held review is still work to pick up, and an agreeing pair then writes.
  expect(queue.pending().map(review => review.id)).toEqual([id])
  expect(queue.commit(snapshot, write, { shortTerm: '同一版', longTerm: '同一版' }).status).toBe('applied')
  expect(write).toHaveBeenCalledTimes(1)
})

it('lets a missing authoritative read throw the commit without writing or changing the queue', () => {
  const { queue, id } = scenario({ second: true })
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  const path = join(root, 'review-queue', `${id}.json`)
  const before = readFileSync(path, 'utf8')
  files.delete(fileKey('event', 'e2'))
  const write = vi.fn()
  expect(() => queue.commit(snapshot, write)).toThrow('missing authoritative memory event:e2')
  expect(write).not.toHaveBeenCalled()
  expect(readFileSync(path, 'utf8')).toBe(before)
})

it('writes an unaffected review while another target in the same queue is refused', () => {
  const index = openIndex()
  index.rebuild([
    record('short-term', 's1', [{ kind: 'event', id: 'e1', part: 'sources', taskId: 't1' }]),
    record('short-term', 's2', [{ kind: 'event', id: 'e2', part: 'sources', taskId: 't2' }]),
  ])
  settle('short-term', 's1', 'v-s1', [{ kind: 'event', id: 'e1' }])
  settle('short-term', 's2', 'v-s2', [{ kind: 'event', id: 'e2' }])
  settle('event', 'e1', 'v1')
  settle('event', 'e2', 'v1')
  const { deps } = depsFor(index)
  const queue = new MemoryReviews(root, deps)
  const one = stableReviewId({ kind: 'short-term', id: 's1', part: 'sources' })
  const two = stableReviewId({ kind: 'short-term', id: 's2', part: 'sources' })
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  queue.changed({ kind: 'event', id: 'e2', version: 'v1' })
  const first = queue.snapshot(one)
  const second = queue.snapshot(two)
  settle('event', 'e1', 'v2')
  const write = vi.fn()
  expect(queue.commit(first, write).status).toBe('redo')
  expect(queue.commit(second, write).status).toBe('applied')
  expect(write).toHaveBeenCalledTimes(1)
})

it('reopens a resolved review only when a source reports a new version, and the old snapshot still cannot write', () => {
  const { queue, id } = scenario()
  queue.changed({ kind: 'event', id: 'e1', version: 'v1' })
  const snapshot = queue.snapshot(id)
  const write = vi.fn()
  expect(queue.commit(snapshot, write).status).toBe('applied')
  // The same version is not a change: the written review stays resolved and its snapshot stays consumed.
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v1' })).toEqual([])
  expect(queue.read(id).status).toBe('resolved')
  expect(queue.commit(snapshot, write)).toEqual({ status: 'stale', reason: 'resolved', id, snapshotId: snapshot.snapshotId })
  // A newer source version reopens the review without a snapshot; a fresh snapshot is needed before another write.
  expect(queue.changed({ kind: 'event', id: 'e1', version: 'v2' })).toEqual([id])
  const reopened = queue.read(id)
  expect(reopened.status).toBe('pending')
  expect(reopened.snapshot).toBeUndefined()
  expect(queue.commit(snapshot, write)).toEqual({ status: 'stale', reason: 'superseded', id, snapshotId: snapshot.snapshotId })
  expect(write).toHaveBeenCalledTimes(1)
})
