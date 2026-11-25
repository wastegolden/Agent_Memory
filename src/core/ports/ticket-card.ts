import { latestReport, type Ticket } from './ticket-model.ts'
import { ticketStage } from './ticket-stage.ts'
const SOURCE='github'
const pullNumber = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:`) ? Number(thread.slice(SOURCE.length + 1)) : undefined
export const pullsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => pullNumber(item.thread) ?? [])
export const pullOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => pullsOf(ticket, true).at(-1) ?? pullsOf(ticket).at(-1)

export function preview(text: string): string { return text.replace(/\s+/g, ' ').slice(0, 160) }
/** The states a ticket card shows: an open ticket's stage (docs/003), and an ended ticket's outcome. */
export const TICKET_STATES = ['person/delivery', 'person/answer', 'person/review', 'person/blocked', 'person/failed', 'working', 'working/queued', 'idle',
  'completed', 'merged', 'closed', 'dropped', 'stopped'] as const
export type TicketCardState = typeof TICKET_STATES[number]
function cardState(ticket: Ticket): TicketCardState {
  if (ticket.ended) return ticket.ended.outcome
  const stage = ticketStage(ticket)
  if (stage.stage === 'person') return `person/${stage.action}`
  return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
}
export function ticketCard(ticket: Ticket) {
  const ended = ticket.ended && { at: ticket.ended.at, by: ticket.ended.by, reason: ticket.ended.reason ?? ticket.ended.outcome }
  const { attention } = ticket
  return { ticket_id: ticket.id, title: ticket.title, state: cardState(ticket), strength: ticket.mandate.strength,
    ...(pullOf(ticket) ? { pr_number: pullOf(ticket) } : {}), ...(ended ? { ended } : {}),
    ...(attention ? { attention: { question: attention.question, ...attention.triggerId ? { trigger_id: attention.triggerId } : {} } } : {}),
    ...(ticket.approval ? { approval: { request_id: ticket.approval.requestId, tool: ticket.approval.tool,
      ...(ticket.approval.reason ? { reason: ticket.approval.reason } : {}), requested_at: ticket.approval.requestedAt } } : {}),
    ...(ticket.stages ? { stages: ticket.stages.map(stage => ({ id: stage.id, title: stage.title, done: !!stage.doneAt })) } : {}),
    ...(ticket.project ? { project_id: ticket.project.ticketId, ...ticket.project.stageId ? { stage_id: ticket.project.stageId } : {} } : {}),
    preview: preview(latestReport(ticket)?.summary ?? ''), read: `ticket/${ticket.id}` }
}
