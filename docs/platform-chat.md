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
flag only the main process signs after its own dialog) and the session's
temporary model choice (`set-model`, issue #73). It accepts no URL,
authentication header, executable, physical path or renderer-supplied write
content. The main-frame check also applies to this IPC. Python obtains the business
session from the existing OS secret store and sends same-origin requests with
the existing session-cookie and CSRF contract. Device credentials do not
authenticate chat. No model, Agent graph, shell or fallback executor is added
to Desktop.

Issue #79 adds the conversation export to the same command union: the renderer
names `export` with the mode (`session` or `message`) and the target message id
only. The command never reaches the Runtime; the trusted main process derives
the Markdown document from its own `state` reply, so the export is exactly the
interface-visible message log — message text verbatim (the interface itself
renders plain preformatted text, and the document says so), clarification
prompts as visible prompt text with an answered marker, and nothing else:
no attachments, no local task receipts, no server events, no message/request
identifiers. The destination is a native save dialog with a suggested file
name; the write is staged and renamed atomically, the scope is re-checked
after the dialog like the artifact download, and the outcome rides the reply
snapshot as a transient `exportStatus` the same way `downloadStatus` does.

## Model selection (issue #73)
## Model selection (issue #73)

The settings entry restores the original position with a restricted
`desktop:models` IPC surface: the Server's own permission-filtered model
catalog (`GET /api/models`), the account-level default written through the
same preferences endpoint the Web uses (`PATCH /api/v1/auth/preferences` with
the owner-fence header, 409 mapping to the identity-changed category), and the
备用模型 pick stored as a device-local preference because the platform
preference schema has no field for it. No provider, Base URL or API-key field
exists anywhere in this family — the Desktop never holds a model credential —
and no Ollama section exists; the absence is stated in place.

Each submission resolves the model in the open order — the session's temporary
choice, then the account default (read authoritatively per submission), then no
name (the platform default applies) — and rides the Run context's `model_name`.
A choice that left the authorized list is never silently replaced: without a
usable fallback the submission stops before anything is sent with an explicit
unavailable category and the chat pauses sending until the user switches; with
one, the sanctioned switch re-submits once and the session displays the actual
model and the switch story. Only model-attributable Server refusals trigger the
bounded fallback re-submission — today exactly the fixed denial details
"Model access denied" and "is not in the configured model allowlist" — and
every other failure keeps the existing uncertain-submission contract.

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

Issue #76 restores the collab mode switch to the composer's input area. Every
composer send carries `collab` as an explicit boolean, mapped onto the
platform's own delegation seam (`context.subagent_enabled`): true lets the
lead Agent dispatch parallel sub-agents for that run, false is the
single-Agent mode. The platform's own silent default is delegation OFF and
the Web client's mode switch sends the same explicit boolean, so the
desktop's on state — the composer's default — must say so too. The flag
rides send commands only; an answer run keeps the platform default. Which
sub-agents exist stays the lead Agent's own configuration (the platform
ANDs the flag with its allowlist); the desktop provides no team management
surface and no local orchestration channel. While collaboration is off, the
composer's at-mention picker offers no candidates — a delegation entry that
could not take effect is never shown.

The platform reports parallel sub-agent execution through its own `task_*`
custom events (`task_started`, `task_running`, `task_completed`,
`task_failed`, `task_cancelled`, `task_timed_out`), with the parent run's
`tool_call_id` as the sole correlation key. The desktop folds those frames
into a bounded structured ledger on the snapshot (`subagents`, at most 50
entries, keyed by task id in first-seen order) beside the raw event record.
Every field is a bounded projection of what the platform pushed: the status
name mirrors the event type exactly, `step`/`totalSteps` mirror
`message_index`/`total_messages`, usage is the platform's cumulative
snapshot, and a task whose end was never reported stays `running`. Nothing is
invented between events, and a frame about an unknown or malformed task
identity is dropped. The sub-agent's type name is derived only from the
parent AI message's published `task` tool_calls. A copied result is bounded
at 8,000 characters, an error at 2,000, a description at 2,000 — the full
report stays in the conversation's own tool messages. The ledger belongs to
the run that dispatched it: a new turn starts empty, and reopening a Thread
rebuilds visible progress only from what the platform itself streams again.

