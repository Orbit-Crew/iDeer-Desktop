# Issue #99 acceptance

Overall result: **incomplete; do not close #99**. Desktop implementation and
local regression checks are complete. The real Gateway/Desktop fixture passes,
using an explicitly deterministic Server model. Required external-provider and
isolated installed-app acceptance have not run.

Executed on 2026-10-19, Asia/Shanghai, by Codex. All UI interaction reported
below was automated; no human acceptance is claimed.

## Candidate and environment

- Desktop product source: `1cf14436efbe5f21c8a8a42a1746489ccb58794c`.
  Later acceptance tests, fixtures and documentation do not change the packaged
  product. Review base: `b42458c49da5139475322da63072b36cbcecd673`.
- Server: `95260f452670df62e365f10035d095838ec3a495`, the merged #98 prerequisite.
  No Server production code changed. Its installed editable harness comes from
  `aec07a3b9af3ab451b1f1a377a93f6f11135bf88`; a complete Git diff between those
  candidates is empty, and the installed source checkout was clean.
- Windows 11 Pro, version `10.0.26300`, x64. Build/test Node `22.23.3`;
  Electron `22.3.27`, embedded Node `16.17.1`; bundled Runtime Python `3.12.10`;
  test-host Python `3.12.8`. See [environment metadata](evidence/environment.json).
- Installer SHA-256:
  `2a4cc3168607828079707f3d3cf956656e4ef8f44d67e59cfd376057d5285de3`.
  [Candidate hashes](evidence/candidate-hashes.json) also bind the ASAR,
  Desktop/runtime/Server dependency locks and builder configuration. The new
  Python chat module's source, prepared Runtime and packaged Runtime have the
  same SHA-256.
- Gateway fixture: normal authentication and RBAC, two synthetic regular
  users, isolated SQLite/resource directories and two task-owned Windows
  Credential Manager entries. A private published Agent uses the Server's
  existing deterministic model helper. No external provider, browser pairing
  or local model runs. A task-owned TCP proxy injects transport failure.
  The fixture deletes its own credentials and stops its Gateway on completion.

## Scenario map and results

The user confirmed the test seams before tests were written: restricted Desktop
chat commands and visible UI, existing Server Turn/human-input regressions, and
the real cross-repository probe. Protocol constants come from Server's public
run models, stream modes, session/CSRF contract, canonical resource API and
human-input metadata. Expected model text is the fixed literal in
`gateway_fixture.py`, rather than an expectation derived from implementation
output. Fixture requests use a 60-second observation deadline; production HTTP
and IPC deadlines remain 15 and 30 seconds. No numeric tolerance is applied to
identities, event IDs, versions, statuses or rejection categories.

