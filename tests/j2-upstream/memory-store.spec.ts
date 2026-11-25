/** The file-backed memory store: four independent libraries, index-backed source lookup, versions that follow edited content, reopen persistence and Chinese names. */
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryEvents } from '../../src/core/events.ts'
import { MemoryIndex } from '../../src/core/index.ts'
import { MemoryStore, memoryPath, type MemoryLibrary, type MemorySource } from '../../src/core/store.ts'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const libraries: MemoryLibrary[] = ['events', 'tasks', 'documents', 'experiences']
let directory: string
/** An absolute store root under a Chinese directory name, in directories that do not exist yet. */
let root: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'memory-store-'))
  root = join(directory, '记忆', 'memory')
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })
/** The JSON file a record is stored in. */
const recordFile = (library: MemoryLibrary, id: string): string => join(root, library, `${id}.json`)

describe('four libraries', () => {
  it('stores the same ID in each library as its own record and reads each library on its own', () => {
    const store = new MemoryStore(root)
    const contents: Record<MemoryLibrary, string> = { events: '一次事件事实。', tasks: '一份归档任务。', documents: '一份文档。', experiences: '一条经验。' }
    const sources: Record<MemoryLibrary, MemorySource> = {
      events: { kind: 'chat', id: 'm1' },
      tasks: { kind: 'ticket', id: 't1', path: 'tickets/t1.md' },
      documents: { kind: 'file', id: 'readme', path: '文档/readme.md' },
      experiences: { kind: 'ticket', id: 't2' },
    }
    for (const library of libraries) store.put(library, { id: 'same', source: sources[library], content: contents[library] })
    for (const library of libraries) {
      expect(store.get(library, 'same')).toMatchObject({ id: 'same', content: contents[library], source: sources[library] })
      expect(store.list(library).map(record => record.id)).toEqual(['same'])
      // Each library is its own directory holding one human-readable JSON file and no publication temporary.
      expect(readdirSync(join(root, library))).toEqual(['same.json'])
      expect(JSON.parse(readFileSync(recordFile(library, 'same'), 'utf8'))).toMatchObject({ id: 'same', content: contents[library] })
    }
    // The four records are different even though they share an ID.
    expect(new Set(libraries.map(library => store.get(library, 'same').content)).size).toBe(4)
  })

  it('keeps every library when the store is reopened', () => {
    const first = new MemoryStore(root)
    const event = first.put('events', { id: 'evt-1', source: { kind: 'chat', id: 'm1' }, content: '重开后还在。' })
    const experience = first.put('experiences', { source: { kind: 'ticket', id: 't9' }, content: '内部生成 ID 的经验。' })
    expect(experience.id).not.toBe('')
    expect(existsSync(recordFile('experiences', experience.id))).toBe(true)
    const reopened = new MemoryStore(root)
    expect(reopened.get('events', 'evt-1')).toEqual(event)
    expect(reopened.get('experiences', experience.id)).toEqual(experience)
    expect(reopened.list('documents')).toEqual([])
    expect(reopened.list('tasks')).toEqual([])
  })
})

