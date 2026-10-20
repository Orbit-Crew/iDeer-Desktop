# Issue #100 acceptance

This report covers [issue #100](https://github.com/Orbit-Crew/iDeer/issues/100),
including Desktop, its bundled Windows Runtime and the isolated Server candidate.
The prerequisite [#99](https://github.com/Orbit-Crew/iDeer/issues/99) was closed
before implementation. Modern Windows functional scenarios and all applicable
Server gates passed. Windows 7 remains explicitly unexecuted under #131.

## Candidate and environment

Execution dates: 2026-10-19 through 2026-10-20, Asia/Shanghai. Report finalized
2026-10-21. Evidence timestamps
also include explicit UTC offsets. The operator was Codex; the user explicitly
authorized the TDD seams, comparison base, branch, current-account installation,
uninstallation/reinstallation and synthetic file acceptance. No manual UI pass
or external model-provider pass is claimed.

| Component | Candidate binding |
| --- | --- |
| Desktop | Branch `codex/issue-100`; base `b7e1e0a52cbc540afc48f01e40ad55ab4f3f4152`; final implementation is the commit containing this report |
| Desktop product source | SHA-256 `0a2e2c2af11bcfdaba60a9b71a0c2e4d3ebd2307ac1e27ebd582fa5abcd8911a`; [per-file manifest](evidence/source-binding.json) binds source independently of report/commit metadata |
| Server | Commit `ed13672c4134681a9391e0baefca002a6dde2ad6`; base `aec07a3b9af3ab451b1f1a377a93f6f11135bf88`, with the same tree as prerequisite `95260f452670df62e365f10035d095838ec3a495`; eight changed files are SHA-256 bound in the same manifest |
| Installer | `dist/ideer-desktop-0.1.0-windows-x64-setup.exe`; SHA-256 `af79629c77d070c99c6c9c13d71fc1d0c31c5a9bf94ef244d0ede9f28bba23c5` |
| Installed app | `D:\software\iDeer Desktop\ideer-desktop`; ASAR SHA-256 `5332092aa2424b99f56aa51c925c3b645df5c88d8dac7fe023a59f0a3187e923`; all 271 prepared Runtime files match installed files, and Runtime core matches checked-in source |
| Windows | Windows 11 Pro, `10.0.26300`, x64; [OS evidence](evidence/os.json) |
| Desktop build/runtime | Build Node `22.23.3`; Electron `22.3.27`, embedded Node `16.17.1`, Python `3.12.10`, cryptography `43.0.3`, cffi `1.17.1`, websockets `13.1` |
| Dependencies | Exact Desktop package lock, Runtime distribution lock, Server `backend/uv.lock` and `frontend/pnpm-lock.yaml`; [lock hashes](evidence/candidate-hashes.json) |
| Server execution | Isolated WSL Ubuntu checkout, locked Python 3.12 environment created with `uv sync --locked`; pnpm `10.26.2`; no production database or deployment |
| Windows regression host | Python `3.12.8`, pytest `8.3.5`, cryptography `43.0.3`, websockets `13.1`; [test interpreter metadata](evidence/runtime-test-env.json). Installed functional acceptance uses the embedded Python `3.12.10` |
| Fixture configuration | Auth enabled, A/D1 and B/D2 synthetic identities, SQLite in task-owned state, published Agents with `tool_groups: [local.files]`, AgentPlatform evidence plugin enabled, memory/title/scheduler off; [fixture source](../../../scripts/acceptance/issue-100/server_fixture.py) |

The Server model is deterministic and emits the requested local tool call. The
Gateway, authentication, pairing, Agent authorization, broker signature,
Runtime, Windows filesystem, Thread persistence and archived receipts execute
their production code. Native dialog callbacks provide synthetic directories and
consent. Playwright clicks the actual Desktop directory button and first chat
Send button, and checks the actual confirmation options. Human operation of
native dialogs and a live external provider were not part of this run.

## Fixed expectations and commands

These constants are fixture inputs, not values derived from implementation output.
W1 contains `marker.py` with the exact UTF-8 bytes `known_marker = 100\n` (19 bytes).
Search for `known_marker` must return `marker.py`, line 1, `known_marker = 100`.
W2 contains `other.txt` with `W2 fixed text\n` (14 bytes). The outside file contains
`T100_OUTSIDE_MUST_NOT_LEAK`; the protected `.git/config` contains
`T100_PROTECTED_MUST_NOT_LEAK`. Their independent SHA-256 values and post-run
hashes appear in [file scenarios](evidence/file-scenarios.json).

The installed functional entry point is:

```powershell
& .runtime/python.exe -I scripts/acceptance/issue-100/profiles.py prepare <FreshDesktopState>
& scripts/acceptance/issue-100/installed.ps1 -State <FreshDesktopState> `
  -Executable 'D:\software\iDeer Desktop\ideer-desktop\ideer-desktop.exe'
```

Start the real isolated Gateway first using its locked Python and
`server_fixture.py --server-root <ServerCheckout> --state <FreshServerState>
--desktop-state <FreshDesktopState>`. The [runner instructions](../../../scripts/acceptance/issue-100/README.md)
describe Windows/WSL path mapping, isolation, cleanup and evidence collection.
Each polling deadline is 60 seconds; the pre-dispatch hold deadline is 45 seconds,
Electron launch is 45 seconds, UI actions and app exit are 30 seconds. Text,
hashes, errors and line numbers use exact comparisons, with no numeric tolerance.

## Scenario results

| Scenario | Actual steps and expectation | Result and evidence |
| --- | --- | --- |
| T100-01 | Select W1 through the real button; inspect confirmation; list/read/search; compare Resource API responses and Gateway endpoint summary | passed. Confirmation says content is sent on demand, no automatic directory upload, only logical paths, and no Resource registration. Resource list remains the same single seeded Agent. 258 HTTP requests include zero upload endpoint calls; 24 model-message checks contain no Windows absolute paths. [Boundary summary](evidence/data-boundary.json), [request summary](evidence/request-summary.json), [model assembly](evidence/model-tool-names.json), [resource comparison and consent](evidence/file-scenarios.json) |
| T100-02 | Server dispatches list, read and literal search to the paired Windows Runtime; compare fixed bytes, hash and line position; inspect original Thread tool results and archived Run receipts | passed. List returns only W1 `marker.py`; read returns exact 19 bytes and expected hash; search returns exact line 1. Results use `/workspace/<uuid>` sources. [Thread results](evidence/file-scenarios.json), [Run and Local Task receipt chain](evidence/run-evidence-A.json), [UI screenshot](evidence/workspace-chat.png) |
| T100-03 | Read protected `.git/config`, `../outside/secret.txt`, outside-target junction and symlink; then trusted platform deny and local DENY; compare original file bytes | passed. Protected path returns `PROTECTED_PATH`; traversal, junction and actual NTFS LX symlink return `OUTSIDE_ALLOWED_ROOTS`. Platform deny removes the tool and creates no Local Task. Local DENY returns `POLICY_DENIED`. No secret marker reaches the Thread; protected/outside/marker files remain unchanged. [Per-call errors and hashes](evidence/file-scenarios.json), [archived denied receipts](evidence/run-evidence-A.json) |
| T100-04 | Hold a requested W1 read before dispatch; choose W2 and release; retry stale W1, read W2; invoke legacy direct Server file route; restart as B/D2 then A/D1 | passed. Held/stale W1 requests return `OUTSIDE_ALLOWED_ROOTS`; W2 returns its exact 14 bytes. Old direct route returns HTTP 403 `CANONICAL_RUN_REQUIRED`. B/D2 has no active workspace and gets 404 for A's Thread. A/D1 restart restores the W2 logical root. Restricted IPC and signed Desktop-mode regressions reject old execution paths. [Switch and identity evidence](evidence/file-scenarios.json), [Runtime regressions](evidence/runtime-signoff.xml.gz) |

Win32 `CreateSymbolicLink` creation lacked privilege on this account. The run
instead created a real NTFS WSL LX symlink pointing outside W1 and verified its
rejection. That flavor is recorded explicitly; the Win32 symbolic-link flavor
remains unexecuted additional platform coverage. Junction coverage ran on Windows.
The Runtime rejects all reparse tags/attributes before resolving a target, and
focused regressions cover that decision. This distinction is not a Win7 pass.

Run success is separate from tool success. Several denial Runs correctly finish
with a ToolMessage containing an error; their Local Tasks/receipts record failure.
Platform-level tool withholding creates no Local Task. Inspect the stable tool
error and task receipt rather than interpreting the Run status alone as access.

## Installation and data preservation

The final candidate was installed in the authorized existing directory. All six
checks passed: installation, shortcuts, candidate identity, real Electron security
smoke, uninstall retention and reinstall retention. The lifecycle runner exited
0 in 59.96 seconds; the installed Electron smoke took 16.411 seconds. It checked
sandbox, context isolation, disabled Node integration/webview, IPC rejection,
navigation/popups/CSP, sidebar, resize, single instance, UI quit and native close.
The Runtime also started, stopped, recovered after a forced process crash and
stopped with the app. [Lifecycle results](evidence/lifecycle-results.json),
[Runtime lifecycle](evidence/runtime-lifecycle.json), [payload equality](evidence/installed-payload.json).

Uninstall/reinstall preserved both unique Desktop/legacy retention fixtures with
unchanged hashes. This does not claim a historical linz installation migration.
The installed functional wrapper separately backed up the current account's
existing Runtime profile, restored all three original files and verified their
hashes. The final functional runner exited 0 in 53.21 seconds on 2026-10-20,
11:30:18 through 11:31:10 UTC. The app was left closed, all six temporary Credential Manager entries
were deleted, and the fixture Gateway exited. [Retention](evidence/data-retention.json),
[profile restoration](evidence/profile-restoration.json),
[credential cleanup](evidence/credential-cleanup.json),
[Gateway cleanup](evidence/gateway-cleanup.json).

## Gates and review

| Command/check | Outcome |
| --- | --- |
| `npm.cmd run typecheck` | passed, exit 0, 9.90 seconds |
| `npm.cmd test` | passed, exit 0; 7 files / 10 tests, 7.38 seconds |
| `python -m pytest local-runtime/tests -q --junitxml=artifacts/issue-100/runtime-signoff.xml` with `PYTHONPATH=local-runtime` | passed, exit 0; 265 passed, 6 skipped, 1 deprecation warning, 56.97 seconds |
| `python scripts/verify-runtime-source.py` | passed; pinned migration sources preserved, each intentional source change has a provenance reason |
| `npm.cmd run dist:win` | passed, exit 0, 112.05 seconds; includes Runtime assembly, build and x64 NSIS. [Timing](evidence/dist-win-timing.json) |
| Server focused regressions and ruff | passed, exit 0; 33 tests, 4 deprecation warnings, 10.38 seconds; changed Server files pass ruff |
| Server inventory/document/upstream-patch gates | passed, exit 0; 5.806 / 0.775 / 0.086 seconds; [exact commands and timings](evidence/server-aux-final-summary.json) |
| Server `pr-standard` | passed, parent exit 0, `TEST_LANE_DURATION` 2,428 seconds. [Final commands, environment and lane metadata](evidence/server-gate-summary.json), [complete log](evidence/server-pr-final.log.gz) |
| Server PR sub-lanes | local-runtime: 230 passed / 4 skipped, 20 seconds; backend-standard: 26,857 passed / 237 skipped, 1,785 seconds; frontend-standard: Rstest 167 files / 1,270 tests and Vitest 355 files / 10,565 tests, 474 seconds; frontend-smoke: 35 passed, 138 seconds. All exits 0 |
| Protected Server Real E2E | passed, exit 0; 7 passed / 5 skipped, 5.5 minutes of Playwright execution. Extension path selects it through `.github/scripts/should-run-real-e2e.sh`, overriding the generic selector |
| GitNexus `detect_changes({scope: 'all'})` | complete, 8 changed files, 17 symbols, 9 processes, HIGH risk; no partial/truncated result. [Structured result](evidence/gitnexus-detect-full.json) |
| Two independent review axes | Standards: one product P2 and three acceptance assertion gaps corrected, zero open. Spec: one product P2 corrected, zero open. [Review record](code-review.md) |

The six Windows Runtime skips comprise two unavailable Win32 symlink-creation
tests, POSIX process groups, two non-Windows secret-store cases and POSIX private
key mode bits. The installed LX symlink/junction checks above provide actual
Windows escape coverage. Full skip reasons remain in the XML; skips are not passes.

The first Server PR run failed: 8 script command-selection tests were polluted by
the globally exported `TEST_PNPM_BIN`; frontend-smoke rejected an external
`node_modules` symlink. The unchanged 17 script tests pass with the override
removed. The final run uses a task-owned PATH shim for locked pnpm 10.26.2 and a
real dependency copy inside the isolated checkout. Initial failure output is
retained as [historical gate evidence](evidence/server-pr-standard.log.gz).
It is not substituted for a passing final gate.

The focused Server command, from `backend/` with the locked candidate Python,
was:

```bash
.venv-candidate/bin/python -m pytest \
  tests/unit/gateway/test_local_runtime_context.py \
  tests/unit/gateway/test_canonical_agent_run.py \
  tests/unit/agentplatform/test_local_runtime_extension.py \
  tests/unit/agentplatform/test_runtime_adapter.py \
  tests/integration/api/test_devices_router.py -q -p no:cacheprovider
.venv-candidate/bin/ruff check \
  app/gateway/run_preparation.py app/gateway/canonical_agent_run_preparation.py \
  app/gateway/local_workspace_policy.py app/gateway/routers/devices.py \
  packages/agentplatform-extension/agentplatform_extension/local_runtime/tools.py \
  tests/unit/gateway/test_local_runtime_context.py \
  tests/unit/agentplatform/test_local_runtime_extension.py \
  tests/integration/api/test_devices_router.py
```

`PYTHONPATH` included the isolated backend, backend/tests, harness,
agentplatform-extension and extension-api package roots. `TEST_PNPM_BIN` was
unset. These focused checks supplement the full gate rather than replacing it.

The isolated Server root also ran `python scripts/test_inventory.py`,
`python scripts/check_documents.py` and
`python scripts/check_upstream_patches.py --base 95260f452670df62e365f10035d095838ec3a495
--upstream-baseline 345f08be00c8a9495079b732a39b46aa9af1584e` with the same locked
Python. These final reruns retain their complete argv, cwd, timestamps and exits.

The protected Real E2E run used `QA_ISOLATED=1 bash backend/scripts/run-real-e2e.sh`
without a grep/filter. Four RAGFlow fixture cases and the live-model workflow
case were skipped by their existing explicit dataset/provider requirements.
The seven executed browser scenarios cover memory persistence, login-cookie
choice, role boundaries and visibility application persistence. These skips
are not passes or evidence for local-file behavior. The dedicated cross-repository
T100 run supplies that behavior evidence. Real E2E's initial cleanup could not
remove immutable published-resource directories; the exact isolated directory
was checked, owner write permissions restored, remnants removed and both
test ports verified closed. The original cleanup errors remain in the log.

Two later installed evidence runs failed before the final passing run: one
returned `CHAT_SERVER_UNAVAILABLE` while concurrent compilation caused host
resource pressure (causation was not established); another fixture's Windows
path detector mistook `http://` for a drive path. The latter detector was fixed
to require a drive-letter boundary. Both runs restored the original profile and
removed their temporary credentials. [Execution history](evidence/execution-history.json)
keeps these failures distinct from the final exact-comparison run.
The package was subsequently rebuilt from the same frozen source to capture
complete packaging time; its final installer hash is the one in the header.
The earlier fixture runs used installer
`f42e9c125aa409aae46daa0174bbf269f6b5a8be4d8ed6f11097279fb40e18c0` with the same
ASAR and Runtime payload. The `installed-package-final` history entry and final
lifecycle evidence refer to the rebuilt package.

## Windows 7 follow-up

Status: unexecuted, explicitly deferred by issue #100 to
[#131](https://github.com/Orbit-Crew/iDeer/issues/131), assigned to **Neowyh**.
Run the installation/start/quit/uninstall/reinstall and T100-01 through T100-04
matrix on actual Windows 7. Verify native picker/consent, Credential Manager,
signed reconnect, file-handle/root identity checks, reparse/junction/symlink
denials, receipt persistence and process cleanup.

Dependencies requiring compatibility verification include Electron 22.3.27 /
Node 16.17.1, embedded CPython 3.12.10, cryptography/cffi wheels, Windows crypto
and credential APIs, Job Object/process handling, file sharing/open flags and
the NSIS installer. Any compatible distribution substitutions or compatibility
patches must be recorded and the package rebuilt/retested under #131. Current
modern Windows results make no Windows 7 compatibility or linz-retirement claim.

## Evidence handling

[Evidence manifest](evidence/manifest.json) contains SHA-256 values for the
allowlisted artifacts. Profiles, settings, SQLite databases, credential references,
private keys, cookies, tokens and unrelated user files are excluded. The final
gate summary and tested source-tree proof accompany the Server delivery record.

The [Server implementation patch](server-implementation.patch.gz) contains the
eight reviewed Server changes (gzip SHA-256
`aef06257c546a55601ef7154dbba9309934ec3a6888502c7f7ea61947e6a1e90`;
decompressed patch SHA-256
`1f1153b3cb800298676ea7c51bf0f43d1ca3693d3ea4477e9fd8516dda7eee33`).
It reverse-checks cleanly against the tested Linux candidate. To reproduce it,
decompress the gzip artifact, check out Server base
`aec07a3b9af3ab451b1f1a377a93f6f11135bf88` and run
`git apply <path-to-server-implementation.patch>`. The normalized candidate tree
is `cb44f7515dcf615fc11b54c824500145b018c857`, identical on Linux and Windows and
in Server commit `ed13672c4134681a9391e0baefca002a6dde2ad6`.
[Source-tree proof](evidence/server-source-tree-proof.json) and
[delivery record](evidence/server-delivery.json) bind the tested files to that
commit. Desktop's implementation and this report are committed together on
`codex/issue-100`.
