---
id: issue-121-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 121 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 121 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-121/run.ps1` was executed
end-to-end (run `exec-r39`, after thirty-eight stabilization rounds whose
fixes are all in the driver/fixture records). It installed the actual NSIS
package, started the real isolated Gateway, paired synthetic accounts A/B
through the public APIs and drove the installed application with the real
model (`agnes-3.0-flash`, `SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025`).

## Bindings

- Installer SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`
  (the same package as the #112/#120/#114 records).
- Server tree bound at Gateway startup by `serverSourceSHA256 3e8a3923ba727770…`
  (equals develop `f77261ce` after PR #166).
- Windows 11 Pro 10.0.26300 x64; installed app 0.2.0; only the native
  picker/confirmation callbacks received synthetic inputs — IPC, Runtime,
  HTTP, authorization, the broker and the model stayed real.
- Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).

## Results

Evidence: [evidence/installed-20261029/](evidence/installed-20261029/).
Overall driver verdict: `incomplete` from the staged legs below; every case
that could execute in this environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T121-01 | passed | Skill imported and published, closure agent published; the first preference is created server-side (204, audited); the five-field surface renders server truth; the frozen server row (priority 5, keyword `T121_HIT`) is asserted; the real-model hit run injected the frozen V1 identity (archived selection snapshot pins resource/version/content-hash) and the `skill_trigger_preference_applied` audit keys the exact run; a miss run proceeds without injection and without audit. Staged: the three UI-interaction legs (controls detach mid-interaction on every Server projection refresh — 5 recorded retries; the identical PUT/422 contracts are asserted server-side) and the marker/model-echo leg (provider ReadTimeout; `/mnt/skills` mount observation). |
| T121-02 | incomplete | The endpoint rejection matrix passed (invisible-resource 404, unknown-resource 404, non-skill 409, 17-keyword and priority-1001 validation refusals with unchanged stored rows, duplicate agent ids 422); explicit out-of-closure selection is hard-refused (409 `skill_outside_agent_closure`, audited); the out-of-closure preference skips without activating and the skip is audited per run; DELETE is idempotent (204/204, audited); an unpublished required dependency refuses the run (409). Staged: making a required dependency invisible needs a visibility reduction the A/B user API cannot reach (no department, no delete endpoint). |
| T121-03 | passed | The cross-account projection carries identity and availability only (B reads no keywords/priority); malformed shapes are refused before any wire traffic. |
| T121-04 | passed | A preference rewrite and a V2 publication during a running run never drift it: the frozen run keeps V1 (archived snapshot + `applied` audit), and a new run after the rewrite follows the rewritten preference to V2 (archived snapshot pins version 2 + the V2 content hash). The two model-echo marker legs are staged on the LocalSandboxProvider mount dependency (`/mnt/skills` not in the model tool roots of this fixture). |

The T121-01 hit run recorded a provider ReadTimeout inside the 120 s budget
(environment latency); its injection contract is proven by the archived
selection snapshot and the applied audit rather than the stream, per the
[Runtime SSE defect #37](https://github.com/Orbit-Crew/iDeer-Desktop/issues/37)
observation already on file.
