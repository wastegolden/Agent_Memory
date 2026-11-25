import { DatabaseSync } from 'node:sqlite'
export type Key<V> = string & { readonly __value?: V }
export const record = <V>(key: string) => key as Key<V>
export interface MaintenanceKV { get<V>(key: Key<V>): V | undefined; set<V>(key: Key<V>, value: V): void }
/** Local durable KV port for standalone policy/cursor tests; not a scheduler. */
export class Store implements MaintenanceKV {
  private readonly db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  }
  get<V>(key: Key<V>): V | undefined {
    const row=this.db.prepare('SELECT value FROM state WHERE key = ?').get(key)
    return row ? JSON.parse(String(row.value)) as V : undefined
  }
  set<V>(key: Key<V>, value: V): void {
    this.db.prepare('INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key,JSON.stringify(value))
  }
  close(): void { this.db.close() }
}
