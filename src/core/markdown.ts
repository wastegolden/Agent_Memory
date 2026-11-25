/**
 * Human-editable Markdown for the three hand-edited memory kinds: person cards, task lists and independent
 * short-term items. The visible text is the source of truth; short trailing JSON comments only carry machine
 * fields that a person should not have to type, and a decode that fills one in returns the exact file with only
 * that comment appended.
 */
import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { MemorySource } from './store.ts'
import type { PersonCard, PersonRequirement, PersonRelation } from './people.ts'
import type { ShortTermItem } from './short-term.ts'
import type { TaskAttachment, TaskList } from './task-lists.ts'

/** One decoded file: the value, the bytes that should be written back (identical unless a comment was added), and whether they changed. */
export interface DecodedMarkdown<T> { value: T; content: string; changed: boolean }

/** A person relation with the stable file ID that a decoded card always has. */
export type PersonMarkdownRelation = PersonRelation & { id: string }
/** A decoded person card: its relations gain the stable ID held in their trailing comment. */
export type PersonMarkdownCard = Omit<PersonCard, 'relations'> & { relations: PersonMarkdownRelation[] }
/** A relation accepted by `encodePerson`; an existing program card has no `id`, so one is derived once. */
export type PersonMarkdownRelationInput = PersonRelation & { id?: string }
/** A person accepted by `encodePerson`; the existing `PersonCard` shape is assignable. */
export type PersonMarkdownInput = Omit<PersonCard, 'relations'> & { relations: PersonMarkdownRelationInput[] }

/** A decoded task todo, with the machine fields a human does not write by hand. */
export type TaskMarkdownTodo = TaskList['todos'][number] & {
  kind: 'todo'
  sources: MemorySource[]
  createdAt: string
  recipient?: string
}
/** A decoded task note, with the machine fields a human does not write by hand. */
export type TaskMarkdownNote = Omit<TaskList['notes'][number], 'sources'> & {
  kind: 'note' | 'agreement' | 'experience'
  sources: MemorySource[]
  createdAt: string
  dueAt?: string
}
/** A decoded task list: the existing fields plus per-entry machine metadata. */
export type TaskMarkdownList = Omit<TaskList, 'todos' | 'notes'> & {
  todos: TaskMarkdownTodo[]
  notes: TaskMarkdownNote[]
}
/** A todo accepted by `encodeTask`; the existing `TaskList` todo shape is assignable. */
export type TaskMarkdownTodoInput = TaskList['todos'][number] & {
  kind?: 'todo'
  sources?: MemorySource[]
  createdAt?: string
  recipient?: string
}
/** A note accepted by `encodeTask`; the existing `TaskList` note shape is assignable. */
export type TaskMarkdownNoteInput = Omit<TaskList['notes'][number], 'sources'> & {
  kind?: 'note' | 'agreement' | 'experience'
  sources?: MemorySource[]
  createdAt?: string
  dueAt?: string
}
/** A task list accepted by `encodeTask`; the existing `TaskList` shape is assignable. */
export type TaskMarkdownInput = Omit<TaskList, 'todos' | 'notes'> & {
  todos: TaskMarkdownTodoInput[]
  notes: TaskMarkdownNoteInput[]
}
/** A decoded independent short-term item; task-bound todos are not stored in these files. */
export type ShortTermMarkdownItem = Omit<ShortTermItem, 'kind'> & { kind: 'agreement' | 'experience' }

interface SectionSpec { key: string; title: string; optional?: boolean }
const personSections: readonly SectionSpec[] = [
  { key: 'description', title: '人物简介' },
  { key: 'requirements', title: '要求' },
  { key: 'relations', title: '关系' },
]
const taskSections: readonly SectionSpec[] = [
  { key: 'plan', title: '任务规划' },
  { key: 'sources', title: '来源' },
  { key: 'todos', title: '待办' },
  { key: 'notes', title: '便签' },
  { key: 'attachments', title: '附件', optional: true },
]