| Scenario | Actual entry and steps | Expected and observed automatic result | Status |
| --- | --- | --- | --- |
| T99-01 | `tests/test_platform_chat.py::test_catalog_uses_business_identity_and_retains_canonical_identity`, `test_read_only_identity_cannot_select_or_force_activate_visible_agent`, `test_unavailable_resources_are_disabled_and_forced_activation_fails`, `test_available_optional_skill_in_agent_closure_can_be_selected`; real `desktop.cjs` selects A's private Agent and creates a Thread through UI, then B forces its ID | Canonical ID, private visibility and published version retained. Viewer selection disabled. Protocol fixtures reject unpublished, suspended and missing-required-dependency resources before Thread creation. Real Gateway denies B's forced private-Agent activation with `CHAT_NOT_FOUND`. Optional available Skill closure is covered by the protocol fixture. Real Gateway Skill/version/dependency cases still need the required final environment | incomplete |
| T99-02 | `test_turn_submission_is_fenced_and_reopening_restores_server_messages`, `test_restored_human_input_response_uses_the_existing_message_contract`, `test_plain_human_reply_resolves_only_latest_pending_human_input`; real `desktop.cjs` issues simultaneous same-Turn commands, observes SSE and clicks the Server clarification choice | Exactly one accepted Run; the duplicate returns `CHAT_TURN_ALREADY_SUBMITTED`. Fixed Server text, Run/Thread IDs, event IDs and immutable selection snapshot are recorded. Clarification request/answer metadata matches existing platform behavior. Actual tool progress is visible. External-provider streaming and real delegated-subagent progression are unexecuted | incomplete |
| T99-03 | `test_disconnect_is_visible_without_resubmitting_the_turn`, `test_unreachable_server_is_an_explicit_error_and_never_creates_a_local_run`; real probe quits/relaunches Electron, reopens the same Thread, cuts an established stream's proxy, attempts restore while offline and restores the proxy | Server message identities and clarification state survive restart. Loss becomes `disconnected`; restore while offline returns `CHAT_SERVER_UNAVAILABLE`. Recovery reads the same Run ID with `success`, without automatically resubmitting the prior POST. No local Agent/model fallback exists in the shipped graph | passed for the isolated automatic probe |
| T99-04 | `test_identity_switch_drops_history_and_rejects_old_view_commands`; real probe restarts under B, checks catalog/history and forced access, then returns to A; existing Server behavior suites below | B sees neither A's private Agent nor Thread and cannot open/activate either. Old-scope commands reject; no transcript/draft/catalog local persistence is introduced. Returning to A restores the owned Thread. Existing Turn and human-input regressions pass | passed for the isolated automatic probe |

Final actual UI/Gateway steps and durations are in
[the probe result](evidence/gateway-result.json). It records the Run selection
snapshot, event IDs, restored message IDs, same-Run recovery and A/B/A outcome.
See [the UI screenshot](evidence/desktop-chat.png) and
[credential/process cleanup](evidence/gateway-cleanup.json). Each completed
fixture command exited 0. The redacted log and result manifest are preserved;
the database, cookies and credentials are excluded.
Archived text evidence normalizes line endings and terminal blank lines. Original
command outputs remain under ignored `artifacts/issue-99`; the manifest binds
the archived bytes, which Git preserves without newline conversion.

Manual acceptance remains unexecuted for every scenario. Automated UI evidence
does not constitute human confirmation or an installed-app provider test.

## Baseline commands

Exact invocation roots and environment setup are documented in
[the fixture instructions](../../../scripts/acceptance/issue-99/README.md).
All successful commands below exited 0.

| Command | Result | Duration/evidence |
| --- | --- | --- |
| `npm.cmd run typecheck` | passed | [log](evidence/typecheck-final.log) |
| `npm.cmd test` | 10 passed in 7 files | 5.48 s, [log](evidence/test-final.log) |
| `npm.cmd run verify:provenance` | passed | [log](evidence/provenance-final.log); combined Desktop checks took 11.50 s in [result](evidence/desktop-checks.json) |
| `python -m pytest tests -q -p no:cacheprovider --basetemp ../artifacts/issue-99/runtime-final-tmp --junitxml ../artifacts/issue-99/runtime-final.xml`, from `local-runtime` | 250 passed, 6 skipped | pytest 27.84 s; process 28.41 s; [log](evidence/runtime-final.log), [JUnit](evidence/runtime-final.xml), [result](evidence/runtime-final-result.json) |
| `npm.cmd run dist:win`, with cached `ELECTRON_BUILDER_CACHE` and Node 22/Python on PATH | NSIS x64 candidate built | [log](evidence/dist-win-final.log); total wall time was not independently recorded |
| `node scripts/desktop-smoke.cjs`, `DESKTOP_EXECUTABLE=dist/win-unpacked/ideer-desktop.exe` as an absolute canonical Windows path | packaged UI, sandbox, main-frame IPC rejection, CSP/navigation/popup restrictions, resize/sidebar, Runtime restart/crash recovery, second instance and both exit paths passed | 8.99 s process, [result](evidence/packaged-smoke-final-result.json), [log](evidence/packaged-smoke-final.log), [processes](evidence/desktop-processes.json), [Runtime lifecycle](evidence/runtime-lifecycle.json) |
| Server `python -m pytest tests/unit/gateway/test_human_input.py tests/unit/gateway/test_thread_run_idempotency.py tests/integration/api/test_shared_resource_run_e2e.py -q --basetemp ../dev-log/issue99-regression-final` | 27 passed | 11.70 s, [log](evidence/server-regression-final.log) |
| Server frontend `node node_modules/vitest/vitest.mjs run tests/unit/core/threads/turn-submit.test.ts --no-cache --maxWorkers=2` | 36 passed; actual invocation also listed the human-input files owned by Rstest, which Vitest correctly did not collect | 2.74 s, [log](evidence/server-frontend-regression.log) |
| Server frontend `node node_modules/@rstest/core/bin/rstest.js run tests/unit/core/messages/human-input.test.ts tests/unit/components/workspace/messages/human-input-card.test.ts tests/unit/components/workspace/messages/human-input-card.dom.test.tsx` | 35 passed, no skips | 5.155 s, [log](evidence/server-rstest-regression.log) |
| `gateway_fixture.py --server-root <checkout> --state <fresh fixture>` then `node scripts/acceptance/issue-99/desktop.cjs <fixture>` | real Electron/preload/Runtime/Gateway probe passed with Server-side deterministic model | [result](evidence/gateway-result.json) includes elapsed milliseconds |

