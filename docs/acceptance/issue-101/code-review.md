# Issue #101 code review

The user selected branch `feat/issue-101` and comparison base `develop`.
Desktop base is pinned at `3b21dbdc68fdf82d7288ce9edd0dfc1689b18361`.
Server base is the fetched GitHub develop commit
`fb5ded4d37587d1c70b067087cf20bf444a18b3d`.

Two independent agents reviewed the working candidates in parallel. Commands
were `git diff develop --` for Desktop and `git diff <ServerBase> --` for
Server, supplemented by intentional untracked source, tests and migration files.
Candidate commits will follow correction, verification and final source binding.
Gate results belong to the acceptance report; they do not replace either axis.

## Standards

Initial P2: `ReceiptLedger.complete()` used `receipt IS NULL` to identify an
unfinished admission. Cleanup also sets this column to NULL, so a duplicate task
could turn a cleaned tombstone into a pending denial with the old receipt ID
and a new hash. An isolated database probe reproduced the transition. This
violates the immutable receipt contract and the provenance statement that
completed evidence is immutable. The guard now preserves the full tombstone.
Reviewer recheck confirmed unchanged ID, hash and acknowledgment after duplicate
completion and database reopening, empty pending uploads and blocked admission.

No other actionable documented-standard violations or baseline smells were found
across the initial candidates. Operator documentation for the receipt API and
stable broker identity is included in Server `docs/local-runtime/ARCHITECTURE.md`.

Follow-up P2: renderer receipt responses were fenced against identity changes,
but an older status response could restore task summaries after Stop. The
reviewer requested a component operation generation and delayed-status regression.
RuntimePanel now delegates refresh, Stop and cleanup to one controller. The
reviewer verified the shared generation guards all status/history responses,
clears before stopping, rejects old cleanup responses across account changes,
and invalidates abandoned controllers. Deferred-response regressions exercise
the same controller methods used by the component. This finding is resolved.

## Spec

Initial P1: history, counts, pagination and confirmed cleanup were unscoped in
the shared receipt database. A new account could view another account's task
metadata and clear confirmed evidence. Parent #95 requires ownership isolation
for caches, grants, audit and pending records. Reads, counts, task summaries and
cleanup now require the original full binding. Main and Runtime both recheck the
scope after native confirmation. Reviewer recheck confirmed the correction.

Initial P2: durable execution facts omitted the logical target and stable error
code. After restart, generic failed status could not explain the original file
target or error category. Parent #95 requires both as execution basis. Safe
metadata must be persisted without exception text, secrets or full bodies.
Both producers now retain an allowlisted error category and safe logical target.
The reviewer found and verified a further correction for supported nested payloads:
`arguments > args > payload` now matches file execution on both sides. Physical
or malformed targets retain a canonical hash. No Spec findings remain open.

The reviewer also requested acceptance assertions for B seeing only B's history
and revocation while an authenticated WebSocket remains open. These are coverage
gaps associated with the requirements, not additional product findings.

The installed runner checks B's public history/tasks and pending protection. The
Server API regression checks revocation on an already-open authenticated socket.
These automated checks are recorded separately in the acceptance report.

Standards: 0 open findings. Spec: 0 open findings. Final product/test fingerprints
are recorded in the acceptance evidence. Reviews are source reviews, not a claim
that unexecuted platform or acceptance checks passed.

## Delivery test correction

Server follow-up `aa7bada13417e99ce7550c274bc3ffec2a6c435b` was reviewed incrementally against `2929de002b9823f3aa2bc700b830de34f9300cec` by the same independent reviewers. Standards: 0 findings. Spec: 0 findings. The migration-chain test now checks receipt → desktop_login → rejoin and ancestry to the old merge, while retaining its two-parent assertion and all existing upgrade/schema/bootstrap coverage. Only that test changed; product sources are unchanged. Final GitHub gate results are recorded separately in the acceptance report and PR checks.
