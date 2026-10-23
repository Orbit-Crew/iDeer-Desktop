# Issue 102 code review

Desktop fixed point: `9db5447c089ea835d1c20c3bf445f6f406468088`.
Server fixed point: `aeeb9fb2c83c7a7364de0c989c7c011cb4d15ab8`.
The user requested develop as the base. The implementation skill requires review
before committing, so the initial Desktop review used the complete staged
working diff, `git diff --cached <Desktop fixed point>`, including new files.
There were no feature commits at that review point.

Independent Standards and Spec agents reviewed in parallel. This record keeps
their findings separate. Follow-up reviews include the working-tree changes
since the fixed point, including unstaged remediation. Functional acceptance
results are recorded separately in [the acceptance report](report.md).

## Standards

Initial Desktop review found no documented-standard violations and no baseline
smells worth changing. It separately identified one P2 correctness risk:
Desktop chat reads Runtime's pending-consent dictionaries across threads. A
concurrent mutation could escape the chat handler and terminate its sole control
thread. The reviewer did not reproduce this race with its stress probe, and the
record does not claim a reproduced failure. The snapshot now runs on the owning
Runtime event loop, with bounded cross-thread scheduling and safe failure in
the chat control handler. Signed consent-churn and timeout regressions cover
the revised behavior. Follow-up Standards review has no unresolved Desktop
findings.

A credential-redaction regression also found that an altered content card
could retain the original request hash. The Runtime now suppresses that card
and rejects approval with `CONSENT_CONTENT_REDACTED`. The failing test was
recorded before remediation. The focused follow-up then passed all six selected
filesystem, signed-write and chat cases. Exact commands and the limits of the
captured record are retained in the [focused-check summary](evidence/desktop/focused-checks.md).

Server Standards review identified a P2 race: a transport exception following
a valid terminal receipt could overwrite the known task outcome. Both
`send_task` and `cancel_task` now preserve terminal state and a received receipt.
The regression first produced 8 failures and 2 passes, then the broker suite
passed all 41 tests. Independent final code-and-record review confirmed both
guards and found 0 unresolved findings; it did not rerun the full Server lane.

## Spec

Initial Desktop review found five P2 issues:

- Cleanup or handle-close failure after a successful file replacement could
  return an ordinary failure despite actual `AFTER` bytes. The reviewer reproduced
  this with an isolated filesystem fault. Such results must remain uncertain.
- The generic file-error path omitted the already-granted approval from a write
  receipt, including an uncertain result associated with its original Run.
- The acceptance runner used the former read-only directory button label.
- The runner waited for cards on invalid paths that fail the Runtime's initial
  boundary check before any prompt exists.
- The runner attempted its completion-storage fault before a real read had
  demonstrated recovery from the preceding admission-storage failure.

All five were fixed. Post-replacement cleanup failures now remain
`RESULT_UNCERTAIN`; the error path retains the original approval basis. The
runner uses the actual button label, expects boundary rejection before a card,
and performs a real read to verify receipt-store recovery between faults.

An incremental review reproduced another P2 race: cancellation while sending
an uncertain readback-error result could emit a false `CANCELLED` result after
the write. The effect marker is now set before that await, and the cancellation
handler preserves the uncertain fact. The reviewer independently ran the signed
regression successfully. Final Desktop Spec review has 0 unresolved findings
and no scope expansion.

Server's complete Spec review found 0 gaps. Incremental review of the final
terminal-preservation patch also found 0 gaps. Its reviewed broker SHA-256 is
`c2666418152417d9bc9cf93df65ee04dfa6396e781e029f090f3f4c99c98020e`.

Initial counts: Standards 0 rule/smell findings and 1 separate P2 correctness
risk; Spec 5 P2 findings, worst being an ordinary failed result after a real write.

Final unresolved findings: Standards 0; Spec 0. These are code-review results.
The separate real acceptance Run submission failure must be resolved and the
required functional scenarios must pass before acceptance is complete.

## UTF-8 follow-up from real acceptance

The actual Unicode/newline acceptance exposed a further product defect in the
owned Node-to-Python JSON pipe. The bundled Windows interpreter's isolated
startup used GBK despite Node sending UTF-8. An independent real-process probe
observed corrupted Chinese characters and lone surrogates, followed by a Server
Run admission `UnicodeEncodeError`. The subprocess now receives explicit
`-X utf8` while retaining `-I`, `-u`, fixed executable, environment whitelist and
`shell: false`.

A new real RuntimeProcess-to-bundled-Python-to-local-HTTP test verifies exact
Chinese, emoji and embedded CRLF in the outgoing request and returned public
status. The semantic red run failed with received garbled text; the green run
passed both tests. Initial sandbox socket failures are recorded separately and
do not count as semantic red/green evidence. See the
[UTF-8 evidence](evidence/desktop/utf8/README.md).

Independent incremental Standards and Spec reviews each reported 0 new
findings. They reviewed code and evidence without rerunning all suites or
claiming that complete functional acceptance had passed.

## Long approval observation follow-up

The first corrected-candidate development run completed the original Server
timeout Run with a denied receipt after 300 seconds. The runner nevertheless
failed because it kept reading stale Desktop state after the long SSE connection
disconnected. Fixed-field persisted-state evidence distinguishes the actual
terminal Run from that observation failure.

The runner now clicks the actual reconnect button for the same Thread and Run
after a local terminal task, requested cancellation or bounded final observation.
It allows at most three clicks, at least five seconds apart, within the original
90/345-second observation budget. It cannot submit a new Run or approval.
Independent incremental Standards and Spec reviews each found 0 issues and
checked the validator's matching recovery assertions. Syntax verification
passed. Both complete functional runs then passed against this exact runner.

## Remaining fixture-contract corrections

Fast diagnostic runs exposed request/observation mismatches. Web consent needs
the synthetic owner's `actor_id`; the script now saves the response before
checking HTTP 403 and exact `detail.code=LOCAL_APPROVAL_REQUIRED`. Structured
HTTP failures retain the baseline top-level generic error envelope. Traversal
now strictly expects `INVALID_PATH` from the current shared Windows filename
guard, while junction escape still requires `OUTSIDE_ALLOWED_ROOTS`. Standards
review caught and closed one inaccurate README attribution: the baseline lower
traversal guard returned `OUTSIDE_ALLOWED_ROOTS`, rather than the current earlier
filename error.

Four real canonical auxiliary reads verify storage after the four later Runtime
restarts while retaining the old uncertain write. They have independent
Thread/Run/task identities and verify BEFORE, receipt confirmation, original
uncertain-row preservation and exactly one dispatch/execution. The report
separates 21 original operations from those four actual extra reads.

The final recovery observer uses the existing durable receipt API instead of
requiring a late upload to mutate the online Task response. It preserves that
live snapshot, projects necessary fields from the real owner-authenticated
archive response, and correlates its original Run/task/tool call/request hash,
approved basis, receipt ID/hash/ACK, local confirmation and dropped completed
result with actual AFTER bytes. The original cancelled Run must stay
interrupted. Existing Server architecture and receipt-replay/API tests define
this contract; no Server behavior was changed to satisfy the runner.

Independent final incremental Standards and Spec reviews each reported 0 new
findings for auxiliary recovery and archive observation. The README fact issue
is closed. Final unresolved findings remain Standards 0 and Spec 0. Both complete
functional runs passed; their exact candidates and results are recorded in
[the acceptance report](report.md).
