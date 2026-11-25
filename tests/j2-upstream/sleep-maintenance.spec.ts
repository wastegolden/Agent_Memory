import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { MaintenanceSettings } from '../../src/core/adapters/maintenance-settings.ts'
import { SLEEP_MAINTENANCE_KEY, SleepMaintenance, type SleepCounts, type SleepRun } from '../../src/core/adapters/sleep-maintenance.ts'
import { Store } from '../../src/core/ports/kv.ts'

let directory: string
let path: string
let store: Store
let settings: MaintenanceSettings
let sleep: SleepMaintenance
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sleep-maintenance-'))
  path = join(directory, 'sleep.sqlite')
  store = new Store(path)
  settings = new MaintenanceSettings(store)
  settings.update({ enabled: true, sleepEnabled: true }) // Both are off in a new installation.
  sleep = new SleepMaintenance(store, settings)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

/** The round the next evaluation must open; fails the test instead of hiding a missing window. */
function opened(now: Date | string): SleepRun {
  const run = sleep.evaluate(now)
  if (run === undefined) throw new Error(`expected a sleep round at ${String(now)}`)
  return run
}

it('opens one stable round inside the default local sleep window and none outside it', () => {
  expect(sleep.status()).toBeUndefined()
  expect(sleep.evaluate('2026-01-01T17:59:00.000Z')).toBeUndefined() // 01:59 Asia/Shanghai
  expect(store.get(SLEEP_MAINTENANCE_KEY)).toBeUndefined()
  const run = opened('2026-01-01T18:00:00.000Z') // 02:00
  expect(run).toEqual({ runId: 'sleep-2026-01-02', night: '2026-01-02', state: 'sleeping', startedAt: '2026-01-01T18:00:00.000Z' })
  expect(sleep.evaluate('2026-01-01T21:59:00.000Z')).toEqual(run) // 05:59, the same round and start
  expect(sleep.evaluate('2026-01-01T22:00:00.000Z')).toBeUndefined() // 06:00 closes the half-open window
  expect(sleep.status()).toEqual(run)
  expect(store.get(SLEEP_MAINTENANCE_KEY)).toEqual({ latest: run, nights: { '2026-01-02': run } })
})

it('turns the window off when sleep, maintenance or a distinct hour pair is disabled', () => {
  settings.update({ sleepEnabled: false })
  expect(sleep.evaluate('2026-01-01T18:30:00.000Z')).toBeUndefined()
  settings.update({ sleepEnabled: true, enabled: false })
  expect(sleep.evaluate('2026-01-01T18:30:00.000Z')).toBeUndefined()
  settings.update({ enabled: true, sleepStartHour: 3, sleepEndHour: 3 })
  expect(sleep.evaluate('2026-01-01T19:30:00.000Z')).toBeUndefined() // 03:30
  expect(sleep.evaluate('2026-01-01T20:30:00.000Z')).toBeUndefined() // 04:30
  expect(store.get(SLEEP_MAINTENANCE_KEY)).toBeUndefined()
})

