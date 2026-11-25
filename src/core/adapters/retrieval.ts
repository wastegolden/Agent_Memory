/** Main-session tools for memory retrieval selections. */
import { z } from 'zod'
import { memoryKinds, type MemoryRetrieval } from '../retrieval.ts'
import { tool, type Tool } from './tool.ts'

/** IDs become file names: validate external IDs once at the shared tool boundary, and reuse the rule in the unified read entry. */
export const MemoryIdSchema = z.string().regex(/^[\p{L}\p{N}_-]+$/u)

/**
 * `jarvis_memory_selection`'s arguments, one union entry instead of a new tool: an id reopens a saved selection,
 * `used_by` asks which records still reference one memory, and `diagnostics` lists the broken files the index reports.
 */
const SelectionInputSchema = z.union([
  z.object({ id: MemoryIdSchema }).strict(),
  z.object({
    action: z.literal('used_by'),
    kind: z.enum(memoryKinds).describe('The memory kind to look references up for: person, event, task, short-term, document, archive, experience or selection. Document, archive and experience live in the documents, tasks and experiences index libraries.'),
    id: z.string().min(1).describe('Referenced record or entry ID, including managed memory:person:property entry IDs.'),
  }).strict(),
  z.object({ action: z.literal('diagnostics') }).strict(),
])

/** Memory search and selection reading for the main Session. */
export function retrievalTools(retrieval: MemoryRetrieval): Tool[] {
  return [
    tool({ name: 'jarvis_memory_search', description: 'Search memory only by the given people, tasks, project or text, and save the selection with each item\'s reason, real sources and version. Person IDs select their cards and events plus recipient-matched short-term records; task IDs select the task list, its short-term records, events and archived task; a project selects its own task, tasks whose runtime project_id matches, and project events; text selects matching documents, experiences and current person, task and short-term text.',
      schema: z.object({
        person_ids: z.array(MemoryIdSchema).optional(),
        task_ids: z.array(MemoryIdSchema).optional(),
        project_id: MemoryIdSchema.optional(),
        text: z.string().optional(),
        reason: z.string(),
      }).strict(),
      execute: async args => retrieval.retrieve({
        ...(args.person_ids ? { personIds: args.person_ids } : {}),
        ...(args.task_ids ? { taskIds: args.task_ids } : {}),
        ...(args.project_id ? { projectId: args.project_id } : {}),
        ...(args.text ? { text: args.text } : {}),
        reason: args.reason,
      }) }),
    tool({ name: 'jarvis_memory_selection', description: 'Reopen a saved memory selection, ask what still references a memory, or list broken memory files. {id} reopens the selection: its snapshot stays unchanged, and each selected item reports the current text and version of its source and whether that version changed. {action:"used_by",kind,id} reads the editable current views first, then returns the records whose references name that memory, with the selection snapshots that selected it. {action:"diagnostics"} returns the memory paths currently reported as broken.',
      schema: SelectionInputSchema,
      execute: async args => {
        if ('action' in args) {
          return args.action === 'used_by' ? retrieval.usedBy(args.kind, args.id) : retrieval.diagnostics()
        }
        return retrieval.read(args.id)
      } }),
  ]
}
