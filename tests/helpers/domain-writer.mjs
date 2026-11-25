import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { openDatabase } from '../../src/storage/database.mjs'
import { CommitService } from '../../src/storage/commit.mjs'
import { SQLiteMemoryIndexer } from '../../src/retrieval/index.mjs'
import { pullBatch } from '../../src/organizer/queue.mjs'

const [file, mode] = process.argv.slice(2)
const db = mode === 'lock' ? new DatabaseSync(file) : openDatabase(file)
const service = mode === 'commit' && new CommitService(db, { indexer: new SQLiteMemoryIndexer(db) })

process.on('message', async message => {
  if (message.action === 'lock') db.exec('BEGIN IMMEDIATE')
  if (message.action === 'release') db.exec('ROLLBACK')
  if (message.action === 'race') {
    const deadline = Date.now() + 5000
    let batch
    while (!batch && Date.now() < deadline) {
      batch = pullBatch(db, { scope: message.scope, consumerId: message.consumer, limit: 1 })
      if (!batch) await delay(10)
    }
    if (!batch) throw new Error('Racing writer could not claim its source')
    const proposal = { batchId: batch.batchId, scope: message.scope, proposalId: randomUUID(),
      operations: [message.operation] }
    process.send(service.commit(proposal, message.consumer))
    return
  }
  process.send({ status: 'OK' })
})
process.on('disconnect', () => db.close())
process.send({ status: 'READY' })
