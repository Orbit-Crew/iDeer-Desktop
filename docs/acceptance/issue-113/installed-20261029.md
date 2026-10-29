---
id: issue-113-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 113 installed combination acceptance on modern Windows
last-verified: 2026-10-29
verified-against: Desktop candidate worktree HEAD 82d336e (tested tree bound by installerSHA256/appASARSHA256, the develop-identical package); Server tree bound by serverSourceSHA256 3e8a3923ba727770… (equals develop f77261ce)
---

# Issue 113 installed combination acceptance, 2026-10-29

The prepared driver `scripts/acceptance/issue-113/run.ps1` was executed
end-to-end (run `exec-r17`; four stabilization rounds r14–r17 all stop at the
same honest blocker). It installed the actual NSIS package, started the real
isolated Gateway, paired synthetic accounts A/B through the public APIs and
drove the installed application. The publication-refusal family executed for
real; every chat/run-dependent leg is staged on the recorded defects.

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
Overall driver verdict: `incomplete`; every case that could execute in this
environment passed.

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T113-01 | incomplete | All three publication refusals hit the real endpoints from the installed UI: an unactivated local KB refuses publication with 409, and a draft containing a local import refuses both `prepare` (409) and `publish` (409). The mid-run R2 drift drill and the chat-run R2 drill stay unexecuted: chat thread creation fails with `CHAT_NOT_FOUND` even on a freshly published agent — the [double-publish defect](https://github.com/Orbit-Crew/iDeer/issues/167) leaves the original agent unusable and the fresh-agent workaround hits the same missing-chat state ([SSE defect #37](https://github.com/Orbit-Crew/iDeer-Desktop/issues/37) context recorded). |
| T113-02 | unexecuted | Behind the same chat/thread dependency. |
| T113-03 | unexecuted | Behind the same chat/thread dependency. |
| T113-04 | unexecuted | Behind the same chat/thread dependency. |

The run also records `runtimeStreamDefect` (#37) and
`defect167DoublePublish: true` with the per-phase `freshAgentChatCreateUnavailable`
observations, so the staged boundary is auditable from the evidence itself.
