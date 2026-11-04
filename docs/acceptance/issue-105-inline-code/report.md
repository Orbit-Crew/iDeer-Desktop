# Issue 105 (Desktop [四期·27] 内联代码受控执行) acceptance

## Scope and ticket

This directory records the Desktop ticket
[#105「内联代码受控执行」](https://github.com/Orbit-Crew/iDeer-Desktop/issues/105)
([四期·27], blocked by the already-merged #74 permission tiers and #81 device
parsing). The neighboring `issue-105/` directory belongs to a different,
older GitHub #105 (the local result upload ticket) and is untouched.

Execution date: 2026-11-04, Asia/Shanghai, by the orchestration agent on the
`feat/issue-105-inline-code` worktree at develop `b14e033`. Layered
acceptance bookkeeping (三层验收): this record covers 入口恢复 and 业务接线
with automated contract evidence. 实际候选安装验收 is not claimed here and
follows the installed-candidate process separately.

## What was built

- Inline Python/Node execution returns: the platform's `local.python` task
  payload is materialized as a temp script inside the authorized folder
  (`.ideer/inline/<session>/`), executed from that file with a pinned
  interpreter (the bundled Runtime's own Python with `-I`; the app's own
  executable as Node under `ELECTRON_RUN_AS_NODE`, passed by the Desktop
  shell via `--node-executable` and probed once before first use), with the
  working root still resolved through the workspace boundary.
- Tier semantics per the ticket: 询问档每条问 (the chat shows the full code,
  language and target root — a new `inline-code` consent card), 自主夹内不问
  (`local.python` joined the autonomous tier's folder-anchored set), 完全不问;
  outside roots and protected paths refuse in every tier, and a tier-resolved
  run records `tier:<tier>` in the receipt and audit log.
- Session cleanup: leaving a session sweeps its scratch; identity reset,
  controller stop and runtime shutdown sweep everything; a crashed process's
  leftovers are swept on the workspace's first attach. Refused or denied asks
  write nothing.
- Desktop mode now builds the python service from the confirmed workspace
  grant (previously the capability was tray-only); without a workspace it
  stays unannounced. The Win7 compatibility gate still disables
  `local.python` entirely at the `capability` level, so the 六期 matrix
  governs that platform.

## Evidence

Automated suites on this candidate (local-runtime pytest 3.12 via the
project venv; vitest 1.6 via Node 18; Windows 11 Pro 10.0.26300 x64):

- `local-runtime/tests`: **771 passed, 8 skipped, 0 failed** on the branch
  rebased onto develop `1be63af` (which brought in #82/#83/#104) and after the
  two-axis review fixes, including the
  new `tests/test_inline_code.py` (23 cases: materialization inside the
  workspace, sanitized session names, tolerance of unknown sessions and a
  detached store, stale-scratch sweep on first attach and none on reconnect,
  node probe validation and refusal without a configured runtime, real Node
  execution, real Python execution with artifacts inside the folder), the
  rewritten `tests/test_session_tier.py` three-tier × boundary matrix and a
  FakeBroker end-to-end run that settles an autonomous-tier inline ask
  without a prompt (`receipt.consent_decision == "tier:autonomous"`, script
  on disk inside the folder, audit `actor_id="session-tier"`), and the
  chat-projection cases in `tests/test_platform_chat.py` (card contents,
  plain allow/deny settlement, `rememberScript` refused for inline code,
  credential-redaction refusal, scratch swept on session switch, identity
  reset, and never on reopening the same session).
- `vitest run`: 283+ passed; the only 3 failures (`nsis-process-guard`,
  `updates-release` ×2) reproduce identically on the unmodified baseline
  (verified by stashing this branch) and are environmental (Windows temp
  cleanup and process spawn under this shell), not from this change.
- Two-axis review (this repository's Standards/Spec pattern, fixed point
  origin/develop `1be63af`): Standards found no violations, only judgement
  calls (repeated language branching, duplicated capability→kind mapping,
  one speculative default, a pointless parametrization). Spec found all five
  AC boxes implemented; the adopted fixes: a pre-switch sweep so rebinding
  the workspace never strands scripts in the previously authorized folder,
  a digest suffix on session directory names so distinct sessions that
  sanitize alike cannot share one scratch, and honest card wording (the
  sandbox confines the working root and the runtime's own artifacts; it is
  not a filesystem sandbox for the executed child). The sticky Node probe
  refusal, the credential-redaction hard stop and the capability-granular
  autonomous widening were kept deliberately (fail-closed doctrine; the AC's
  自主夹内不问).
- `tsc --noEmit` for `tsconfig.node.json` and `tsconfig.web.json`: clean.

## Honest limits

- The real-Node case runs when a Node is available (`skipif`); on this
  machine it executed against Node v18.13.0.
- The bundled `.runtime` used by the process-level tests was assembled in
  this worktree from the candidate's own `local-runtime/core` via
  `scripts/prepare-runtime.py` (artifacts hash-verified against
  `distribution.lock.json`; the missing `pypdf` wheel came from the
  Tsinghua PyPI mirror after the direct pythonhosted fetch failed on this
  network).
- No installed-candidate scenario is recorded here; the two
  `test_desktop_process.py::test_packaged_signed_echo_mcp_rejections_restart_and_crash`
  cases fail on this machine identically with and without this branch and
  remain a pre-existing environment limitation, not a candidate result.
