# Real compatibility matrix

Use the existing issue 104 restartable real Gateway fixture, isolated A/B
profiles prepared by `issue-102/profiles.py`, the final Desktop package, and
the same deployment public key in Server and packaged Desktop. Set Server
`UPDATES_CONTROLLED_DIR`, `UPDATES_TRUSTED_PUBLIC_KEY_FILE`, `UPDATES_STATE_DIR`
and `SERVER_RELEASE_VERSION`. The last value must equal the signed exact
combination, not a version inferred from the declaration.

Prepare cases without printing the TEMP private key:

```powershell
& $node scripts/acceptance/issue-110/prepare-assets.cjs --release-state artifacts/dev-log/test-release-state.json --server $actualServerVersion --output artifacts/acceptance-release/compatibility-cases
$env:IDEER_ACCEPTANCE_COMPAT_ASSETS = (Resolve-Path artifacts/acceptance-release/compatibility-cases).Path
$env:IDEER_ACCEPTANCE_COMPAT_ROOT = (Resolve-Path artifacts/acceptance-release/controlled).Path
```

First run the unchanged old client against the upgraded Server. Use a fresh
Gateway/profile state and the archived 0.1.0 source, compiled entry and original
bundled Runtime. The old HELLO mapping is explicit in the signed candidate row:
Runtime package 0.1.0, protocol 1. It does not guess Desktop or Python versions.

```powershell
$env:DESKTOP_CANDIDATE_ROOT = $archivedOldClient
$env:IDEER_ACCEPTANCE_LEGACY_CLIENT = '1'
& $node scripts/acceptance/issue-110/desktop.cjs $oldState
```

Then use another fresh fixture/profile state on the same Server source and the
new final Desktop. Remove the old-client flags, set `DESKTOP_EXECUTABLE` to
the installed 0.2.0 executable, and provide the earlier old-client result:

```powershell
Remove-Item Env:DESKTOP_CANDIDATE_ROOT,Env:IDEER_ACCEPTANCE_LEGACY_CLIENT
$env:DESKTOP_EXECUTABLE = $installedDesktop
$env:IDEER_ACCEPTANCE_OLD_RESULT = Join-Path $oldState result.json
& $node scripts/acceptance/issue-110/desktop.cjs $newState
```

The script supplies an absolute `--user-data-dir` below its fixture state. It
never uses the default profile. It switches signed controlled files, verifies
actual Runtime UI state and exact current versions, exercises compatible
writes, capability-blocked writes and unaffected reads, local DENY and private
resource refusal, then restarts under core incompatibility with an unconfirmed
write receipt. Original bytes, receipt identity and hash must remain; no
redispatch is allowed. Cleanup failures and partial cases remain explicit in
`result.json`. This runner does not claim unsupported rolling upgrades or
Win7 validation.
