# Issue #109 installed recovery acceptance

Use a disposable NSIS installation and a fresh profile for every run. The
existing user installation and profile are outside these fixtures. Run with the
candidate's Node 22 and test Python, and keep the isolated Ed25519 private key
outside the checkout. The installed update public key must match that key.

## Native installed failures

```powershell
& $python scripts/acceptance/issue-101/record_command.py --output $commandRecord -- `
  $node scripts/acceptance/issue-109/native.cjs $mode $result $installer $privateKey
```

`$result`, `$installer` and `$privateKey` are absolute paths. Each invocation
installs the actual NSIS candidate under a new `TEMP/ideer109-*` directory.
The driver compiles the checked-in staging/transaction API, and extracts the
actual maintenance helper from the installed ASAR. Product host methods,
process checks, signature checks and health responses are not mocked.

| Mode | Fault and independent expected result | Issue scenarios |
| --- | --- | --- |
| `copy-failure` | After durable backup, replace the second destination with an empty directory. Real copy/rename fails after the first file changed. Expect `rolled-back`, exact original program hashes and real window/IPC/echo health. | T109-01/02 |
| `interruption` | Hold the second destination open with Windows read sharing. After the first real copy commits, terminate only the disposable helper. Resume the same durable journal using the shipped helper. Expect `UPDATE_INTERRUPTED` followed by one verified rollback. | T109-01/02/03 |
| `startup-failure` | Apply a correctly signed syntax-broken Runtime module. Expect actual process startup failure, exact rollback and verified Desktop/Runtime usability. | T109-01/02/03 |
| `combination-mismatch` | Sign a declared Desktop version `0.2.1` while the actual application remains `0.2.0`. Expect health mismatch and verified rollback, never `updated`. | T109-02/03 |
| `unreadable-format` | A signed candidate writes profile format `2` and fails during real application startup. Old readers accept only format `1`. Expect `recovery-failed`, `RECOVERY_DATA_FORMAT_UNREADABLE`, preserved format/data/backup and no old-program launch. | T109-02/03 |
| `recovery-failure` | Combine the version mismatch with a corrupt isolated backup. Expect `RECOVERY_BACKUP_INTEGRITY_FAILED`, a durable recovery lock, repair instructions and the actual failure UI on a readable-profile restart. | T109-03 |

Every native case compares protected file and SQLite pending-ledger hashes.
Those file canaries are preservation checks, not authenticated credential,
authorization or KB queries. The paired scenario below supplies those separate
integration checks. Native health uses a nonce-bound real window, preload IPC,
the bundled interpreter and `ideer-update-health-v1` echo. A terminal record is
polled for at most 180 seconds; timeout is failure. Re-running a terminal failed
journal must not repeat installation or restoration.

After assertions finish, cleanup first requests window closure and then may
terminate only the completed synthetic process tree identified by that
transaction. This cleanup is outside task drain and is not used as proof that
an in-flight write stopped safely.

## Paired recovery and post-recovery functions

```powershell
& scripts/acceptance/issue-109/run-paired.ps1 -State $freshState `
  -Node $node -Python $python -Installer $installer -PrivateKey $privateKey `
  -ServerRoot '/home/neowyh/.codex-worktrees/ideer-complete-105-110-20261025'
```

The launcher creates a fresh NSIS installation, signs the failing Runtime
candidate, and starts the real Gateway fixture with fresh A/B identities.
The task-only WSL bind adapter and Windows loopback raw TCP proxy compensate
for the host's broken automatic WSL localhost forwarding. They do not emulate
HTTP, WebSocket, authorization or business responses. No system network
configuration is changed. The standard `--user-data-dir` isolates the profile.

`paired.cjs` composes the issue-102 driver. Before failure it creates and revokes
a real directory grant, proves a new write asks again, creates an owner-bound
KB resource through `/api/resources`, checks B cannot read its knowledge
metadata, and performs a real write while dropping only Server acknowledgments.
After rollback it checks the same legal credential-reference hashes, revoked
grant absence and original pending receipt facts, then restarts the actual
application. It replays the original receipt to confirmation without task
redispatch, writes and reads a new file through the real Server/Runtime,
queries the same KB metadata and verifies the durable update lock in the UI.

The KB assertions cover the canonical resource, provider-binding metadata and
owner access. They do not claim RAG ingestion or content retrieval from an
external provider. Model tool selection is deterministic; the Gateway, signed
broker, Windows Runtime and filesystem effects are real. Automated UI decisions
are fixture inputs and do not represent human release approval.

The launcher signals its own Gateway/proxy to exit and removes only the
synthetic credential references it created. Archive result/command JSON,
compressed logs, screenshots and source/package hashes. Keep profiles,
databases and credential material in ignored artifacts. Real Win7 remains
unexecuted under [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131).
