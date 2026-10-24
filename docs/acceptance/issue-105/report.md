# Issue 105 acceptance

[iDeer #105](https://github.com/Orbit-Crew/iDeer/issues/105) keeps local
workspace results display-only until one explicit, user-authorized upload,
and separates device-local results from platform attachments in Thread
history. T105-01 through T105-04 passed on the Desktop/Runtime candidate with
signed-protocol fixtures and the real bundled Runtime. This repository
delivers the Desktop/Runtime side; the Server-side artifact endpoint and its
repository gates are delivered in the Server workflow and are listed as
dependencies below.

Execution date: 2026-10-24, Asia/Shanghai. All automated scenarios in this
report were executed by the orchestration agent; no human sign-off is claimed
and no external model call is involved. Prerequisite #102 was verified
closed on 2026-10-23 (recorded in the issue 104 report).

## Candidate and environment

Desktop branch `feat/issue-105` from develop `516fe7af7eb9ecc00df4eaefdfb9c692662b11a4`.
Implementation commit: see the closing commit on this branch (bound in the PR).

Windows 11 Pro 10.0.26300 x64; Node 22.14.0 (npm commands); test Python
3.12.8 (`pytest==8.3.5`, `ruff==0.11.13`); bundled Runtime Python 3.12.10
assembled by `scripts/prepare-runtime.py`; Electron 22.3.27. Fixtures use
isolated synthetic identities (account-105, account-B), temporary workspace
directories, fresh SQLite databases, loopback HTTP/WebSocket brokers with
real Ed25519-signed envelopes, and a deterministic Server fixture implementing
the issue 105 artifact contract (`/api/threads/{id}/artifacts`, hash-idempotent,
thread-bound). No real credential, user data, or production Server is touched.

## Scenario contract and results

Independent expected literals: `T105-UNIQUE-RESULT` (18 UTF-8 bytes, SHA-256
`0e72092273360afa4c59cd372e0a9aee7cb612cf474ccb20048b305e4fbf1274`, computed
independently of the implementation), tamper literal `TAMPERED`, identities
`account-105`/`account-B`, device `device-105`. The
registered local-result fact is immutable per (identity, task); uploads are
bound to the owning identity, thread, run and task; the platform artifact
contract echoes `artifact_id`, `name`, `sha256` back and the device refuses
to mark anything uploaded unless that echo matches the staged bytes.

| Scenario | What the tests establish | Result |
| --- | --- | --- |
| T105-01 | Viewing/opening a Thread never issues an upload (`upload_posts == []`); completed signed workspace writes register exactly one identity-bound local fact (replayed deliveries do not re-register); outside-root writes register nothing; Thread history carries `localResult` for device-local facts and `artifacts` only for platform attachments, with no fabricated download URL or absolute path | passed |
| T105-02 | The explicit `upload` command (only `decision: 'allow'` is accepted end to end) reads the bytes through the current workspace grant, verifies SHA-256, stages via the existing `FileArtifactUploader` handle, and posts with an `Idempotency-Key` of `local://<sha256>/<name>` plus a single-use grant; the Server echo is verified before `artifact_ref` is recorded | passed |
| T105-03 | No-record, policy-deny, missing-file, content-changed, workspace-changed and wrong-thread rejections send nothing at all; server 403/503 and echo-mismatch leave the registry unmarked; each retry carries a fresh single-use grant token; a switched account cannot upload under the old identity (`CHAT_IDENTITY_CHANGED`, then `CHAT_THREAD_CHANGED`) | passed |
| T105-04 | Repeating an explicit upload after success replays the same artifact with exactly one POST total; `mark_uploaded` is idempotent for the same ref, conflicts on a different ref, and rejects unregistered tasks; storage failures are one fixed category (`RESULT_STORAGE_UNAVAILABLE`) and never fake success | passed |

## Executed commands

| Command | Result | Record |
| --- | --- | --- |
| `npm.cmd run typecheck` (Node 22.14.0) | passed | this run |
| `npm.cmd test` | 24 passed, 12 files (22 baseline + 2 new) | this run |
| `npm.cmd run test:security` | passed | this run |
| `npm.cmd run verify:provenance` | passed (`f88141bb…`) | this run |
| `python scripts/verify-runtime-source.py` | passed (`ccb251e0…`) | this run |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed | this run |
| pytest `local-runtime/tests -q` (Python 3.12.8) | 365 passed, 6 skipped (346 baseline + 19 new) | this run |
| `npm.cmd run dist:win` | see packaging section | this run |

New test files: `local-runtime/tests/test_local_results.py` (4 registry +
3 signed-write scenarios), 6 upload/history scenarios in
`local-runtime/tests/test_platform_chat.py`, `test/local-result-upload.test.ts`
(bridge validation + bundled Runtime boundary). New runtime module:
`local-runtime/core/local_results.py`; protocol wiring in
`desktop.py`/`transport.py`/`consent_coord.py`/`platform_chat.py`;
Electron bridge and UI in `src/main/runtime.ts`, `src/shared/desktop.ts`,
`src/renderer/src/components/ChatPanel.tsx`.

## Packaging

`npm.cmd run dist:win` produced `ideer-desktop-0.1.0-windows-x64-setup.exe`
(92,391,381 bytes) on the candidate; SHA-256
`9d48793a0598645cfdb10eb975a9efc305304b79c85a43617329493c5254b97b`. The
packaged Runtime includes `local_results.py` via the assembled `.runtime`
tree.

## Server workflow dependencies — delivered

The Server repository accepted the artifact contract this report asserted:
Orbit-Crew/iDeer PR #143 (merged as `432b60930f499490dafde6e136b1cd2e036f227c`)
implements `POST /api/threads/{thread_id}/artifacts` with digest and byte
re-verification, hash idempotency (duplicate replays return the same
artifact), grant and owner binding, and the same fixed rejection categories
with no stored bytes on refusal. Payloads land in the owning thread's
user-data outputs, so the existing artifact listing and access control apply.
Win7 stays `unexecuted` per the ticket and is owned by
[#131](https://github.com/Orbit-Crew/iDeer/issues/131).
