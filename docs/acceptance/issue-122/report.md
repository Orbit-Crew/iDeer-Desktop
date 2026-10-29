---
id: issue-122-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 122 Desktop side of Skill execution environment declaration and content-bound script authorization — the local.skill.script wire gate, the binding-scoped grant registry, DENY-first policy, consent with content-bound remember, the receipt binding, and the grant surface
last-verified: 2026-10-27
verified-against: orch/issue-122-skill-exec-env working tree on top of 4d61488 (#121 candidate); every acceptance command below was run against this tree
---

# Issue 122 Desktop acceptance

The Desktop candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop` (WSL:
`/mnt/g/code/iDeer-worktrees/issue-112-desktop`), branch
`orch/issue-122-skill-exec-env`, stacked on 4d61488 (#121). The Server repo
carries the same branch on top of a015b08b; its companion report is
`docs/acceptance/issue-122/report.md` in that repository. No issue closure,
no PR, and no `dist:win` installer are claimed by this report — packaging
stays a recorded-pending step (see Pending).

## Implemented surface

- `local-runtime/core/skill_script.py` (new): the device-leg gate —
  - the frozen declaration parser mirroring the Server's
    `skill_environment.py` byte for byte (frozen cross-repo contract; the
    same `requirements_fingerprint`), with `SKILL_SCRIPT_ENVIRONMENT_*`
    fixed refusals for a Server-targeted or OS-mismatched declaration (AC1:
    no cross-environment downgrade, explicit unavailability);
  - the fixed wire shape (`validate_payload`): exactly the seven skill
    fields plus the transport's own envelope fields; a 200k-char script
    bound to its announced SHA-256 (`SKILL_SCRIPT_CONTENT_MISMATCH` on any
    drift);
  - `SkillScriptRegistry`: binding-scoped SQLite grants whose identity
    hashes (profile binding, skill, script path, script digest, declared
    scope) — another account never inherits a row, `view` is binding
    filtered, revoke by path or by listed identity;
  - `SkillScriptService.evaluate`: local policy decides FIRST (a configured
    DENY or any Level-2 unknown outranks every stored grant, directory
    grant, sharing status, and built-in identity — AC3), then an exact
    grant executes without re-asking while changed bytes or a changed
    declared scope re-ask (`SCRIPT_REAUTHORIZATION_REQUIRED`); a prose-only
    version bump with identical bytes and declaration stays covered (AC2);
  - `SkillScriptService.execute`: the unique Runtime's own constrained
    Python executor (suspended start, job-owned cleanup on Windows, bounded
    redacted output, fixed 120 s timeout no payload can move) and a receipt
    bound to `skill_id`/`skill_version`/`skill_content_hash`/
    `authorization_basis` (AC3).
- `local-runtime/core/transport.py`: the `local.skill.script` dispatch —
  bound-broker-key required (unbound → DENY), a runtime without the service
  refuses, admission requires a healthy durable receipt ledger (an uncertain
  script must recover), CONSENT_REQUIRED relays through the existing
  consent state machine, ALLOW executes under the recorded basis, and
  `SKILL_SCRIPT_*` categories cross the boundary verbatim.
- `local-runtime/core/consent_coord.py`: the settle path remembers a tray
  approval that asked to remember as a content-bound registry grant
  (`skill_script_grant:<identity>` basis) — the capability-wide
  always-allow escape is force-disabled for script execution (AC2) — and
  the consented run re-uses the same execution half with the same basis.
- `local-runtime/core/policy.py`: `local.skill.script` is LEVEL_1 — every
  request starts as an explicit local confirmation; only the exact
  content-bound grant short-circuits the ask.
- `local-runtime/core/receipts.py` + `receipt_ledger.py`: four new receipt
  fields (skill id/version/content hash/authorization basis) persisted
  through the durable outbox; `unknown_write_effects` now also counts
  uncertain skill scripts, so a verified update can never drain past an
  unresolved script effect.
- `local-runtime/core/tray.py` + `desktop.py`: the desktop capability set
  announces `local.skill.script`; the `skill-scripts` control command
  (strict per-action key sets, scope-checked, fixed categories) lists and
  revokes the owned registry; the status snapshot carries
  `skillScriptAuthorizations` / `skillScriptStorageError`.
- Electron: `desktop:skill-scripts` pinned in `test/security.test.ts`
  (list/revoke only — the channel can never create a grant), the
  `skillScripts` bridge call with one in-flight request and 30 s timeout,
  bounded response re-validation (hashes only, never script bytes), and the
  SkillSection 脚本授权 card (per-grant fingerprint, revoke, honest empty
  and storage-error states).

## Scenario evidence

| Scenario | Status | Command / evidence |
| --- | --- | --- |
| T122-01 (declared environment + representative DEVICE execution) | passed (device legs) | `npx vitest run test/skills.test.tsx` and `$HOME/miniconda3/bin/python -m pytest tests/test_skill_script.py -q` → 15 passed; `test_representative_script_actually_executes_on_the_device` runs the real script through the constrained executor via the signed wire with fixed output `device-fixed-ok`; `test_environment_mismatch_and_unavailable` refuses a Server-declared skill and an OS mismatch; `test_declaration_mirror_refuses_invalid_shapes`. |
| T122-02 (default off; explicit authorize; offline / dependency mismatch) | passed (default-off + authorize + mismatch legs) | `test_default_off_then_grant_then_remember` (asks first, executes silently after the content-bound remember), `test_wire_round_trip_asks_then_executes_with_bound_receipt` (CONSENT_REQUIRED relay, nothing executed while asking), `test_wire_shape_is_fixed`. Device-offline retry: staged (needs a real offline device; no downgrade path exists on the device). |
| T122-03 (content / scope change vs prose-only change) | passed | `test_content_or_scope_change_requires_reauthorization` (changed bytes and changed declared dependency re-ask; prose-only version bump with identical bytes+declaration does not), `test_wire_round_trip_remembered_grant_skips_the_ask` (grant skips the ask; revocation asks again). |
| T122-04 (identity matrix; revoke; no exemption, DENY-first) | passed | `test_local_deny_outranks_every_grant` (configured local DENY beats a stored grant), `test_grants_do_not_cross_accounts_or_survive_revocation`, `test_registry_view_is_binding_scoped`; directory grants and sharing have no path to this capability (matching_grant is write-only; policy decides first). |
| T122-05 (corrupted package; interrupted receipt upload + recovery) | passed (tamper + outbox legs); restart-recovery leg staged | `test_tampered_content_refuses` (bytes not hashing to the announced digest never run), `test_receipt_binds_version_digest_and_basis`, `test_ledger_persists_skill_receipt_fields` (durable outbox keeps the skill fields for replay); admission-before-execution is enforced in dispatch. A dedicated power-cycle restart exercise is staged. |

## Gates

- Runtime: `cd local-runtime && python -m pytest tests -q` → **492 passed,
  11 skipped, exit 0** (baseline at #121: 477 passed / 11 skipped; +15 new
  skill-script tests, exact reconciliation).
- Desktop: `npm run typecheck` → **0 errors, exit 0**; `npx vitest run` →
  **27 files / 126 tests passed, exit 0** (baseline 124; +2 new).
- `desktop:skill-scripts` pinned alongside every other channel in
  `test/security.test.ts` (1 passed).

## Pending

- Device-offline retry against a real offline device (T122-02) — staged.
- Power-cycle restart-recovery exercise for an interrupted script-receipt
  upload (T122-05) — staged; the outbox contracts are covered by tests.
- Per-skill environment inventory for the full migrated catalog — staged
  (Server-side companion).
- Real-LLM / manual UI legs — staged as usual.
- Win7 compatibility verification — explicitly deferred to #131; the modern
  Windows results above must not be read as Win7 results.
- `dist:win` packaging — recorded pending; not run in this ticket.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r9–r17,
settling at r17). The server authorization/execution legs with content-bound
receipts passed; the device gate refused server-declared skills and
OS-mismatch payloads with typed codes (linux-on-Windows answers
`SKILL_SCRIPT_ENVIRONMENT_UNAVAILABLE`); the deny rule outranks every grant;
the reauthorization/regrant/prose-only-bump triple passed; drifted frozen
bytes refuse with `SKILL_PACKAGE_CORRUPTED` before anything runs; script
bodies never appear on any wire observation. The device representative
execution and consent-remember legs stay staged on the unreachable
`local.skill.script` approval surface. Two driver fixture defects found on
the way (the dropped `skill_id`; the frozen-storage permission lift for the
drift harness) are documented in the record — the product answered
fail-closed on both. Bindings and sanitized evidence are in
[installed-20261029.md](installed-20261029.md). Win7 remains with #131.
