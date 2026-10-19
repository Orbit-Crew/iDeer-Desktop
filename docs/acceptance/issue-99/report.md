# Issue #99 acceptance

Overall result: **passed for modern Windows automatic acceptance**. Desktop
implementation, regressions, real-provider scenarios and installed-app lifecycle
are complete. The user explicitly authorized installation under the current
Windows account. Win7 remains unexecuted under #131. This report does not change
the GitHub issue state.

Executed on 2026-10-19, Asia/Shanghai, by Codex. All UI interaction reported
below was automated; no human acceptance is claimed.

## Candidate and environment

- Desktop product source: `f7f6264ed19978caca883db543c3ea57562acd81`.
  Later acceptance tests, fixtures and documentation do not change the packaged
  product. Review base: `b42458c49da5139475322da63072b36cbcecd673`.
- Server: `95260f452670df62e365f10035d095838ec3a495`, the merged #98 prerequisite.
  No Server production code changed. The initial Windows regression environment's installed editable harness comes from
  `aec07a3b9af3ab451b1f1a377a93f6f11135bf88`; a complete Git diff between those
  candidates is empty, and the installed source checkout was clean.
  Real-provider acceptance uses a separate WSL checkout at `95260f4`, with its
  harness and extensions explicitly on the Python import path. The existing WSL
  Python 3.12.3 environment is reused; its source checkout is `6a13947`, whose
  backend and frontend dependency locks match `95260f4`. This is an acceptance
  environment, not a fresh `uv sync --locked` or Server standard-lane pass.
- Windows 11 Pro, version `10.0.26300`, x64. Build/test Node `22.23.3`;
  Electron `22.3.27`, embedded Node `16.17.1`; bundled Runtime Python `3.12.10`;
  test-host Python `3.12.8`. See [environment metadata](evidence/environment.json).
- Installer SHA-256:
  `057943d1dfebc951bd5658cca1c8db5bbc3fc33198fcf80fa8ed2eaa2b6b8842`.
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
  This initial deterministic probe is supplemented by the real-provider and
  installed-app runs below.

The initial deterministic and 61,620 ms development-provider probes used product
`1cf1443`. Screenshot review then found that an active Thread's journal and
checkpoint could display the same human Turn twice after Server changed its ID
from `X` to `X__user`. Commit `f7f6264` applies the existing Server/Web identity
rule and adds a failing-then-passing public-interface regression. The final
sign-off uses the rebuilt, reinstalled candidate and real-provider probe below.
Earlier probe artifacts and [their hashes](evidence/candidate-before-alias-fix.json)
are historical evidence, not sign-off for the final Runtime module.

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
| T99-01 | Catalog, read-only identity, optional Skill and unavailable-resource protocol tests in `tests/test_platform_chat.py`; real `desktop.cjs` selects A's published Agent and required Skill through UI; `provider_profiles.py negative` submits restricted resources directly to Server | Canonical IDs, private visibility and version 1 retained in catalog and Run snapshot. UI disables unpublished and dependency-unavailable resources. Forced Desktop creation rejects. Direct Server Run requests return 409 for unpublished, 404 for archived required dependency and 404 for B's private Agent, with no Run created | passed |
| T99-02 | Turn/human-input protocol tests; installed `desktop.cjs` submits a unique marker twice concurrently, observes real provider SSE, answers the actual clarification card, then opens an existing Server Run with delegation enabled | One accepted Run and `CHAT_TURN_ALREADY_SUBMITTED` for the duplicate. Actual agnes response contains the requested marker. Clarification answer completes through the UI. Real task start/running/completed events, subagent model usage and its returned marker are recorded. Run Evidence and public-message tool receipt are archived | passed |
| T99-03 | Disconnect/unreachable protocol tests; installed probe restarts, reopens the same Thread, cuts a live proxy connection, attempts both restore and send offline, then restores connectivity | Message identities and human-input state survive restart. Offline restore and send return `CHAT_SERVER_UNAVAILABLE`. Recovery observes the same successful Run. Exactly four Runs exist in the chat Thread, so neither duplicate nor offline submission created another Run. No local fallback exists | passed |
| T99-04 | Identity-switch protocol test; installed probe switches A/B/A and forces private resource/history access; existing Server Turn/human-input regressions below | B cannot see A's Agent or Thread, and forced access rejects. Returning to A restores its owned Thread. Old-scope commands reject; no transcript/draft/catalog local persistence is introduced. Existing regressions pass | passed |

