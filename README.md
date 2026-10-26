# iDeer Desktop

For issue completion reviews or acceptance evidence, start with the
[acceptance index](docs/acceptance/README.md). It links #108's current report,
historical attempts, candidate bindings and reproducible drivers.

Windows desktop entry for iDeer, version 0.1.0. The React/antd/zustand application
owns a bundled Python Runtime and displays process, connection and task state.
Paired devices receive signed Server tasks through the existing protocol.
Unconfigured devices cannot execute tasks. Browser login establishes a separate
business session for platform Agent/Skill chat, streaming and Thread history.
The Server runs the Agent; Desktop never falls back to a local model.

After selecting a workspace, text file creation and overwrite requests appear
in the original chat as local approval cards. Each approval binds the exact
path and content for one task. Users can also explicitly allow text writes for
the selected directory and its subdirectories. Settings lists these account
and device-bound grants and can revoke them. Logout stops tasks and pending
approvals; the same active device can recover grants after a valid login.
Changing accounts or rebinding a device never imports another identity's grants.
Writes require a reliable local receipt record;
disconnects do not automatically repeat a write. See the
[issue #102 acceptance report](docs/acceptance/issue-102/report.md) for scenario
results and remaining verification.
Persistent directory consent and account/device lifecycle results are in the
[issue #103 acceptance report](docs/acceptance/issue-103/report.md).
The original Thread can stop a Turn and recover local task and receipt facts
after disconnects or restarts. Stop requests do not roll back committed writes.
See [issue #104 acceptance](docs/acceptance/issue-104/report.md).

Use Node 22 and npm on the build machine:

```sh
npm ci
python -m pip install './local-runtime[test]'
npm run runtime:prepare
npm run typecheck
npm test
npm run dev
# Build the Windows x64 NSIS candidate on Windows
npm run dist:win
```

Electron is pinned to 22.3.27 with software rendering. Installation identity and
`%APPDATA%/iDeer Desktop` are independent of linz. Closing the window exits.
No old installation, data, credentials or workspace is imported or deleted.

See [porting and ownership](docs/porting.md), [validation and Win7 gates](docs/validation.md),
[execution evidence](docs/validation-results.md), and [third-party notices](THIRD_PARTY_NOTICES.md).
Modern Windows acceptance follows [the scenario report](docs/acceptance/issue-96/report.md).
Runtime migration follows [issue #97 acceptance](docs/acceptance/issue-97/report.md)
and the [migration record](docs/runtime-migration.md).
See [platform chat](docs/platform-chat.md) and the
[issue #99 acceptance report](docs/acceptance/issue-99/report.md) for the chat
boundary, checks and remaining acceptance requirements.
Real Win7 validation is deferred to [issue #131](https://github.com/Orbit-Crew/iDeer/issues/131)
as specified by [parent #95](https://github.com/Orbit-Crew/iDeer/issues/95), and does not block issue #96.
It remains required for complete Win7 compatibility and linz retirement.
Upstream license verification remains unresolved and is required before distribution.
A CI package is a candidate, not an approved release.
