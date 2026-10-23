# Focused Desktop and Runtime checks

Recorded by the Desktop implementation agent on 2026-10-22 (Asia/Shanghai).
These are facts from terminal tool outputs. Full stdout was not redirected to
files when the checks ran; this document is a result summary, not a raw log.
Root owns candidate hashes, installation verification, complete suite results
and the final acceptance report. The following checks do not replace those.

Every Python command set `PYTHONPATH` to the current checkout's `local-runtime`
and used a unique `$env:TEMP/ideer-102-*` directory through `--basetemp`.
Native Windows handle tests needed the approved unsandboxed execution mode.
The default sandbox denied native ancestor handles, and long pytest IDs caused
two temporary-directory setup errors before explicit short IDs were added.

| Command | Actual result | Scope and qualification |
| --- | --- | --- |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_files.py local-runtime/tests/test_workspace_writes.py local-runtime/tests/test_tray_consent.py local-runtime/tests/test_platform_chat.py -q -p no:cacheprovider --basetemp=<unique-temp>` | 52 passed, one upstream websockets deprecation warning, 142.54 s | Earlier focused candidate before the last expiry/Windows ancestor additions |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_files.py local-runtime/tests/test_workspace_writes.py -q -p no:cacheprovider --basetemp=<unique-temp>` | 27 passed, 13.97 s | Content bounds/encoding/readback and signed approval/storage checks before final cases |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py local-runtime/tests/test_platform_chat.py -k 'signed_write or chat_write' -q -p no:cacheprovider --basetemp=<unique-temp>` | 22 passed, 14 deselected, 71.34 s | Original chat scope/thread/Run/task/hash binding, malformed local decisions and signed task expiry/identity/directory changes |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py -k 'cancel or disconnect' -q -p no:cacheprovider --basetemp=<unique-temp>` | 3 passed, 13 deselected, 0.84 s | Signed cancellation before approval and cancellation/disconnect after the actual write and durable completion; no false cancelled outcome |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_files.py local-runtime/tests/test_workspace_writes.py -k 'pins_parent or deny-after' -q -p no:cacheprovider --basetemp=<unique-temp>` | 2 passed, 35 deselected, 0.66 s | After changing Windows ancestor handles from attribute-only access to read access; the preceding red run reproduced a successful ancestor rename |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_files.py local-runtime/tests/test_workspace_writes.py local-runtime/tests/test_files.py local-runtime/tests/test_protocol.py -q -p no:cacheprovider --basetemp=<unique-temp>` | 58 passed, 2 skipped, 13.72 s | Final Windows handle product change, workspace writes, existing file and signed protocol regressions; the two skips were existing platform-specific tests |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py -k readback -q -p no:cacheprovider --basetemp=<unique-temp>` | 1 passed, 18 deselected, 0.56 s | Final added signed regression confirms real AFTER bytes plus a pending `result_not_verified` receipt when post-write readback fails |
| `.cache/node22/node-v22.23.3-win-x64/node.exe node_modules/vitest/vitest.mjs run test/chat.test.tsx` | 2 passed, 5.64 s | Original streaming Run shows exact full content, request hash and only one-time allow/deny; red run first confirmed the missing card |
| `.cache/node22/node-v22.23.3-win-x64/node.exe node_modules/vitest/vitest.mjs run test/chat-bridge.test.ts -t rejects` | 2 passed, 1 skipped, 0.66 s | Invalid/expanded local decision commands rejected before process startup; bundled-process test deliberately excluded by the focused selection |
| `.cache/node22/node-v22.23.3-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json` and same command with `tsconfig.web.json` | Both exited 0 | TypeScript checks after the Desktop approval bridge/card additions |
| `.venv/Scripts/python.exe scripts/verify-runtime-source.py` | Exited 0 | Original Runtime Git blob identities retained; explicit migration explanations updated |
| `.cache/node22/node-v22.23.3-win-x64/node.exe scripts/verify-provenance.cjs` | Exited 0 | Pinned linz provenance verified |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py -k 'completion-followup or pending-storage' -q -p no:cacheprovider --basetemp=<unique-temp>` | Red: 2 failed; after the completion-storage latch change: 2 passed, 19 deselected, 0.87 s | Reproduced a second write after failed completion storage and a write approved after another pending task's completion failed; both now refuse without extra effect |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py local-runtime/tests/test_receipt_ledger.py local-runtime/tests/test_receipt_transport.py local-runtime/tests/test_receipt_replay.py -q -p no:cacheprovider --basetemp=<unique-temp>` | 35 passed, 4.41 s | After the final storage latch: existing receipt storage/replay behavior and signed restart recovery through an actual read receipt |
| `.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_writes.py -k 'completion-followup or pending-storage or restart-recovery' -q -p no:cacheprovider --basetemp=<unique-temp>` | 3 passed, 19 deselected, 0.85 s | Final lock-protected latch implementation; ACK cannot restore writes, actual successful read receipt can |
| `.cache/node22/node-v22.23.3-win-x64/node.exe node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json` | Exited 0 | After the final recovery message in RuntimePanel |

