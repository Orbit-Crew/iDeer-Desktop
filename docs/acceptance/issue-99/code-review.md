# Issue 99 code review

Review base: `b42458c49da5139475322da63072b36cbcecd673`, the merged #98
Desktop prerequisite. Product candidate:
`1cf14436efbe5f21c8a8a42a1746489ccb58794c`.
The implement skill requested the review. Two independent read-only subagents
ran the Standards and Spec axes, followed by correction and re-review.

## Standards

Initial review found no hard violations. One non-blocking data-clump judgement
concern identified positional session fields at the credential boundary.
The final implementation uses a frozen `ChatSession` with named fields and
`repr=False` for its token. A final fixture review also found that a failed
Electron quit could skip proxy/Gateway cleanup. Nested finalizers now always
attempt proxy shutdown and write the Gateway stop file, while preserving the
quit failure in the result. This fixture-only correction passed syntax review;
its exceptional cleanup path was not fault-injected. No product code changed.

Sources: README, docs/porting.md, docs/runtime-migration.md,
docs/validation.md, docs/agents/issue-tracker.md, docs/code-review.md and the
code-review skill's Fowler smell baseline. No Desktop AGENTS.md was present.

## Spec

Three initial findings were corrected with failing-then-passing regressions:

1. Run requests now use public `messages-tuple`, rather than the internal
   LangGraph `messages` mode rejected by Server admission.
2. Reopened Web Threads resolve their Agent alias or previous Run snapshot to
   the canonical resource ID before follow-up submission.
3. Historical plain human replies close the latest pending human-input request,
   matching the existing Web fallback.

The re-review found no remaining concrete code blocker. It required preserving
the limits of the acceptance evidence. A subsequent fixture extension now
covers simultaneous duplicate IPC calls and actual stream interruption through
a task-owned TCP proxy. External-provider and installed-app acceptance remain
unexecuted; the issue must stay open.

Final review findings: Standards 0 unresolved; Spec 0 unresolved code findings.
Acceptance gaps remain listed in [the report](report.md).
