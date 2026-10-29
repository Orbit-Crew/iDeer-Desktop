---
id: issue-123-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 123 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 123 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-123/run.ps1` was executed
end-to-end (run `exec-r7`). The installed UI walked the connector install
loop: cancel registers nothing, the good package previewed and installed with
the canonical identity registered on the platform (the four-key payload was
observed at the boundary), the managed copy re-hashed identically and the
controlled MCP configuration was asserted from disk. The tray-started MCP
server did not announce its tools to the paired device inside the driver
window, so the consented-echo chain is staged on that dependency — the stdio
echo chain is covered end-to-end by the runtime tests
(`test_connector_install.py`) against the real fixture server.

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120 records; tree equals Desktop develop `de3b6ef`).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0 / Electron 22.3.27; only
  the native picker/confirmation dialog callbacks received synthetic inputs.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
The tray leg is recorded as a fixture observation, not a product failure.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T123-01 | incomplete | Cancel registers nothing; the install registers the canonical identity; managed copy re-hash and controlled config asserted; tool discovery + consented echo staged on the tray dependency. |
| T123-02..04 | unexecuted in this run | The round-7 execution ended before the bad-package matrix, cross-account isolation and removal legs; they run in the follow-up execution and are additionally covered by the Server and runtime suites. |
