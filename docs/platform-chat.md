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

## Read-only local workspace

The Runtime card opens a native directory chooser and a separate native data
boundary confirmation. A grant permits file names and requested UTF-8 text to
reach Server and the model on demand. It never uploads an entire directory or
creates a platform Resource. The renderer cannot supply a physical path or
execute a local file operation.

The local grant persists across restarts and same-account/device reauthentication.
It binds the platform origin, user, device, device signing public key and broker
pin. A directory selection creates a fresh `/workspace/<uuid>` logical root and
records the directory identity. Changing directory or binding invalidates old
paths. Login expiry disables access. No physical path or device identifier enters
the model's file tool schema or result.

Server exposes `local.files.list`, `local.files.read`, and `local.files.search`
through the selected canonical Agent Run. `path` is required; search also
requires a literal `query` of at most 256 characters. Published Agent
`tool_groups: [local.files]` enables these operations; an explicit empty list
withholds them. The deployment's `IDEER_LOCAL_READ_CAPABILITIES` comma-separated
allowlist defaults to the three read operations; an empty value disables them.
The authenticated caller's Resource USE permission, live device owner and
capabilities, frozen Agent limits and local policy must all allow execution.
The legacy direct `/api/devices/{id}/tasks/local` endpoint rejects these file
operations with `CANONICAL_RUN_REQUIRED`.

Desktop advertises only the implemented read operations after a directory grant.
Legacy configured roots, file writes, Python and MCP execution remain unavailable
in Desktop mode. The standalone legacy Runtime classes and their tests remain.

Reads accept at most 65,536 bytes of UTF-8 text and reject binary or oversized
files. Listings return at most 500 entries. Literal search visits at most 500
nodes and returns at most 100 matches with 1-based line numbers and up to 1,000
characters per matching line. Results include a logical source path; text reads
also include byte count and SHA-256. Truncated listings/searches identify that
state. Protected credential/configuration paths, the Runtime profile, outside
roots and link/junction/reparse paths fail before content is returned. Windows
opens pin every ancestor against rename and validate the selected root identity.
The existing signed task and receipt chain binds each result or stable error to
its Run and Local Task.

The [issue #100 acceptance runners](../scripts/acceptance/issue-100/README.md)
exercise the real Gateway and installed Windows Runtime with synthetic files.
The [acceptance report](acceptance/issue-100/report.md) binds the candidate,
installer, scenario evidence, review and platform limitations.
