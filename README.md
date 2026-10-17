# iDeer Desktop

Windows desktop entry for iDeer, version 0.1.0. This bootstrap opens a standalone
React/antd/zustand application and clearly shows that Server is not connected.
Login, chat, models and local tool execution are unavailable at this stage.

Use Node 22 and npm on the build machine:

```sh
npm ci
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
Early tickets and stage candidates require applicable modern Windows evidence.
Real Win7 acceptance is deferred to [closing ticket #131](https://github.com/Orbit-Crew/iDeer/issues/131),
as specified by [parent #95](https://github.com/Orbit-Crew/iDeer/issues/95).
Win7 remains unverified until that gate passes. Upstream license verification is
still required before distribution. A CI package is a candidate, not an approved release.
