import { isDeepStrictEqual } from 'node:util'
import { isPublicTitle } from '../retrieval/terms.mjs'

export class CommitError extends Error {}

function check(condition) {
  if (!condition) throw new CommitError('INVALID_PROPOSAL')
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const strings = value => Array.isArray(value) && value.every(nonempty)
const versionOk = value => Number.isSafeInteger(value) && value >= 0
const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key))

function dateOrNull(value) {
  if (value === undefined || value === null) return null
  check(typeof value === 'string' && /^\d{4}-\d\d-\d\d(?:$|T.+(?:Z|[+-]\d\d:\d\d)$)/u.test(value))
  const day = value.slice(0, 10)
  const calendar = new Date(day)
  check(Number.isFinite(calendar.getTime()) && calendar.toISOString().startsWith(day))
  const date = new Date(value)
  check(Number.isFinite(date.getTime()))
  return date.toISOString()
}

const longFields = ['kind', 'title', 'data', 'context', 'validFrom', 'validUntil', 'tags']
function longRecord(raw) {
  const {id, expectedVersion, kind, title} = raw
  let {data} = raw
  check(nonempty(id) && versionOk(expectedVersion) && isPublicTitle(title) && object(data))
  check(raw.context === undefined || typeof raw.context === 'string')
  check(raw.tags === undefined || strings(raw.tags))
  if (kind === 'fact') {
    check(keys(data, ['subject','key','value']) && nonempty(data.subject) && nonempty(data.key))
    check(Object.hasOwn(data, 'value') && data.value !== undefined)
    // Persist exactly the JSON value the caller submitted (including zero, false and null).
    try { check(isDeepStrictEqual(data.value, JSON.parse(JSON.stringify(data.value)))) }
    catch { throw new CommitError('INVALID_PROPOSAL') }
    data = {...data, subject: data.subject.trim(), key: data.key.trim()}
  } else {
    check(kind === 'procedure' && keys(data, ['conditions','steps','parameters','outwardSteps']))
    check(!raw.context && raw.validFrom == null && raw.validUntil == null)
    check(strings(data.conditions) && strings(data.steps) && data.steps.length > 0 && strings(data.parameters))
    if (Object.hasOwn(data, 'outwardSteps')) {
      check(Array.isArray(data.outwardSteps) && data.outwardSteps.every(step =>
        Number.isInteger(step) && step >= 1 && step <= data.steps.length))
      data = {...data, outwardSteps: [...new Set(data.outwardSteps)].sort((a, b) => a - b)}
    }
  }
  const validFrom = dateOrNull(raw.validFrom)
  const validUntil = dateOrNull(raw.validUntil)
  check(!validFrom || !validUntil || validFrom < validUntil)
  return {id, expectedVersion, kind, title: title.trim(), data,
    context: raw.context?.trim() ?? '',
    validFrom, validUntil, tags: raw.tags ?? []}
}

function operation(raw) {
  const common = ['type','id','expectedVersion','sourceIds']
  check(object(raw) && nonempty(raw.id) && versionOk(raw.expectedVersion))
  check(raw.sourceIds === undefined || (Array.isArray(raw.sourceIds) && raw.sourceIds.length > 0 &&
    raw.sourceIds.every(id => Number.isSafeInteger(id) && id > 0)))
  const {type,id,expectedVersion,sourceIds} = raw
  const base = {type,id,expectedVersion,sourceIds}
  switch (type) {
    case 'short.put':
      check(keys(raw, [...common, 'title','body','status','expiresAt']) && isPublicTitle(raw.title) &&
        nonempty(raw.body) && ['open','done','expired'].includes(raw.status))
      return {...base, title: raw.title.trim(), body: raw.body, status: raw.status, expiresAt: dateOrNull(raw.expiresAt)}
    case 'long.put':
      check(keys(raw, [...common, ...longFields]))
      return {...base, ...longRecord(raw)}
    case 'short.promote':
      check(expectedVersion > 0 && keys(raw, [...common, 'record']) &&
        keys(raw.record, ['id','expectedVersion',...longFields]))
      return {...base, record: longRecord(raw.record)}
    case 'short.archive':
    case 'long.remove':
      check(keys(raw, common) && expectedVersion > 0)
      return base
    default:
      throw new CommitError('INVALID_PROPOSAL')
  }
}

export function parseProposal(raw) {
  check(keys(raw, ['scope','batchId','proposalId','operations']) &&
    [raw.scope,raw.batchId,raw.proposalId].every(nonempty) && Array.isArray(raw.operations))
  return {scope: raw.scope, batchId: raw.batchId, proposalId: raw.proposalId, operations: raw.operations.map(operation)}
}
