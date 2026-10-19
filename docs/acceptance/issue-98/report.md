# Issue #98 acceptance

Implementation, modern Windows T98-01 through T98-04, the required standard
gates and the protected default Real E2E are complete. Optional external-provider
cases and real Win7 remain unexecuted as detailed below.

Execution dates: 2026-10-18 and 2026-10-19, Asia/Shanghai. Executor: Codex.
Desktop product source `307904c28df8cbd9b87674e31cbdb99551fbe887`; Server product source `49b635ac5a59085c7c5c028c09a835db48728c9a`.
Desktop review base `2fbfa8528a3f77b11cbf68b8e3f338ec08c1db94` is the merged
develop commit confirmed by the user. Server review base is
`ccb251e07e5f5934b851e4c3df00224718f28123`.
Documentation commits after these product commits do not change the tested app.

Final Server validation candidate `9d3ee3d9cdd8bdfc0e246b7249a69d80f6134d25` adds only the migration-chain
test correction to product source 49b635. No production code changed after the
real Windows acceptance. Final Linux gates ran on this corrected candidate.

## Scenario record

| Scenario | Final modern Windows result | Evidence |
| --- | --- | --- |
| T98-01 | passed | Actual installed Electron UI and restricted IPC invoke the real browser opener. Existing account A signs in through the normal Server login page and explicitly confirms its device fingerprint. Browser confirmation creates no Desktop session. Runtime exchange creates separate business/device credentials and an owned, online device over signed WS. Restart restores OS credentials and the same device. |
| T98-02 | passed | Actual Gateway returns wrong initiator/key `401 LOGIN_BINDING_INVALID`, wrong owner/confirmation `403 LOGIN_OWNER_MISMATCH`, replay `409 LOGIN_ALREADY_USED`, and expired confirmation/completion `410 LOGIN_EXPIRED`. Real 300-second TTL expires after 301 seconds. Concurrent completion yields exactly one `200`, one `409` and one new device. Unauthenticated WS closes with `4003`. |
| T98-03 | passed | Installed renderer/stdio/status/browser URL contain no long-lived credentials. Settings contain three separate OS-store references and no plaintext session token. Real Windows Credential Manager storage and restart pass. Real CredWrite blob-size rejection produces `SECURE_STORAGE_FAILED`, zero stored credentials and zero plaintext fallback files. |
| T98-04 | passed | Runtime reaches actual Gateway/Next through nginx's unified loopback entry. An acceptance socket guard blocks direct Gateway and all other outbound ports. Stopping the verified fixture proxy tree closes the public port and changes Runtime to `connecting`; restarting it restores the signed online connection. Final proxy tree exits and the public port closes. |

## Candidate and environment

Windows 11 Pro 10.0.26300 x64; app 0.1.0; Electron 22.3.27 with Node 16.17.1;
build Node 22.23.3/npm 10.9.9; exact pnpm 10.26.2; test Python 3.12.8;
bundled Python 3.12.10, cryptography 43.0.3 and websockets 13.1;
nginx 1.31.7 and Playwright 1.59.1. Lock/config hashes and component versions
are in [environment-manifest.json](evidence/environment-manifest.json).

Installer `dist/ideer-desktop-0.1.0-windows-x64-setup.exe` SHA-256:
`f3a94a7269025bf716792063498d32698793b73b9c004b15c00be2074450ab73`.
It was installed through actual NSIS to
`D:/software/iDeer Desktop/ideer-desktop`.
Installed `app.asar` SHA-256:
`2f7dbfd009b74024f58b62d1847a89733827b63723cf5ff0653fd12b9b0c8772`.
All 23 installed Runtime core Python files match the tested Windows working-tree
bytes, and their Git-normalized bytes match the product commit. All
five current compiled `out/` files match the installed ASAR. See
`installed-runtime-source-match.json` and `installed-build-match.json`.
The raw installation environment captured HEAD before the product commit existed;
these byte comparisons and `candidate-source-sha256.json` bind that built working
tree to the final product commit without rewriting the raw observation.

The real fixture disables auth bypass and dotenv loading, isolates both modern
and compatibility settings, and uses SQLite under Server `dev-log/live-98`.
Its public entry is `http://127.0.0.1:21980`; private Gateway and Next ports are
21981 and 21982. Local HTTP is permitted only for loopback. Production login
origins require HTTPS and Runtime refuses proxies and redirects for exchange.

## Final checks

