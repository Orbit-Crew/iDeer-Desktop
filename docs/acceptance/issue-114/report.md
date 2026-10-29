---
id: issue-114-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 114 Desktop side — no code change; two-entry consistency inherits the #113 retrieval surface
last-verified: 2026-10-27
verified-against: orch/issue-114-web-device-retrieval at b8005dd (identical to the #115 Desktop candidate)
---

# Issue 114 Desktop acceptance

The Desktop worktree `G:\code\iDeer-worktrees\issue-112-desktop`, branch
`orch/issue-114-web-device-retrieval`, carries **no Desktop code change** for
issue 114: `git status` is clean against b8005dd (the #115 candidate). The
Server/Web companion report is `docs/acceptance/issue-114/report.md` in the
Server repository. No issue closure and no PR are claimed.

## Why no Desktop change satisfies this ticket

- AC1 (one authorization/Runtime chain): the Desktop chat entry already runs
  the same canonical Server run preparation introduced in #113; the Web entry
  now binds the identical closure and frozen bindings (Server
  `knowledge_scope_view`). Neither entry can widen the frozen scope; the Web
  selector may only narrow. The device-confirmation flow keeps its origin
  model from #102/#103: the Web caller is refused with 403
  `LOCAL_APPROVAL_REQUIRED` (Server `test_local_knowledge_consent_gate.py`)
  while the Desktop approval dialog remains the only decider.
- AC2/AC3/AC4: attribution, partial-failure semantics, pause behavior, and
  receipt statuses are produced Server-side (`hybrid_knowledge.py`,
  `retrieval_receipts.py`) and reach this client through the same receipt and
  pipe channels it already renders generically; the device-side retrieval
  contract (`knowledge_search.py`) is unchanged and its structured
  `missing`/failure codes map onto the new Server statuses unchanged.

## Evidence

Desktop verification is inherited unchanged from the #115 candidate report
(tree byte-identical): `npm run typecheck` exit 0; `npx vitest run` 24 files /
98 tests passed; bundled-runtime suite 429 passed / 11 skipped (WSL miniconda
workaround documented there). Cross-entry behavior is evidenced in the Server
report's scenario table (T114-01..04, all passed automated, with staged
installed-UI legs). The dual-UI walk-through (Web selection + Desktop
approval dialog + identical receipt text on both surfaces) is staged on the
modern-Windows installed acceptance run and does not block this automated
evidence.

Win7: unexecuted, owned by #131. `dist:win` of the eventual combined
candidate: pending, recorded in the closing acceptance pass.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r4). The
scope view, frozen run surface and device search contract executed for real
against the installed app; the isolated Gateway's missing `knowledge_search`
tool declaration was added to the fixture config during debugging (the
fail-closed deployment veto is by design). Dual-UI walkthrough and
provider/live-fault legs stay staged as recorded. Bindings and sanitized
evidence are in [installed-20261029.md](installed-20261029.md). Win7 remains
with #131.
