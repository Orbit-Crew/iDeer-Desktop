---
id: issue-118-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 118 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 118 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-118/run.ps1` was executed
end-to-end (run `exec-r4`). The wiki generation rides the Server's own
orchestration over the #116 material chain: the frozen revision registered
through the installed UI, the view was honest before generation, and the
server settled the single page as skipped with a typed per-page category
after the material ask timed out — the model was never invoked, exactly as
the honest-baseline design requires.

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
Overall driver verdict: `incomplete` from the consent-surface/provider
dependencies below.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T118-01 | incomplete | Frozen revision registered through the installed UI; view-before-generation honest (not_generated, one page listed); generate parked server-side by the material-consent ask while the device budget ends the UI call (defect #37 observation); server-side orchestration settled skipped with a typed category; the live model-written page stays unexecuted (consent surface + provider dependencies). |
| T118-02 | incomplete | Page list renders progress with per-page frozen digests; skipped pages show （已跳过） with no reading entry; the original-page read returns 200 with an empty body and out-of-manifest document ids 404 without leaking filenames; a completed-page reading surface was unreachable in this environment. |
| T118-03 | passed | Revision-context changes reset the list and the open page; R1's wiki stays byte-identical before/after; restart and reopen render the stored wiki. |
| T118-04 | passed | Bad commands are refused before reaching the Runtime; B's list/generate/page all 404. |
