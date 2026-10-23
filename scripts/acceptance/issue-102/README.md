# Issue 102 real write acceptance

The fixture runs the actual isolated Gateway, SQLAlchemy persistence, signed
device broker, Electron main/preload/UI and bundled Windows Runtime. It reuses
Issue 100's deterministic model and synthetic A/B pairing helper. Only the model
and explicitly selected network failures are fixture code. Approvals are actual
clicks on the cards in the original Desktop chat.

Start with current candidate sources, built Electron output, prepared `.runtime`,
installed Node dependencies and the Server's actual Python environment. The
root task owns package/install gates. Coordinate before starting Desktop so
acceptance does not compete with installation or another Runtime.

## Commands

These commands assume the Desktop checkout is
`C:\Users\Neo\.codex\worktrees\f9fc\iDeer-Desktop`. Substitute a new unique
state suffix for each attempt. Both state directories must not already exist.
The Server checkout can be elsewhere; its source is bound before `READY`.

In WSL, start the fixture and retain its process/log until the Desktop creates
the `stop` file:

```sh
cd /home/neowyh/.codex-worktrees/ideer-issue102-server-20261021/backend
.venv/bin/python /mnt/c/Users/Neo/.codex/worktrees/f9fc/iDeer-Desktop/scripts/acceptance/issue-102/server_fixture.py \
  --server-root /home/neowyh/.codex-worktrees/ideer-issue102-server-20261021 \
  --state /tmp/ideer-t102-UNIQUE \
  --desktop-state /mnt/c/Users/Neo/.codex/worktrees/f9fc/iDeer-Desktop/artifacts/issue-102/functional-UNIQUE
```

The fixture prints `READY` and writes `ready.json`. Its state contains synthetic
signing material and databases. Keep it outside committed evidence. On Windows,
pair the synthetic profiles using the candidate's bundled interpreter, then run
either the development entry or the installed wrapper:

```powershell
$taskState = 'C:\Users\Neo\.codex\worktrees\f9fc\iDeer-Desktop\artifacts\issue-102\functional-UNIQUE'
$taskNode = (Resolve-Path '.cache/node22/node-v22.23.3-win-x64/node.exe').Path
& .runtime/python.exe -I scripts/acceptance/issue-102/profiles.py prepare $taskState
# Development, using a new isolated appData directory in this state:
& $taskNode scripts/acceptance/issue-102/desktop.cjs $taskState
# Installed acceptance, use a separate fresh fixture and profile preparation:
pwsh -File scripts/acceptance/issue-102/installed.ps1 -State $taskState `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe' -Node $taskNode
```

When the build uses the verified mirror, set the trusted process environment
`DESKTOP_CANDIDATE_ROOT` to its absolute path before the development command,
and prepare profiles with `MIRROR/.runtime/python.exe`. The runner reads built
`out` and `.runtime` from that mirror while retaining original repository paths
for helpers and source binding. It records the mirror input manifest hash.
The installed run always takes its Python and core files from the installed
package, regardless of this environment variable. Package hashes can therefore
use `dist/win-unpacked/resources/runtime/python.exe`; they must identify an
actual file, not an invented copy at the original repository's `.runtime`.

For the installed run, `profiles.py prepare` may also use the candidate installed
`resources/runtime/python.exe`. The runner always uses that installed interpreter
for local observation/fault controls. It records the installed ASAR, executable,
Python and Runtime core hashes. The wrapper checks the actual Windows Known
Folder, backs up the existing Runtime profile, marks its synthetic replacement,
and restores the original after Desktop exits. Every original file count and
SHA-256 must match after restoration.

Use the command recorder from Issue 101 to retain complete exit code, duration
and logs, for example:

```powershell
& .venv/Scripts/python.exe scripts/acceptance/issue-101/record_command.py `
  --output artifacts/issue-102/functional-final-command -- `
  pwsh -File scripts/acceptance/issue-102/installed.ps1 -State $taskState `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe' -Node $taskNode
& .venv/Scripts/python.exe scripts/acceptance/issue-102/validate_evidence.py --functional $taskState
# For a development run only, add --allow-development.
```

The unanswered approval scenario observes the real 300-second timeout. The
signed write task has a 305-second deadline, with a 45-second observation allowance.
No product timeout, source, clock or signing
policy is patched. All other waits are bounded to 90 seconds unless documented
in the script. Only a read-only refresh returning `CHAT_SERVER_UNAVAILABLE`
gets three attempts. Thread creation and Run submission happen once. A mutation
transport failure must be reconciled using its recorded Thread/turn/Run IDs.
If the chat SSE disconnects while a long approval is pending, the runner waits
for the original local task to finish, then clicks the actual Desktop reconnect
button to recover that same Thread and Run. Cancellation or the final 20 seconds
of observation can also trigger recovery. At most three clicks, at least five
seconds apart, are recorded per operation, within its original observation
deadline. Recovery never submits another Run or task.

