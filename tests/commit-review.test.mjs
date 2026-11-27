import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CommitService } from '../src/storage/commit.mjs'
import { historyLong, listShort, openDatabase, readLong, readShort } from '../src/storage/database.mjs'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { installIndex } from '../src/retrieval/index.mjs'

const scope = 'review'
const short = (id, extra = {}) => ({ type:'short.put', id, expectedVersion:0,
  title:id, body:id, status:'open', ...extra })
const fact = (id, subject, key, extra = {}) => ({ type:'long.put', id, expectedVersion:0,
  title:id, kind:'fact', data:{ subject, key, value:'observed' }, ...extra })
const procedure = { type:'long.put', id:'procedure', expectedVersion:0, kind:'procedure',
  title:'Procedure', data:{ conditions:[], parameters:[], steps:['Review'] } }

function setup(t) {
  const db = openDatabase(':memory:')
  t.after(() => db.close())
  const service = new CommitService(db,{capacity:15})
  function submit(role, ...operations) {
    enqueue(db,{scope, authorRole:role, sourceSessionId:role, sourceId:randomUUID(), text:'Observed'})
    const batch = pullBatch(db,{scope, consumerId:'organizer'})
    assert.deepEqual(batch.events.map(event => event.authorRole),[role])
    const request = {scope, batchId:batch.batchId, proposalId:randomUUID(), operations}
    const result = service.commit(request,'organizer')
    if (result.status !== 'COMMITTED') {
      // Release the rejected batch before the next assertion switches authors.
      assert.equal(service.commit({...request, operations:[]},'organizer').status,'COMMITTED')
    }
    return result
  }
  return {db,submit}
}

test('external cannot modify, merge, archive or promote worker items, facts or procedures', t => {
  const {db,submit} = setup(t)
  const active = short('worker')
  const rule = fact('fact','Review','Mode')
  assert.equal(submit('worker',active,short('finished',{status:'done'}),rule,procedure).status,'COMMITTED')
  const {type, ...record} = fact('promoted','Review','Promotion')
  for (const op of [
    {...active, expectedVersion:1, status:'done'}, {...active, id:'alias'},
    {type:'short.archive', id:'finished', expectedVersion:1},
    {type:'short.promote', id:'worker', expectedVersion:1, record},
    {...rule, expectedVersion:1}, {...procedure, expectedVersion:1},
    {type:'long.remove', id:'fact', expectedVersion:1},
    {type:'long.remove', id:'procedure', expectedVersion:1},
    fact('shadow',' REVIEW ','Ｍｏｄｅ'),
  ]) assert.equal(submit('external',op).status,'FORBIDDEN',op.type)
  assert.equal(readShort(db,scope,'worker').version,1)
  assert.equal(readShort(db,scope,'finished').status,'done')
  assert.equal(readLong(db,scope,'promoted'),null)
  assert.equal(historyLong(db,scope,'fact').length,1)
  assert.equal(historyLong(db,scope,'procedure').length,1)
})

test('capacity cleanup obeys all three role levels and receipts include implicit archives', t => {
  const {db,submit} = setup(t)
  assert.equal(submit('owner',short('owner',{status:'done'})).status,'COMMITTED')
  assert.equal(submit('worker',short('worker',{status:'done'}),
    ...Array.from({length:12},(_,i) => short('task-'+i))).status,'COMMITTED')
  assert.equal(submit('external',short('external',{status:'done'})).status,'COMMITTED')
  const external = submit('external',short('external-new'))
  assert.deepEqual(external.changes.map(({id,status}) => [id,status]),[['external-new','open'],['external','archived']])
  assert.equal(submit('external',short('new')).status,'CAPACITY_REACHED')
  assert.equal(listShort(db,scope).items.length,15)
  const options = submit('worker',short('new'))
  assert.deepEqual(options.changes.map(({id,status}) => [id,status]),[['new','open'],['worker','archived']])
  const owner = submit('owner',short('next'))
  assert.deepEqual(owner.changes.map(({id,status}) => [id,status]),[['next','open'],['owner','archived']])
  assert.equal(readShort(db,scope,'worker').status,'archived')
})

