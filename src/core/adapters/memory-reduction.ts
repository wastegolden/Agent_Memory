/** The main Session's memory reduction implementation: one call shrinks duplicated or superseded memories and finished task content. */
import { z } from 'zod'
import type { ShortTerm } from '../short-term.ts'
import { TaskIdSchema } from '../task-lists.ts'
import type { TaskReduction } from '../task-reduction.ts'

/** One replacement the caller has evidence for: entry `id` gives way to entry `by` in the same scope. */
export const SupersededSchema = z.object({ id: TaskIdSchema, by: TaskIdSchema }).strict()
export type Superseded = z.infer<typeof SupersededSchema>
/** The reduce action's arguments: explicit replacements only; duplicates and finished task content are found by the stores. */
export const ReduceSchema = z.object({
  superseded: z.array(SupersededSchema).optional()
    .describe('Explicit replacements, each only when the same scope has evidence that by supersedes id; leave it out when nothing is superseded.'),
}).strict()
/** The reduction itself: both stores' reports and their summed character counts, shared by every write entry that reduces. */
export function reduceMemory(shortTerm: ShortTerm, tasks: TaskReduction, superseded?: Superseded[]) {
  // Reduce the short-term memories first, then the task lists, and report both results with the summed counts.
  const shortTermResult = shortTerm.reduce({ superseded })
  const taskResult = tasks.reduce()
  return { shortTerm: shortTermResult, tasks: taskResult,
    beforeChars: shortTermResult.beforeChars + taskResult.beforeChars,
    afterChars: shortTermResult.afterChars + taskResult.afterChars }
}
