---
id: issue-82-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 82 Desktop side of complete Skill package import and declaration — the four declared script languages (Python/JS/shell/executable), the import-time projection of declared permissions (network/subprocess) and dependencies, the confirmation-dialog declaration summary, and the script-authorization interplay (import success is never executability)
last-verified: 2026-11-02
verified-against: feat/issue-82-skill-packages working tree on top of b14e033 (develop, post-#129)
---

# Issue 82 Desktop acceptance

The candidate lives in the isolated worktree
`G:\code\iDeer-worktrees\issue-82-skill-packages`, branch
`feat/issue-82-skill-packages`, stacked on b14e033. Everything below ran on
that tree; no issue closure, no PR merge, and no `dist:win` installer are
claimed by this report.

## Implemented surface

- `local-runtime/core/skill_script.py`: the four declared script languages
  (`SCRIPT_LANGUAGES` = python/js/shell/executable) classified from the
  script's own suffix — the original product's interpreter-dispatch
  semantics — via `script_language()`; a member outside the bounded mapping
  refuses as `SKILL_SCRIPT_LANGUAGE_UNSUPPORTED`. `SkillScriptService.evaluate`
  and `.execute` refuse every non-Python declaration BEFORE the grant lookup:
  the device leg ships exactly one constrained executor, so a declared
  js/shell/executable script is an explicit unavailability — a package
  importing successfully is never executability, and no grant row is created
  for a script the device cannot run (AC1/AC4).
- `local-runtime/core/skill_import.py`: the device preview now projects the
  package's own declaration — the normalized `execution-environment` block
  (target + os/dependencies/software/tools/data through the SAME frozen
  grammar `skill_script.parse_execution_environment`), the declared
  `network`/`subprocess` permissions (front-matter `permissions` plus
  `requires-internet`), and each script member's declared language (AC1/AC2/AC5).
  The projection is display-only: members, hashes, and the canonical package
  hash are exactly the uploaded bytes. A bounded front-matter reader accepts
  the canonical spellings (block lists, one-level flow lists, quoted scalars,
  comments, unrelated enterprise keys) and refuses anything it cannot
  confidently parse with the fixed `SKILL_IMPORT_INVALID_DECLARATION`
  category — the same refuse-don't-guess rule the wire declarations follow
  (#170). The frozen wire grammar, the front-matter allowlist, and the
  executable-suffix import invariant are unchanged.
- `local-runtime/core/platform_chat.py`: the preview response carries
  `environment`/`permissions` to the bridge.
- `src/shared/desktop.ts` + `src/main/runtime.ts`: `SkillImportPreview`
  gains `environment`/`permissions`, `SkillPackageFileView` gains
  `language`; the wire parser validates the exact shapes (bounded entry
  lists, fixed vocabulary, boolean permissions) and refuses a malformed
  projection as `SKILL_IMPORT_FAILED` instead of displaying a partial
  declaration.
- `src/main/skillDeclaration.ts` + `src/main/index.ts`: the confirmation
  dialog shows the declaration summary (declared languages per script,
  declared permissions with the no-auto-grant note, the environment's
  requirement dimensions) and states explicitly that import success does
  not make scripts executable — every execution still passes the script
  authorization gate.

## Deliberate boundaries

- Authorization change invalidation (AC4) rides the existing content-bound
  grant identity unchanged: the identity already binds script path, bytes
  (SHA-256), and the declaration fingerprint, so any declaration or byte
  change re-asks (`SCRIPT_REAUTHORIZATION_REQUIRED`), and a sibling script
  of the same skill is never covered. The fingerprint algorithm and the
  five-field wire grammar are untouched — pre-existing grants stay valid.
- Shell/executable-class members remain refused at import by the unchanged
  unscanned-executable invariant (spec testing decision: security
  whitelists are never relaxed for new features); their declarations are
  still recognized and displayed, and a package carrying such members
  refuses with the existing fixed category.
- Device execution of js/shell/executable scripts is a cross-leg follow-up
  (spec decision #60 "四类语言全支持" spans the Server sandbox too); this
  ticket makes the device answer explicit instead of silently wrong.

## Scenario evidence

| Scenario | Status | Command / evidence |
| --- | --- | --- |
| AC1 (four languages declared and recognized) | passed | `test_script_language_classification` (four classes, case-insensitivity, `.pl`/extensionless/`.py2`/`.txt` refuse), `test_non_python_scripts_refuse_before_any_grant_or_run` (js/shell/exe refuse before grant lookup, zero executor calls, no grant row), `test_preview_projects_declaration_permissions_and_languages` and the bridge test `projects the declared environment, permissions, and script languages through the owned Runtime` (real bundled Runtime, directory package: `.py`→python, `.js`→js, non-scripts carry none). |
| AC2 (permissions shown at import) | passed | The same two projection tests assert `permissions == {network, subprocess}` from front-matter `permissions` + `requires-internet`; `test_invalid_declaration_refuses_the_preview` refuses unknown permission tokens, non-boolean `requires-internet`, unknown `execution-environment` keys, bad targets, and anchors with `SKILL_IMPORT_INVALID_DECLARATION` (nothing uploads, the attempt is recorded as failed). |
| AC3 (preview → private draft → explicit publish) | passed (regression) | The full #120 suite stays green, including `test_confirmed_import_binds_hash_and_lands_private_draft` and `test_publish_records_the_platform_version_copy`; the projected declaration changes no bytes (`packageHash` equals the members' canonical hash in the projection tests). |
| AC4 (unauthorized never runs; authorization change invalidates) | passed | Existing #122 invariants re-verified plus `test_grant_stays_bound_to_one_exact_script`; `test_content_or_scope_change_requires_reauthorization` (changed bytes / changed declared dependency re-ask; prose-only bump does not), `test_local_deny_outranks_every_grant`, `test_grants_do_not_cross_accounts_or_survive_revocation`. |
| AC5 (dependencies shown with the package) | passed | The projection tests assert the normalized `dependencies` (and os/tools/software/data) reach the preview and the dialog summary (`formatDeclarationSummary` unit test covers the rendered lines, including the nothing-declared wording). |
| AC6 (bridge contract + Runtime authorization coverage) | passed | `test/skills.test.tsx` extends the bridge suite (command validation unchanged, real-Runtime preview projection, fixed-category refusal over the wire, dialog-summary unit); `test_skill_script.py` + `test_skill_import.py` carry the Runtime legs. |

## Gates

- Runtime: `PYTHONPATH=local-runtime python -m pytest local-runtime/tests -q`
  → **660 passed, 8 skipped, exit 0** (baseline at develop b14e033:
  648 passed / 8 skipped; +12 new tests, exact reconciliation).
- Desktop: `npm run typecheck` (node + web) → **0 errors**; `npx vitest run`
  → **53 files / 281 tests passed** (baseline at develop b14e033: 53 files /
  279 tests; +2 new tests inside the existing skills suite).
- `python -m ruff check local-runtime --select E9,F63,F7,F82` → clean;
  `python scripts/verify-runtime-source.py` and `npm run verify:provenance`
  → verified.

## Pending

- Real-LLM / manual UI legs (the dialog text itself) — staged as usual; the
  summary text is unit-tested through `formatDeclarationSummary`.
- Device execution of the three additional declared languages — cross-leg
  follow-up (Server sandbox + device executors), not part of this ticket.
- Three-layer "actual candidate acceptance" run and `dist:win` packaging —
  recorded pending per the acceptance convention.
- Win7 compatibility — explicitly deferred to #131.