Python lint for the changed Runtime modules/tests passed. The environment-staged
fixture also passed lint with `E402` excluded because it sets import paths and
configuration before importing Server. `node --check` and `git diff --check`
passed. The [two-axis review](code-review.md) has no unresolved code findings.

The six Runtime skips are two Windows symlink cases without creation privilege,
one POSIX process-group case, two non-Windows secret-backend cases and one POSIX
file-mode case. They are not counted as passed. Existing elevated symlink
evidence is not reused as validation of this candidate.

Initial attempts are not successful gates. The default builder cache failed on
macOS symlink extraction; the existing verified Windows builder cache completed
the build without changing the packaging configuration. One sandboxed esbuild
attempt could not read parent directories; the normal-access run passed.
The new Server clone lost two scanner files to host file restrictions, while
its already-installed identical harness remained readable. The first backend
collection failed, and a later scratch-directory setup failed; both were
corrected before the 27-test successful run. The recorded
[Server standard-lane preflight](evidence/server-preflight.log) failed because
the new clone did not have a locked UV environment. The targeted regressions
used the existing installed environment; this is not a Server standard or
`pr-standard` pass. No Server production path changed in this work.

## Remaining required acceptance

1. Run T99-01/T99-02 against the approved deployment with real published
   Agent/Skill and dependency/version fixtures and an actual model provider.
   Include delegated-subagent progress and real Run Evidence. No approved
   provider configuration was supplied for this run.
2. Install, launch, exercise the real provider and history paths, exit and
   uninstall/reinstall the final NSIS candidate under an isolated Windows test
   account. Only the packaged payload was launched here. The normal user's
   existing installed application was not replaced for this fixture.
3. Record human UI acceptance and final candidate/dependency/config hashes for
   those runs. Do not promote the automatic probe or prerequisite #98 evidence
   to a pass for these unexecuted steps.

These are delivery gaps for #99, not work deferred to a later stage. Keep #99
open until its required modern-Windows acceptance is complete.

## Real Win7

Unexecuted, owned by Neowyh under
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). Verify the final installer,
Electron 22/Node 16 compatibility patches and soft rendering; bundled Python,
TLS/HTTP streaming and Windows Credential Manager; login/ownership separation;
resource selection; human-input cards; disconnect/restart recovery; identity
isolation; install/uninstall and clean process exit. Record OS/SP/patches,
dependency and final-package hashes. This explicitly deferred platform check
does not block modern-Windows #99 acceptance and is not counted as passed here.