test('dedupe preserves unfinished commitments and reports both the surviving and retired rows', t => {
  const {db,submit} = setup(t)
  const a = short('open')
  const b = short('finished',{status:'done'})
  assert.equal(submit('worker',a,b).status,'COMMITTED')
  const intoClosed = {...b,id:a.id,expectedVersion:1}
  assert.equal(submit('owner',intoClosed).status,'UNFINISHED')
  assert.equal(submit('owner',{...b,id:'new',status:'open'}).status,'UNFINISHED')
  assert.equal(readShort(db,scope,a.id).version,1)
  assert.equal(submit('owner',{...a,expectedVersion:1,status:'done'}).status,'COMMITTED')
  const merged = submit('owner',{...intoClosed,expectedVersion:2})
  assert.deepEqual(merged.changes.map(({id,status}) => [id,status]),[['finished','done'],['open','archived']])
})

test('fact identity normalizes Unicode, whitespace and case but remains scoped to context', t => {
  const {db,submit} = setup(t)
  const original = fact('original','  Service  ','　DB_Port ',{context:'production'})
  const collision = fact('variant','ＳＥＲＶＩＣＥ','ｄｂ＿ｐｏｒｔ',{context:'production'})
  assert.equal(submit('owner',original).status,'COMMITTED')
  const {data} = readLong(db,scope,'original')
  assert.deepEqual([data.subject,data.key],['Service','DB_Port'])
  assert.equal(submit('worker',collision).status,'FORBIDDEN')
  assert.equal(submit('external',collision).status,'FORBIDDEN')
  assert.equal(submit('owner',collision).status,'VERSION_CONFLICT')
  assert.equal(submit('worker',{...collision,context:'staging'}).status,'COMMITTED')
  assert.equal(submit('owner',{...collision,id:'original',expectedVersion:1}).status,'COMMITTED')
})

test('short expiry and fact validity reject rolled-over dates and accept a leap day with an offset', t => {
  const {db,submit} = setup(t)
  for (const value of ['2026-02-31','2026-02-29T23:59:59-06:00','2026-04-31T00:00:00Z']) {
    assert.equal(submit('worker',short('deadline',{expiresAt:value})).status,'INVALID_PROPOSAL')
    assert.equal(submit('worker',fact('fact','Engine','test',{validUntil:value})).status,'INVALID_PROPOSAL')
  }
  assert.equal(submit('worker',short('deadline',{expiresAt:'2024-02-29T23:59:59-06:00'})).status,'COMMITTED')
  assert.equal(readShort(db,scope,'deadline').expiresAt,'2024-03-01T05:59:59.000Z')
})

test('a SQLite automatic rollback preserves the original error', t => {
  const {db,submit} = setup(t)
  db.exec(`CREATE TRIGGER stop_insert BEFORE INSERT ON short_items BEGIN
    SELECT RAISE(ROLLBACK,'original storage error'); END`)
  assert.throws(() => submit('worker',short('entry')), /original storage error/u)
  assert.equal(readShort(db,scope,'entry'),null)
})

test('only the owner may shrink or remove outward step markers', t => {
  const {db,submit} = setup(t)
  function edit(role, expectedVersion, outwardSteps, expectedStatus) {
    const data = {...procedure.data, steps:['inspect','publish','notify']}
    if (outwardSteps !== undefined) data.outwardSteps = outwardSteps
    assert.equal(submit(role,{...procedure, expectedVersion, data}).status,expectedStatus)
  }
  edit('worker', 0, [1,2], 'COMMITTED')
  edit('worker', 1, undefined, 'FORBIDDEN')
  edit('worker', 1, [2], 'FORBIDDEN')
  edit('worker', 1, [], 'FORBIDDEN')
  edit('worker', 1, [2,3], 'COMMITTED')
  edit('worker', 2, [1,2,3], 'COMMITTED')
  edit('owner', 3, [2], 'COMMITTED')
  edit('owner', 4, undefined, 'COMMITTED')
  assert.equal(db.prepare('SELECT rev FROM long_revisions WHERE scope=?').get(scope).rev, 5)
})

