# Issue #100 code review

The user confirmed Desktop baseline `b7e1e0a52cbc540afc48f01e40ad55ab4f3f4152`.
The Server comparison uses `aec07a3b9af3ab451b1f1a377a93f6f11135bf88`, whose
source tree matches merged prerequisite `95260f452670df62e365f10035d095838ec3a495`.
Two independent agents reviewed Standards and Spec. They inspected the working
diff against those baselines and all added files before the implementation commit.

## Standards

One P2 finding corrected. Listing stopped after 501 raw directory entries and
then filtered protected entries. This could hide truncation. The service now
preserves raw enumeration exhaustion for listing and search; the new public
regression covers more than 501 entries with protected files.

The installed acceptance wrapper was also checked for profile preservation.
It verifies the Windows Known Folder, refuses concurrent Desktop instances,
requires its ownership nonce before cleanup, restores the original profile and
checks its file hashes. Follow-up source review found no open issues.

The final acceptance-runner review found three P2 assertion gaps. Exact file
results (including hash, byte count and search position), the sorted Resource
identity set, and successful cleanup/restoration with nonempty model checks are
now mandatory. Follow-up source review closed all three; the final installed
run and evidence collector passed those assertions.

Standards: one product finding and three acceptance assertion gaps corrected,
zero open.

## Spec

One P2 finding corrected. A reconnect callback could load the old workspace,
lose a concurrent directory selection and save the old grant. The callback now
holds the shared settings transaction lock across reload, update and save.
The race reproduced in a separate source copy without the lock; the candidate
passes the public reconnect/directory-selection regression.

The initially empty archived Run receipts were a fixture configuration error.
The fixture now enables the same AgentPlatform evidence plugin as the production
intranet configuration. Public acceptance checks verify archived local receipts
and Run, Tool Call and Local Task identifiers. No production receipt patch was needed.

Spec: one product finding corrected, zero open. Acceptance results are recorded
separately in report.md; review does not waive execution gates.
