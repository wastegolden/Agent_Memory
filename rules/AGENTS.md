Use `short_term_list` to locate task details and `short_term_read` to read an entry by ID. For long-term evidence, use `search` with a specific term and pass a returned handle to `read`. On `REFINE_QUERY`, search one specific topic or term at a time. On `NO_EVIDENCE`, stop searching until a new source is available.

After executing a procedure, call `report_outcome` with its original handle and status (`ok`, `failed`, or `fallback`). Include the 1-based `failedStep` when known for a failed run. Set `outwardDone` when an externally visible step was reached. Verify the external state before retrying such a step or considering a fallback.

The initial list identifies the organizer mode. In `subagent` mode, ask the bundled `memory-organizer` to process captured work when a new session or user turn starts. Run it once per turn and let an empty batch end the task. In `daemon` mode the background process takes care of the queue.
