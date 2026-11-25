/** The document library: local originals indexed into memory, plus create and download requests that wait for a user's approval. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemoryIndex } from './index.ts'
import { MemoryStore, type MemoryIndexItem, type MemoryRecord, type MemorySource } from './store.ts'

/** A document a user asks for: a new local file with its content, or a download of a URL. */
export type DocumentRequestInput =
  | { kind: 'create'; path: string; content: string; category: 'formal' | 'internal' }
  | { kind: 'download'; path: string; url: string; category: 'formal' | 'internal' }
/** A request saved before approval, pending until a user's web message completes or rejects it. */
export type DocumentRequest = DocumentRequestInput & {
  id: string
  createdAt: string
  status: 'pending' | 'completed' | 'rejected'
  triggerId?: string
  documentId?: string
}

/** The formal and internal document library under memory root `root`, with the requests awaiting approval in `document-requests`. */
export class Documents {
  private readonly store: MemoryStore
  private readonly requests: string
  /**
   * Opens the library at absolute `root`, creating the document memory library and the request directory; a supplied
   * index is the memory module's shared one, so documents are located through the same metadata as every other library.
   * @throws When `root` is not absolute.
   */
  constructor(root: string, index?: MemoryIndex) {
    this.store = new MemoryStore(root, index ? { index } : {})
    this.requests = join(root, 'document-requests')
    mkdirSync(this.requests, { recursive: true })
  }
  /**
   * Reads the UTF-8 text at absolute `path` and saves it in the `documents` library, sourced from that path under kind
   * `document-formal` or `document-internal`; indexing the same source again keeps its ID and refreshes content and version.
   */
  indexFile(path: string, category: 'formal' | 'internal'): MemoryRecord {
    const content = readFileSync(path, 'utf8')
    const source: MemorySource = { kind: category === 'formal' ? 'document-formal' : 'document-internal', id: path, path }
    const [indexed] = this.store.findBySource({ kind: source.kind, id: source.id })
    return this.store.put('documents', { id: indexed?.id, source, content })
  }
  /**
   * Reads record `id` with the current text of its original file; an original edited after indexing updates the memory
   * content, version and updatedAt on this read.
   * @throws When the original file no longer exists.
   */
  read(id: string): MemoryRecord {
    const record = this.store.get('documents', id)
    const content = readFileSync(record.source.path!, 'utf8')
    return content === record.content ? record : this.store.put('documents', { id, source: record.source, content })
  }
  /** Index items for documents whose source path or latest original text contains `query`, after reading each original. */
  search(query: string): MemoryIndexItem[] {
    return this.store.list('documents').flatMap((record): MemoryIndexItem[] => {
      const latest = this.read(record.id)
      const path = latest.source.path!
      return path.includes(query) || latest.content.includes(query)
        ? [{ library: 'documents', id: latest.id, version: latest.version }]
        : []
    })
  }
  /** Saves `input` as a pending request under `document-requests` and returns it; no file is created or downloaded yet. */
  propose(input: DocumentRequestInput): DocumentRequest {
    const request: DocumentRequest = { ...input, id: randomUUID(), createdAt: new Date().toISOString(), status: 'pending' }
    this.save(request)
    return request
  }
  /** The requests still waiting for approval, oldest first. */
  pending(): DocumentRequest[] {
    return readdirSync(this.requests).filter(name => name.endsWith('.json'))
      .map(name => this.request(name.slice(0, -'.json'.length)))
      .filter(request => request.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  /**
   * Executes pending request `id` after the user's web message `triggerId` approved it: a create writes its content to a
   * new file, a download fetches its URL and writes the response text, then either indexes that file and is marked completed.
   * @throws When the request is not pending, a create target already exists, or a download response is not HTTP success.
   */
  async complete(id: string, triggerId: string): Promise<MemoryRecord> {
    const request = this.request(id)
    if (request.status !== 'pending') throw new Error(`Document request is not pending: ${id}`)
    if (request.kind === 'create') {
      mkdirSync(dirname(request.path), { recursive: true })
      writeFileSync(request.path, request.content, { encoding: 'utf8', flag: 'wx' })
    } else {
      const response = await fetch(request.url)
      if (!response.ok) throw new Error(`Document download failed with HTTP ${response.status}: ${request.url}`)
      const content = await response.text()
      mkdirSync(dirname(request.path), { recursive: true })
      writeFileSync(request.path, content, { encoding: 'utf8', flag: 'wx' })
    }
    const document = this.indexFile(request.path, request.category)
    this.save({ ...request, status: 'completed', triggerId, documentId: document.id })
    return document
  }
  /** Marks request `id` rejected for the user's web message `triggerId`; no file is created or downloaded. */
  reject(id: string, triggerId: string): void {
    this.save({ ...this.request(id), status: 'rejected', triggerId })
  }
  /** The request saved under `id` in `document-requests`. */
  private request(id: string): DocumentRequest {
    return JSON.parse(readFileSync(join(this.requests, `${id}.json`), 'utf8')) as DocumentRequest
  }
  /** Saves `request` as its human-readable JSON file, replacing the earlier state of the same request. */
  private save(request: DocumentRequest): void {
    writeFileSync(join(this.requests, `${request.id}.json`), `${JSON.stringify(request, null, 2)}\n`, 'utf8')
  }
}
