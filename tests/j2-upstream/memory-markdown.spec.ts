/** Markdown memory files: text is human-editable, IDs and sources survive, and only new lines gain metadata. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodePerson, decodeShortTerm, decodeTask, encodePerson, encodeShortTerm, encodeTask } from '../../src/core/markdown.ts'
import type { PersonCard } from '../../src/core/people.ts'
import type { ShortTermItem } from '../../src/core/short-term.ts'
import { TaskListInputSchema, type TaskList } from '../../src/core/task-lists.ts'

const directories: string[] = []
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

const personFixture = (): PersonCard => ({
  id: 'owner',
  name: '小王',
  description: '第一段\n\n## 不是新节，只是简介里的标题\n第三段',
  requirements: [{ id: 'r1', text: '以后都用中文回复', eventIds: ['event-1'] }],
  relations: [{ personId: 'colleague', description: '同一团队\n负责发布', eventIds: ['event-2'] }],
  updatedAt: '2026-11-10T00:00:00.000Z',
})

const taskFixture = (): TaskList => ({
  id: 'task-1',
  title: '发布准备',
  plan: '## 步骤\n\n1. 检查\n\n## 来源\n这是计划正文，不是来源节。\n\n结尾。',
  sources: [{ kind: 'chat', id: 'message-1', path: join(tmpdir(), 'a-->b.md') }],
  todos: [{ id: 'todo-1', text: '确认清单', done: false }],
  notes: [{ id: 'note-1', text: '告诉小王', recipient: '小王' }],
  updatedAt: '2026-11-10T01:00:00.000Z',
})

it('round-trips a person card, keeps relation IDs and reads hand-edited text', () => {
  const card = personFixture()
  const content = encodePerson(card)
  expect(content).toContain('## 人物简介 <!-- {"section":"description"} -->')
  expect(content).toContain('## 要求 <!-- {"section":"requirements"} -->')
  expect(content).toContain('## 关系 <!-- {"section":"relations"} -->')

  const decoded = decodePerson(content, 'memory/people/owner.md')
  expect(decoded.changed).toBe(false)
  expect(decoded.content).toBe(content)
  expect(decoded.value).toMatchObject({ id: 'owner', name: '小王', description: card.description,
    requirements: card.requirements })
  expect(decoded.value.relations[0]?.id).toBeTruthy()
  expect(decoded.value.relations[0]).toMatchObject({ personId: 'colleague', description: '同一团队\n负责发布',
    eventIds: ['event-2'] })
  expect(encodePerson(decoded.value)).toBe(content)

  const edited = content.replace('第一段', '改过的第一段').replace('以后都用中文回复', '以后都用英文回复')
  const after = decodePerson(edited, 'memory/people/owner.md')
  expect(after.changed).toBe(false)
  expect(after.content).toBe(edited)
  expect(after.value.description).toContain('改过的第一段')
  expect(after.value.requirements[0]).toMatchObject({ id: 'r1', text: '以后都用英文回复' })
})

it('recognizes a section by its marker key, so a heading reworded by hand still reads', () => {
  const card = personFixture()
  const reworded = encodePerson(card).replace('## 人物简介 <!--', '## 简介 <!--')
  expect(decodePerson(reworded, 'memory/people/owner.md').value).toMatchObject({ id: 'owner', description: card.description,
    requirements: card.requirements })
  // A heading whose marker names another section is still out of place.
  const misplaced = encodePerson(card).replace('{"section":"description"}', '{"section":"relations"}')
  expect(() => decodePerson(misplaced, 'memory/people/owner.md')).toThrow('expected section')
})

it('round-trips a task list, keeps plan headings as text and preserves source paths and checkbox state', () => {
  const task = taskFixture()
  const content = encodeTask(task)
  expect(content).toContain('## 来源\n这是计划正文')
  expect(content).not.toContain('a-->b.md')
  expect(content).toContain('- [ ] 确认清单 <!-- {')

  const decoded = decodeTask(content, 'memory/tasks/task-1.md')
  expect(decoded.changed).toBe(false)
  expect(decoded.content).toBe(content)
  expect(decoded.value.plan).toBe(task.plan)
  expect(decoded.value.sources).toEqual(task.sources)
  expect(decoded.value.todos[0]).toMatchObject({ id: 'todo-1', text: '确认清单', done: false,
    kind: 'todo', sources: [], createdAt: task.updatedAt })
  expect(decoded.value.notes[0]).toMatchObject({ id: 'note-1', text: '告诉小王', recipient: '小王',
    kind: 'note', sources: [], createdAt: task.updatedAt })
  expect(encodeTask(decoded.value)).toBe(content)

  const edited = content.replace('- [ ] 确认清单', '- [x] 手工改过的清单').replace('告诉小王', '告诉小李')
  const after = decodeTask(edited, 'memory/tasks/task-1.md')
  expect(after.changed).toBe(false)
  expect(after.content).toBe(edited)
  expect(after.value.todos[0]).toMatchObject({ id: 'todo-1', text: '手工改过的清单', done: true })
  expect(after.value.notes[0]).toMatchObject({ id: 'note-1', text: '告诉小李', recipient: '小王' })
})

it('round-trips task attachments and leaves files without the section unchanged', () => {
  const task = taskFixture()
  const attachments = [
    { id: 'att-1', path: resolve('memory', 'files', '说明.txt'), name: '说明' },
    { id: 'att-2', path: resolve('memory', 'files', 'raw.bin') },
  ]
  const content = encodeTask({ ...task, attachments })
  expect(content).toContain('## 附件 <!-- {"section":"attachments"} -->')
  expect(content).toContain('"id":"att-1"')

  const decoded = decodeTask(content, 'memory/tasks/task-1.md')
  expect(decoded.changed).toBe(false)
  expect(decoded.content).toBe(content)
  expect(decoded.value.attachments).toEqual(attachments)
  expect(encodeTask(decoded.value)).toBe(content)

  const legacy = encodeTask(taskFixture())
  expect(legacy).not.toContain('## 附件')
  const old = decodeTask(legacy, 'memory/tasks/task-1.md')
  expect(old.changed).toBe(false)
  expect(old.content).toBe(legacy)
  expect(old.value.attachments).toEqual([])
  expect(encodeTask(old.value)).toBe(legacy)
})

it('rejects a relative attachment path at the task input boundary', () => {
  const base = { title: '任务', plan: '', sources: [], todos: [], notes: [] }
  expect(TaskListInputSchema.safeParse({ ...base, attachments: [{ id: 'a', path: 'files/a.txt' }] }).success).toBe(false)
  expect(TaskListInputSchema.safeParse({ ...base,
    attachments: [{ id: 'a', path: resolve('files', 'a.txt') }] }).success).toBe(true)
})

it('adds metadata once to hand-written todos and notes, preserving every other byte', () => {
  const task = taskFixture()
  const content = encodeTask(task)
  const todosHeading = '## 待办 <!-- {"section":"todos"} -->\n\n'
  const notesHeading = '## 便签 <!-- {"section":"notes"} -->\n\n'
  const withNewLines = content
    .replace(todosHeading, todosHeading + '- [ ] 手写待办\n')
    .replace(notesHeading, notesHeading + '- 手写便签\n')

  const first = decodeTask(withNewLines, 'memory/tasks/task-1.md')
  expect(first.changed).toBe(true)
  expect(first.content.split('\n')).toHaveLength(withNewLines.split('\n').length)
  expect(first.value.todos.map(todo => todo.text)).toEqual(['手写待办', '确认清单'])
  expect(first.value.notes.map(note => note.text)).toEqual(['手写便签', '告诉小王'])
  expect(first.value.todos[0]?.createdAt).toBe(task.updatedAt)
  expect(first.value.notes[0]?.createdAt).toBe(task.updatedAt)

  const todoLine = first.content.split('\n').find(line => line.startsWith('- [ ] 手写待办'))
  const noteLine = first.content.split('\n').find(line => line.startsWith('- 手写便签'))
  expect(todoLine).toContain('<!-- {')
  expect(todoLine).toContain('"kind":"todo"')
  expect(noteLine).toContain('"kind":"note"')
  expect(first.content.replace(todoLine!, '- [ ] 手写待办').replace(noteLine!, '- 手写便签')).toBe(withNewLines)

  const second = decodeTask(first.content, 'memory/tasks/task-1.md')
  expect(second.changed).toBe(false)
  expect(second.content).toBe(first.content)
  expect(second.value.todos[0]?.id).toBe(first.value.todos[0]?.id)
  expect(second.value.notes[0]?.id).toBe(first.value.notes[0]?.id)
})

it('adds metadata once to hand-written requirements and relations, preserving every other byte', () => {
  const person = personFixture()
  const content = encodePerson(person)
  const requirementsHeading = '## 要求 <!-- {"section":"requirements"} -->\n\n'
  const relationsHeading = '## 关系 <!-- {"section":"relations"} -->\n\n'
  const withNewLines = content
    .replace(requirementsHeading, requirementsHeading + '- 手写要求\n')
    .replace(relationsHeading, relationsHeading + '- colleague：手写关系\n')

  const first = decodePerson(withNewLines, 'memory/people/owner.md')
  expect(first.changed).toBe(true)
  expect(first.value.requirements.map(requirement => requirement.text)).toEqual(['手写要求', '以后都用中文回复'])
  expect(first.value.relations.map(relation => relation.description)).toEqual(['手写关系', '同一团队\n负责发布'])
  expect(first.value.relations[0]?.personId).toBe('colleague')

  const requirementLine = first.content.split('\n').find(line => line.startsWith('- 手写要求'))
  const relationLine = first.content.split('\n').find(line => line.startsWith('- colleague：手写关系'))
  expect(requirementLine).toContain('"eventIds":[]')
  expect(relationLine).toContain('"personId":"colleague"')
  expect(first.content.replace(requirementLine!, '- 手写要求').replace(relationLine!, '- colleague：手写关系'))
    .toBe(withNewLines)

  const second = decodePerson(first.content, 'memory/people/owner.md')
  expect(second.changed).toBe(false)
  expect(second.content).toBe(first.content)
  expect(second.value.requirements[0]?.id).toBe(first.value.requirements[0]?.id)
  expect(second.value.relations[0]?.id).toBe(first.value.relations[0]?.id)
})

it('round-trips independent short-term text and rejects task-bound todo shapes', () => {
  const item: ShortTermItem = {
    id: 'short-1',
    kind: 'agreement',
    text: '第一段\n\n第二段\n最后一行并保留一个空行\n',
    sources: [{ kind: 'chat', id: 'message-1' }],
    createdAt: '2026-11-10T02:00:00.000Z',
  }
  const content = encodeShortTerm(item)
  expect(content).not.toContain('待办')
  const decoded = decodeShortTerm(content, 'memory/short-term/short-1.md')
  expect(decoded.changed).toBe(false)
  expect(decoded.value).toEqual(item)
  expect(encodeShortTerm(decoded.value)).toBe(content)

  expect(() => encodeShortTerm({ ...item, kind: 'todo' })).toThrow(/agreement or experience/)
  expect(() => encodeShortTerm({ ...item, taskId: 'task-1' })).toThrow(/taskId/)
  const todoKind = content.replace('kind: "agreement"', 'kind: "todo"')
  expect(() => decodeShortTerm(todoKind, 'memory/short-term/bad.md')).toThrow('memory/short-term/bad.md')
  const taskId = content.replace('kind: "agreement"', 'kind: "agreement"\ntaskId: "task-1"')
  expect(() => decodeShortTerm(taskId, 'memory/short-term/bad.md')).toThrow('memory/short-term/bad.md')
})

it('reports the file path for malformed headers, sections, checkboxes and metadata', () => {
  const card = personFixture()
  expect(() => decodePerson('not a header\n', 'memory/people/bad.md')).toThrow('memory/people/bad.md')
  expect(() => decodePerson(encodePerson(card).replace('## 要求 <!-- {"section":"requirements"} -->', '## 要求'),
    'memory/people/bad.md')).toThrow('memory/people/bad.md')

  const task = taskFixture()
  expect(() => decodeTask(encodeTask(task).replace('- [ ] 确认清单', '- [~] 确认清单'),
    'memory/tasks/bad.md')).toThrow('memory/tasks/bad.md')
  expect(() => decodeTask(encodeTask(task).replace('<!-- {"id":"todo-1"', '<!-- {"id":oops'),
    'memory/tasks/bad.md')).toThrow('memory/tasks/bad.md')
})

it('decodes from the supplied content without writing the source file', () => {
  const root = mkdtempSync(join(tmpdir(), 'memory-markdown-'))
  directories.push(root)
  const path = join(root, 'owner.md')
  const content = encodePerson(personFixture())
  writeFileSync(path, content, 'utf8')
  const before = readFileSync(path)
  const decoded = decodePerson(readFileSync(path, 'utf8'), path)
  expect(decoded.changed).toBe(false)
  expect(readFileSync(path)).toEqual(before)
})
it('preserves task memory kinds and follows hand-edited visible sources and relation targets', () => {
  const task = taskFixture()
  const markdown = encodeTask({ ...task, notes: [{ id: 'lesson', kind: 'experience', text: '保留经验类型', sources: [], createdAt: task.updatedAt }] })
    .replace('chat:message-1 ', 'event:edited-event ')
  const read = decodeTask(markdown, 'task.md').value
  expect(read.notes[0]?.kind).toBe('experience')
  expect(read.sources[0]).toMatchObject({ kind: 'event', id: 'edited-event' })
  const person = encodePerson(personFixture()).replace('- colleague：', '- edited-person：')
  expect(decodePerson(person, 'person.md').value.relations[0]?.personId).toBe('edited-person')
})
