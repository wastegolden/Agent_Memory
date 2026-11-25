/** A real Node child process for the S3-2 organizer crash test: it records source events, starts one pass, and blocks after the requested remember write until the parent kills it. */
import { writeFileSync } from 'node:fs'

const moduleUrl = (name) => new URL(`../../../src/core/${name}`, import.meta.url).href
const { MemoryEvents } = await import(moduleUrl('events.ts'))
const { TaskLists } = await import(moduleUrl('task-lists.ts'))
const { ShortTerm } = await import(moduleUrl('short-term.ts'))
const { PersonCards } = await import(moduleUrl('people.ts'))
const { MemoryChanges } = await import(moduleUrl('changes.ts'))
const { MemoryOrganizer } = await import(moduleUrl('organizer.ts'))

const root = process.env.MEMORY_ORGANIZER_ROOT
const ready = process.env.MEMORY_ORGANIZER_READY
const mode = process.env.MEMORY_ORGANIZER_MODE
if (root === undefined || ready === undefined || mode === undefined) {
  throw new Error('the organizer child needs MEMORY_ORGANIZER_ROOT, MEMORY_ORGANIZER_READY and MEMORY_ORGANIZER_MODE')
}
if (mode !== 'after-first' && mode !== 'after-last') throw new Error(`Unknown organizer child mode: ${mode}`)

const events = new MemoryEvents(root)
const tasks = new TaskLists(root, () => undefined)
const shortTerm = new ShortTerm(root, tasks)
const people = new PersonCards(root, events)
const changes = new MemoryChanges(root, events)
const first = events.record({ kind: 'user', at: '2026-11-10T00:00:00.000Z', text: '第一条事实',
  source: { kind: 'web-message', id: 'organizer-child-1' } })
const second = events.record({ kind: 'jarvis', at: '2026-11-10T00:00:01.000Z', text: '第二条事实',
  source: { kind: 'web-message', id: 'organizer-child-2' } })

const pause = () => {
  writeFileSync(ready, 'ready')
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000)
}
let writes = 0
const shortTermProxy = {
  list: () => shortTerm.list(),
  remember: (input, internalId) => {
    const view = shortTerm.remember(input, internalId)
    writes += 1
    if (writes === (mode === 'after-first' ? 1 : 2)) pause()
    return view
  },
}
const organizer = new MemoryOrganizer(root, { events, shortTerm: shortTermProxy, changes, people, tasks,
  select: async () => ({ items: [
    { kind: 'agreement', text: '约定一', eventIds: [first.id] },
    { kind: 'experience', text: '经验二', eventIds: [second.id] },
  ], changes: [] }) }, { threshold: 1, batchSize: 10 })
await organizer.organize({ reason: 'idle' })