Final actual UI/Gateway steps and durations are in
[the installed probe result](evidence/provider-installed-result.json). It records the Run selection
snapshot, event IDs, restored message IDs, same-Run recovery and A/B/A outcome.
See [the UI screenshot](evidence/provider-chat.png) and
[credential/process cleanup](evidence/provider-cleanup.json). Each completed
fixture command exited 0. The redacted log and result manifest are preserved;
the database, cookies and credentials are excluded.
Archived text evidence normalizes line endings, trailing whitespace and terminal blank lines. Original
command outputs remain under ignored `artifacts/issue-99`; the manifest binds
the archived bytes, which Git preserves without newline conversion.

Manual UI acceptance remains unexecuted. Codex performed the automatic UI runs;
the user authorized the installation environment but did not manually confirm
each UI result. The issue specifies automatic execution for all four scenarios.

## Real-provider and installed-app acceptance

The user supplied the existing WSL Server/model configuration location. The
probe uses the configured `agnes-3.0-flash` provider through the production model
factory and unmodified Gateway. Its model credentials remain in the WSL process
environment. Only environment references enter the temporary fixture config;
no model credentials are copied to Desktop or committed. An initial tiny
DeepSeek probe returned HTTP 402; agnes responded successfully and was selected.

The Server's DB, resources, accounts and Gateway socket are isolated under
`dev-log/issue-99`; the user's Server checkout and data are preserved. The two
synthetic users authenticate through the real login API. Their business sessions
use task-owned Windows Credential Manager entries. Browser pairing is the #98
prerequisite, not a step claimed by this fixture.

The earlier development-app probe passed in 61,620 ms. After the user authorized the
current Windows account, `windows-local-acceptance.ps1` installed the final NSIS
candidate at the existing registered location, ran the installed security smoke,
uninstalled and reinstalled it. This was repeated for the alias-fix candidate.
All six final lifecycle checks passed; the last check
occurred at 35.694 s. The final installed smoke process took 11,209 ms, with 10,586 ms
inside the Node probe. The installed ASAR matches the candidate hash above.
Unique Desktop and linz data fixtures survived every stage. Both real shortcuts
then opened the expected window and exited with actual process exit code 0.

The final installed application run also passed all T99 scenarios against the
real provider in 60,061 ms, including an assertion that the restored delegated
Turn appears exactly once. UI screenshots wait for the rendered Run status and
include live subagent progress. Both Node and Gateway processes exited 0.
See [installed provider result](evidence/provider-installed-result.json),
[Run Evidence](evidence/provider-run-evidence.json),
[resource rejection requests](evidence/provider-negative-api.json),
[chat UI](evidence/provider-chat.png), [delegation result](evidence/provider-delegation.png),
[live subagent progress](evidence/provider-delegation-progress.png),
[installation results](evidence/installed-lifecycle.json) and
[shortcut results](evidence/installed-shortcuts.json).
[Environment and command metadata](evidence/provider-environment.json) binds the
execution timestamps, Server candidate, config and dependency hashes.

The delegated Run is prepared through the existing Server API with
`subagent_enabled=true`; Desktop opens and observes that same Run. Desktop does
not add a new delegation mode. The Skill assertion verifies canonical selection
and immutable version binding. The response marker is also in the synthetic
Agent SOUL, so it does not independently prove Skill instruction execution.
Server `metadata.run_evidence` has empty tool/subagent receipt arrays in these
runs; these empty arrays are preserved. The public Run-message API separately
provides the `ask_clarification` tool receipt. Real custom task events prove the
subagent execution, without claiming receipt completeness.

The installed probe uses the real Windows Known Folder and requires Runtime
settings to be absent. It creates settings exclusively and checks its credential
reference before each identity switch and cleanup. Both temporary credentials
were deleted, the originally absent settings file is absent again, and the
Gateway exited. See [cleanup](evidence/provider-cleanup.json). Existing application
installation and shortcuts remain restored at their registered location.

## Baseline commands

Exact invocation roots and environment setup are documented in
[the fixture instructions](../../../scripts/acceptance/issue-99/README.md).
All successful commands below exited 0.

