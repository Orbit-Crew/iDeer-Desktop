---
id: issue-123-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 123 Desktop/MCP side of the optional local Connector component install loop — the offline package validation, the device-local controlled MCP configuration, the binding-scoped install registry, the desktop.py connectors wire gate, the platform identity registration leg, the desktop-mode connector MCP composition with supervisor swap, and the pinned desktop:connectors channel
last-verified: 2026-10-27
verified-against: orch/issue-123-connector-install working tree on top of 9b35acb (#122 candidate); every acceptance command below was run against this tree
---

# Issue 123 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-123-connector-install`, stacked on 9b35acb (#122). The Server repo
carries the same branch on top of b3c93587; its companion report is
`docs/acceptance/issue-123/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Fixed fixture

- Fixture entry: `local-runtime/tests/fixtures/connector_mcp_server.py`,
  SHA-256 `a57c9391be2349a0ef08ec437c08a9b1f10c1e4658daca8c4e2fce8c2b7a0100`
  — a stdlib-only newline-delimited JSON-RPC stdio MCP server with known
  outputs: `echo` (input round-trip), `read_file`/`write_file` confined to
  the directory given via `MCP_ROOT` (out-of-root and symlink escapes fail
  as tool errors with no side effect), and a pid marker hook for the
  orphan-process check. Test packages are generated around it with a frozen
  manifest shape (`connector`/`displayName`/`version`/`entry`/`requirements`,
  version `1.2.0`, `python>=3.9` floor); invalid variants (broken manifest,
  bad slug/version, missing/absolute/escaping/native `.exe` entry,
  symlinked entry, unprobeable dependency, impossible version floor) are
  derived from the same frozen constants, never from implementation output.
- Environment: Windows 11 host (build 10.0.26300 x64), WSL2 Ubuntu
  (5.15.167.4-microsoft-standard-WSL2) for the CPython test leg, bundled
  Windows CPython 3.12.10 runtime for the Electron-bridge leg.

## Implemented surface

- `local-runtime/core/connector_install.py` (new): the offline installer —
  - `read_package` validates one user-located candidate directory
    read-only: fixed manifest key set (unknown keys refuse — a manifest
    carrying commands, environment or hooks must not look installable),
    slug/version grammar, package-relative `.py` entry that cannot be
    absolute, escaping or symlinked down to its root, member screen that
    refuses native executables and oversized/link-containing packages, and
    a probeable dependency floor (`python>=X.Y` probed against the running
    interpreter; an unprobeable dependency is `CONNECTOR_DEPENDENCY_MISSING`,
    a floor this device fails is `CONNECTOR_VERSION_MISMATCH`) — AC1/AC4;
  - `ConnectorInstallService.install` orders the flow platform-first:
    confirmed install registers the canonical identity (identity fields
    only: slug, display name, version, manifest hash) through the injected
    `registrar`, then copies the package into this profile's managed store
    and re-hashes the copy (`CONNECTOR_PACKAGE_INVALID` on drift), writes
    the controlled MCP configuration (command = pinned bundled interpreter +
    managed entry; the only injected environment is the connector's own
    managed data directory), and records the binding-scoped registry row. A
    preview (`confirmed=False`) writes nothing and registers nothing; a
    same-content reinstall is idempotent; a frozen-identity conflict from
    the platform maps to `CONNECTOR_IDENTITY_CONFLICT` — AC2;
  - `remove` is stop-first and binding-scoped: the local commit (store,
    registry row, controlled config) happens before the platform
    unregister, so an interrupted removal never leaves a platform identity
    for a component the device no longer has — AC2/AC4;
  - every projection across the Desktop boundary carries identity fields
    only (`slug`, `displayName`, `version`, `manifestHash`, `packageHash`,
    `fileCount`, entry basename); local paths and package bytes never
    travel — AC2/AC3.
- `local-runtime/core/platform_chat.py`: `register_connector_identity` /
  `unregister_connector_identity` ride this device's own authenticated
  platform session (`/api/connectors`); the registration body has exactly
  four identity keys, and an already-absent identity is a successful
  unregister no-op — AC2.
- `local-runtime/core/tray.py`: in desktop mode the controller builds a
  `ConnectorInstallService` (registry `connectors.db` beside the profile
  config) and composes the desktop MCP service from `connector_service.
  specs(owner)` — the controlled configuration only, never a user-editable
  MCP config file, and only for the profile that installed the components
  (`profile_binding`). `refresh_connectors()` reuses the existing supervisor
  swap: stop removed servers, start added ones, republish the capability
  projection — AC1/AC2.
- `local-runtime/core/desktop.py`: the `connectors` control channel — fixed
  per-action key sets (`list` / `preview|install` with `path`+`confirmed` /
  `remove` with `slug`+`confirmed`), the profile scope binding checked
  before anything else, owner resolved from the profile binding with
  authenticated-login gating, and fixed `CONNECTOR_*` categories on the way
  out; a confirmed install/remove triggers `controller.refresh_connectors()`
  so the running projection can never outlive the registry — AC1/AC4.
- `src/main/index.ts` `desktop:connectors` (pinned in
  `test/security.test.ts`): the renderer names the action only; the
  candidate directory is located by the trusted main process, the preview is
  read-only, and the install/remove run only after an explicit dialog
  confirmation whose copy states the device-local binding and no-share
  boundaries — AC2/AC4.
- `src/main/runtime.ts`: the wire client for the channel (fixed command
  shapes, one in-flight request, 30 s bound) with bounded reply validation —
  identity projections only; `src/preload/index.ts` exposes the single
  pinned `connectors` bridge method; `src/shared/desktop.ts` carries the
  `ConnectorView`/`ConnectorInstallPreview` identity types and the
  `connectors`/`connectorStorageError` status fields.
- `src/renderer/src/components/ConnectorSection.tsx` (mounted in
  RuntimePanel): lists installed connectors (identity facts + manifest hash,
  copyable) with install/remove entries and fixed-category action hints;
  `test/connectors.test.tsx` pins the surface, the command validation, and a
  real bundled-Windows-runtime refusal leg (below).

## Scenario evidence

| Scenario | Status | Command / evidence |
| --- | --- | --- |
| T123-01 (candidate install → version/dependency/entry/controlled config → start → discovery → consented echo/managed read/write via local.mcp.* → exit with no orphan) | passed | `cd local-runtime && $HOME/miniconda3/bin/python -m pytest tests/test_connector_install.py -q` → 15 passed, exit 0. `test_install_start_discovery_execute_and_no_orphans` runs the whole chain over the real stdio fixture: install → controlled config asserted (pinned interpreter, managed entry, `MCP_ROOT` = the connector's own data dir) → supervisor start → discovery projects exactly `local.mcp.demo-echo.{echo,read_file,write_file}` → consented echo returns the known marker → managed write/read round-trip matches file content → out-of-root write is a tool error with no file effect → `stop_all` leaves `returncode` set and the projection empty (no orphan). `test_install_registers_identity_first_and_commits` binds the platform id before the local commit. Real-Windows UI leg (Electron dialogs, tray): staged — the wired path is exercised end-to-end below without the dialog step. |
| T123-02 (remove component/dependency, mismatched version, invalid entry, connection failure → actionable reason; recovery via real call after fix) | passed (automated legs) | Same file: `test_package_validation_matrix` (missing/broken manifest, bad slug/version, missing/absolute/escaping/native entry, symlinked entry), `test_version_floor_mismatch_is_actionable` (`CONNECTOR_VERSION_MISMATCH` + a satisfied floor previews cleanly), `test_removed_component_refuses_to_start_with_actionable_state` (vanished entry → `failed` + `SERVER_CRASHED`, projection empty — nothing impersonates availability), `test_registration_failure_keeps_the_device_unchanged` / `test_removal_unregisters_after_local_commit` (platform-unreachable legs keep honest categories), `tests/test_desktop_connectors.py::test_wire_gate_refuses_malformed_connector_commands`, and the `CONNECTOR_*` hint matrix in `test/connectors.test.tsx`. Recovery-after-fix: the confirmed install/remove/list roundtrip in `test_desktop_connectors.py::test_preview_install_list_remove_roundtrip` and the idempotent reinstall re-establish a real runnable state; a dedicated UI fault-injection session is staged. |
| T123-03 (platform resource + share state after install; B/D2 cannot use D1's binding; config not synced; sanitized logs) | passed (automated legs) | `test_preview_projection_carries_no_device_paths` (projection contains no device path), `test_removal_refuses_unknown_and_is_binding_scoped` (another binding's install is `CONNECTOR_NOT_INSTALLED`), `test_unconfirmed_install_writes_nothing` and `test_registration_failure_keeps_the_device_unchanged` (no controlled config appears without a confirmed, registered install), desktop `connectors` status rows carry identity facts only; the Server legs live in the Server report (owner-scoped invisible-404, credential-shaped keys 422, log sanitation). Cross-account/cross-device run-time refusal is structural: the desktop supervisor is composed from this profile's binding-scoped registry (`_desktop_connector_mcp`), so B/D2 has no runnable spec for D1's connector. Real B/D2/D1 three-device exercise: staged. |
| T123-04 (out-of-root / link-escape write, unapproved execution, platform refusal, local DENY even with tool approval; secrets never to Server/model) | passed | `test_install_start_discovery_execute_and_no_orphans` (out-of-root write → failed tool result, no file effect), `test_package_validation_matrix` (symlinked entry and native members refused), `test_local_deny_wins_over_tool_approval` (configured local DENY returns `PolicyDecision.DENY` even with consent supplied), `test_consent_is_required_and_payload_bound` (a different payload re-asks; approval is payload-bound), `test_frozen_identity_conflict_is_its_own_category`. Receipt assertion: the echo receipt JSON contains no argument/content bytes (`"T123-echo-marker" not in receipt`). Script execution: connector packages carry no script surface at all — the entry must be a plain relative `.py` inside a link-free package and is launched only through the controlled config. Platform-policy interplay rides the existing `local.mcp.*` dispatch (broker-key gate, capability admission) unchanged. |

## Gates

- New/touched runtime tests: `cd local-runtime && $HOME/miniconda3/bin/python
  -m pytest tests/test_connector_install.py tests/test_desktop_connectors.py
  -q` → **19 passed, exit 0**.
- Full local-runtime suite: `$HOME/miniconda3/bin/python -m pytest tests -q`
  (WSL, cwd `local-runtime`) → **511 passed, 11 skipped, exit 0** (baseline
  492 + 19 new — reconciles exactly).
- Desktop typecheck: `npm run typecheck` → **0 errors, exit 0**.
- Desktop vitest: `npx vitest run` → **28 files, 129 tests passed, exit 0**
  (baseline 27 files / 126 tests; +1 file, +3 tests).
- Bundled runtime refreshed from source (`python3.12
  scripts/prepare-runtime.py` in WSL) before the Electron-bridge leg;
  `test/connectors.test.tsx` includes a `win32`-only leg that starts the
  real bundled Windows runtime and proves every connector operation refuses
  with `CONNECTOR_UNAVAILABLE` before an owned authenticated binding exists
  (modern Windows verification for the platform-start/dependency gate).
- `npm.cmd run dist:win` — recorded pending; not run in this ticket.

## Pending

- T123-01/T123-02 manual UI legs (Electron dialog flows, tray supervision
  under real fault injection) — staged; the underlying control path is
  automated end-to-end.
- T123-03 real A/B/D1/D2 three-device exercise — staged; needs the isolated
  device fleet.
- Real-LLM legs (Server-driven task calling an installed connector end to
  end through the broker) — staged as usual.
- Win7 compatibility verification — explicitly deferred to #131; the modern
  Windows results above must not be read as Win7 results.
- `dist:win` packaging — recorded pending; not run in this ticket.
