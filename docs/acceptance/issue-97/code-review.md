# Issue #97 code review

Fixed point explicitly confirmed by the user: a41817d.
Candidate: 1f527e69bd8df3d8e924dcc88b0979ba1fe7684b.
Comparison: `git diff a41817d...1f527e6`.
The code-review skill ran Standards and Spec in independent parallel agents,
followed by focused re-review of their corrections. Initial attempts exhausted
usage before producing findings; the resumed reviews below completed.

## Standards

No hard violation or confirmed application-code defect in the fixed launcher,
restricted environment, main-frame IPC checks, credentials, durable admission or
packaging boundary. A later review found one P2 in the acceptance script:
substring matching accepted a parent directory of the registered installation.
The script now resolves the registered uninstaller and compares its parent
directory exactly, also requiring the expected uninstaller and application.
The reviewer confirmed the fix; a real parent-directory negative run was rejected
before any installation action, recorded in evidence/parent-rejection.json.

One optional P3 maintenance judgment remains: process_job.py and the preserved
PythonExecutor implementation both define Windows Job Object ABI structures.
Their distinct ownership lifetimes are tested. Sharing those definitions can be
done in a later refactor; this is not a documented-standard violation or blocker.

The reviewer also confirmed the corrected smoke waits for the actual IPC value
instead of passing an async predicate to waitForFunction. Old heading assertions
were updated to the delivered UI. No further required correction was found.

## Spec

No implementation error or scope expansion found. The unchanged Server signing
and verification module running in a controlled peer meets the controlled-peer
protocol contract. This does not claim a full deployed Server test.

The first review noted that crash replay covered completed tasks only. A counting
MCP fixture now persists a side effect, blocks 30 seconds before returning any
result, and the test kills Runtime within the 10-second observation bound.
Restart rejects uncertain-97 with a verified signed TASK_REPLAYED and leaves its
ledger marker exactly once. The reviewer confirmed this fills that test window.

Required installer/UI evidence was pending during review. The acceptance report
records the final candidate's executed results separately; review does not replace
those operations or waive the Win7 handoff.

Standards: 1 P2 corrected, 0 unresolved hard findings, 1 optional P3 smell.
Spec: 0 implementation findings; the identified crash-window coverage gap was fixed.
