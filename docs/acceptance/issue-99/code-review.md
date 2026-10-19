# Issue 99 code review

Review base: `b42458c49da5139475322da63072b36cbcecd673`, the merged #98
Desktop prerequisite. Product candidate:
`f7f6264ed19978caca883db543c3ea57562acd81`.
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
a task-owned TCP proxy. The original external-provider and installed-app
evidence gaps were completed in the supplementary run below.

Final review findings: Standards 0 unresolved; Spec 0 unresolved code findings.
Acceptance scope and limits remain listed in [the report](report.md).

## Real-provider supplement

The same two axes reviewed the new provider fixtures and installed mode.
Standards found four acceptance-script risks, all corrected before final evidence:

1. Credential references now reach an atomic ownership manifest before the OS
   store write, so interrupted setup remains recoverable.
2. Credential cleanup attempts every owned reference and records failures.
   A cleanup failure changes the probe result to failed and still signals Server
   shutdown.
3. Installed mode creates its settings exclusively and checks fixture ownership
   before every subsequent write, as well as before deletion. It cannot replace
   an existing session during initial setup.
4. Shortcut evidence now reads and checks the actual process exit code, rather
   than inferring success from process disappearance.

The normal installed path and shortcut exits were re-executed successfully.
Exceptional credential-cleanup and concurrent-settings-write paths were reviewed
but not fault-injected.

Spec found no new product blocker. It required precise evidence wording: Skill
selection/version binding is proven, while the Agent's duplicate marker prevents
an independent Skill-instruction assertion. Server Run Evidence's empty receipt
arrays are preserved. Real task custom events prove delegation; the public
Run-message API separately provides the clarification receipt.

The issue specifies automatic execution for T99-01 through T99-04. It does not
require an additional manual UI pass; the earlier interpretation of that as a
mandatory gate was corrected. The user authorized current-account installation.
Installed lifecycle, both shortcuts and the real-provider scenarios passed.
Manual UI confirmation and Win7 remain unexecuted, with Win7 assigned to #131.

## Restored human identity correction

Final screenshot review found the same human Turn displayed from both the
journal's `X` and DynamicContext checkpoint's `X__user`. A public `open` regression
failed before the fix. The correction adopts Server/Web's human-only suffix
identity rule while retaining the original Server ID in output. Two distinct
Turns with identical content remain separate.

Both Standards and Spec re-reviewed the product correction and found no
remaining code finding. The final Runtime suite passed 251 tests with six skips;
Desktop typechecking, all ten tests and provenance checks passed. The rebuilt
NSIS candidate repeated installed lifecycle and all real-provider scenarios.
The UI probe now asserts one displayed user Turn and waits for the rendered
success status before its final screenshot. A separate live progress screenshot
captures the real task events. Final candidate bindings are in the report.
