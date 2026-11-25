/** The review queue: a changed source enqueues the records the index reports as referencing it, and a review is written only while the target and every source still read at the versions its snapshot recorded. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { publishFile } from './files.ts'
import type { MemoryReference } from './index.ts'

/** Where one queued review stands: still to do, waiting for the caller to answer a question, or already written. */
export type ReviewStatus = 'pending' | 'needs_clarification' | 'resolved'
/** Why the queue holds the review: a source changed, or a write was refused because the snapshot no longer held. */
export type ReviewReason = 'changed' | 'redo'
/** A changed source a review depends on: its index identity plus the version reported when it changed. */
export interface MemoryReviewSource extends MemoryReference { version?: string }
/** The version of one of the target's sources as it read when the snapshot was taken. */
export interface ReviewSourceVersion { kind: string; id: string; part?: string; version: string }
/** One frozen read of the target and every source it had, so a write can never land on versions the caller never saw. */
export interface ReviewSnapshot {
  snapshotId: string
  reviewId: string
  target: MemoryReference
  targetVersion: string
  sources: ReviewSourceVersion[]
  at: string
}
/** One queued review: its stable target, the sources reported changed, the task attribution, its only snapshot and any held question. */
export interface MemoryReview {
  id: string
  target: MemoryReference
  taskIds: string[]
  status: ReviewStatus
  reason?: ReviewReason
  sources: MemoryReviewSource[]
  question?: string
  snapshot?: ReviewSnapshot
  updatedAt: string
  appliedAt?: string
  /** Organizer operations held for another judgement; their observed source versions remain evidence, never a result body. */
  deferred?: { operationId: string; mode: 'target' | 'reselect'; sources: MemoryReviewSource[] }[]
}
/** The two texts a caller wants to commit; `commit` asks instead of writing when they differ. */
export interface ReviewConflict { shortTerm: string; longTerm: string }
/** One reference whose version moved, or that joined or left the target, between the snapshot and the commit's fresh read. */
export interface ReviewAffected { role: 'target' | 'source'; kind: string; id: string; part?: string; from?: string; to?: string }
/** What a commit did: written, refused for moved versions, held for clarification, or stale because it may never write again. */
export type ReviewCommitResult =
  | { status: 'applied'; id: string; snapshotId: string }
  | { status: 'redo'; scope: 'partial' | 'all'; affected: ReviewAffected[] }
  | { status: 'needs_clarification'; id: string; question: string }
  | { status: 'stale'; reason: 'resolved' | 'superseded' | 'unknown'; id?: string; snapshotId?: string }
/** The two capabilities review needs: the index answering references, and an authoritative read of one reference. */
export interface MemoryReviewsDeps {
  usedBy(kind: string, id: string): MemoryReference[]
  read(ref: MemoryReference): { version: string; sources: MemoryReference[] }
}

/** The identity of a reference for comparing two reads: kind, id and the target-local part, never task attribution. */
const sourceKey = (reference: { kind: string; id: string; part?: string }): string =>
  JSON.stringify([reference.kind, reference.id, reference.part ?? null])
/** The same identity as a plain reference, so a result carries no more than kind, id and part. */
const identity = (reference: { kind: string; id: string; part?: string }): { kind: string; id: string; part?: string } =>
  ({ kind: reference.kind, id: reference.id, ...(reference.part === undefined ? {} : { part: reference.part }) })
/** The stable review ID of a target: `sha256` over its index kind, id and local part, so one target keeps one queue file across restarts. */
export function stableReviewId(target: MemoryReference): string {
  return createHash('sha256').update(JSON.stringify([target.kind, target.id, target.part ?? null]), 'utf8').digest('hex')
}

/**
 * The review queue at `root/review-queue`: `changed` enqueues only the records the index reports as referencing the changed
 * source, `snapshot` freezes the target and its current sources, and `commit` calls the caller's write only when the target,
 * every source and the target's own reference set still match that snapshot. One JSON file per stable target, published whole
 * with `publishFile`; there is no dependency registry, no lock and no background run.
 */
