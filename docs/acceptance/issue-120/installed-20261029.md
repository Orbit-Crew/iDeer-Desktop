---
id: issue-120-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 120 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server candidate tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 120 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-120/run.ps1` was executed
end-to-end (run `run-20261029-r8`) with the real external model
`agnes-3.0-flash` loaded from the private AgentPlatform configuration through
environment-variable indirection. It installed the actual NSIS package into a
fresh TEMP directory, started the real isolated Gateway from the Server
candidate with the reviewed compatibility pin, registered and paired
synthetic accounts A/B through the public APIs with OS secret storage,
observed the skill-import boundary through the raw TCP proxy, and drove the
installed application's own Skill section UI. Only the native picker and
confirmation dialog callbacks received synthetic inputs; IPC, the bundled
Runtime, HTTP, authorization, storage and the model stayed real.

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112 record; tree equals Desktop develop `de3b6ef`).
- Server candidate recorded in `ready.json` as base commit `4f45d5c8…` with
  `serverSourceSHA256 3e8a3923ba727770…` — the same per-file backend digest as
  the #112 run, i.e. the executed tree equals develop `f77261ce` after PR #166.
- Model `agnes-3.0-flash` (max_tokens 3000, timeout 120 s); driver SHA-256
  `4c061945658b002f…`; full per-file server hashes in the archived
  `server-source-files.json`.
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0 / Electron 22.3.27.

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: **passed** for all four scenarios.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T120-01 | passed | All three package kinds (markdown/zip/directory): cancel leaves zero uploads, zero registry rows, unchanged resource list, and the confirmation dialog carries the body excerpt, complete upload scope and package fingerprint; confirmed import lands the private draft with the exact package hash; publish creates the version copy with `content_hash` equal to the frozen package hash. |
| T120-02 | passed | Built-in skill is read-only (draft PUT 403, published V1 bytes unchanged); fork creates an independent copy; local file edit never replaces platform content; modifying content becomes a new draft revision (V2) while the frozen V1 stays byte-identical. |
| T120-03 | passed | Zip with `../` traversal refused as `SKILL_IMPORT_ILLEGAL_CONTENT` and broken zip as `SKILL_IMPORT_PACKAGE_INVALID` — both before any upload (zero wire posts), recorded as real failed registry rows with the renderer's fixed alert captured; hash-mismatch confirm rejected 400; private packages 404 for account B. |
| T120-04 | passed | Real model runs through the installed UI: a run started with the skill selected kept its frozen V1 selection (version 1 + content hash) while V2 was published mid-run; the archived run detail still carries V1; published V1/V2 contents stayed byte-identical to their frozen packages; a new run after the preference-refresh selected V2. Two model-echo marker cases are recorded **unexecuted**: the local sandbox fixture does not mount run-skill-views into the model's tool roots (`/mnt/skills`), and the model honestly reported it could not read the mounted skill; the freeze semantics under test are server-side and are asserted through the frozen selection and immutable published versions. The Runtime stream behavior is recorded as the observation of defect [#37](https://github.com/Orbit-Crew/iDeer-Desktop/issues/37) (15 s SSE read timeout, no reconnect). |

Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).