it('attributes a cross-midnight window to its start day and never reopens a finished night', () => {
  settings.update({ sleepStartHour: 22, sleepEndHour: 6 })
  expect(sleep.evaluate('2026-01-02T13:59:00.000Z')).toBeUndefined() // 21:59 on 2026-01-02
  const run = opened('2026-01-02T14:00:00.000Z') // 22:00 on 2026-01-02
  expect(run).toMatchObject({ runId: 'sleep-2026-01-02', night: '2026-01-02', state: 'sleeping' })
  expect(sleep.evaluate('2026-01-02T17:30:00.000Z')).toEqual(run) // 01:30 on 2026-01-03, still that night
  const counts: SleepCounts = { shortTerm: { before: 100, after: 40 }, context: { before: 80, after: 30 } }
  const completed = sleep.complete(run.runId, { summary: 'nightly reflection', counts }, '2026-01-02T18:00:00.000Z') // 02:00 on 2026-01-03
  expect(completed).toMatchObject({ runId: 'sleep-2026-01-02', night: '2026-01-02', state: 'completed',
    startedAt: '2026-01-02T14:00:00.000Z', endedAt: '2026-01-02T18:00:00.000Z', summary: 'nightly reflection', counts })
  expect(sleep.evaluate('2026-01-02T19:00:00.000Z')).toEqual(completed) // 03:00, the completed night is returned, not reopened
  expect(sleep.complete(run.runId)).toBeUndefined()
  expect(sleep.interrupted(run.runId)).toBeUndefined()
  expect(sleep.evaluate('2026-01-02T22:00:00.000Z')).toBeUndefined() // 06:00 on 2026-01-03
  const next = opened('2026-01-03T14:00:00.000Z') // 22:00 on 2026-01-03
  expect(next).toMatchObject({ runId: 'sleep-2026-01-03', night: '2026-01-03', state: 'sleeping' })
  const state = store.get(SLEEP_MAINTENANCE_KEY)
  expect(Object.keys(state?.nights ?? {})).toEqual(['2026-01-02', '2026-01-03'])
  expect(state?.nights['2026-01-02']?.state).toBe('completed')
})

it('records an interrupted round with summary, counts and end time, and keeps that night closed', () => {
  const run = opened('2026-01-01T18:30:00.000Z') // 02:30 on 2026-01-02
  const result = sleep.interrupted(run.runId, { summary: 'shutdown', counts: { shortTerm: { before: 10, after: 8 } } },
    '2026-01-01T18:40:00.000Z')
  expect(result).toMatchObject({ state: 'interrupted', endedAt: '2026-01-01T18:40:00.000Z', summary: 'shutdown',
    counts: { shortTerm: { before: 10, after: 8 } } })
  expect(sleep.evaluate('2026-01-01T19:00:00.000Z')).toEqual(result) // 03:00, the interrupted night does not reopen
  expect(sleep.complete(run.runId)).toBeUndefined()
  expect(sleep.status()).toEqual(result)
})

it('restores the sleeping round after a restart and completes that same round', () => {
  const run = opened('2026-01-01T18:30:00.000Z') // 02:30 on 2026-01-02
  store.close()
  store = new Store(path)
  settings = new MaintenanceSettings(store)
  sleep = new SleepMaintenance(store, settings)
  expect(sleep.evaluate('2026-01-01T19:30:00.000Z')).toEqual(run) // 03:30, same night, same run id and start
  const completed = sleep.complete(run.runId, { summary: 'done' }, '2026-01-01T20:00:00.000Z')
  expect(completed).toMatchObject({ runId: run.runId, night: '2026-01-02', state: 'completed' })
  store.close()
  store = new Store(path)
  settings = new MaintenanceSettings(store)
  sleep = new SleepMaintenance(store, settings)
  expect(sleep.status()).toEqual(completed)
  expect(sleep.evaluate('2026-01-01T21:00:00.000Z')).toEqual(completed) // 05:00, still the same night
})

it('uses the configured time zone for both the window and the night date', () => {
  settings.update({ timeZone: 'America/Los_Angeles', sleepStartHour: 22, sleepEndHour: 6 })
  expect(sleep.evaluate('2026-01-03T05:59:00.000Z')).toBeUndefined() // 21:59 on 2026-01-02 PST
  const run = opened('2026-01-03T06:00:00.000Z') // 22:00 on 2026-01-02 PST, already 2026-01-03 in UTC
  expect(run).toMatchObject({ runId: 'sleep-2026-01-02', night: '2026-01-02', state: 'sleeping' })
  expect(sleep.evaluate('2026-01-03T09:30:00.000Z')).toEqual(run) // 01:30 on 2026-01-03 PST, the same night
  expect(sleep.evaluate('2026-01-03T14:00:00.000Z')).toBeUndefined() // 06:00 on 2026-01-03 PST
})
