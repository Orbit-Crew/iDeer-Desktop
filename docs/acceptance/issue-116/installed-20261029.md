---
id: issue-116-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 116 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 116 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-116/run.ps1` was executed
end-to-end with the real external model `agnes-3.0-flash`. The generation
orchestration was exercised for real: the Server-side graph generation parked
on the device material-consent ask, the installed UI's 15-second device HTTP
budget ended the call first (defect
[#37](https://github.com/Orbit-Crew/iDeer-Desktop/issues/37)), and the server
settled each page honestly as skipped — no model call was pretended.

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
Overall driver verdict: `incomplete` from the staged dependencies below.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T116-01 | incomplete | Server-orchestrated generation with structured per-source failure passed (zero material dispatch observed on the wire); a completed real-model graph stays unexecuted — the candidate's `knowledge_seam.py` constructs KnowledgeFacade without a `graph_broker_factory`, so the device material dispatch chain never engages, and the consent-card legs have no reachable approval surface (chat consent covers local.files.write only). |
| T116-02 | incomplete | Frozen source digests render, the empty-graph state is honest, and the locate button resolves the source inside the confirmed workspace without the path leaving the device; the manual usability pass with a model-generated graph depends on the completed-graph leg. |
| T116-03 | passed | Cross-account invisibility (B's view/generate/query 404, zero UI entry) and R1/R2 revision isolation. |
| T116-04 | incomplete | Reopen-page persistence passed (same manifest/digest/per-source results after quit→relaunch); device drift/offline structured failures need the real dispatch chain (staged). |
