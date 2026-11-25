/**
 * Sleep maintenance: persists one nightly maintenance round per local night, from the configured sleep window opening to
 * its completion or interruption. It records state only; actual reflection, memory reduction and call accounting are
 * performed by the assembly that calls it. It starts no timer, creates no Session and calls no model.
 */
import { record } from '../ports/kv.ts'
import type { MaintenanceSettings, MaintenanceSettingsValue } from './maintenance-settings.ts'
import type { MaintenanceKV as Store } from '../ports/kv.ts'

/** Lifecycle of one nightly maintenance round. */
export type SleepRunState = 'sleeping' | 'completed' | 'interrupted'
/** One measured count before and after a reduction, such as a token or entry count. */
export interface SleepCount { before: number; after: number }
/** Counts recorded by a finished round, keyed by what was reduced (for example `shortTerm` and `context`). */
export type SleepCounts = Record<string, SleepCount>
/** What a finished round reports: a human-readable summary and the before/after counts it measured. */
export interface SleepResult { summary?: string; counts?: SleepCounts }
/** One night's persisted round; `night` is the local date the sleep window started on, even when it crosses midnight. */
export interface SleepRun {
  runId: string
  night: string
  state: SleepRunState
  startedAt: string
  endedAt?: string
  summary?: string
  counts?: SleepCounts
}
/** The persisted sleep state: one round per night, plus the latest round retained for status after the window closes. */
export interface SleepMaintenanceState { latest?: SleepRun; nights: Record<string, SleepRun> }
/** Store key of the sleep-maintenance state; this module is its only writer. */
export const SLEEP_MAINTENANCE_KEY = record<SleepMaintenanceState>('maintenance-sleep')

/**
 * Decides which nightly round is current, opens a stable one inside the window, and records how it ended. A round is
 * keyed by the local date the window started on, so a window crossing midnight stays one night, and a completed or
 * interrupted night is returned as it is instead of being reopened.
 */
export class SleepMaintenance {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly settings: MaintenanceSettings) {}

  /**
   * The current night's round. Inside the configured window it returns the round already opened for that night (in any
   * state) or opens `sleep-YYYY-MM-DD` with `startedAt = now`. Outside a configured window, or when sleep or maintenance
   * is disabled or both window hours are equal, it returns `undefined` and persists nothing.
   */
  evaluate(now: Date | string = new Date()): SleepRun | undefined {
    const settings = this.settings.read()
    const at = instant(now)
    const night = activeNight(settings, at)
    if (night === undefined) return undefined
    const state = this.load()
    const existing = state.nights[night]
    if (existing !== undefined) return existing
    const run: SleepRun = { runId: `sleep-${night}`, night, state: 'sleeping', startedAt: at.toISOString() }
    state.nights[night] = run
    state.latest = run
    this.store.set(SLEEP_MAINTENANCE_KEY, state)
    return run
  }

  /** Marks `runId` completed with its summary, counts and end time; `undefined` when it is not the sleeping round. */
  complete(runId: string, result: SleepResult = {}, now: Date | string = new Date()): SleepRun | undefined {
    return this.finish(runId, 'completed', result, now)
  }

  /** Marks `runId` interrupted with its summary, counts and end time; `undefined` when it is not the sleeping round. */
  interrupted(runId: string, result: SleepResult = {}, now: Date | string = new Date()): SleepRun | undefined {
    return this.finish(runId, 'interrupted', result, now)
  }

  /** The most recent round in any state, or `undefined` before the first round. */
  status(): SleepRun | undefined { return this.load().latest }

  private finish(runId: string, state: SleepRunState, result: SleepResult, now: Date | string): SleepRun | undefined {
    const persisted = this.load()
    const run = Object.values(persisted.nights).find(candidate => candidate.runId === runId)
    if (run === undefined || run.state !== 'sleeping') return undefined
    const endedAt = instant(now).toISOString()
    const finished: SleepRun = { ...run, state, endedAt,
      ...(result.summary === undefined ? {} : { summary: result.summary }),
      ...(result.counts === undefined ? {} : { counts: result.counts }) }
    persisted.nights[run.night] = finished
    persisted.latest = finished
    this.store.set(SLEEP_MAINTENANCE_KEY, persisted)
    return finished
  }

  private load(): SleepMaintenanceState {
    return this.store.get(SLEEP_MAINTENANCE_KEY) ?? { nights: {} }
  }
}

/**
 * The local night a sleep round belongs to at `at`, or `undefined` when the window is off or `at` is outside it. The
 * window is half-open; a start later than the end wraps over midnight, and the night is the local date it started on.
 */
function activeNight(settings: MaintenanceSettingsValue, at: Date): string | undefined {
  if (!settings.enabled || !settings.sleepEnabled) return undefined
  const start = settings.sleepStartHour, end = settings.sleepEndHour
  if (start === end) return undefined
  const local = localTime(settings.timeZone, at)
  if (start < end) return local.hour >= start && local.hour < end ? local.day : undefined
  if (local.hour >= start) return local.day
  if (local.hour < end) return previousDay(local.day)
  return undefined
}

/** The configured zone's local calendar day and hour for `at`. */
function localTime(timeZone: string, at: Date): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const part = (type: string): string => parts.find(item => item.type === type)?.value ?? ''
  return { day: `${part('year')}-${part('month')}-${part('day')}`, hour: Number(part('hour')) }
}

/** The local calendar day before `day` (a `YYYY-MM-DD` key), computed on the calendar rather than in a time zone. */
function previousDay(day: string): string {
  const midnight = Date.parse(`${day}T00:00:00.000Z`)
  return new Date(midnight - 86_400_000).toISOString().slice(0, 10)
}

/** Parses `value` as an instant, rejecting an invalid date instead of persisting it. */
function instant(value: Date | string): Date {
  const at = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(at.getTime())) throw new Error('A valid time is required')
  return at
}