| Command | Result | Duration/evidence |
| --- | --- | --- |
| `npm.cmd run typecheck` | passed | [log](evidence/typecheck-reviewed.log) |
| `npm.cmd test` | 10 passed in 7 files | 12.58 s, [log](evidence/test-reviewed.log) |
| `npm.cmd run verify:provenance` | passed | [log](evidence/provenance-reviewed.log); combined wall time was not independently recorded |
| `python -m pytest local-runtime/tests -q -p no:cacheprovider --basetemp artifacts/issue-99/runtime-reviewed-tmp --junitxml artifacts/issue-99/runtime-reviewed.xml` | 251 passed, 6 skipped | pytest 49.46 s; [log](evidence/runtime-reviewed.log), [JUnit](evidence/runtime-reviewed.xml) |
| `npm.cmd run dist:win`, with cached `ELECTRON_BUILDER_CACHE` and Node 22/Python on PATH | final NSIS x64 candidate built | [log](evidence/dist-win-reviewed.log); total wall time was not independently recorded |
| `node scripts/desktop-smoke.cjs` with the installed executable's absolute Windows path | packaged UI, sandbox, main-frame IPC rejection, CSP/navigation/popup restrictions, resize/sidebar, Runtime restart/crash recovery, second instance and both exit paths passed | 11.209 s process, [log](evidence/installed-smoke.log), [processes](evidence/installed-processes.json), [Runtime lifecycle](evidence/installed-runtime-lifecycle.json) |
| Server `python -m pytest tests/unit/gateway/test_human_input.py tests/unit/gateway/test_thread_run_idempotency.py tests/integration/api/test_shared_resource_run_e2e.py -q --basetemp ../dev-log/issue99-regression-final` | 27 passed | 11.70 s, [log](evidence/server-regression-final.log) |
| Server frontend `node node_modules/vitest/vitest.mjs run tests/unit/core/threads/turn-submit.test.ts --no-cache --maxWorkers=2` | 36 passed; actual invocation also listed the human-input files owned by Rstest, which Vitest correctly did not collect | 2.74 s, [log](evidence/server-frontend-regression.log) |
| Server frontend `node node_modules/@rstest/core/bin/rstest.js run tests/unit/core/messages/human-input.test.ts tests/unit/components/workspace/messages/human-input-card.test.ts tests/unit/components/workspace/messages/human-input-card.dom.test.tsx` | 35 passed, no skips | 5.155 s, [log](evidence/server-rstest-regression.log) |
| Historical `gateway_fixture.py --server-root <checkout> --state <fresh fixture>` then `node scripts/acceptance/issue-99/desktop.cjs <fixture>` | initial product `1cf1443` passed with Server-side deterministic model; retained as historical evidence | [result](evidence/gateway-result.json) includes elapsed milliseconds |
| WSL `provider_server.py`, Windows `provider_profiles.py prepare`, then installed `node scripts/acceptance/issue-99/desktop.cjs artifacts/issue-99/provider-installed-reviewed` | real provider, published Skill, direct resource rejections, clarification, delegated progress, restart/offline recovery and A/B/A passed on the final candidate | 60,061 ms, [result](evidence/provider-installed-result.json), [cleanup](evidence/provider-cleanup.json) |
| `windows-local-acceptance.ps1 -Installer <final NSIS> -InstallDirectory <registered location> -EvidenceDirectory artifacts/issue-99/installed-reviewed` | final install, installed security smoke, uninstall/data retention and reinstall passed | [lifecycle](evidence/installed-lifecycle.json), [smoke log](evidence/installed-smoke.log), [data hashes](evidence/installed-data-retention.json) |
| `scripts/acceptance/issue-99/shortcuts.ps1 -Executable <installed exe> -EvidenceDirectory artifacts/issue-99/installed-reviewed` | desktop and Start Menu shortcut windows opened and exited 0 | 1,313 / 1,365 ms, [result](evidence/installed-shortcuts.json) |

Python lint for the changed Runtime modules/tests passed. The environment-staged
fixture also passed lint with `E402` excluded because it sets import paths and
configuration before importing Server. `node --check` and `git diff --check`
passed. The [two-axis review](code-review.md) has no unresolved code findings.
The new provider scripts passed Ruff with environment-staged `E402` excluded;
the updated Node fixture passed `node --check`. The selected text evidence also
passed a [configured-secret and JWT scan](evidence/provider-evidence-audit.json).

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

## Acceptance limits

No required modern-Windows scenario remains unexecuted. The automatic results
apply to the recorded candidate, dependencies, configuration and environment.
No human UI confirmation, production deployment, release publication or GitHub
issue closure is claimed. The only required platform check deferred by the
issue is real Win7 below.

## Real Win7

Unexecuted, owned by Neowyh under
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). Verify the final installer,
Electron 22/Node 16 compatibility patches and soft rendering; bundled Python,
TLS/HTTP streaming and Windows Credential Manager; login/ownership separation;
resource selection; human-input cards; disconnect/restart recovery; identity
isolation; install/uninstall and clean process exit. Record OS/SP/patches,
dependency and final-package hashes. This explicitly deferred platform check
does not block modern-Windows #99 acceptance and is not counted as passed here.
