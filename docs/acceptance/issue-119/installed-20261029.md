---
id: issue-119-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 119 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 119 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-119/run.ps1` was executed
end-to-end (run `exec-r10`, settled after the r8–r10 driver hardening). It
installed the actual NSIS package, started the real isolated Gateway, paired
synthetic accounts A/B through the public APIs and drove the installed
application. No model was needed by the executed legs: the fixture's single
frozen page is honestly recorded as skipped because the local-knowledge
material ask has no reachable approval surface in the installed app.

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120/#114 records).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0; only the native
  picker/confirmation callbacks received synthetic inputs — IPC, Runtime,
  HTTP, authorization and storage stayed real.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: `incomplete` from the staged legs below; every case
that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T119-01 | incomplete | The generate command is bounded at 60 s while the run records honestly, and the skipped page produces no reading entry (typed error code, per-page `skipped` state, zero `前往/返回` buttons). Staged: a completed target with the `前往/返回` walk — the frozen-document material ask is a LEVEL_1 local consent whose approval surface is unreachable in the installed app (tray-UI-only), and the isolated environment has no knowledge provider (T112-03 dependency precedent). |
| T119-02 | passed | The other account never sees the wiki row, the view or the navigation (404s + zero UI entries), verified through a real account switch. |
| T119-03 | incomplete | The projection-shape bounds are asserted on the real server payload (pages/links/missing/backlinks/sources/entities/relations all within caps). Staged: missing-link dead-end presentation and non-clickable non-completed targets (need a completed page), and the flood-bounds leg (needs 200 model-generated pages). |
| T119-04 | passed | R2 registers beside R1 with its own manifest; R1's navigation stays bound to its frozen manifest (server truth asserted beside R2). Staged: the UI context-switch/reopen walkthrough — the R1 index panel never renders in this fixture (the navigation projection depends on the generation outcome, the same dependency staged in T119-01); the reopened-session binding is asserted server-side against the frozen manifest hash. |