| Check | Result |
| --- | --- |
| Desktop source verifier / ruff / Runtime preparation | passed |
| Desktop TypeScript, both projects | passed |
| Desktop full Runtime tests | 237 passed, 6 platform skips; pytest 48.63 seconds |
| Desktop full Vitest | 7 tests in 5 files passed; 11.60 seconds |
| Windows NSIS build / install / Runtime lifecycle / signed WS and MCP | passed |
| Real Windows T98-01 through T98-04 | passed against product sources 307904c / 49b635 |
| Server focused login / production handler / payload checks | 23 passed; 16.04 seconds |
| Migration-chain contract after correcting the old head assertion | 10 passed on Windows in 5.84 seconds; 10 passed on Linux in 10.59 seconds |
| Final Linux local-runtime | passed; passed=224, skipped=4; TEST_LANE_DURATION=19 seconds; status=0 |
| Final Linux backend-standard | passed; passed=26842, skipped=239; TEST_LANE_DURATION=1023 seconds; status=0 |
| Final Linux frontend-standard | passed; rstestPassed=1270, vitestPassed=10558; TEST_LANE_DURATION=432 seconds; status=0 |
| Final Linux frontend-smoke | passed; passed=34; TEST_LANE_DURATION=64 seconds; status=0 |
| Final Linux parent pr-standard | passed; TEST_LANE_DURATION=1544 seconds; status=0 |
| Protected default Real E2E | 7 passed, 5 optional external-service cases unexecuted; exit 0; 142.013 seconds |
| Real E2E fixture cleanup | verified state removed and Gateway/Next ports closed |
| Final Linux full frontend TypeScript | passed; 35.867 seconds; exit 0 |
| Server document / upstream-patch gates / test inventory | passed; document gates replayed after final report |

## Retained failed attempts and corrections

| Attempt | Original result and follow-up |
| --- | --- |
| Official Windows pr-standard | Failed. Runtime 222 passed / 6 skipped; backend 388 failed / 24,301 passed / 388 skipped / 62 collection errors. Frontend standard/smoke launcher exited 139. Parent duration 1,397 seconds; all sub-lane timings and raw-log hashes retained. |
| Native Windows backend | Failed with 351 failed / 26,303 passed / 408 skipped / 3 collection errors in 1,416.23 pytest seconds. Identified groups use Linux-only modes, paths, fcntl or symlink assumptions. Not every failure is attributed to the environment. |
| Native Windows frontend | Rstest 1,270 passed; Vitest 10,557 passed / 1 typography failure. Commit 49b635 uses the existing type-page-title role; 3 focused tests pass. Both final Linux frontend suites pass. |
| Native Windows smoke | 32 passed / 2 documentation cold-compile timeouts; the unchanged documentation-spec retry passed 3 in 9.3 seconds. Final Linux smoke passes the complete 34-test selection. |
| First complete Linux pr-standard on 49b635 | Backend 26,841 passed / 1 failed / 239 skipped; the old test pinned the previous migration head. Other three sub-lanes passed. Parent duration 1,714 seconds, status 1. Test-only commit 9d3ee3d retains the old merge's two parents and verifies the new unique head and its direct parent. Focused red: 1 failed in 11.22 seconds; green: 10 passed on each OS. Final complete gate passes. |
| First protected Real E2E | Browser assertions passed 7, with 5 optional cases skipped; runner exit 0. Official cleanup refused the nested TMPDIR. Its Gateway was verified and stopped, its read-only fixture directories were made owner-writable solely for removal, and that state was removed. The final rerun uses the supported direct /tmp parent and separately verifies cleanup. |

Earlier dependency/cache/DrvFS, missing-rg, antivirus-incomplete snapshot and
cancelled collection attempts remain separate raw records, not successful gates.
No test assertion, selection or timeout was weakened. The user restored/trusted
the two unchanged original scanner files; global protection remains enabled.
Curated summaries retain failed-case names and SHA-256 values of the full logs.

The unchanged Real E2E cleanup also cannot remove its read-only published fixture
directories as an ordinary user. On the final run the official stop step stopped
the services, then scoped post-test cleanup restored owner write permission only
inside that verified run directory and removed it. Both ports and state removal
were verified. The original cleanup errors and this harness limitation remain
recorded; no production cleanup script was changed in this feature.

## TDD and exact expectations

Initial Runtime and Desktop IPC tests failed because `core.browser_login` and
`beginLogin` did not exist, then passed after implementation. Expired business
auth initially remained authenticated; it now reports `expired / LOGIN_EXPIRED`
and prevents an executable device connection. The baseline Server router replay
fails the new HTTP expectation with `404 != 200`, one failed / four deselected in
27.18 seconds. Existing signed WS/MCP coverage is retained with a real business
authentication response in its fixture.

The full Gateway acceptance exposed stringified `LOGIN_*` error details. The
production exception-handler fixture first produced 3 failures / 2 passes in
27.48 seconds. An explicit seven-code allowlist preserves status and `detail.code`
without changing the existing top-level `error.code=INTERNAL_ERROR` convention.
All 23 focused login/handler/payload cases then passed. Subsequent final real HTTP
acceptance also passed against Server 49b635.

