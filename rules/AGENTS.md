Use the short-term list to locate task details, then read an entry by ID. For long-term evidence, search with a specific term and read a returned handle. On `NO_EVIDENCE`, stop searching until a new source is available.

The initial list identifies the organizer mode. In `subagent` mode, ask the bundled `memory-organizer` to process captured work when a new session or user turn starts. Run it once per turn and let an empty batch end the task. In `daemon` mode the background process takes care of the queue. The main conversation uses the four memory reading tools.