The four T102-04 Runtime restarts each perform one additional canonical
`local.files.read` of `W/health.txt`, then reopen the original write Run. A prior
uncertain write deliberately remains in the ledger, so a new Runtime starts with
its conservative write latch. These four auxiliary reads prove actual receipt
storage recovery without clearing that uncertain write. They are recorded in
`auxiliaryOperations`, with separate Thread/turn/Run/task/receipt identities,
the six BEFORE bytes and hash, exactly one dispatch and execution, confirmed
receipt delivery and cleared storage error. The complete run therefore has
21 primary requests plus four auxiliary read requests, and 22 required subcases.

After lost live results, the runner keeps the original live Task response as a
fact, including a possible null `receipt`. It separately performs an actual
owner-authenticated `GET /api/devices/receipts/{task_id}` to verify the durable
receipt, original task/Run/tool call/request hash, approved basis and matching
receipt ID/hash/ACK. This follows Server `docs/local-runtime/ARCHITECTURE.md`
lines 34-47: receipt upload confirms evidence and cannot resume a terminal Run.
Only required binding metadata is retained from that archive API; full binding,
dispatch signatures and credential material are excluded from this projection.

## Fixed data and scenarios

Each run creates one unique temporary directory with `W` and `outside`. The
fixed text is `BEFORE`, six UTF-8 bytes, and `AFTER`, five UTF-8 bytes. An additional
operation writes `AFTER\r\n第二行\n`, 17 UTF-8 bytes. Expected hashes come from
those constants before any operation. The runner compares the files as raw
Buffers. HTML textarea values normalize CRLF to LF, so it separately verifies
the original content in the Runtime approval snapshot and the expected DOM
normalization. File evidence retains the submitted CRLF bytes.

| Scenario | Subcase / fixture path | Operation and independent expected result |
| --- | --- | --- |
| T102-01 | `create`, `W/new.txt` | Send from Desktop UI, inspect card, click allow once. New file is exactly AFTER. |
| T102-01 | `overwrite`, `W/target.txt` | Send from Desktop UI, inspect card, click allow once. BEFORE becomes exactly AFTER. |
| T102-01 | `unicode-newlines`, `W/unicode.txt` | Allow once. Actual file equals all 17 submitted bytes. |
| T102-02 | `reject`, `W/reject.txt` | Actual reject click. Explicit denial, unchanged BEFORE. |
| T102-02 | `timeout`, `W/timeout.txt` | Leave approval unanswered. Explicit expiry/timeout, removed card, unchanged BEFORE. |
| T102-02 | `changed-request-hash`, `W/hash.txt` | Attempt allow using a changed digest. Require `CONSENT_MISMATCH`, zero completed executions, then reject the original. A stale original callback cannot execute it. Signed protocol tests also cover payload/content changes after approval. |
| T102-02 | `web-approval`, `W/web.txt` | POST the real consent API with an authenticated Web identity. Require 403 `LOCAL_APPROVAL_REQUIRED`, no effect, then reject locally. |
| T102-02 | `local-deny`, `W/deny.txt` | Set DENY only in the marked synthetic profile and restart Runtime. Require local policy denial and unchanged BEFORE. Restore ask-first. |
| T102-02 | `outside-path`, `outside/secret.txt` | Request `../outside/secret.txt`. Require pre-approval `INVALID_PATH`, no card, zero completed executions and unchanged outside bytes. The current shared Windows filename guard rejects the `..` component before resolution. The lower boundary at base `9db5447` rejects traversal as `OUTSIDE_ALLOWED_ROOTS`. The junction case below checks resolved-path escape separately. |
| T102-02 | `protected-path`, `W/.git/config` | Request protected path. Require pre-approval `PROTECTED_PATH`, no card, zero completed executions and unchanged bytes. |
| T102-02 | `link-escape`, `W/junction/secret.txt` | Request path through a real NTFS junction to outside. Require pre-approval `OUTSIDE_ALLOWED_ROOTS`, no card, zero completed executions and unchanged outside bytes. |
| T102-03 | `admission-failure`, `W/admission.txt` | SQLite INSERT trigger fails admission. Require `RECEIPT_STORAGE_UNAVAILABLE`, no new ledger row, no write. |
| T102-03 | `admission-recovery-read`, `W/health.txt` | Remove the admission trigger and execute a canonical read. Require a genuinely saved completed receipt, matching BEFORE/hash and cleared error before injecting the completion fault. |
| T102-03 | `completion-failure`, `W/completion.txt` | SQLite UPDATE trigger fails completion after allow. File is AFTER, ledger remains uncertain, result says `RESULT_UNCERTAIN`. |
| T102-03 | `second-write-blocked`, `W/completion-blocked.txt` | While completion persistence still fails, a second write must be refused before admission, without approval or effect. |
| T102-03 | `uncertain-restart` | Remove trigger and restart Runtime. Original uncertain admission remains and there is exactly one dispatch. |
| T102-03 | `uncertain-recovery-read`, `W/health.txt` | Execute a canonical read and save its receipt reliably after the uncertain write restart. BEFORE and its hash agree, the storage error clears, and only then do subsequent scenarios submit new writes. |
| T102-04 | `before-submit-cancel`, `W/before-submit.txt` | Hold deterministic model before it submits a Local Task; cancel original Run, release model. Zero task dispatches, unchanged BEFORE. |
| T102-04 | `before-write-cancel`, `W/before-cancel.txt` | Cancel while approval is pending. Restart Runtime and reopen original chat. Card disappears, zero completed executions, one dispatch, unchanged BEFORE. |
| T102-04 | `before-write-disconnect`, `W/before-disconnect.txt` | Close real Server WebSocket while approval is pending. Restart/reconnect, zero completed executions, one dispatch, unchanged BEFORE. |
| T102-04 | `after-write-cancel`, `W/after-cancel.txt` | Lose task result and receipt upload after the actual effect; cancel original Run. Restore network/restart. AFTER remains, original completed receipt uploads, one dispatch/execution. |
| T102-04 | `after-write-disconnect`, `W/after-disconnect.txt` | Lose task result/receipt and close WebSocket after the actual effect. Restore/restart. AFTER remains and original receipt confirms without redispatch. |

