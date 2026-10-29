---
id: issue-113-desktop-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 113 Desktop side of frozen-scope local knowledge retrieval through the unique Runtime
last-verified: 2026-10-27
verified-against: orch/issue-113-frozen-retrieval based on 81b0a0d (#112 candidate); the candidate is the branch tip of the same tree this evidence was produced from
---

# Issue 113 Desktop acceptance

The Desktop candidate is the isolated worktree
`G:\code\iDeer-worktrees\issue-112-desktop`, branch
`orch/issue-113-frozen-retrieval`, starting at 81b0a0d (the #112 candidate).
The Server repo carries the same branch name and starts at 6874d17e; its
companion report is `docs/acceptance/issue-113/report.md` in that repository.
No issue closure and no PR are claimed by this report.

Implemented Desktop surface (#113): the device answers one new broker
operation, `local.knowledge.search`, and re-validates the frozen revision
before any content leaves.

- `local-runtime/core/knowledge_search.py` (new): validates the task payload
  (query, revision UUID, manifest hash, 1-200 frozen document identities) and
  performs content-addressed revalidation. Every manifest entry matches at
  most one live workspace file by (file name, SHA-256) through the existing
  workspace store boundary — links/junctions/protected paths fail closed —
  and a document whose bytes no longer hash to its frozen digest is reported
  as a structured `missing` entry (`content_drift` / `file_unavailable` /
  `not_searchable`), never substituted with current content. Matches are
  bounded literal line matches (100 matches, 500 files scanned) that carry
  document id, filename, snippet, and workspace logical path + line — the
  location a user can follow back to the original file. Physical paths never
  appear in results.
- `local-runtime/core/knowledge_import.py`: `find_registration` — the
  binding-scoped registry lookup that refuses to re-validate any revision
  this identity never registered on this device (`KNOWLEDGE_SEARCH_
  REVISION_UNKNOWN`); the device is not a generic search engine for the
  platform.
- `local-runtime/core/file_service.py`: the capability is announced beside
  the read capabilities (`KNOWLEDGE_CAPABILITIES`), gated by the current
  local grant, and executes only for an activated registration with a
  matching manifest hash.
- `local-runtime/core/policy.py`: `local.knowledge.search` is LEVEL_0
  read-only over content the user explicitly imported; the local DENY rule
  (`CapabilityRule.DENY`) still vetoes it.
- `local-runtime/core/transport.py`: signed-task dispatch for the operation
  behind the same bound-broker-key gate as the file reads; a fixed-category
  `KnowledgeSearchError` crosses as the task error code and is never recast
  as an empty success. The execution receipt (`_file_receipt`) carries
  `run_id`/`task_id`/`capability`, so the device record and the durable
  receipt-ledger row stay tied to the originating Run (visible in Desktop
  task history via the existing `thread_history`).

Environment: Windows 11 x64 host, Git Bash; bundled runtime exercised through
the WSL Ubuntu Python 3.13 test environment (miniconda pytest), Desktop
typecheck and vitest via node v22.14.0 (pinned worktree toolchain). No model
credentials were configured; real-LLM scenario portions are unexecuted on
that stated dependency.

| Scenario | Overall status | Current evidence and remaining required work |
| --- | --- | --- |
| T113-01 | incomplete (device contract covered; live run unexecuted) | The device always re-validates against the manifest it froze, so a Run that pinned/loaded R1 keeps receiving R1 content even after R2 is imported and activated; the Server-side freeze half of the scenario is evidenced in the Server report. Live mid-run R2 publication with an installed Desktop is unexecuted. |
| T113-02 | incomplete (automated passed; real-data QA unexecuted) | Automated: signed `local.knowledge.search` returns verified chunks with logical-path + line positions and a receipt whose `run_id`/`task_id`/`capability` tie the device record to the original Run; workspace physical paths never appear in any response; a registered two-document workspace yields `documentsMatched=2` with both positions. Question answering over real local material with a real model is unexecuted on model credentials. |
| T113-03 | incomplete (automated passed; UI comparison unexecuted) | Automated: drifted content (`CHANGED`) never leaves the device — the drifted document is reported missing with `content_drift`; unknown revision id and tampered manifest hash are refused `KNOWLEDGE_SEARCH_REVISION_UNKNOWN` with no result field; a foreign identity's binding finds no registration. Original-file vs platform-attachment UI comparison is unexecuted; no upload path exists in the change, so the original file cannot become a platform artifact. |
| T113-04 | incomplete (automated passed; live failure injection unexecuted) | Automated: an unknown revision fails as a typed error (`KNOWLEDGE_SEARCH_REVISION_UNKNOWN`) instead of an empty success; local policy DENY vetoes the capability; binary (non-UTF-8) frozen content is reported `not_searchable` rather than silently skipped. Device-offline and mid-retrieval disconnection are enforced by the broker task lifecycle on the Server side (fixed error categories, no impersonation); live fault injection against a paired device is unexecuted. |

Win7 is the only explicitly deferred platform verification for this stage: it
stays unexecuted and is owned by the closing ticket #131 together with the
Win7 compatibility patches listed there. Modern Windows passes above must not
be read as Win7 passes.

## Commands and results

All commands ran from the Desktop worktree; each is reproducible and exited 0.

- `cd local-runtime && python -m pytest tests/test_knowledge_search.py -q`
  -> 10 passed (0.43s). Red first: the same file failed collection before
  `core.knowledge_search` existed, and 5/10 failed after the first slice
  (non-UUID document identities, registry/transport wiring) before turning
  green.
- `cd local-runtime && python -m pytest tests -q`
  -> 421 passed, 11 skipped (86.91s) — pre-change baseline was 411 passed,
  11 skipped; the +10 are the new file, zero regressions.
- `npm run typecheck` -> exit 0.
- `npx vitest run` -> 23 files / 96 tests passed (18.55s), exit 0 — identical
  to the orchestrator-recorded pre-change baseline.
- `npm.cmd run dist:win` -> not run; recorded as the pending packaging step
  for the stage candidate (installer SHA-256 to be bound after packaging).

## Dependencies still required (staged portions)

- Installed Desktop package + paired live Server for live fault injection
  (device offline, mid-retrieval disconnect) and the mid-run R2 drift drill.
- Model credentials for the real-data question-answering portions; those are
  recorded unexecuted (staged on model credentials).

## Baseline relation

Desktop typecheck, vitest (23 files / 96 tests) and the runtime suite were
green at the #112 candidate (orchestrator-recorded baseline: runtime 411
passed / 11 skipped). After the change: typecheck exit 0, vitest 96 passed,
runtime 421 passed / 11 skipped — only the new 10-test file was added, and it
was created red before its implementation.

Execution update, 2026-10-29: the prepared driver ran end-to-end (r14–r17,
settling at r17). The three publication refusals (unactivated KB, draft
local-import prepare, draft local-import publish) executed for real and
returned 409; every chat/run-dependent leg is staged on the recorded
`CHAT_NOT_FOUND` blocker (defects #167/#37, fresh-agent workaround included).
Bindings and sanitized evidence are in
[installed-20261029.md](installed-20261029.md). Win7 remains with #131.