interface Line { raw: string; text: string; value: string; eol: '' | '\n' | '\r\n' }
interface SectionLine { line: Line; index: number }
interface Section { key: string; title: string; lineIndex: number; lines: SectionLine[] }
interface Header { values: Map<string, unknown>; lineOf: Map<string, number>; end: number }

function fail(path: string, line: number | undefined, message: string): never {
  throw new Error(`${path}${line === undefined ? '' : `:${line}`}: ${message}`)
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Split into lines while retaining each exact line ending, so appending a comment never rewrites other bytes. */
const linesOf = (content: string): Line[] => {
  const lines: Line[] = []
  let start = 0
  while (start < content.length) {
    const newline = content.indexOf('\n', start)
    if (newline < 0) {
      const raw = content.slice(start)
      lines.push({ raw, text: raw, value: raw, eol: '' })
      break
    }
    const raw = content.slice(start, newline + 1)
    const withoutNewline = raw.slice(0, -1)
    const crlf = withoutNewline.endsWith('\r')
    lines.push({ raw, text: crlf ? withoutNewline.slice(0, -1) : withoutNewline,
      value: withoutNewline, eol: crlf ? '\r\n' : '\n' })
    start = newline + 1
  }
  return lines
}

/** Append only the comment suffix to the requested physical lines; all other bytes stay word for word. */
const applyEdits = (lines: Line[], edits: Map<number, string>): string =>
  lines.map((line, index) => {
    const suffix = edits.get(index)
    if (suffix === undefined) return line.raw
    const body = line.eol === '' ? line.raw : line.raw.slice(0, line.raw.length - line.eol.length)
    return body + suffix + line.eol
  }).join('')

const headerValue = (raw: string): unknown => {
  const text = raw.trim()
  if (text === '') return ''
  try { return JSON.parse(text) as unknown } catch { return text }
}

const readHeader = (lines: Line[], path: string, allowed: readonly string[]): Header => {
  if (lines.length === 0) fail(path, 1, 'missing file header')
  const values = new Map<string, unknown>()
  const lineOf = new Map<string, number>()
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    if (line.text === '' || line.text.startsWith('## ')) break
    const match = /^([A-Za-z][A-Za-z0-9]*):[ \t]*(.*)$/.exec(line.text)
    if (!match) fail(path, index + 1, 'expected a fixed "key: value" header line')
    const key = match[1]!
    if (!allowed.includes(key)) fail(path, index + 1, `unknown header key "${key}"`)
    if (values.has(key)) fail(path, index + 1, `duplicate header key "${key}"`)
    values.set(key, headerValue(match[2] ?? ''))
    lineOf.set(key, index + 1)
    index++
  }
  if (values.size === 0) fail(path, 1, 'missing file header')
  return { values, lineOf, end: index }
}