Every operation records its phase, exact fixed input, timestamps, Thread/turn/Run
IDs, approval basis, signed dispatch observations, local metadata/audit and public
task state. Successful file hash, receipt request digest, tool call, task and Run
must agree. An `execution` audit event for denial is a receipt fact. Execution
counts in this runner use only `action=completed`.

## Controls and cleanup

`profile_controls.py` refuses a profile without `.issue102-owner` and a synthetic
credential reference. Its SQLite triggers never fill the disk and only affect
the marked fixture's `receipts.db`. It removes both triggers during cleanup.
`fixture_hooks.py` records transport metadata and can drop results/uploads/ACKs
or close the existing socket. It cannot create an approval or successful result.
Product code has no fixture switch.

`result.json` is rewritten after each phase. Any exception records the failure
and leaves unfinished scenarios incomplete/unexecuted. The runner always attempts
normal Desktop quit, deletes only the six synthetic credential references, writes
`stop` for the Gateway and removes only its unique temporary directory. The
installed wrapper separately restores the user's original profile. If startup
or pairing fails before the runner, run `profiles.py cleanup STATE` with the same
bundled interpreter, write `STATE/stop`, and retain failure/cleanup facts.

## Final evidence validation

Copy only reviewed evidence into `docs/acceptance/issue-102/evidence`. Do not copy
`ready.json`, profile JSON, credential-reference ledger, SQLite databases, JWT or
signing keys. Preserve unsuccessful attempts under `attempts/`. The selected
`functional/` run must contain `result.json`, `wire-events.jsonl`, screenshots,
`credential-cleanup.json`, `gateway-cleanup.json` and installed
`profile-restoration.json`.

The final validator expects Issue 101's source-binding format at
`desktop/desktop-source-binding.json[.gz]` and
`server/server-source-binding.json[.gz]`, plus Desktop `package-hashes.json` and
`lock-hashes.json`. Keep actual successful command records named
`typecheck-release`, `desktop-tests-release`, `security-release`,
`runtime-static-verified`, `runtime-tests-verified`, `dist-win-release`,
`install-lifecycle-release` and `functional-final-command`, each `.json`. These
names designate selected final results; historical failures remain separate.
`manifest.json` lists every other evidence file with `path`, `bytes`, `sha256`.
Run `validate_evidence.py --root REPOSITORY`, and add `--staged` after staging.
The validator checks all hashes, current source/lock/package bindings, all four
scenarios and 22 required subcases, real file/approval/receipt correlation,
the four auxiliary read requests,
cleanup and forbidden credential fields. It never treats a historical pass as
the selected installed result. Real Win7 remains unexecuted under Issue 131.
