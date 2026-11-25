/** J2 composition for a trusted local host. This is not the externally exposed MCP surface. */
import { isAbsolute } from 'node:path'
import { MemoryIndex } from './index.ts'
import { MemoryEvents } from './events.ts'
import { TaskLists } from './task-lists.ts'
import { PersonCards } from './people.ts'
import { ShortTerm } from './short-term.ts'
import { MemoryChanges } from './changes.ts'
import { MemoryOrganizer, type OrganizerLimits } from './organizer.ts'
import { Documents } from './documents.ts'
import { Experiences } from './experiences.ts'
import { MemoryRetrieval } from './retrieval.ts'
import { TaskReduction } from './task-reduction.ts'
import { ProjectArchives } from './project-archives.ts'
import { MemoryReviews } from './reviews.ts'
import { reviewReads } from './review-reader.ts'
import { PersonaChanges, type PersonaChangeDeps } from './persona-changes.ts'
import { MemoryMethods } from './methods.ts'
import { MethodReplay } from './method-replay.ts'
import { MethodActivation, type MethodActivationDeps } from './method-activation.ts'
import { ExperienceMethodReview, reviewExperience, type ReviewExperienceOptions } from './experience-method-review.ts'
import { selectEventMemory, type EventMemoryInput, type SelectEventMemoryOptions } from './compaction-selection.ts'
import type { MemoryModelContext, MemoryRoleModel } from './ports/model.ts'
import type { Ticket } from './ports/ticket-model.ts'

export interface LocalJ2Ports {
  ticket?(id: string): Ticket | undefined
  openTickets?(): Iterable<Ticket>
  model?: { context: MemoryModelContext; route(): MemoryRoleModel | undefined
    selectionOptions?(reason: string | undefined, runId: string | undefined): Omit<SelectEventMemoryOptions,'method'>
    reviewOptions?(): ReviewExperienceOptions }
  persona?: Pick<PersonaChangeDeps,'persona'|'path'|'messages'>
  confirmation?: Pick<MethodActivationDeps,'ownerMessage'|'message'>
  limits?: OrganizerLimits
}
export function openLocalJ2(root: string, ports: LocalJ2Ports = {}) {
  if (!isAbsolute(root)) throw Error('J2 root must be an absolute, host-owned filesystem path')
  const index = new MemoryIndex(root)
  try {
    index.rebuild([])
    const events = new MemoryEvents(root,index)
    const taskLists = new TaskLists(root,ports.ticket ?? (() => undefined),index)
    const people = new PersonCards(root,events,index)
    const shortTerm = new ShortTerm(root,taskLists)
    const documents = new Documents(root,index)
    const experiences = new Experiences(root,shortTerm,events)
    const changes = new MemoryChanges(root,events)
    const taskReduction = new TaskReduction(root,taskLists)
    const projectArchives = new ProjectArchives(root,taskLists)
    const personaChanges = ports.persona ? new PersonaChanges(root,{...ports.persona,events,index}) : undefined
    const reviews = new MemoryReviews(root,reviewReads({events,people,tasks:taskLists,shortTerm,documents,index,persona:personaChanges,experiences}))
    const retrieval = new MemoryRetrieval(root,{events,people,shortTerm,tasks:taskLists,documents,experiences})
    const methods = new MemoryMethods(root)
    const model = () => {
      const route = ports.model?.route()
      if (!ports.model || !route) throw Error('No authorized local memory model adapter configured')
      return {port:ports.model,route}
    }
    async function selectMemory(input: EventMemoryInput, options: {
      methodVersion?: string; signal?: AbortSignal; reason?: string; runId?: string
    }={}) {
      const method = options.methodVersion === undefined ? methods.active() : methods.get(options.methodVersion)
      if (!method) throw Error('Absent memory method')
      const {port,route} = model()
      const output = await selectEventMemory(port.context,route,input,options.signal,{
        ...port.selectionOptions?.(options.reason,options.runId),method,
      })
      return {...output,methodVersion:method.version}
    }
    const organizer = new MemoryOrganizer(root,{events,shortTerm,changes,people,tasks:taskLists,
      select: (input,signal,context) => selectMemory(input,{signal,reason:context?.reason,runId:context?.runId}),
      defer: input => reviews.defer({operationId:input.operationId,target:input.target,mode:input.mode,
        sources:input.sourceIds.map(id => input.observedSources.find(item=>item.id===id) ?? {kind:'event',id})}),
    },ports.limits ?? {threshold:6,batchSize:32})
    const methodReplay = new MethodReplay(root,{methods,select:selectMemory,capture:ids=>({
      events:ids.map(id=>{const r=events.get(id);return {id,seq:r.seq,event:{kind:r.event.kind,at:r.event.at,text:r.event.text,
        source:{kind:r.event.source.kind,id:r.event.source.id},taskId:r.event.taskId}}}),
      existing:shortTerm.list().map(r=>({id:r.id,kind:r.kind,text:r.text,taskId:r.taskId,recipient:r.recipient,
        sources:r.sources.map(s=>({kind:s.kind,id:s.id}))})),
      tasks:taskLists.list().map(r=>({id:r.task.id,title:r.task.title})),
      people:people.list().map(r=>({id:r.id,name:r.name,requirements:r.requirements.map(x=>({id:x.id,text:x.text,eventIds:[...x.eventIds]}))})),
    })})
    const methodActivation = ports.confirmation ? new MethodActivation(root,{methods,...ports.confirmation,getComparison:id=>{
      const r=methodReplay.readComparison(id)
      return {id,status:r.status==='completed'?'completed':'failed',baselineVersion:r.baseline.version,candidateVersion:r.candidate.version}
    }}) : undefined
    const experienceReview = new ExperienceMethodReview(root,{methods,experiences,events,review:(input,signal)=>{
      const {port,route}=model()
      return reviewExperience(port.context,route,input,signal,port.reviewOptions?.())
    }})
    for(const ticket of ports.openTickets?.() ?? []) taskLists.ensure(ticket)
    people.list(); taskLists.list(); shortTerm.reconcile(); retrieval.reconcile()
    return { index,events,taskLists,people,shortTerm,documents,experiences,changes,taskReduction,projectArchives,
      personaChanges,reviews,retrieval,methods,organizer,methodReplay,methodActivation,experienceReview,selectMemory,close:()=>index.close() }
  } catch(e) { index.close(); throw e }
}
export type LocalJ2 = ReturnType<typeof openLocalJ2>
