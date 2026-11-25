export interface MemoryRoleModel { provider: string; model: string; reasoningEffort?: string }
interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; [key: string]: unknown }
type ModelChunk = { type: 'text-delta'; text: string } | { type: 'usage'; usage: Usage } | { type: 'finish'; reason: { kind: string } }
type ModelRequest = MemoryRoleModel & { signal?: AbortSignal; maxTokens?: number; messages: Array<{role: 'user'; content: Array<{type: 'text'; text: string}>}> }
export interface MemoryModelContext { llm: {
  resolveCallConfig(model: MemoryRoleModel): Promise<MemoryRoleModel>
  stream(request: ModelRequest): AsyncIterable<ModelChunk>
} }
export async function resolveRoleModel(ctx: MemoryModelContext, model: MemoryRoleModel): Promise<MemoryRoleModel> {
  const result = await ctx.llm.resolveCallConfig(model)
  return { provider: result.provider, model: result.model, ...(result.reasoningEffort ? { reasoningEffort: result.reasoningEffort } : {}) }
}
