/** The event index at scale: a query with a fixed ten hits reads those ten event files and nothing else as the library grows. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryEvents } from '../../src/core/events.ts'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** The event identity the stream uses: event kind, source kind and source ID hashed together. */
const identity = (kind: string, source: { kind: string; id: string }): string => sha256(JSON.stringify([kind, source.kind, source.id]))
/** The event time of synthetic event `index`, all on the same first date so each file stays in one month directory. */
const at = (index: number): string => new Date(Date.UTC(2026, 10, 10, 0, 0, 0) + index * 1000).toISOString()
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/**
 * Writes `count` authoritative flat event files directly, so preparing the library is not itself the cost under test.
 * The first ten events share `taskId` and `personId` `target`; every later one has its own, so a target query has ten hits.
 */
function seed(count: number): string {
  const root = mkdtempSync(join(tmpdir(), `memory-events-${count}-`))
  roots.push(root)
  const directory = join(root, 'events', '2026-11')
  mkdirSync(directory, { recursive: true })
  for (let i = 0; i < count; i++) {
    const kind = 'worker'
    const source = { kind: 'worker-report', id: `report-${i}` }
    const event = { kind, at: at(i), text: `报告 ${i}`, source, taskId: i < 10 ? 'target' : `task-${i}`,
      personIds: [i < 10 ? 'target' : `person-${i}`] }
    const id = `20261110-${identity(kind, source)}`
    const flat = { id, seq: i + 1, createdAt: at(i), updatedAt: at(i), ...event }
    writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(flat, null, 2)}\n`, 'utf8')
  }
  return root
}

it('reads exactly the ten hit files per query at both one thousand and ten thousand events', () => {
  const eventFileReads: number[] = []
  for (const count of [1000, 10000]) {
    const events = new MemoryEvents(seed(count))
    // A damaged file added after the single startup reconcile: list reads only index hits, so it must stay unnoticed.
    const decoy = join(events.root, 'events', '2026-11', '20261110-decoy.json')
    writeFileSync(decoy, '{ broken')
    const reconcile = vi.spyOn(events, 'reconcile')
    const queries = vi.spyOn(events.index, 'queryEvents')
    const reads = vi.spyOn(events, 'get')
    const queriesToMeasure = [{ taskId: 'target' }, { personId: 'target' }, { from: at(0), to: at(9) }]
    for (const query of queriesToMeasure) {
      const started = performance.now()
      const hits = events.list(query)
      const elapsed = performance.now() - started
      // Ten fixed hits, one SQLite event query, ten event file reads, and no directory scan or reconcile.
      expect(hits.map(event => event.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      expect(queries).toHaveBeenCalledTimes(1)
      expect(reads).toHaveBeenCalledTimes(10)
      expect(reconcile).not.toHaveBeenCalled()
      eventFileReads.push(reads.mock.calls.length)
      console.log(`${count} events, ${JSON.stringify(query)}: ${hits.length} hits, ${reads.mock.calls.length} event file reads, ${elapsed.toFixed(1)} ms`)
      reads.mockClear()
      queries.mockClear()
    }
    // The decoy was never touched: no diagnostic, because no read walked the month directory.
    expect(events.index.diagnostics()).toEqual([])
    reconcile.mockRestore()
    queries.mockRestore()
    reads.mockRestore()
  }
  // The per-query file read count is the hit count at both sizes, so it does not grow with the library.
  expect(eventFileReads).toEqual([10, 10, 10, 10, 10, 10])
}, 180_000)
