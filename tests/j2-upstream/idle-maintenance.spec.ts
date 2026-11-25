import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { IDLE_MAINTENANCE_KEY, IdleMaintenance } from '../../src/core/adapters/idle-maintenance.ts'
import { MaintenanceSettings } from '../../src/core/adapters/maintenance-settings.ts'
import { Store } from '../../src/core/ports/kv.ts'

const MINUTE = 60_000
let directory: string
let path: string
let store: Store
let settings: MaintenanceSettings
let idle: IdleMaintenance
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'idle-maintenance-'))
  path = join(directory, 'idle.sqlite')
  store = new Store(path)
  settings = new MaintenanceSettings(store)
  settings.update({ enabled: true }) // Off in a new installation.
  idle = new IdleMaintenance(store, settings)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('requires a silent owner, no pending work and a new filtered source before it is due', () => {
  const lastUserAt = new Date('2026-01-01T00:00:00.000Z')
  expect(idle.evaluate({ now: lastUserAt, lastUserAt, hasWork: false, sourceSeq: 0 }))
    .toEqual({ due: false, reason: 'no-new-sources', throughSeq: 0 })
  expect(idle.evaluate({ now: new Date(lastUserAt.getTime() + 30 * MINUTE - 1), lastUserAt, hasWork: false, sourceSeq: 1 }))
    .toEqual({ due: false, reason: 'user-active', throughSeq: 1 })
  const idleAt = new Date(lastUserAt.getTime() + 30 * MINUTE)
  expect(idle.evaluate({ now: idleAt, lastUserAt, hasWork: false, sourceSeq: 1 }))
    .toEqual({ due: true, reason: 'due', throughSeq: 1 })
  expect(idle.evaluate({ now: idleAt, lastUserAt, hasWork: true, sourceSeq: 1 }))
    .toEqual({ due: false, reason: 'work-pending', throughSeq: 1 })
  settings.update({ enabled: false })
  expect(idle.evaluate({ now: idleAt, lastUserAt, hasWork: false, sourceSeq: 1 }))
    .toEqual({ due: false, reason: 'disabled', throughSeq: 1 })
  // Evaluation is a pure read: it persists no state of its own.
  expect(store.get(IDLE_MAINTENANCE_KEY)).toBeUndefined()
})

it('measures the silent interval in real elapsed time across midnight', () => {
  const lastUserAt = new Date('2026-01-01T23:40:00.000Z')
  expect(idle.evaluate({ now: new Date('2026-01-02T00:09:59.999Z'), lastUserAt, hasWork: false, sourceSeq: 1 }).reason).toBe('user-active')
  expect(idle.evaluate({ now: new Date('2026-01-02T00:10:00.000Z'), lastUserAt, hasWork: false, sourceSeq: 1 }))
    .toEqual({ due: true, reason: 'due', throughSeq: 1 })
})

it('fixes the boundary at start, blocks a second run and advances the cursor only on success', () => {
  const lastUserAt = new Date('2026-01-01T00:00:00.000Z')
  const at = new Date('2026-01-01T01:00:00.000Z')
  expect(idle.evaluate({ now: at, lastUserAt, hasWork: false, sourceSeq: 3 }))
    .toEqual({ due: true, reason: 'due', throughSeq: 3 })
  const run = idle.started('idle-1', 3, at)
  expect(run).toEqual({ runId: 'idle-1', throughSeq: 3, startedAt: at.toISOString(), state: 'running' })
  expect(idle.status()).toEqual({ lastReflectedSourceSeq: 0, lastStartedAt: at.toISOString(), run })
  // A raised cursor during the run neither changes the fixed boundary nor starts another round.
  expect(idle.evaluate({ now: new Date(at.getTime() + 10 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 9 }))
    .toEqual({ due: false, reason: 'run-active', throughSeq: 3 })
  expect(idle.completed('other-run', true)).toBe(false)
  expect(idle.completed('idle-1', true, new Date(at.getTime() + 20 * MINUTE))).toBe(true)
  expect(idle.status()).toEqual({
    lastReflectedSourceSeq: 3,
    lastStartedAt: at.toISOString(),
    run: { runId: 'idle-1', throughSeq: 3, startedAt: at.toISOString(), state: 'completed',
      endedAt: new Date(at.getTime() + 20 * MINUTE).toISOString() },
  })
  expect(store.get(IDLE_MAINTENANCE_KEY)).toMatchObject({ lastReflectedSourceSeq: 3, run: { throughSeq: 3 } })
  expect(idle.completed('idle-1', true)).toBe(false)
  // Covered sources stop being new; a cursor past this run's boundary still is, but the start interval gates it.
  expect(idle.evaluate({ now: new Date(at.getTime() + 21 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 3 }).reason).toBe('no-new-sources')
  expect(idle.evaluate({ now: new Date(at.getTime() + 59 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 9 }))
    .toEqual({ due: false, reason: 'cooldown', throughSeq: 9 })
  expect(idle.evaluate({ now: new Date(at.getTime() + 60 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 9 }))
    .toEqual({ due: true, reason: 'due', throughSeq: 9 })
})

it('records a failed round without advancing the cursor and still applies the start interval', () => {
  const lastUserAt = new Date('2026-01-01T00:00:00.000Z')
  const at = new Date('2026-01-01T01:00:00.000Z')
  idle.started('idle-1', 4, at)
  expect(idle.completed('idle-1', false, new Date(at.getTime() + MINUTE))).toBe(true)
  expect(idle.status()).toMatchObject({ lastReflectedSourceSeq: 0, run: { runId: 'idle-1', state: 'failed' } })
  expect(idle.evaluate({ now: new Date(at.getTime() + 30 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 4 }))
    .toEqual({ due: false, reason: 'cooldown', throughSeq: 4 })
  const retryAt = new Date(at.getTime() + 60 * MINUTE)
  expect(idle.evaluate({ now: retryAt, lastUserAt, hasWork: false, sourceSeq: 5 }))
    .toEqual({ due: true, reason: 'due', throughSeq: 5 })
  idle.started('idle-2', 5, retryAt)
  expect(idle.completed('idle-2', true, new Date(retryAt.getTime() + MINUTE))).toBe(true)
  expect(idle.status()).toMatchObject({ lastReflectedSourceSeq: 5, run: { runId: 'idle-2', state: 'completed' } })
})

it('restores the cursor and an unfinished run across a restart', () => {
  const lastUserAt = new Date('2026-01-01T00:00:00.000Z')
  const at = new Date('2026-01-01T01:00:00.000Z')
  const run = idle.started('idle-1', 6, at)
  store.close()
  store = new Store(path)
  settings = new MaintenanceSettings(store)
  idle = new IdleMaintenance(store, settings)
  expect(idle.status()).toEqual({ lastReflectedSourceSeq: 0, lastStartedAt: at.toISOString(), run })
  expect(idle.evaluate({ now: new Date(at.getTime() + 120 * MINUTE), lastUserAt, hasWork: false, sourceSeq: 20 }))
    .toEqual({ due: false, reason: 'run-active', throughSeq: 6 })
  expect(idle.completed('idle-1', true, new Date(at.getTime() + 121 * MINUTE))).toBe(true)
  expect(idle.status().lastReflectedSourceSeq).toBe(6)
})
