# Platform chat and history

After browser login, the chat card lists the authenticated user's canonical
Agent and Skill resources. Entries retain their ID, visibility and latest
published version. Suspended, unpublished, unreadable or dependency-unavailable
entries are disabled. An optional selected Skill must belong to the Agent's
dependency closure. Server Run admission remains authoritative for permissions,
resource closure and immutable version snapshots; the UI displays the actual
`selection_snapshot` returned for each Run.

The renderer calls one restricted `desktop:chat` IPC method. Its command union
allows state, catalog refresh, Thread creation/open, send, human-input answer,
reconnect, scoped Run stopping, an exact local approval decision and the
session permission tier (#74: one explicit tier switch whose full-tier confirm
flag only the main process signs after its own dialog). It accepts no URL,
authentication header, executable, physical path or renderer-supplied write
content. The main-frame check also applies to this IPC. Python obtains the business
session from the existing OS secret store and sends same-origin requests with
the existing session-cookie and CSRF contract. Device credentials do not
authenticate chat. No model, Agent graph, shell or fallback executor is added
to Desktop.

Issue #72 adds one more restricted platform-facing method, `desktop:threads`,
for the session sidebar's Thread management. Its command union allows list,
search, rename and delete only. Every reply carries the Server's own
post-action list plus the account's thread permissions, so the sidebar never
keeps a local roster and never merges state. The wire always carries the chat
session scope the Runtime itself last reported; Python re-fences it against a
freshly computed session, so a stale identity is rejected. Rename rides the
Server's state endpoint whose `values.title` the Server syncs into the Thread
display name; delete requires the Server's own success flag and is confirmed
in a trusted main-process dialog first. Deleting a Thread never touches the
local receipt ledger — unconfirmed receipts stay queryable. The Server's
`threads:write`/`threads:delete` permission and owner checks stay
authoritative on every request; the renderer only grays out operations early
and explains why.

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
time out after 15 seconds and IPC after 30 seconds. The run stream is the one
long-lived exception: its reads tolerate a 90-second silent window (issue #37 —
one model phase can stay quiet far past any request round-trip), and a stream
that still ends without the Server's end event resumes at most three times from
the last delivered event id before the disconnect becomes visible. Timeouts
never trigger an automatic submission retry. Large responses return an explicit
size error.

Use the [issue #99 fixture instructions](../scripts/acceptance/issue-99/README.md)
for reproducible protocol checks and the real Gateway/Desktop probe. The
[acceptance report](acceptance/issue-99/report.md) records protocol checks,
real-provider scenarios and installed-app acceptance separately.

## Local workspace

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

Server exposes `local.files.list`, `local.files.read`, `local.files.search`
and `local.files.write`
through the selected canonical Agent Run. `path` is required; search also
requires a literal `query` of at most 256 characters. Published Agent
`tool_groups: [local.files]` enables these operations; an explicit empty list
withholds them. The deployment's `IDEER_LOCAL_READ_CAPABILITIES` comma-separated
allowlist defaults to the three read operations; an empty value disables them.
`IDEER_LOCAL_WRITE_CAPABILITIES` defaults to `local.files.write`; an empty value
disables writes. The read allowlist continues to govern only read operations.
The authenticated caller's Resource USE permission, live device owner and
capabilities, frozen Agent limits and local policy must all allow execution.
The legacy direct `/api/devices/{id}/tasks/local` endpoint rejects these file
operations with `CANONICAL_RUN_REQUIRED`.

Desktop advertises the implemented workspace operations after a directory grant.
Legacy configured roots, Python and MCP execution remain unavailable in Desktop
mode. The standalone legacy Runtime classes and their tests remain.

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

## Approve one text write

`local.files.write` accepts a logical `path` and UTF-8 `content`, up to 65,536
bytes without NUL characters. It creates a file or replaces its contents;
parent directories must already exist. It uses the same current identity,
directory generation, protected-path and link checks as reads. Windows pins
ancestor handles during replacement. The Runtime writes exact UTF-8 bytes,
including the submitted newlines, then reads back and verifies the result.

The original chat displays the path, exact proposed content, Run, task ID and
request digest. Its only decisions are allow once and reject. Approval travels
through Desktop's owned local control channel and is checked against the pending
task, digest and current chat scope. A Web consent response cannot authorize
the write. A changed request requires its own approval. Local DENY, expired or
abandoned prompts, changed identity or workspace, cancellation before execution
and failed durable admission prevent writing. Existing always-allow settings do
not skip Desktop's per-task write approval.

Issue #74 adds the one standing exception: the chat session's own permission
tier. In the `autonomous` tier (and for writes also in the `full` tier) a write
whose target the confirmed workspace proves inside, and outside the protected
names, runs without a per-task prompt — the tier itself is the standing answer,
recorded in the receipt as `tier:<tier>` and in the audit log. Every other
capability, an unprovable or outside target, and a session at the default
`ask_first` tier keep the per-task approval above. The tier never overrides a
local DENY, the protected-path refusals or the workspace identity checks, and
it is scoped to the loaded session only: reloading or reopening a thread falls
back to `ask_first`, and that expiry is audited like any switch.

The Runtime admits the original task into its identity-bound receipt ledger
before execution. A failed completion record or unverifiable readback is shown
as a result that needs verification. Completion-storage failure pauses further
writes, including requests already waiting for approval. Admission, receipt
acknowledgment and history cleanup do not clear that failure. After storage is
repaired, a successfully saved read-only task receipt can demonstrate recovery;
it does not resolve or repeat the earlier uncertain write.
While that uncertain record remains, restarting Runtime conservatively pauses
writes again. A new read with a durably saved receipt verifies storage for the
current process before another write can proceed.
Disconnects and restarts replay receipts
under their original binding; they do not repeat the write. Cancellation does
not roll back an effect or replace its completed receipt with a claim that it
never happened. Late results stay associated with the original Run.

The [issue #102 runners](../scripts/acceptance/issue-102/README.md) exercise
approval, refusal, storage faults and disconnect/cancellation behavior. The
[scenario report](acceptance/issue-102/report.md) records what was executed on
the actual candidate and installation.

## Stop and recover local work

Stop first saves a device-bound Run fence and attempts to cancel current local
tasks. Future deliveries for that Run cannot execute, including after Runtime
restart. Desktop then requests Server interruption using the original Thread
and Run. A requested stop is separate from an authoritative Run or task terminal
state. An uncertain cancellation can be explicitly retried. Already committed
file modifications remain in place.

The original Thread displays Server task facts and local receipt/upload facts
separately. Its owned, paginated Server history survives Server restarts; the
local metadata ledger preserves Thread association independently of the signed
receipt metadata. Unknown effects remain results needing verification. Late
receipts reconcile historical tasks without submitting another Run or write.
Clearing confirmed history cannot remove task admission or stopped Run fences.

Background history polling does not hold the command queue during network
requests. Identity and Thread generations reject obsolete responses. History
errors label cached results as needing another check; they never imply success.
See [issue #104 acceptance](acceptance/issue-104/report.md) and its
[fault runners](../scripts/acceptance/issue-104/README.md).
