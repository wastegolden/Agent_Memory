/**
 * Idle reflection: decides whether an idle maintenance round is due, keeps the source-sequence cursor it has reflected
 * through, and records the most recent run. Settings and Store KV are its only inputs; it starts no timer, creates no
 * Session and calls no model. The caller supplies the filtered source cursor plus the live-work and last-user facts, and
 * performs the actual reflection between `started` and `completed`.
 */
import { record } from '../ports/kv.ts'
import type { MaintenanceSettings } from './maintenance-settings.ts'
import type { MaintenanceKV as Store } from '../ports/kv.ts'

/** Why an evaluation is or is not due; stable strings suitable for a log or a status view. */
export type IdleReason = 'due' | 'disabled' | 'run-active' | 'work-pending' | 'no-new-sources' | 'user-active' | 'cooldown'
/** What the caller knows when it asks whether an idle reflection is due. */
export interface IdleEvaluationInput {
  now: Date | string
  /** When the owner last spoke; only time since then, not a local clock, decides idleness. */
  lastUserAt: Date | string
  /** Whether any worker or ticket work is pending; pending work suppresses reflection. */
  hasWork: boolean
  /** The caller's filtered source sequence, with maintenance summaries already removed. This class never reads another cursor. */
  sourceSeq: number
}
/** The decision and the fixed source sequence a started round covers. */
export interface IdleEvaluation { due: boolean; reason: IdleReason; throughSeq: number }
/** Lifecycle of one idle reflection run. */
export type IdleRunState = 'running' | 'completed' | 'failed'
/** One idle reflection run: the fixed boundary it covers and how it ended. */
export interface IdleMaintenanceRun { runId: string; throughSeq: number; startedAt: string; state: IdleRunState; endedAt?: string }
/** The persisted idle-reflection state: the reflected cursor, the latest start and the latest run. */
export interface IdleMaintenanceState { lastReflectedSourceSeq: number; lastStartedAt?: string; run?: IdleMaintenanceRun }
/** Readable status: the persisted fields, returned as a copy. */
export type IdleMaintenanceStatus = IdleMaintenanceState
/** Store key of the idle-reflection state; this module is its only writer. */
export const IDLE_MAINTENANCE_KEY = record<IdleMaintenanceState>('maintenance-idle')

/**
 * Evaluates and records idle reflection. It holds one latest run, treats a `running` run as the single active one, and
 * advances the reflected cursor only when that run reports success. A failed run leaves the cursor alone; the start
 * timestamp still rate-limits the next attempt for `reflectionMinMinutes`.
 */
export class IdleMaintenance {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly settings: MaintenanceSettings) {}

  /**
   * Whether a reflection is due from the supplied facts. A disabled policy and a running round suppress everything; then
   * pending work, an already-reflected source cursor, a speaking owner inside `idleMinutes`, and a start inside
   * `reflectionMinMinutes` each suppress it in turn. `throughSeq` is the boundary a started round must cover.
   */
  evaluate(input: IdleEvaluationInput): IdleEvaluation {
    const settings = this.settings.read()
    const state = this.load()
    if (!settings.enabled) return { due: false, reason: 'disabled', throughSeq: input.sourceSeq }
    const active = state.run
    if (active?.state === 'running') return { due: false, reason: 'run-active', throughSeq: active.throughSeq }
    if (input.hasWork) return { due: false, reason: 'work-pending', throughSeq: input.sourceSeq }
    if (input.sourceSeq <= state.lastReflectedSourceSeq) return { due: false, reason: 'no-new-sources', throughSeq: input.sourceSeq }
    const now = instant(input.now).getTime()
    if (now - instant(input.lastUserAt).getTime() < settings.idleMinutes * 60_000) {
      return { due: false, reason: 'user-active', throughSeq: input.sourceSeq }
    }
    if (state.lastStartedAt !== undefined && now - instant(state.lastStartedAt).getTime() < settings.reflectionMinMinutes * 60_000) {
      return { due: false, reason: 'cooldown', throughSeq: input.sourceSeq }
    }
    return { due: true, reason: 'due', throughSeq: input.sourceSeq }
  }

  /**
   * Records the start of `runId`, fixing [`throughSeq`, `now`] as the boundary and start time of this run. A later
   * evaluation keeps returning that boundary while the run is active.
   */
  started(runId: string, throughSeq: number, now: Date | string = new Date()): IdleMaintenanceRun {
    if (runId.trim() === '') throw new Error('A run id is required')
    if (!Number.isInteger(throughSeq) || throughSeq < 0) throw new Error('throughSeq must be a non-negative integer')
    const startedAt = instant(now).toISOString()
    const run: IdleMaintenanceRun = { runId, throughSeq, startedAt, state: 'running' }
    this.store.set(IDLE_MAINTENANCE_KEY, { ...this.load(), lastStartedAt: startedAt, run })
    return run
  }

  /**
   * Finishes the matching running round. Only a success advances `lastReflectedSourceSeq`, and only as far as this
   * run's fixed `throughSeq`. Returns false when no running round has this id, including a duplicate completion.
   */
  completed(runId: string, success: boolean, now: Date | string = new Date()): boolean {
    const state = this.load()
    const run = state.run
    if (run === undefined || run.runId !== runId || run.state !== 'running') return false
    const endedAt = instant(now).toISOString()
    const finished: IdleMaintenanceRun = { ...run, state: success ? 'completed' : 'failed', endedAt }
    this.store.set(IDLE_MAINTENANCE_KEY, {
      ...state,
      lastReflectedSourceSeq: success ? Math.max(state.lastReflectedSourceSeq, run.throughSeq) : state.lastReflectedSourceSeq,
      run: finished,
    })
    return true
  }

  /** The persisted cursor, latest start and latest run; `run.state` distinguishes an active round from a finished one. */
  status(): IdleMaintenanceStatus {
    const state = this.load()
    return { ...state, ...(state.run === undefined ? {} : { run: { ...state.run } }) }
  }

  private load(): IdleMaintenanceState {
    return this.store.get(IDLE_MAINTENANCE_KEY) ?? { lastReflectedSourceSeq: 0 }
  }
}

/** Parses `value` as an instant, rejecting an invalid date instead of persisting it. */
function instant(value: Date | string): Date {
  const at = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(at.getTime())) throw new Error('A valid time is required')
  return at
}
