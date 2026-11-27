import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { enqueue, pullBatch } from '../src/organizer/queue.mjs'
import { scopeForSession } from '../src/organizer/settings.mjs'
import { CommitService } from '../src/storage/commit.mjs'
import { historyLong, openDatabase, readLong, recordProcedureOutcome } from '../src/storage/database.mjs'
import { runScript, sandbox } from './helpers/host-process.mjs'

const cli = 'src/bridge/export.mjs'

test('export takes a read-only scoped snapshot and increments only the outcomes cursor', async t => {
  const {dir,env} = sandbox(t)
  const file = join(dir,'memory.sqlite')
  const workspace = join(dir,'workspace')
  const scope = scopeForSession({}, [workspace], '')
  const db = openDatabase(file)
  const proc = {type:'long.put', id:'deploy', kind:'procedure', title:'Deploy', expectedVersion:0,
    tags:['release'], data:{steps:['old step'],conditions:[],parameters:[]}}
  const fact = {type:'long.put', id:'FACT_ID_PRIVATE', kind:'fact', title:'Fact label', expectedVersion:0,
    data:{subject:'service',key:'setting',value:'FACT_VALUE_PRIVATE'}}
  const service = new CommitService(db)
  function commit(target, operations) {
    enqueue(db, {scope:target, sourceId:'seed', sourceSessionId:'runner', authorRole:'owner', text:'QUEUE_PRIVATE'})
    const {batchId} = pullBatch(db, {scope:target,consumerId:'organizer'})
    assert.equal(service.commit({scope:target,batchId,proposalId:'seed',operations},'organizer').status, 'COMMITTED')
  }
  commit(scope, [proc, {...proc,expectedVersion:1,data:{...proc.data,steps:['new step']}},
    {...proc,id:'archived'}, {type:'long.remove',id:'archived',expectedVersion:1}, fact,
    {...fact,expectedVersion:1,data:{...fact.data,value:'OTHER_FACT_PRIVATE'}},
    {type:'short.put',id:'SHORT_ID_PRIVATE',title:'Private task',body:'SHORT_BODY_PRIVATE',expectedVersion:0,status:'open'}])
  commit('other', [{...proc,id:'FOREIGN_PRIVATE'}])
  db.prepare('INSERT INTO session_roles(conversationId,role,scope) VALUES (?,?,?)').run('ROLE_PRIVATE','reader',scope)
  for (const [session,target] of [['b',scope], ['a',scope], ['z','other']]) {
    db.prepare('INSERT INTO transcript_cursor VALUES(?,?,?,?,?,?,?,?)')
      .run(target,session,'trace-' + session,'GENERATION_PRIVATE','file-' + session,23,18,'STAMP_PRIVATE')
  }
  for (const [target,outwardDone] of [[scope,null], ['other',true], [scope,false], [scope,true]]) {
    recordProcedureOutcome(db, {scope:target, procedureId:target === scope ? 'deploy' : 'FOREIGN_PRIVATE',
      procedureVersion:2, status:'failed', outwardDone, authorRole:'owner',sessionId:'runner'})
  }
  const procedures = ['archived','deploy'].map(id => readLong(db,scope,id))
  const history = ['archived','deploy'].flatMap(id => historyLong(db,scope,id))
  db.close()
  const bytes = readFileSync(file)
  const modified = statSync(file,{bigint:true}).mtimeNs
  const all = await runScript(cli, ['--scope',scope,'--db',file], env)
  assert.equal(all.code, 0, all.stderr)
  assert.doesNotMatch(all.stdout, /_PRIVATE|short_items|short_bodies|session_roles|memory_queue|"kind":"fact"/)
  const result = JSON.parse(all.stdout)
  assert.deepEqual(Object.keys(result).sort(),
    ['schemaVersion','scope','exportedAt','procedures','procedureHistory','outcomes','cursors'].sort())
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.scope, scope)
  assert.equal(new Date(result.exportedAt).toISOString(),result.exportedAt)
  assert.deepEqual(result.procedures, procedures)
  assert.deepEqual(result.procedureHistory, history)
  assert.deepEqual(result.outcomes.map(o => [o.id,o.scope,o.procedureId,o.outwardDone]),
    [[1,scope,'deploy',null],[3,scope,'deploy',false],[4,scope,'deploy',true]])
  assert.deepEqual(result.cursors, ['a','b'].map(s => ({sourceSessionId:s,path:'trace-'+s,fileId:'file-'+s,captured:23})))
  const incremental = await runScript(cli, ['--workspace',workspace,'--since-outcome-id','3'], env)
  assert.equal(incremental.code, 0, incremental.stderr)
  const next = JSON.parse(incremental.stdout)
  assert.deepEqual(next, {...result, exportedAt:next.exportedAt, outcomes:result.outcomes.slice(2)})
  assert.deepEqual(readFileSync(file),bytes)
  assert.equal(statSync(file,{bigint:true}).mtimeNs,modified)
})

test('invalid export arguments, missing databases and old schemas fail without creating or upgrading a database', async t => {
  const {dir,env} = sandbox(t)
  const missing = join(dir,'absent.sqlite')
  for (const args of [[], ['--scope',' '], ['--workspace'], ['--scope','x','--workspace','y'],
    ...['-1','1.5','NaN','1e2','9007199254740992',''].map(n => ['--scope','x','--since-outcome-id',n])]) {
    const result = await runScript(cli, [...args,'--db',missing], env)
    assert.notEqual(result.code, 0)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /--scope|--workspace|--since-outcome-id/)
  }
  const result = await runScript(cli, ['--scope','x','--db',missing], env)
  assert.notEqual(result.code, 0)
  assert.equal(existsSync(missing),false)
  const file = join(dir,'old.sqlite')
  const db = openDatabase(file)
  db.exec('PRAGMA user_version=3')
  db.close()
  const before = readFileSync(file)
  const old = await runScript(cli, ['--scope','x','--db',file], env)
  assert.notEqual(old.code, 0)
  assert.match(old.stderr, /upgrade/)
  assert.deepEqual(readFileSync(file), before)
})