The initial signed-write run had 9 passes and one test-fixture failure because
`ReceiptLedger.path` is a string; using `Path(...).as_uri()` corrected that fixture.
The Windows parent-rename test first failed against the attribute-only ancestor
handles and passed after the access-mode fix. A separate local-DENY-after-prompt
fixture initially saved a stale settings snapshot and removed its workspace
grant; loading current settings before changing only the rule corrected it.

No real Win7 checks were run here. No full-suite, package, installation or real
Server acceptance success is claimed by this focused summary.

## Review follow-up checks

The review follow-up added three deterministic seam regressions. The first run
reported **3 failed, 1 passed, 61 deselected in 10.28 s**. It reproduced a cleanup
failure classified as `LOCKED_OR_UNAVAILABLE` despite real AFTER bytes, an
uncertain approved write receipt missing `consent_decision`, and a pending-card
snapshot exception escaping the public chat handler. A separate token test
reported **1 failed, 23 deselected in 21.58 s** and showed a redacted content card
still carrying the original approval hash.

After the fixes, the following focused selection reported **6 passed,
61 deselected, one upstream websockets deprecation warning in 68.36 s**:

```powershell
$env:PYTHONPATH = Join-Path (Get-Location) 'local-runtime'
.venv/Scripts/python.exe -m pytest local-runtime/tests/test_workspace_files.py local-runtime/tests/test_workspace_writes.py local-runtime/tests/test_platform_chat.py -k 'cleanup_failure or readback or unavailable_local_approval or snapshots_remain or hidden_by_credential' -q -p no:cacheprovider --basetemp=<unique-temp>
```

The signed-controller snapshot test creates and cancels 30 approval requests
while UI callers repeatedly obtain pending requests and status. It passed as
concurrency coverage. It is not a claimed deterministic reproduction of the
earlier cross-thread dictionary race.

`vitest run test/chat.test.tsx` reported **2 passed in 5.12 s**. The affected web
TypeScript check, pinned Runtime source verifier and `git diff --check` exited
0. Git printed existing line-ending normalization warnings for the signed-write
test and acceptance runner files.
The final nested cleanup `finally` adjustment was followed by
`pytest local-runtime/tests/test_workspace_files.py -k cleanup_failure` with
**1 passed, 19 deselected in 0.37 s** on Windows. POSIX descriptor-close behavior
is guaranteed by that cleanup structure but was not executed on this machine.

The final incremental review added a signed write/readback-failure scenario
that blocks the outbound uncertain error and then receives a signed task cancel.
Its red run reported **1 failed, 23 deselected in 1.22 s**, reproducing an extra
wire cancellation after actual AFTER bytes and persisted uncertainty. File-error
reporting now remains inside the outer cancellation guard, and an uncertain
file error marks a possible effect before awaiting error delivery.
`pytest local-runtime/tests/test_workspace_writes.py -k 'cancel or disconnect or readback'`
then reported **5 passed, 19 deselected in 1.29 s**. These cover cancellation
before effect, completed-write cancellation/disconnect, approved uncertain
readback receipt basis, and interrupted uncertain-error delivery. The new case
checks the actual AFTER bytes, absence of a false cancelled wire result and the
retained pending `result_not_verified` receipt with original task, Run and hashes.
Pinned Runtime verification and `git diff --check` exited 0.
