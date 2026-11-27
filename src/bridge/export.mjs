import { parseArgs } from 'node:util'
import { scopeForSession, settings } from '../organizer/settings.mjs'
import { openDatabase } from '../storage/database.mjs'

let db
try {
  const {values} = parseArgs({options: {
    scope: {type: 'string'}, workspace: {type: 'string'}, db: {type: 'string'}, 'since-outcome-id': {type: 'string'},
  }})
  if ((values.scope === undefined) === (values.workspace === undefined) ||
      !(values.scope ?? values.workspace).trim()) throw new Error('Specify one non-empty --scope or --workspace')
  if (values.db !== undefined && !values.db.trim()) throw new Error('--db requires a file path')
  const since = values['since-outcome-id']
  if (since !== undefined && (!/^\d+$/u.test(since) || !Number.isSafeInteger(Number(since))))
    throw new Error('--since-outcome-id must be a non-negative safe integer')

  const config = settings()
  const scope = values.scope?.trim() ?? scopeForSession(config, [values.workspace], '')
  db = openDatabase(values.db ?? config.databaseFile, {readOnly: true})
  db.exec('BEGIN')
  // Both partial indexes contain procedure keys only, including tombstones.
  const procedures = db.prepare(`SELECT scope,id,kind,title,data,context,valid_from AS validFrom,
    valid_until AS validUntil,tags,sources,version,deleted,author_role AS authorRole,updated_at AS updatedAt
    FROM long_records INDEXED BY procedures_by_scope WHERE scope=? AND kind='procedure' ORDER BY id`)
    .all(scope).map(row => ({...row, data: JSON.parse(row.data), tags: JSON.parse(row.tags),
      sources: JSON.parse(row.sources), deleted: Boolean(row.deleted)}))
  const procedureHistory = db.prepare(`SELECT record FROM long_history INDEXED BY procedure_history_by_scope
    WHERE scope=? AND json_extract(record,'$.kind')='procedure' ORDER BY id,version`)
    .all(scope).map(row => JSON.parse(row.record))
  const outcomes = db.prepare(`SELECT id,scope,procedure_id AS procedureId,procedure_version AS procedureVersion,
    status,failed_step AS failedStep,outward_done AS outwardDone,detail,author_role AS authorRole,
    session_id AS sessionId,recorded_at AS recordedAt FROM procedure_outcomes
    WHERE scope=? ${since === undefined ? '' : 'AND id>?'} ORDER BY id`)
    .all(scope, ...(since === undefined ? [] : [Number(since)]))
    .map(row => ({...row, outwardDone: row.outwardDone === null ? null : Boolean(row.outwardDone)}))
  const cursors = db.prepare(`SELECT sourceSessionId,path,fileId,captured FROM transcript_cursor
    WHERE scope=? ORDER BY sourceSessionId`).all(scope)
  process.stdout.write(JSON.stringify({schemaVersion: 1, scope, exportedAt: new Date().toISOString(),
    procedures, procedureHistory, outcomes, cursors}) + '\n')
} catch (error) {
  process.stderr.write('agent-memory export: ' + error.message + '\n')
  process.exitCode = 1
} finally {
  db?.close()
}
