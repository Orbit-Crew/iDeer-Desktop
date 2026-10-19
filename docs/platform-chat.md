# Platform chat and history

After browser login, the chat card lists the authenticated user's canonical
Agent and Skill resources. Entries retain their ID, visibility and latest
published version. Suspended, unpublished, unreadable or dependency-unavailable
entries are disabled. An optional selected Skill must belong to the Agent's
dependency closure. Server Run admission remains authoritative for permissions,
resource closure and immutable version snapshots; the UI displays the actual
`selection_snapshot` returned for each Run.

The renderer calls one restricted `desktop:chat` IPC method. Its command union
allows state, catalog refresh, Thread creation/open, send, human-input answer
and reconnect. It accepts no URL, authentication header, executable or local
path. The main-frame check also applies to this IPC. Python obtains the business
session from the existing OS secret store and sends same-origin requests with
the existing session-cookie and CSRF contract. Device credentials do not
authenticate chat. No model, Agent graph, shell or fallback executor is added
to Desktop.

`DesktopChat` uses the existing `/api/resources`, `/api/threads` and thread Run
APIs. Run creation uses `Idempotency-Key`, the human message's stable Turn ID,
`multitask_strategy=reject` and the public `messages-tuple`, `values`, `custom`
stream modes. A separate observation stream cannot resubmit a Run. Root values
and message chunks update the transcript; namespaced and custom events expose
Server tool/subagent progress. A disconnected or uncertain submission disables
new sends until the user restores state. Reconnect reloads Server history and
the existing Run, without replaying the previous POST.

History combines paginated Server message records with checkpoint state. A
human message's `X` and DynamicContext's `X__user` share the same display
identity, matching Server/Web. The latest original Server ID is retained;
different Turns with identical content remain separate. A
Web Thread's Agent slug resolves through its authorized canonical alias, or
through the previous Run's resource snapshot. Structured human-input responses
retain the platform request ID, source and option/text payload. A later visible
plain human reply also resolves the latest open question, matching the Web
client's legacy fallback. Free-text, choice and form cards use the same response
message contract.

Chat state is held in memory under a scope derived from origin, user ID and
business-session reference. Changing that scope or losing authentication clears
resources, history, pending inputs and Turn fences. Old-scope commands are
rejected. No chat transcript, draft, resource catalog or selected Thread is
persisted to browser storage or a shared local cache. Reopening a Thread loads
its durable state from Server. A stopped Runtime or unreachable Server is an
explicit unavailable state.

JSON responses and SSE frames are bounded at 2 MiB. A chat message is limited
to 16,000 characters, at most eight IPC requests can be outstanding, HTTP reads
time out after 15 seconds and IPC after 30 seconds. Timeouts never trigger an
automatic submission retry. Large responses return an explicit size error.

Use the [issue #99 fixture instructions](../scripts/acceptance/issue-99/README.md)
for reproducible protocol checks and the real Gateway/Desktop probe. The
[acceptance report](acceptance/issue-99/report.md) records protocol checks,
real-provider scenarios and installed-app acceptance separately.
