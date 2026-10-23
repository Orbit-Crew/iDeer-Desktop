# Historical attempts

These attempts are not selected passing evidence. No failed Run submission was
resent. Fresh attempts use separate synthetic identities and directories.

| Attempt | Actual result and disposition |
| --- | --- |
| `original-runtime-acl` | Runtime preparation returned access denied. A suite using the original ignored `.runtime` reported 2 failed, 306 passed, 6 skipped and exit 1. A fresh source-identical build mirror and a unique pytest base temp resolved the observed path access problems. The selected full suite has its own command record. |
| `functional-dev-20261022-1206` | unexecuted. The Server candidate was superseded before Desktop launch. All six synthetic credentials were removed. |
| `functional-dev-20261022-1215` | failed after two successful actual UI writes. The Unicode/newline Run submission returned `CHAT_SERVER_ERROR`, so the runner stopped immediately. The old runner removed its temporary files before final byte snapshots were added; that missing snapshot evidence was not reconstructed. |
| `functional-dev-20261022-1221` | failed at the same Unicode submission. The safe observer recorded `UnicodeEncodeError` and frame names during Run admission. The upgraded cleanup captured actual synthetic file snapshots. A later inventory found the retained Gateway PID/process/port gone; no original natural-exit cleanup record is claimed. |
| `functional-dev-20261022-2011-utf8` | failed before any operation, while waiting for business identity. Runtime reported `LOGIN_REAUTHENTICATION_REQUIRED`. It removed all six synthetic credentials, closed Desktop and removed the temporary files. No unproven timeout or sandbox cause is assigned. |
| `functional-dev-20261023-0731` | failed in the harness after create, overwrite, Unicode/newline and reject passed. It waited on stale Desktop state after the long SSE stream disconnected. Restricted persisted-state queries confirm the original Server Run ended successfully at 23:37:03Z with the matching denied receipt and unchanged file, within the real 300-second prompt timeout plus observation allowance. The runner now uses the actual UI reconnect path to recover that original Run, without resubmission or changing the timeout. |
| `functional-dev-20261023-0742` | failed after the corrected real timeout and changed-hash cases passed. Web consent returned 400 because the test request omitted the required `actor_id`; that original response body was not saved before the assertion. The request now supplies synthetic A's actor ID, and captures the response before checking the original 403 requirement. The next diagnostic observed the expected 403 and typed `detail.code`. |
| `utf8-initial-environment` | First rebuild did not set the existing local electron-builder cache and failed extracting macOS signing-tool symlinks on Windows. The first Runtime command omitted its package `PYTHONPATH` and failed collection. Both command records remain; corrected commands and successful full checks are separate. |
| `server-pr-standard-superseded` | exit 143 / 1903.138 seconds. The old candidate was superseded by the reviewed terminal-receipt preservation fix; its backend master was stopped. Before that interruption, backend setup errors occurred because copied pytest entrypoints selected the main workspace's interpreter and config. Independent Python and repaired standard entrypoints then each passed the same 743-test comparison. The final complete standard lane passed separately. |

The Unicode product fix has independent real-process red/green evidence under
`../desktop/utf8`. It forces the owned Python interpreter into UTF-8 mode;
the initial no-socket-permission focused attempts are distinguished there from
the semantic regression failure and success.

No `ready.json`, profile, database, signing material or credential-reference
ledger is included in this directory.

The [fast diagnostic summary](diagnostic-summary.json) is a projection of actual
result records, not raw command output or selected acceptance evidence. These
runs deliberately omit the long timeout and cannot satisfy the final validator.
They found the traversal error-category mismatch, the need for a fresh storage
health read after later restarts, and the live-task versus durable-archive
observation mismatch. The final diagnostic completed the other 21 subcases
with 20 original operations and 4 auxiliary reads, while retaining
`diagnostic-incomplete`. Its validation was intentionally rejected. Complete
unmodified-timeout development and installed runs are selected separately.
