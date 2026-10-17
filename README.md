# iDeer Desktop

Windows desktop entry for iDeer, version 0.1.0. The React/antd/zustand application
owns a bundled Python Runtime and displays process, connection and task state.
Paired devices receive signed Server tasks through the existing protocol.
Unconfigured devices cannot execute tasks. Login and chat UI remain unavailable.

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
Real Win7 validation is deferred to [issue #131](https://github.com/Orbit-Crew/iDeer/issues/131)
as specified by [parent #95](https://github.com/Orbit-Crew/iDeer/issues/95), and does not block issue #96.
It remains required for complete Win7 compatibility and linz retirement.
Upstream license verification remains unresolved and is required before distribution.
A CI package is a candidate, not an approved release.
