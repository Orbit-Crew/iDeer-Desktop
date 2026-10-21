# Issue 101 installed acceptance

The fixture runs the real isolated Gateway, SQLAlchemy persistence, signed device
broker, installed Electron app and bundled Windows Runtime. It reuses issue 100's
deterministic model and synthetic A/B pairing helper. File contents, task metadata,
hashes and protocol expectations are fixed independently of implementation output.
The fixture never calls an external model provider.

Start `server_fixture.py` with the candidate Server's Python and three absolute
paths: `--server-root`, a fresh Linux `--state` directory, and a fresh Windows
`--desktop-state` directory expressed through `/mnt/c/` in WSL. The fixture prints
`READY` and writes `ready.json`. The Server state contains protected synthetic JWT
and broker keys and must remain outside committed evidence.

On Windows, run the candidate bundled interpreter with
`-I scripts/acceptance/issue-100/profiles.py prepare <Windows-state>`. Then run
`pwsh -File scripts/acceptance/issue-101/installed.ps1 -State <Windows-state>
-Executable <installed-candidate-exe>`. The wrapper verifies the actual Known Folder,
backs up the existing Runtime profile, marks the synthetic profile it owns, and
restores and hashes the original files after the app exits.

The runner records stages in `result.json`, the older-page screenshot
`receipt-history-older.png`, and the final `receipt-history.png`. Before each
screenshot it waits up to 15 seconds for three consecutive rendered samples with
authenticated/running status, a history summary, and no status/history error.
This check reads the DOM without issuing competing receipt IPC. The fixture
also records receipt IDs, hashes and ACK IDs in `receipt-events.jsonl`, without
headers, credentials or full task payloads. A passing process exit is necessary;
the report must still bind these outputs to the actual candidate/package hashes.

Every read records its connection, refresh, Thread-create, Run-submit and terminal
observation phases, with a synthetic turn ID before submission. Only a read-only
chat refresh returning `CHAT_SERVER_UNAVAILABLE` receives up to three attempts,
with each attempt's timing and a 250 ms then 500 ms delay recorded. Thread creation
and Run submission are each attempted once. A transport failure at either mutation
requires reconciliation, never automatic resubmission. Failure output includes a
sanitized stack and final scoped local metadata before profile restoration.

| Scenario | Automated operation |
| --- | --- |
| T101-01 | Drop receipt uploads before archive, complete a real read, quit/restart Desktop, restart the Server interpreter, restore original A and upload evidence without executing again. |
| T101-02 | Lose the first ACK after archive commit, restart the Server interpreter again, compare the stable ACK and terminal Run, and count exactly one local execution audit row. |
| T101-03 | Switch to B, verify A is absent from B's history and task summary and API reads return 404; disable A, restore legal A, protect pending rows and clear confirmed rows into tombstones. |
| T101-04 | Execute 23 reads, compare durable counts with 20-row pages, open older records through the actual UI, and verify unchanged marker contents. |
| T101-05 | Install SQLite triggers only in the marked synthetic profile to reject admission or completion. Verify no new admission for the first fault, an uncertain row for the second, and two new successful reads while only ACKs are dropped. |

`profile_controls.py` refuses profiles without `.issue101-owner`. Its fault action
never fills a disk. The network-only fault drops ACKs while leaving the signed
socket and ordinary task results usable. `hold-uploads`, `drop-acks`, `disable-A`
and `restart-request` are fixture control files only; product code has no such
fault switches.

In cleanup, run the issue 100 helper with `cleanup <Windows-state>` to remove only
the synthetic credential references it created, then create `<Windows-state>/stop`
and wait for the Gateway fixture to exit. Preserve sanitized results and hashes in
`docs/acceptance/issue-101/report.md`. Real Win7 remains assigned to issue 131.