export class MemoryReviews {
  private readonly queue: string
  /** Opens the queue directory under `root`, so one target may be reviewed before anything else exists. */
  constructor(root: string, private readonly deps: MemoryReviewsDeps) {
    this.queue = join(root, 'review-queue')
    mkdirSync(this.queue, { recursive: true })
  }
  /**
   * Queues every indexed record that references `source`, merging repeated reports into the same target entry and keeping
   * the task attribution its references carry. Only `deps.usedBy` is consulted, so no memory file is read here, and a report
   * of a source and version already recorded is not new work. Returns the stable IDs whose queue file changed.
   */
  changed(source: MemoryReviewSource): string[] {
    const touched: string[] = []
    for (const reference of this.deps.usedBy(source.kind, source.id)) {
      const id = stableReviewId(reference)
      const record = this.load(id) ?? this.create(reference)
      let dirty = false
      let evidence = false
      // Task attribution is merged even when the source report itself is not new.
      for (const taskId of [reference.taskId, source.taskId]) {
        if (taskId === undefined || record.taskIds.includes(taskId)) continue
        record.taskIds.push(taskId)
        dirty = true
      }
      const known = record.sources.find(item => sourceKey(item) === sourceKey(source))
      if (known === undefined) {
        record.sources.push({ ...identity(source),
          ...(source.taskId === undefined ? {} : { taskId: source.taskId }),
          ...(source.version === undefined ? {} : { version: source.version }) })
        dirty = true
        evidence = true
      } else if (source.version !== undefined && source.version !== known.version) {
        known.version = source.version
        dirty = true
        evidence = true
      }
      if (!dirty) continue
      if (evidence) {
        if (record.status === 'resolved') {
          // New versions reopen a written review; its old snapshot may never write again.
          record.status = 'pending'
          record.snapshot = undefined
          record.appliedAt = undefined
          record.question = undefined
        }
        record.reason = 'changed'
      }
      record.updatedAt = new Date().toISOString()
      this.save(record)
      if (!touched.includes(id)) touched.push(id)
    }
    return touched
  }
  /** Persist one known late organizer result without registering another dependency graph; replaying its operation ID is a no-op. */
  defer(input: { operationId: string; target: MemoryReference; sources: MemoryReviewSource[]; mode: 'target' | 'reselect' }): string {
    const id = stableReviewId(input.target)
    const record = this.load(id) ?? this.create(input.target)
    if (record.deferred?.some(item => item.operationId === input.operationId)) return id
    record.deferred = [...(record.deferred ?? []), {
      operationId: input.operationId, mode: input.mode, sources: input.sources,
    }]
    for (const source of input.sources) {
      if (!record.sources.some(known => sourceKey(known) === sourceKey(source))) record.sources.push(source)
    }
    if (input.target.taskId !== undefined && !record.taskIds.includes(input.target.taskId))
      record.taskIds.push(input.target.taskId)
    record.status = 'pending'
    record.reason = 'redo'
    record.question = undefined
    record.snapshot = undefined
    record.appliedAt = undefined
    record.updatedAt = new Date().toISOString()
    this.save(record)
    return id
  }
  /** The reviews that still need work (pending or waiting for an answer), by stable ID; `taskId` keeps only that task's reviews. */
  pending(taskId?: string): MemoryReview[] {
    const reviews: MemoryReview[] = []
    for (const name of readdirSync(this.queue)) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const record = this.load(name.slice(0, -'.json'.length))
      if (record === undefined || record.status === 'resolved') continue
      if (taskId !== undefined && !record.taskIds.includes(taskId)) continue
      reviews.push(record)
    }
    return reviews.sort((left, right) => left.id.localeCompare(right.id))
  }
  /** The queued review with stable ID `id`; a missing or unreadable queue file throws rather than pretending there is none. */
  read(id: string): MemoryReview {
    const record = this.load(id)
    if (record === undefined) throw new Error(`no queued memory review ${id}`)
    return record
  }
  /**
   * Freezes the target and every source it currently has, replacing the entry's one snapshot, and returns that snapshot.
   * The authoritative reads happen here once; `commit` only rechecks what this snapshot recorded.
   */
  snapshot(id: string): ReviewSnapshot {
    let record = this.read(id)
    const target = this.deps.read(record.target)
    const sources: ReviewSourceVersion[] = this.sourcesFor(record, target.sources).map(source =>
      ({ ...identity(source), version: this.deps.read(source).version }))
    // Authoritative reads can themselves report newly observed versions through the shared index.
    record = this.read(id)
    const at = new Date().toISOString()
    const snapshot: ReviewSnapshot = {
      snapshotId: randomUUID(), reviewId: record.id, target: record.target,
      targetVersion: target.version, sources, at,
    }
    record.snapshot = snapshot
    record.updatedAt = at
    this.save(record)
    return snapshot
  }
  /**
   * Re-reads the target, every source it currently has and its reference set, and writes through `writeCallback` only while
   * all of them still match `snapshot`. A moved version, a changed reference set, a differing short-term/long-term pair or a
   * stale snapshot leaves the queue persisted and the callback uncalled; a written review resolves the entry so neither it
   * nor its snapshot can write twice.
   */
  commit(snapshot: ReviewSnapshot, writeCallback: () => void, conflict?: ReviewConflict): ReviewCommitResult {
    let record = this.load(snapshot.reviewId)
    if (record === undefined) return { status: 'stale', reason: 'unknown', snapshotId: snapshot.snapshotId }
    if (record.status === 'resolved') return { status: 'stale', reason: 'resolved', id: record.id, snapshotId: snapshot.snapshotId }
    if (record.snapshot === undefined || record.snapshot.snapshotId !== snapshot.snapshotId) {
      return { status: 'stale', reason: 'superseded', id: record.id, snapshotId: snapshot.snapshotId }
    }
    snapshot = record.snapshot
    const target = this.deps.read(record.target)
    const before = new Map(snapshot.sources.map(source => [sourceKey(source), source] as const))
    const after = new Map<string, { source: MemoryReference; version: string }>()
    for (const source of this.sourcesFor(record, target.sources)) after.set(sourceKey(source), { source, version: this.deps.read(source).version })
    record = this.read(record.id)
    const affected: ReviewAffected[] = []
    const targetMoved = target.version !== snapshot.targetVersion
    if (targetMoved) affected.push({ role: 'target', ...identity(record.target), from: snapshot.targetVersion, to: target.version })
    let movedSources = 0
    for (const [key, fresh] of after) {
      const earlier = before.get(key)
      if (earlier === undefined) {
        // A source the target did not have at snapshot time: the reference itself changed.
        affected.push({ role: 'source', ...identity(fresh.source), to: fresh.version })
        continue
      }
      if (earlier.version === fresh.version) continue
      movedSources += 1
      affected.push({ role: 'source', ...identity(fresh.source), from: earlier.version, to: fresh.version })
    }
    for (const [key, earlier] of before) {
      if (after.has(key)) continue
      affected.push({ role: 'source', ...identity(earlier), from: earlier.version })
    }
    const referencesChanged = before.size !== after.size || [...before.keys()].some(key => !after.has(key))
    if (targetMoved || referencesChanged || (movedSources > 0 && movedSources === before.size)) {
      this.refuse(record, 'redo')
      return { status: 'redo', scope: 'all', affected }
    }
    if (movedSources > 0) {
      this.refuse(record, 'redo')
      return { status: 'redo', scope: 'partial', affected }
    }
    if (conflict !== undefined && conflict.shortTerm !== conflict.longTerm) {
      const question = '短期与长期文本不一致：请确认以哪一版为准后再提交。'
      record.status = 'needs_clarification'
      record.question = question
      record.updatedAt = new Date().toISOString()
      this.save(record)
      return { status: 'needs_clarification', id: record.id, question }
    }
    writeCallback()
    const at = new Date().toISOString()
    record.status = 'resolved'
    record.reason = undefined
    record.question = undefined
    record.appliedAt = at
    record.updatedAt = at
    this.save(record)
    return { status: 'applied', id: record.id, snapshotId: snapshot.snapshotId }
  }
  /** A new pending review of `reference`; `changed` adds the source evidence that made it necessary. */
  private create(reference: MemoryReference): MemoryReview {
    return { id: stableReviewId(reference), target: identity(reference), taskIds: [],
      status: 'pending', reason: 'changed', sources: [], updatedAt: new Date().toISOString() }
  }
  /** Persists a refused write as pending with the redo reason, so a restart sees the decision and no old result lands. */
  private refuse(record: MemoryReview, reason: ReviewReason): void {
    record.status = 'pending'
    record.reason = reason
    record.question = undefined
    record.updatedAt = new Date().toISOString()
    this.save(record)
  }
  /** A deferred review retains every observed event, including evidence for a target entry that does not exist yet. */
  private sourcesFor(record: MemoryReview, sources: MemoryReference[]): MemoryReference[] {
    const all = [...sources, ...(record.deferred ?? []).flatMap(item => item.sources)]
    return [...new Map(all.map(source => [sourceKey(source), identity(source)])).values()]
  }
  /** Reads one queue file; a missing file is `undefined`, while invalid JSON throws instead of hiding the damage. */
  private load(id: string): MemoryReview | undefined {
    let content: string
    try {
      content = readFileSync(join(this.queue, `${id}.json`), 'utf8')
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined
      throw error
    }
    return JSON.parse(content) as MemoryReview
  }
  /** Publishes one queue file whole, so after a restart a reader sees either the earlier review or the new one. */
  private save(record: MemoryReview): void {
    publishFile(join(this.queue, `${record.id}.json`), `${JSON.stringify(record, null, 2)}\n`)
  }
}
