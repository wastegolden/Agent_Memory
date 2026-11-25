import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_MAINTENANCE_SETTINGS, MAINTENANCE_SETTINGS_KEY, MaintenanceSettings, MaintenanceSettingsSchema,
  type MaintenanceSettingsValue } from '../../src/core/adapters/maintenance-settings.ts'
import { Store } from '../../src/core/ports/kv.ts'

let directory: string
let path: string
let store: Store
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'maintenance-settings-'))
  path = join(directory, 'settings.sqlite')
  store = new Store(path)
})
afterEach(() => { store.close(); rmSync(directory, { recursive: true, force: true }) })

it('defaults the policy, validates every bound at the entry and accepts a closed sleep window', () => {
  expect(MaintenanceSettingsSchema.parse({})).toEqual(DEFAULT_MAINTENANCE_SETTINGS)
  // Maintenance and the nightly run stay off until the owner turns them on.
  expect(DEFAULT_MAINTENANCE_SETTINGS).toEqual({ enabled: false, idleMinutes: 30, reflectionMinMinutes: 60, patrolMinutes: 120,
    timeZone: 'Asia/Shanghai', sleepEnabled: false, sleepStartHour: 2, sleepEndHour: 6, dailyCalls: 24, runCalls: 8, maxOutputTokens: 16384 })
  // There is no price or cost field to configure.
  expect(Object.keys(DEFAULT_MAINTENANCE_SETTINGS)).toEqual(['enabled', 'idleMinutes', 'reflectionMinMinutes', 'patrolMinutes',
    'timeZone', 'sleepEnabled', 'sleepStartHour', 'sleepEndHour', 'dailyCalls', 'runCalls', 'maxOutputTokens'])
  for (const value of [{ idleMinutes: 0 }, { reflectionMinMinutes: 0 }, { patrolMinutes: 0 }, { dailyCalls: 0 }, { runCalls: 0 },
    { maxOutputTokens: 0 }, { sleepStartHour: -1 }, { sleepStartHour: 24 }, { sleepStartHour: 1.5 }, { sleepEndHour: 24 },
    { timeZone: 'Not/AZone' }, { enabled: 'yes' }, { sleepEnabled: 'yes' }, { unknown: true }, { pricePerCall: 1 }]) {
    expect(() => MaintenanceSettingsSchema.parse(value)).toThrow()
  }
  // Equal hours mean the sleep window is off, not a zero-hour window; the schema keeps both values.
  expect(MaintenanceSettingsSchema.parse({ sleepStartHour: 12, sleepEndHour: 12 }).sleepStartHour).toBe(12)
})

it('reads the defaults, then merges a partial update without resetting fields the patch omits', () => {
  const settings = new MaintenanceSettings(store)
  expect(settings.read()).toEqual(DEFAULT_MAINTENANCE_SETTINGS)
  expect(settings.update({ idleMinutes: 45, sleepStartHour: 22 })).toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, idleMinutes: 45, sleepStartHour: 22 })
  expect(settings.read()).toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, idleMinutes: 45, sleepStartHour: 22 })
  // The next patch keeps the earlier changes, and an explicit undefined keeps the saved value too.
  expect(settings.update({ sleepEndHour: 5, enabled: false, idleMinutes: undefined }))
    .toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, idleMinutes: 45, sleepStartHour: 22, sleepEndHour: 5, enabled: false })
  // A rejected patch is not saved.
  expect(() => settings.update({ idleMinutes: 0 })).toThrow()
  expect(() => settings.update({ timeZone: 'Not/AZone' })).toThrow()
  expect(settings.read()).toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, idleMinutes: 45, sleepStartHour: 22, sleepEndHour: 5, enabled: false })
})

it('fills defaults for a saved record that predates a field and persists the whole policy across a reopen', () => {
  store.set(MAINTENANCE_SETTINGS_KEY, { enabled: false, idleMinutes: 5 } as unknown as MaintenanceSettingsValue)
  expect(new MaintenanceSettings(store).read()).toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, enabled: false, idleMinutes: 5 })
  const saved = new MaintenanceSettings(store).update({ timeZone: 'Europe/Berlin', reflectionMinMinutes: 90, maxOutputTokens: 2048 })
  store.close()
  store = new Store(path)
  expect(new MaintenanceSettings(store).read()).toEqual(saved)
  expect(saved).toEqual({ ...DEFAULT_MAINTENANCE_SETTINGS, enabled: false, idleMinutes: 5, timeZone: 'Europe/Berlin',
    reflectionMinMinutes: 90, maxOutputTokens: 2048 })
})