Issue #78 restores 消息级分支 as one more restricted `desktop:chat` command
shape: `branch` names the target turn only — one assistant message id plus,
when the transcript groups more than one, the rest of that completed
assistant turn's ids. The renderer offers the action on Agent messages of a
settled turn only (no in-flight run, no stream, no open clarification); the
Runtime pre-checks the same `threads:write` permission the rename path
checks and then rides the platform's own Thread branch endpoint
(`POST /api/threads/{id}/branches`). The Server owns everything else:
checkpoint discovery, the new Thread row, the inherited history and the
project membership; the branch re-opens through the normal load path, so its
transcript is read back from the platform's new Thread and no local copy of
history exists at any point. In-flight work is refused by the Server itself
and surfaces as the shared conflict category with the source session still
open. No title rides the wire — the Server's default branch naming applies.
The branch action is also the only place a project folder binding crosses
sessions: a source session with a binding hands a copy to its branch and a
source without one stays unbound, decided by one tested function
(`inherited_binding`); the binding producer and its run-context consumer
arrive with the project folder binding ticket (二期 #92), until which every
branch resolves to no binding. A successful branch asks the session sidebar
to re-read the Server's own list — the new Thread exists there now.

## Platform project management (issue #91)

The session sidebar gains the platform project directory in the same place
the Web has it. Projects exist only as platform Projects: create, switch,
rename, archive/restore and delete ride the Server's own Project API through
one restricted `desktop:projects` channel, and the reply always carries the
Server's own post-action list plus the account's `projects:write` /
`projects:delete` permissions, so no second project roster is ever stored on
this device and the same account reads the same projects on any machine it
logs into. Create and rename carry a bounded name only — instructions and
presentation stay platform-side — and every write is refused before any
Server call when the account lacks the permission, with the Server
re-checking and staying authoritative. A delete is confirmed twice (renderer
popconfirm, then the trusted main-process dialog) and states plainly that
the project's sessions survive as loose sessions; no operation in this
family touches local files, workspace grants or the receipt ledger — the
desktop binds nothing local to a project here (the project folder binding
arrives with #92 on its own ticket).

The sidebar projects each session by the Server's own membership stamp
(`metadata.deerflow_project_id`), carried on every thread row the
`desktop:threads` reply returns. The grouping is a display projection of
that reply — never a merge of local state — and a row whose project id the
current list does not know falls back to the 散会话 bucket instead of
inventing a group. The project view switch (全部会话 / 散会话 / one project)
is this device's view state; the project list itself always comes from the
platform. 散会话移入项目 rides the Server's own move endpoint
(`POST /api/threads/{id}/move`) as one more `desktop:threads` action gated
by the same `threads:write` permission as rename; moving back out to loose
is not a desktop action in this ticket, and the Server fails closed on a
missing, foreign or archived project.

When a project is selected, a newly created chat names it on the Thread
create body (`project_id`), so 不选项目也能直接开聊 stays the loose-session
path and a selected project's new sessions are born on the Server inside it;
the Server rejects a missing, foreign or archived project by name. Switching
projects never clears in-flight work — the Run lives on the Server exactly
as the background-sessions contract states, and reopening any session
reattaches its truthful state.

History, state, export, model selection and every other chat path are
unchanged.

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

## Background sessions and notification jump-back

Switching sessions never aborts a Run: the Run lives on the Server with
`on_disconnect='continue'`, the desktop only stops foreground stream
consumption, and reopening the Thread reattaches the truthful state. The
Runtime keeps a bounded observation ledger of runs a user leaves behind and
emits one `notify` event per fact on the status stdout — a run that has since
reached an end state, or a device approval ask on a session the user cannot
currently see. Events carry identity facts only (thread, run, task, kind, a
bounded summary line), are deduplicated, and are token-scrubbed like every
other surface. The cadence bounds Server polling only; the desktop never sets
a concurrency limit of its own — the platform and device capability
intersection decide what runs in parallel.

The trusted main process parses each event strictly, keeps the bounded
notification ledger, shows the OS toast and pushes the full list to the
renderer after every change; the renderer's notification center pane and
sidebar bell read the same ledger, and activating a notification — from a
toast or a center row — focuses the window and opens the event's session
through the same handshake the sidebar uses. See
[issue #77 acceptance](acceptance/issue-077/report.md).

## Platform reachability and the disconnect pause (issue #80)

The Runtime records the last observed Server contact outcome at its one
transport seam — the same HTTP boundary every chat request passes through. A
socket-level failure marks the platform unreachable with the named category
(`CHAT_SERVER_UNAVAILABLE`), and so does a 5xx answer (`CHAT_SERVER_ERROR`) —
the server side failing is the same outage a dead socket is. A 4xx refusal
marks the platform reachable because identity and request problems are not
outages. Before the first observation the display stays optimistic; the
moment a failure is observed, the snapshot carries
`platform: { reachable: false, detail }` and the chat panel states the outage
explicitly — an outage is never a silent failure.

While the platform is observed unreachable, new work is paused by name:
`create`, `send`, `answer` and `branch` are refused with
`CHAT_PLATFORM_UNREACHABLE` before any Server round-trip, the composer states
the pause with its reason, and the refused Turn is not consumed. Observation
and recovery actions stay available and fail honestly
(`CHAT_SERVER_UNAVAILABLE`) while the outage lasts.

In-flight outcomes stay unknown, never fabricated. A submission whose run
`POST` dies mid-flight marks the stream `uncertain`; a run stream that
outlives its bounded resumes marks it `disconnected` (issue #37). The panel
labels those runs 结果待核实, nothing is re-dispatched, and the unknown Turn's
idempotency fence holds — the Server may have accepted what this device could
not observe, so a fresh user retry is the only submission that ever happens.

When the platform answers again, the session reconciles by itself: one
guarded attempt after a bounded cooldown (5 seconds), shared by the chat
state poll and the Runtime status loop so recovery never depends on a panel
being open. The shared entry point only schedules the attempt — the probe
and the record reload run on their own thread, and the reload lands as one
atomic state commit, the same discipline as the tasks poll: network
observations never hold up a user's command. When nothing else has talked to
the Server since the last failure, the attempt carries its own short
reachability probe (3-second
timeout); once the platform answers, it reloads the Thread through the
normal load path — which restores the Server's own run record and messages,
re-observes a run that is still executing, and merges the task history. The
record is backfilled from the platform, never from the device. An unresolved
Stop keeps its explicit reconcile contract instead. No local model,
orchestration channel or fallback executor exists anywhere on this path; the
device-side task channel keeps its own receipt replay (`replay_receipts`)
and `DEVICE_PAUSED` admission semantics unchanged.
