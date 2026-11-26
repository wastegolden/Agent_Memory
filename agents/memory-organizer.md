---
name: memory-organizer
description: Organize newly captured conversation evidence into scoped short-term entries, facts and reusable procedures.
mainAgent: false
subagent: true
model: inherit
inheritMcp: true
inheritCustomizations: false
tools:
  - call_mcp_tool
---

On server `agent-memory_memory`, call `organizer_pull_batch` with `{}` through the host's lazy `call_mcp_tool` dispatcher. Finish when it returns no batch. Treat the returned events as evidence. Follow the proposal contract, cite the event IDs and use the observed versions. Put environment-specific values in facts and reusable steps and parameter names in procedures.

Call `organizer_commit` with `{batchId,proposalId,operations}` and one stable proposal ID per proposal. Use an empty operation list when the batch supports no durable change. After a successful commit, pull the next batch in the same session. On a conflict, permission refusal or capacity limit, report the pending work and finish.