describe('versions and updates', () => {
  it('writes a content version and keeps createdAt while a repeated put changes updatedAt and version', () => {
    const store = new MemoryStore(root)
    const first = store.put('documents', { id: 'doc-1', source: { kind: 'file', id: 'readme' }, content: '第一版文档。' })
    expect(first).toMatchObject({ id: 'doc-1', version: sha256('第一版文档。'), content: '第一版文档。' })
    expect(first.version).toMatch(/^[0-9a-f]{64}$/)
    expect(Number.isFinite(Date.parse(first.createdAt))).toBe(true)
    expect(Number.isFinite(Date.parse(first.updatedAt))).toBe(true)
    // Pretend the first save is old, so preserving its createdAt is observable even within the same millisecond.
    const stored = JSON.parse(readFileSync(recordFile('documents', 'doc-1'), 'utf8'))
    stored.createdAt = '2026-01-01T00:00:00.000Z'
    writeFileSync(recordFile('documents', 'doc-1'), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
    const updated = store.put('documents', { id: 'doc-1', source: { kind: 'file', id: 'readme', path: 'docs/readme.md' }, content: '第二版文档。' })
    expect(updated.createdAt).toBe('2026-01-01T00:00:00.000Z')
    expect(updated.updatedAt).not.toBe('2026-01-01T00:00:00.000Z')
    expect(updated.version).toBe(sha256('第二版文档。'))
    expect(updated.version).not.toBe(first.version)
    expect(updated.source).toEqual({ kind: 'file', id: 'readme', path: 'docs/readme.md' })
    expect(store.get('documents', 'doc-1')).toEqual(updated)
  })

  it('sees content edited by hand on the next read, in get, list and the source index', () => {
    const store = new MemoryStore(root)
    const saved = store.put('events', { id: 'evt-1', source: { kind: 'chat', id: 'm1' }, content: '原始事件。' })
    const file = recordFile('events', 'evt-1')
    const edited = JSON.parse(readFileSync(file, 'utf8'))
    edited.content = '人工改过的事件。'
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
    const read = store.get('events', 'evt-1')
    expect(read.content).toBe('人工改过的事件。')
    expect(read.version).toBe(sha256('人工改过的事件。'))
    expect(read.version).not.toBe(saved.version)
    expect(store.list('events').map(record => record.version)).toEqual([sha256('人工改过的事件。')])
    expect(store.findBySource({ kind: 'chat', id: 'm1' })).toEqual([{ library: 'events', id: 'evt-1', version: sha256('人工改过的事件。') }])
  })
})

describe('index-backed source lookup', () => {
  it('finds matching sources across libraries and locates the original content', () => {
    const store = new MemoryStore(root)
    const event = store.put('events', { id: 'evt-1', source: { kind: 'chat', id: 'msg-9' }, content: '聊天里的那句话。' })
    const task = store.put('tasks', { id: 'task-1', source: { kind: 'chat', id: 'msg-9', path: 'chat/msg-9.md' }, content: '由那条消息归档的任务。' })
    const document = store.put('documents', { id: 'doc-9', source: { kind: 'file', id: 'design.md', path: '资料/设计.md' }, content: '设计文档。' })
    // The same source ID under another kind, and another ID under the same kind, are not matches.
    store.put('experiences', { id: 'exp-1', source: { kind: 'ticket', id: 'msg-9' }, content: '不同来源。' })
    store.put('experiences', { id: 'exp-2', source: { kind: 'chat', id: 'other' }, content: '不同消息。' })
    expect(store.findBySource({ kind: 'chat', id: 'msg-9' })).toEqual([
      { library: 'events', id: 'evt-1', version: event.version },
      { library: 'tasks', id: 'task-1', version: task.version },
    ])
    expect(store.findBySource({ kind: 'file', id: 'design.md' })).toEqual([{ library: 'documents', id: 'doc-9', version: document.version }])
    expect(store.findBySource({ kind: 'chat', id: 'missing' })).toEqual([])
    // An index item locates the original.
    const [hit] = store.findBySource({ kind: 'file', id: 'design.md' })
    expect(store.get(hit!.library, hit!.id).content).toBe('设计文档。')
  })

  it('keeps findBySource results in memoryLibraries order whatever order the index returns', () => {
    const store = new MemoryStore(root)
    for (const library of libraries) store.put(library, { id: 'same', source: { kind: 'chat', id: 'm1' }, content: `${library} 的内容。` })
    expect(store.findBySource({ kind: 'chat', id: 'm1' }).map(item => item.library))
      .toEqual(['events', 'tasks', 'documents', 'experiences'])
  })

  it('answers source lookup from the index itself, without listing the library directories', () => {
    const index = new MemoryIndex(root, { memory: true })
    const store = new MemoryStore(root, { index })
    const saved = store.put('documents', { id: 'doc-1', source: { kind: 'file', id: 'readme' }, content: '正文。' })
    const lookup = vi.spyOn(index, 'findBySource')
    expect(store.findBySource({ kind: 'file', id: 'readme' })).toEqual([{ library: 'documents', id: 'doc-1', version: saved.version }])
    expect(lookup).toHaveBeenCalledWith({ kind: 'file', id: 'readme' })
    lookup.mockRestore()
  })

  it('shares one index with the event stream, mapping application events to the events library', () => {
    const index = new MemoryIndex(root)
    const events = new MemoryEvents(root, index)
    try {
      const event = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '共享索引中的事件',
        source: { kind: 'web-message', id: 'shared' } })
      const document = events.store.put('documents', { id: 'doc-1', source: { kind: 'web-message', id: 'shared' }, content: '同一来源的文档。' })
      expect(events.store.findBySource({ kind: 'web-message', id: 'shared' })).toEqual([
        { library: 'events', id: event.id, version: event.version },
        { library: 'documents', id: 'doc-1', version: document.version },
      ])
      // The compatibility source every returned event carries is indexed too.
      expect(index.findBySource({ kind: 'event-user', id: 'shared' }).map(hit => hit.id)).toEqual([event.id])
    } finally { index.close() }
  })
})