const headerText = (header: Header, key: string, path: string, allowEmpty = false): string => {
  const value = header.values.get(key)
  const line = header.lineOf.get(key)
  if (value === undefined) fail(path, line, `missing header key "${key}"`)
  if (typeof value !== 'string') fail(path, line, `header "${key}" must be a string`)
  if (!allowEmpty && value.length === 0) fail(path, line, `header "${key}" must not be empty`)
  return value
}
const optionalHeaderText = (header: Header, key: string, path: string): string | undefined => {
  const value = header.values.get(key)
  if (value === undefined) return undefined
  const line = header.lineOf.get(key)
  if (typeof value !== 'string') fail(path, line, `header "${key}" must be a string`)
  return value
}
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], path: string,
  line: number | undefined, label: string): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(path, line, `${label} has unknown field "${key}"`)
  }
}
const requiredString = (value: Record<string, unknown>, key: string, path: string,
  line: number | undefined, label: string): string => {
  const field = value[key]
  if (typeof field !== 'string') fail(path, line, `${label} field "${key}" must be a string`)
  if (field.length === 0) fail(path, line, `${label} field "${key}" must not be empty`)
  return field
}
const optionalString = (value: Record<string, unknown>, key: string, path: string,
  line: number | undefined, label: string): string | undefined => {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'string') fail(path, line, `${label} field "${key}" must be a string`)
  return field
}
const stringArray = (value: unknown, path: string, line: number | undefined, label: string): string[] => {
  if (!Array.isArray(value)) fail(path, line, `${label} must be an array of strings`)
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(path, line, `${label}[${index}] must be a nonempty string`)
    }
    return entry
  })
}
const readSource = (value: Record<string, unknown>, path: string, line: number | undefined): MemorySource => {
  onlyKeys(value, ['kind', 'id', 'path'], path, line, 'source')
  const kind = requiredString(value, 'kind', path, line, 'source')
  const id = requiredString(value, 'id', path, line, 'source')
  const sourcePath = optionalString(value, 'path', path, line, 'source')
  return { kind, id, ...(sourcePath !== undefined ? { path: sourcePath } : {}) }
}
const readSources = (value: unknown, path: string, line: number | undefined): MemorySource[] => {
  if (!Array.isArray(value)) fail(path, line, 'sources must be an array')
  return value.map((entry, index) => {
    if (!isRecord(entry)) fail(path, line, `sources[${index}] must be an object`)
    return readSource(entry, path, line)
  })
}
const headerSources = (header: Header, key: string, path: string): MemorySource[] => {
  const value = header.values.get(key)
  const line = header.lineOf.get(key)
  if (value === undefined) fail(path, line, `missing header key "${key}"`)
  return readSources(value, path, line)
}

const jsonText = (value: unknown): string => {
  const text = JSON.stringify(value) as string | undefined
  return text ?? 'null'
}

/** Machine metadata is a trailing JSON object in an HTML comment; `<`, `>` and `--` are escaped so the comment stays legal. */
const metadataComment = (value: unknown): string => {
  const json = jsonText(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/--/g, '\\u002d\\u002d')
  return `<!-- ${json} -->`
}

