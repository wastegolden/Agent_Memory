/**
 * Maintenance policy: whether the agent maintains itself on its own, the intervals that pace idle reflection and patrol,
 * the local sleep window, and the call and output-token ceilings one maintenance run may spend. It is persisted policy
 * only: it starts no timer, creates no Session and calls no model.
 */
import { z } from 'zod'
import { record } from '../ports/kv.ts'
import type { MaintenanceKV as Store } from '../ports/kv.ts'

/** Whether `value` names a real IANA time zone, checked once at the schema entry rather than on every read. */
function realTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value })
    return true
  } catch { return false }
}

/**
 * The maintenance policy. `idleMinutes` is how long the owner must be silent before an idle reflection may start, and
 * `reflectionMinMinutes` is the shortest interval between two starts. `patrolMinutes` paces project patrols. The sleep
 * window is the local half-open interval [`sleepStartHour`, `sleepEndHour`) in `timeZone`; equal hours turn the window
 * off, and a start later than the end crosses midnight. `dailyCalls`, `runCalls` and `maxOutputTokens` cap one day and
 * one run. It intentionally carries no price or cost fields. Maintenance and the nightly sleep run are both off until the
 * owner turns them on: an installation never starts long-running upkeep of its own accord.
 */
export const MaintenanceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  idleMinutes: z.number().int().min(1).default(30),
  reflectionMinMinutes: z.number().int().min(1).default(60),
  patrolMinutes: z.number().int().min(1).default(120),
  timeZone: z.string().trim().min(1).refine(realTimeZone, 'A real IANA time zone is required').default('Asia/Shanghai'),
  sleepEnabled: z.boolean().default(false),
  sleepStartHour: z.number().int().min(0).max(23).default(2),
  sleepEndHour: z.number().int().min(0).max(23).default(6),
  dailyCalls: z.number().int().min(1).default(24),
  runCalls: z.number().int().min(1).default(8),
  maxOutputTokens: z.number().int().min(1).default(16384),
}).strict()
/** A validated maintenance policy, as read from the Store and used by the maintenance classes. */
export type MaintenanceSettingsValue = z.infer<typeof MaintenanceSettingsSchema>
/** The policy an installation has before the owner changes any of it. */
export const DEFAULT_MAINTENANCE_SETTINGS: MaintenanceSettingsValue = MaintenanceSettingsSchema.parse({})
/** A partial change: only the fields present in the patch change; every other field keeps its saved value. */
export type MaintenanceSettingsPatch = Partial<MaintenanceSettingsValue>

/** Store key of the maintenance policy; this module is its only writer. */
export const MAINTENANCE_SETTINGS_KEY = record<MaintenanceSettingsValue>('maintenance-settings')

/**
 * Reads and partially updates the persisted maintenance policy. `update` validates the merged value once on the way in,
 * so a rejected patch leaves the saved policy untouched. It reads and writes one KV record and holds no state itself.
 */
export class MaintenanceSettings {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>) {}

  /** The saved policy, filled with defaults for any field a record saved before that field existed lacks. */
  read(): MaintenanceSettingsValue {
    const saved = this.store.get(MAINTENANCE_SETTINGS_KEY)
    return saved === undefined ? { ...DEFAULT_MAINTENANCE_SETTINGS } : { ...DEFAULT_MAINTENANCE_SETTINGS, ...saved }
  }

  /**
   * Merges `patch` into the saved policy, validates the result once and saves the whole policy. A field absent from the
   * patch, or explicitly `undefined`, keeps its saved value instead of falling back to a schema default.
   */
  update(patch: MaintenanceSettingsPatch): MaintenanceSettingsValue {
    const merged: Record<string, unknown> = { ...this.read() }
    for (const [name, value] of Object.entries(patch)) if (value !== undefined) merged[name] = value
    const settings = MaintenanceSettingsSchema.parse(merged)
    this.store.set(MAINTENANCE_SETTINGS_KEY, settings)
    return settings
  }
}