test('v1 migration keeps the strongest current fact, appends linked history, and rebuilds search terms', t => {
  const dir = mkdtempSync(join(tmpdir(),'agent-memory-v1-'))
  t.after(() => rmSync(dir,{recursive:true, force:true}))
  const file = join(dir,'memory.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE long_records(scope,id,kind,title,data,context,valid_from,valid_until,tags,sources,
    version INTEGER,deleted INTEGER,author_role,updated_at, PRIMARY KEY(scope,id));
    CREATE UNIQUE INDEX fact_identity ON long_records
      (scope,context,json_extract(data,'$.subject'),json_extract(data,'$.key')) WHERE kind='fact' AND deleted=0;
    CREATE TABLE long_history(scope,id,version INTEGER,record,PRIMARY KEY(scope,id,version));
    CREATE TABLE memory_queue(id INTEGER PRIMARY KEY);
    CREATE TABLE session_roles(conversationId TEXT PRIMARY KEY,role TEXT,scope TEXT,seen_rev INTEGER,snapshot TEXT);
    INSERT INTO memory_queue VALUES(1);
    PRAGMA user_version=1`)
  installIndex(old)
  const insert = old.prepare('INSERT INTO long_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  for (const [id,role,subject,stamp] of [
    ['worker','worker','SERVICE','2030-01-01'],
    ['owner-old','owner',' service ','2025-01-01'],
    ['owner-new','owner','Ｓｅｒｖｉｃｅ','2026-01-01'],
  ]) {
    insert.run(scope,id,'fact','Platform/CI & Jobs',JSON.stringify({subject,key:'mode',value:id}),
      '',null,null,'[]','[]',1,0,role,new Date(stamp).toISOString())
    old.prepare('INSERT INTO long_history VALUES (?,?,?,?)').run(scope,id,1,JSON.stringify(readLong(old,scope,id)))
    old.prepare('INSERT INTO memory_search_terms VALUES(?,?,?,?,?,?,?,?)')
      .run(scope,id,1,'fact',null,null,null,'old fallback')
  }
  old.close()
  assert.throws(() => openDatabase(file,{readOnly:true}),/upgrade/u)
  const db = openDatabase(file)
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,4)
    assert.equal(db.prepare('SELECT count(*) AS n FROM procedure_outcomes').get().n,0)
    for (const id of ['worker','owner-old']) {
      const historical = historyLong(db,scope,id)
      assert.deepEqual(historical.map(r => [r.data.value,r.deleted,r.supersededBy]),[
        [id,false,undefined],[id,true,'owner-new'],
      ])
      assert.equal(readLong(db,scope,id).deleted,true)
    }
    assert.deepEqual({...db.prepare('SELECT id,fact_subject,fact_key FROM long_records WHERE deleted=0').get()},
      {id:'owner-new',fact_subject:'service',fact_key:'mode'})
    const terms = db.prepare('SELECT id,terms FROM memory_search_terms').all()
    assert.deepEqual(terms.map(row => row.id),['owner-new'])
    assert.match(terms[0].terms,/platform\/ci & jobs/u)
    assert.deepEqual({...db.prepare('SELECT retry_after,retry_count FROM memory_queue WHERE id=1').get()},
      {retry_after:0,retry_count:0})
  } finally { db.close() }
  const reopened = openDatabase(file,{readOnly:true})
  try { assert.equal(historyLong(reopened,scope,'worker').length,2) } finally { reopened.close() }
})