Exchange TTL is 300 seconds; real expiry waits 301 seconds. Business and device
sessions last one hour. Runtime HTTP timeout is 10 seconds, Desktop login startup
15 seconds, process force-stop 12 seconds, and nginx read/send 3,600 seconds.
Status/code/ownership assertions compare exact values with no numeric tolerance.
Same-device renewal and concurrent IPC tests added during review passed without
a retained pre-fix red run; that limitation is preserved.

## Linux source and evidence

The final native WSL checkout was fast-forwarded from the original hash-verified
49b635 snapshot to 9d3ee3d. Its only new file version is the migration test, whose
Windows/Linux SHA-256 is
`9bba1fc14077d75dd4d566e7a97e0b43ccf87aa3f6c4e6bd099443d3014ada30`.
Python 3.12.3, Node 22.23.2, pnpm 10.26.2 and CI uv 0.11.1 use task-owned native
ext4 dependencies/cache; browser engine and lock/config fingerprints are retained
with every sub-lane record. Dependency setup did not remove tests or scanners.

Full structured GitNexus change detection was retained before product/test
commits. The new migration test function is not mapped in that index and its
impact remains explicitly UNKNOWN; source inspection identifies only pytest as
its caller. The exact real-Alembic regression supplies its behavior evidence.
The optional index-refresh attempt was cancelled and the earlier FTS repair
failed. Neither is represented as a successful graph check.

## Reproduction and artifacts

Follow [the Windows acceptance scripts](../../../scripts/acceptance/issue-98/README.md)
for the isolated real Gateway/Next/nginx deployment and installed app. Run the
Server's unchanged `scripts/run-test-lane.sh pr-standard` and
`QA_ISOLATED=1 bash backend/scripts/run-real-e2e.sh` in its supported Linux
environment. For Real E2E, use a direct `/tmp` or `/var/tmp` state parent as the
official cleanup requires. External-provider opt-in cases need their own setup.

[The evidence manifest](evidence/sha256.json) hashes every curated redacted
artifact. `server-linux-final-gates.json` includes each sub-lane and parent result,
candidate, dependency/config fingerprint, environment and raw-log hashes.
`login-result.json`, `http-rejections.txt`, `storage-failure.txt` and
`cross-repo-result.json` cover the real T98 scenarios. The WS-only T98-02 subset
in the latter is combined with the complete HTTP negative record.
The installed run took 20.077 seconds; the actual TTL/rejection run 301.875 seconds;
the guarded proxy cut/reconnect run 26.780 seconds.

Database, returned credentials and browser cookies are excluded. Generated
installed settings and their three credentials were deleted after Runtime exit;
the standalone Runtime fixture's three references were also deleted. Session logs
remain in ignored `artifacts/issue-98/` and Server `dev-log/`.
`server-implementation.patch.gz` preserves the Server commits through its final
report commit; `evidence/server-patch.json` records its source head and hashes.

## Standards

The independent Standards review and final typography follow-up report zero
unresolved findings. The implementation uses the existing TanStack query layer,
registered runtime patch ledger and typography role. Validation scripts isolate
their configuration, ports, process trees and generated credential references.
The final one-line `type-page-title` correction also passes the existing three
typography contract tests, ESLint and Prettier.

## Spec

The independent Spec review and final follow-up report zero unresolved code
findings. Fixes include rejecting legacy Desktop device-only profiles without
business authentication, requiring existing-key proof for same-device renewal,
invalidating the previous device session, keeping the device offline until its
new handshake, and rechecking concurrent Desktop login admission.
The final test-only migration-head correction was independently reviewed by both
axes, with zero new findings and no weakened assertions. Required whole-suite
gate results are recorded separately above.

Final review findings: Standards 0; Spec 0. Neither axis has an outstanding code
finding.

## Platform limits

Real Win7 is unexecuted and explicitly deferred to
[#131](https://github.com/Orbit-Crew/iDeer/issues/131), owner Neowyh. That task must
cover T98-01 through T98-04, browser handoff, Credential Manager, bundled
interpreter/crypto/TLS, signed reconnect, Job Object ownership and installation,
startup and exit on actual Win7. Modern Windows results do not establish Win7
compatibility.

The real login acceptance uses the existing local-account path. Manual enterprise
SSO-provider configuration and login are unexecuted. The installed app calls the
real default-browser opener; automation completes login in a separate Chromium
instance on the same real route. The socket guard is a transport fault injection,
not an OS firewall rule. External models and tools are disabled in the isolated
device-authentication fixture.

The protected default CI Real E2E configuration does not provision optional
RAGFlow/model providers. Five such cases are unexecuted, not passes: Knowledge
Center Gate4, evidence Gate7, evidence loading/error/restriction states, evaluation
Gate8 and the real-model workflow. The default runner is unchanged and no grep
filter was used. Their external integrations are outside this device-login scope.