describe('generic library files', () => {
  it('scans only the library roots on open, isolating damaged files and never treating event month files as generic records', () => {
    const events = new MemoryEvents(root)
    events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '月份目录中的事件',
      source: { kind: 'web-message', id: 'm1' } })
    const broken = join(root, 'documents', 'broken.json')
    writeFileSync(broken, '{ not json')
    writeFileSync(join(root, 'documents', '.doc.json.123.456.tmp'), '{"id":"temporary"}', 'utf8')
    const index = new MemoryIndex(root, { memory: true })
    const store = new MemoryStore(root, { index })
    expect(store.list('events')).toEqual([])
    expect(store.list('documents')).toEqual([])
    expect(index.diagnostics()).toEqual([{ path: broken, reason: expect.any(String) }])
    // A repaired file is read again and loses its diagnostic.
    writeFileSync(broken, `${JSON.stringify({ id: 'broken', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'file', id: 'a' }, content: '修好了。' }, null, 2)}\n`, 'utf8')
    expect(store.list('documents')).toEqual([{ id: 'broken', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z', source: { kind: 'file', id: 'a' }, version: sha256('修好了。'), content: '修好了。' }])
    expect(index.diagnostics()).toEqual([])
  })

  it('refreshes a hand-edited generic record\'s source and version when a lookup reads it', () => {
    const index = new MemoryIndex(root, { memory: true })
    const store = new MemoryStore(root, { index })
    const saved = store.put('documents', { id: 'doc-1', source: { kind: 'file', id: 'a' }, content: '正文。' })
    const edited = JSON.parse(readFileSync(recordFile('documents', 'doc-1'), 'utf8'))
    edited.source = { kind: 'file', id: 'b' }
    writeFileSync(recordFile('documents', 'doc-1'), `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
    // A lookup by the old source rereads the hit, sees the new source, and the index now knows the new one.
    expect(store.findBySource({ kind: 'file', id: 'a' })).toEqual([])
    expect(store.findBySource({ kind: 'file', id: 'b' })).toEqual([{ library: 'documents', id: 'doc-1', version: saved.version }])
    expect(index.get('documents', 'doc-1')?.sources).toEqual([{ kind: 'file', id: 'b' }])
    // get reports the edited content version as well.
    edited.content = '手改正文。'
    writeFileSync(recordFile('documents', 'doc-1'), `${JSON.stringify(edited, null, 2)}\n`, 'utf8')
    expect(store.get('documents', 'doc-1')).toMatchObject({ source: { kind: 'file', id: 'b' }, content: '手改正文。',
      version: sha256('手改正文。') })
  })

  it('keeps plain generic records in the root libraries beside the event month files', () => {
    const events = new MemoryEvents(root)
    const plain = events.store.put('events', { id: 'record-1', source: { kind: 'chat', id: 'm1' }, content: 'plain' })
    expect(existsSync(join(root, 'events', 'record-1.json'))).toBe(true)
    expect(events.store.get('events', 'record-1')).toEqual(plain)
    expect(events.list()).toEqual([])
    const event = events.record({ kind: 'user', at: '2026-11-10T00:00:00Z', text: '应用事件',
      source: { kind: 'web-message', id: 'm1' } })
    expect(events.store.list('events').map(record => record.id)).toEqual(['record-1'])
    expect(events.list().map(record => record.id)).toEqual([event.id])
  })
})

describe('Chinese content and paths', () => {
  it('stores Chinese content and Chinese file names as readable JSON under a Chinese directory', () => {
    const store = new MemoryStore(root)
    const saved = store.put('documents', { id: '设计', source: { kind: 'file', id: '设计.md', path: '资料/设计.md' }, content: '第一行。\n第二行。' })
    const file = recordFile('documents', '设计')
    expect(file).toContain('记忆')
    expect(existsSync(file)).toBe(true)
    const raw = readFileSync(file, 'utf8')
    expect(raw.trim().split('\n').length).toBeGreaterThan(5)
    expect(raw).toContain('"content"')
    expect(raw).toContain('设计.md')
    expect(JSON.parse(raw)).toEqual(saved)
    expect(store.get('documents', '设计').content).toBe('第一行。\n第二行。')
    expect(store.list('documents').map(record => record.id)).toEqual(['设计'])
  })

  it('names the memory directory beside the state file', () => {
    expect(memoryPath(join(directory, '状态', 'state.sqlite'))).toBe(join(directory, '状态', 'memory'))
  })
})