/** Split a trailing `<!-- {...} -->` from one line, reporting malformed metadata with this file's path. */
const splitMetadata = (text: string, path: string, line: number):
  { text: string; metadata?: Record<string, unknown> } => {
  const marker = text.lastIndexOf('<!--')
  if (marker < 0 || !text.endsWith('-->')) return { text }
  const before = text.slice(0, marker)
  const body = text.slice(marker + 4, -3).trim()
  let parsed: unknown = undefined
  try { parsed = JSON.parse(body) as unknown } catch (error) {
    fail(path, line, `invalid metadata comment: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(parsed)) fail(path, line, 'metadata comment must contain a JSON object')
  return { text: before.endsWith(' ') ? before.slice(0, -1) : before, metadata: parsed }
}

const skipBlank = (lines: Line[], start: number): number => {
  let index = start
  while (index < lines.length && lines[index]!.text === '') index++
  return index
}

/** A section heading carries a JSON section marker, so a plan heading such as "## 来源" is never mistaken for one. */
const sectionMarker = (text: string, expected: readonly SectionSpec[]): { key: string; title: string } | undefined => {
  const match = /^## (.+?) <!-- (\{.*\}) -->$/.exec(text)
  if (!match) return undefined
  let parsed: unknown = undefined
  try { parsed = JSON.parse(match[2]!) as unknown } catch { return undefined }
  if (!isRecord(parsed) || typeof parsed.section !== 'string') return undefined
  if (!expected.some(spec => spec.key === parsed.section)) return undefined
  return { key: parsed.section, title: match[1]! }
}

const readSections = (lines: Line[], start: number, expected: readonly SectionSpec[], path: string): Section[] => {
  const sections: Section[] = []
  let index = start
  if (index >= lines.length) fail(path, undefined, `missing section "${expected[0]?.title ?? ''}"`)
  while (index < lines.length) {
    const marker = sectionMarker(lines[index]!.text, expected)
    const spec = expected[sections.length]
    if (!marker) fail(path, index + 1, `expected section "${spec?.title ?? expected[0]?.title ?? ''}"`)
    if (!spec) fail(path, index + 1, `unexpected section "${marker.title}"`)
    // The marker's key names the section; the title beside it is for people, who may reword it by hand.
    if (marker.key !== spec.key) fail(path, index + 1, `expected section "${spec.title}", got "${marker.title}"`)
    const headingIndex = index
    const lines_: SectionLine[] = []
    index++
    while (index < lines.length && sectionMarker(lines[index]!.text, expected) === undefined) {
      lines_.push({ line: lines[index]!, index })
      index++
    }
    sections.push({ key: spec.key, title: spec.title, lineIndex: headingIndex, lines: lines_ })
  }
  if (sections.length !== expected.length) {
    for (let index = sections.length; index < expected.length; index++) {
      if (expected[index]?.optional === true) continue
      fail(path, undefined, `missing section "${expected[index]?.title ?? ''}"`)
    }
  }
  return sections
}

/** The value of one body section: drop exactly the structural blank line after the heading and before the next section. */
const bodyValue = (lines: Line[]): string => {
  let start = 0
  let end = lines.length
  if (start < end && lines[start]!.text === '') start++
  if (end > start && lines[end - 1]!.text === '') end--
  return lines.slice(start, end).map(line => line.value).join('\n')
}

interface FirstLine { text: string; extras?: Record<string, unknown> }
interface CollectedItem {
  text: string
  metadata?: Record<string, unknown>
  lastLine: number
  lineNumber: number
  extras: Record<string, unknown>
}

/** Collect list items from one section; continuation lines are indented by two spaces and may hold multi-line text. */
const collectItems = (section: Section, path: string,
  parseFirst: (value: string, line: number) => FirstLine): CollectedItem[] => {
  const items: CollectedItem[] = []
  let current: { parts: string[]; last: number; extras: Record<string, unknown> } | undefined
  const finish = (): void => {
    if (!current) return
    const last = current.parts.length - 1
    const split = splitMetadata(current.parts[last] ?? '', path, current.last + 1)
    current.parts[last] = split.text
    items.push({ text: current.parts.join('\n'), metadata: split.metadata,
      lastLine: current.last, lineNumber: current.last + 1, extras: current.extras })
    current = undefined
  }
  for (const entry of section.lines) {
    const text = entry.line.text
    if (text === '') { finish(); continue }
    if (text.startsWith('- ')) {
      finish()
      const parsed = parseFirst(text.slice(2), entry.index + 1)
      current = { parts: [parsed.text], last: entry.index, extras: parsed.extras ?? {} }
    } else {
      if (!current) fail(path, entry.index + 1, 'expected a list item starting with "- "')
      current.parts.push(text.startsWith('  ') ? text.slice(2) : text)
      current.last = entry.index
    }
  }
  finish()
  return items
}

const itemPrefix = (prefix: string, text: string): string[] => {
  const textLines = text.split('\n')
  const lines = [`${prefix}${textLines[0] ?? ''}`, ...textLines.slice(1).map(line => `  ${line}`)]
  return lines
}
const renderItem = (prefix: string, text: string, metadata: unknown): string => {
  const lines = itemPrefix(prefix, text)
  const last = lines.length - 1
  lines[last] = `${lines[last]} ${metadataComment(metadata)}`
  return lines.join('\n')
}
const sectionText = (title: string, key: string, body: string): string =>
  `## ${title} <!-- ${jsonText({ section: key })} -->\n\n${body}\n\n`
const headerLine = (key: string, value: unknown): string => `${key}: ${jsonText(value)}`

const relationId = (relation: PersonMarkdownRelationInput, index: number): string => {
  const content = JSON.stringify([index, relation.personId, relation.description, relation.eventIds]) as string | undefined
  return 'relation-' + createHash('sha256').update(content ?? '[]').digest('hex').slice(0, 16)
}
const sourceRecord = (source: MemorySource): Record<string, unknown> =>
  ({ kind: source.kind, id: source.id, ...(source.path !== undefined ? { path: source.path } : {}) })
const sourceLine = (source: MemorySource): string => {
  if (source.kind.length === 0 || source.id.length === 0 || source.kind.includes('\n') || source.id.includes('\n')) {
    throw new Error('A memory source needs a nonempty single-line kind and id')
  }
  return `- ${source.kind}:${source.id} ${metadataComment(sourceRecord(source))}`
}

/** Encode a person card, deriving a stable relation ID once when the input is an older program card. */
export function encodePerson(card: PersonMarkdownInput): string {
  const requirements = card.requirements.map(requirement =>
    renderItem('- ', requirement.text, { id: requirement.id, eventIds: requirement.eventIds }))
  const relations = card.relations.map((relation, index) => {
    const id = relation.id ?? relationId(relation, index)
    return renderItem(`- ${relation.personId}：`, relation.description,
      { id, personId: relation.personId, eventIds: relation.eventIds })
  })
  const header = [headerLine('id', card.id), headerLine('name', card.name), headerLine('updatedAt', card.updatedAt)]
  return `${header.join('\n')}\n\n`
    + sectionText('人物简介', 'description', card.description)
    + sectionText('要求', 'requirements', requirements.join('\n'))
    + sectionText('关系', 'relations', relations.join('\n'))
}

/** Encode a task list; todos and notes missing kind/sources/createdAt get the documented defaults. */
export function encodeTask(task: TaskMarkdownInput): string {
  const created = (item: { createdAt?: string }): string => item.createdAt ?? task.updatedAt
  const todos = task.todos.map(todo => {
    const metadata = {
      id: todo.id, kind: 'todo', sources: todo.sources ?? [], createdAt: created(todo),
      ...(todo.recipient !== undefined ? { recipient: todo.recipient } : {}),
      ...(todo.dueAt !== undefined ? { dueAt: todo.dueAt } : {}),
    }
    return renderItem(`- [${todo.done ? 'x' : ' '}] `, todo.text, metadata)
  })
  const notes = task.notes.map(note => {
    const metadata = {
      id: note.id, kind: note.kind ?? 'note', sources: note.sources ?? [], createdAt: created(note),
      ...(note.recipient !== undefined ? { recipient: note.recipient } : {}),
      ...(note.dueAt !== undefined ? { dueAt: note.dueAt } : {}),
      ...(note.methodVersion !== undefined ? { methodVersion: note.methodVersion } : {}),
    }
    return renderItem('- ', note.text, metadata)
  })
  const sources = task.sources.map(sourceLine).join('\n')
  const attachments = (task.attachments ?? []).map(attachment => renderItem('- ',
    attachment.name ?? basename(attachment.path),
    { id: attachment.id, path: attachment.path, ...(attachment.name !== undefined ? { name: attachment.name } : {}) }))
  const header = [headerLine('id', task.id), headerLine('title', task.title), headerLine('updatedAt', task.updatedAt)]
  return `${header.join('\n')}\n\n`
    + sectionText('任务规划', 'plan', task.plan)
    + sectionText('来源', 'sources', sources)
    + sectionText('待办', 'todos', todos.join('\n'))
    + sectionText('便签', 'notes', notes.join('\n'))
    + (attachments.length === 0 ? '' : sectionText('附件', 'attachments', attachments.join('\n')))
}

/** Encode one independent short-term item; task-bound todos and task IDs belong in task files instead. */
export function encodeShortTerm(item: ShortTermItem): string {
  if (item.kind !== 'agreement' && item.kind !== 'experience') {
    throw new Error(`Short-term Markdown holds only agreement or experience items, not "${item.kind}"`)
  }
  if (item.taskId !== undefined) {
    throw new Error('Short-term Markdown is independent: taskId and todos belong in a task file')
  }
  const header = [headerLine('id', item.id), headerLine('kind', item.kind), headerLine('createdAt', item.createdAt)]
  if (item.recipient !== undefined) header.push(headerLine('recipient', item.recipient))
  if (item.kind === 'experience' && item.methodVersion !== undefined) header.push(headerLine('methodVersion', item.methodVersion))
  header.push(headerLine('sources', item.sources))
  return `${header.join('\n')}\n\n${item.text}\n`
}

const readSourcesSection = (section: Section, path: string): MemorySource[] => {
  const sources: MemorySource[] = []
  for (const entry of section.lines) {
    const text = entry.line.text
    if (text === '') continue
    if (!text.startsWith('- ')) fail(path, entry.index + 1, 'source lines must start with "- "')
    const split = splitMetadata(text.slice(2), path, entry.index + 1)
    const stored = split.metadata ? readSource(split.metadata, path, entry.index + 1) : undefined
    const colon = split.text.indexOf(':')
    if (colon <= 0 || colon === split.text.length - 1) {
      fail(path, entry.index + 1, 'source lines need "kind:id" or a trailing metadata comment')
    }
    const kind = split.text.slice(0, colon).trim()
    const id = split.text.slice(colon + 1).trim()
    if (kind.length === 0 || id.length === 0) {
      fail(path, entry.index + 1, 'source kind and id must not be empty')
    }
    sources.push({ kind, id, ...(stored?.path !== undefined ? { path: stored.path } : {}) })
  }
  return sources
}

const readTodos = (section: Section, path: string, edits: Map<number, string>,
  createdAt: string): TaskMarkdownTodo[] =>
  collectItems(section, path, (value, line) => {
    const match = /^\[([ xX])\] ?(.*)$/.exec(value)
    if (!match) fail(path, line, 'todo items must be a checkbox such as "- [ ] text" or "- [x] text"')
    return { text: match[2] ?? '', extras: { done: match[1] !== ' ' } }
  }).map(item => {
    const done = item.extras.done === true
    const metadata = item.metadata
    if (!metadata) {
      const id = randomUUID()
      edits.set(item.lastLine, ' ' + metadataComment({ id, kind: 'todo', sources: [], createdAt }))
      return { id, text: item.text, done, kind: 'todo' as const, sources: [], createdAt }
    }
    onlyKeys(metadata, ['id', 'kind', 'sources', 'createdAt', 'recipient', 'dueAt'],
      path, item.lineNumber, 'todo metadata')
    if (metadata.kind !== 'todo') fail(path, item.lineNumber, 'todo metadata kind must be "todo"')
    const id = requiredString(metadata, 'id', path, item.lineNumber, 'todo metadata')
    const sources = readSources(metadata.sources, path, item.lineNumber)
    const itemCreatedAt = requiredString(metadata, 'createdAt', path, item.lineNumber, 'todo metadata')
    const recipient = optionalString(metadata, 'recipient', path, item.lineNumber, 'todo metadata')
    const dueAt = optionalString(metadata, 'dueAt', path, item.lineNumber, 'todo metadata')
    return { id, text: item.text, done, kind: 'todo' as const, sources, createdAt: itemCreatedAt,
      ...(recipient !== undefined ? { recipient } : {}), ...(dueAt !== undefined ? { dueAt } : {}) }
  })

const readNotes = (section: Section, path: string, edits: Map<number, string>,
  createdAt: string): TaskMarkdownNote[] =>
  collectItems(section, path, value => ({ text: value })).map(item => {
    const metadata = item.metadata
    if (!metadata) {
      const id = randomUUID()
      edits.set(item.lastLine, ' ' + metadataComment({ id, kind: 'note', sources: [], createdAt }))
      return { id, text: item.text, kind: 'note' as const, sources: [], createdAt }
    }
    onlyKeys(metadata, ['id', 'kind', 'sources', 'createdAt', 'recipient', 'dueAt', 'methodVersion'],
      path, item.lineNumber, 'note metadata')
    if (metadata.kind !== 'note' && metadata.kind !== 'agreement' && metadata.kind !== 'experience')
      fail(path, item.lineNumber, 'note metadata kind must be note, agreement or experience')
    const id = requiredString(metadata, 'id', path, item.lineNumber, 'note metadata')
    const sources = readSources(metadata.sources, path, item.lineNumber)
    const itemCreatedAt = requiredString(metadata, 'createdAt', path, item.lineNumber, 'note metadata')
    const recipient = optionalString(metadata, 'recipient', path, item.lineNumber, 'note metadata')
    const dueAt = optionalString(metadata, 'dueAt', path, item.lineNumber, 'note metadata')
    const methodVersion = optionalString(metadata, 'methodVersion', path, item.lineNumber, 'note metadata')
    return { id, text: item.text, kind: metadata.kind, sources, createdAt: itemCreatedAt,
      ...(recipient !== undefined ? { recipient } : {}), ...(dueAt !== undefined ? { dueAt } : {}),
      ...(methodVersion !== undefined ? { methodVersion } : {}) }
  })

const readAttachments = (section: Section, path: string): TaskAttachment[] =>
  collectItems(section, path, value => ({ text: value })).map(item => {
    const metadata = item.metadata
    if (!metadata) fail(path, item.lineNumber, 'attachment items need an id and path in a trailing metadata comment')
    onlyKeys(metadata, ['id', 'path', 'name'], path, item.lineNumber, 'attachment metadata')
    const id = requiredString(metadata, 'id', path, item.lineNumber, 'attachment metadata')
    const attachmentPath = requiredString(metadata, 'path', path, item.lineNumber, 'attachment metadata')
    const name = optionalString(metadata, 'name', path, item.lineNumber, 'attachment metadata')
    return { id, path: attachmentPath, ...(name !== undefined ? { name } : {}) }
  })

const readRequirements = (section: Section, path: string, edits: Map<number, string>): PersonRequirement[] =>
  collectItems(section, path, value => ({ text: value })).map(item => {
    const metadata = item.metadata
    if (!metadata) {
      const id = randomUUID()
      edits.set(item.lastLine, ' ' + metadataComment({ id, eventIds: [] }))
      return { id, text: item.text, eventIds: [] }
    }
    onlyKeys(metadata, ['id', 'eventIds'], path, item.lineNumber, 'requirement metadata')
    const id = requiredString(metadata, 'id', path, item.lineNumber, 'requirement metadata')
    const eventIds = stringArray(metadata.eventIds, path, item.lineNumber, 'requirement eventIds')
    return { id, text: item.text, eventIds }
  })

const readRelations = (section: Section, path: string, edits: Map<number, string>): PersonMarkdownRelation[] =>
  collectItems(section, path, value => {
    const colon = value.indexOf('：')
    if (colon < 0) return { text: value, extras: { visiblePersonId: undefined } }
    return { text: value.slice(colon + 1), extras: { visiblePersonId: value.slice(0, colon).trim() } }
  }).map(item => {
    const visiblePersonId = typeof item.extras.visiblePersonId === 'string' ? item.extras.visiblePersonId : undefined
    const metadata = item.metadata
    if (!metadata) {
      if (!visiblePersonId) {
        fail(path, item.lineNumber, 'relation items without metadata need the form "- personId：description"')
      }
      const id = randomUUID()
      edits.set(item.lastLine, ' ' + metadataComment({ id, personId: visiblePersonId, eventIds: [] }))
      return { id, personId: visiblePersonId, description: item.text, eventIds: [] }
    }
    onlyKeys(metadata, ['id', 'personId', 'eventIds'], path, item.lineNumber, 'relation metadata')
    const id = requiredString(metadata, 'id', path, item.lineNumber, 'relation metadata')
    const personId = visiblePersonId ?? requiredString(metadata, 'personId', path, item.lineNumber, 'relation metadata')
    const eventIds = stringArray(metadata.eventIds, path, item.lineNumber, 'relation eventIds')
    return { id, personId, description: item.text, eventIds }
  })

/** Decode a person card, validating every field once and adding missing metadata comments to new lines only. */
export function decodePerson(content: string, path: string): DecodedMarkdown<PersonMarkdownCard> {
  const lines = linesOf(content)
  const header = readHeader(lines, path, ['id', 'name', 'updatedAt'])
  const id = headerText(header, 'id', path)
  const name = headerText(header, 'name', path, true)
  const updatedAt = headerText(header, 'updatedAt', path)
  const sections = readSections(lines, skipBlank(lines, header.end), personSections, path)
  const description = bodyValue(sections[0]?.lines.map(entry => entry.line) ?? [])
  const edits = new Map<number, string>()
  const requirements = readRequirements(sections[1] ?? fail(path, undefined, 'missing 要求 section'), path, edits)
  const relations = readRelations(sections[2] ?? fail(path, undefined, 'missing 关系 section'), path, edits)
  const changed = edits.size > 0
  return { value: { id, name, description, requirements, relations, updatedAt },
    content: changed ? applyEdits(lines, edits) : content, changed }
}

/** Decode a task list, validating every field once and adding missing metadata comments to new lines only. */
export function decodeTask(content: string, path: string): DecodedMarkdown<TaskMarkdownList> {
  const lines = linesOf(content)
  const header = readHeader(lines, path, ['id', 'title', 'updatedAt'])
  const id = headerText(header, 'id', path)
  const title = headerText(header, 'title', path)
  const updatedAt = headerText(header, 'updatedAt', path)
  const sections = readSections(lines, skipBlank(lines, header.end), taskSections, path)
  const plan = bodyValue(sections[0]?.lines.map(entry => entry.line) ?? [])
  const sources = readSourcesSection(sections[1] ?? fail(path, undefined, 'missing 来源 section'), path)
  const edits = new Map<number, string>()
  const todos = readTodos(sections[2] ?? fail(path, undefined, 'missing 待办 section'), path, edits, updatedAt)
  const notes = readNotes(sections[3] ?? fail(path, undefined, 'missing 便签 section'), path, edits, updatedAt)
  const attachmentSection = sections[4]
  const attachments = attachmentSection === undefined ? [] : readAttachments(attachmentSection, path)
  const changed = edits.size > 0
  return { value: { id, title, plan, sources, todos, notes, attachments, updatedAt },
    content: changed ? applyEdits(lines, edits) : content, changed }
}

/** Decode an independent short-term item; this format has no item metadata to fill in. */
export function decodeShortTerm(content: string, path: string): DecodedMarkdown<ShortTermMarkdownItem> {
  const lines = linesOf(content)
  const header = readHeader(lines, path, ['id', 'kind', 'createdAt', 'recipient', 'methodVersion', 'sources'])
  const id = headerText(header, 'id', path)
  const kind = headerText(header, 'kind', path)
  if (kind !== 'agreement' && kind !== 'experience') {
    fail(path, header.lineOf.get('kind'), 'short-term kind must be "agreement" or "experience"')
  }
  const createdAt = headerText(header, 'createdAt', path)
  const recipient = optionalHeaderText(header, 'recipient', path)
  const methodVersion = optionalHeaderText(header, 'methodVersion', path)
  const sources = headerSources(header, 'sources', path)
  let bodyStart = header.end
  if (lines[bodyStart]?.text === '') bodyStart++
  const bodyLines = lines.slice(bodyStart)
  let text = bodyLines.map(line => line.raw).join('')
  const last = bodyLines[bodyLines.length - 1]
  if (last && last.eol !== '') text = text.slice(0, -last.eol.length)
  return { value: { id, kind, text, sources, createdAt,
    ...(recipient !== undefined ? { recipient } : {}),
    ...(methodVersion !== undefined ? { methodVersion } : {}) }, content, changed: false }
}
