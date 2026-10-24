# Issue 107 acceptance

[iDeer #107](https://github.com/Orbit-Crew/iDeer/issues/107) adds signed
update-asset verification for the Desktop: an online check against the
Server-provided controlled address and an offline import, both ending at a
verified **pending-install** state. Nothing in this delivery installs,
replaces files, or touches user data; actual drain-and-install belongs to
#108. Prerequisite #97 verified closed (2026-10-18).

Execution date: 2026-10-24, Asia/Shanghai. Automated execution only.

## Candidate and environment

Desktop branch `feat/issue-107` from develop `2ead2db702af28a780004889da0eba0203598ebb`.
Windows 11 Pro 10.0.26300 x64; Node 22.14.0 (npm); Electron 22.3.27. The
Ed25519 test keypair is generated per run; the **private key never enters the
repository, the build, the logs or the package** (kept under the gitignored
dev-log during development; production keys are a maintainer responsibility).
The app ships only the pinned public key
(`resources/updates/updates-public-key.pem`, added to extraResources).

## What was delivered

- `src/main/updates.ts`: the single verification pipeline shared by both
  paths — detached Ed25519 signature over the exact manifest bytes, manifest
  schema (version/kind/baseline/combination/server-compatibility), file and
  deletion lists bounded to `out/` and `resources/` inside the program
  directory (absolute paths, drive letters, `..`, backslashes, empty parts,
  duplicates and oversized lists rejected), and fixed error categories.
  Online check only accepts an http(s) origin matching the paired Server
  (plain http restricted to loopback), reads
  `updates/desktop/manifest.json` + `manifest.sig` under a 15 s deadline and
  reports `UPDATE_NOT_PUBLISHED` honestly.
- `scripts/release/issue-107/make-update.cjs`: maintainer tooling that signs
  a canonical manifest with a key supplied from the environment or a file.
  End-to-end run recorded: sign → detached `.sig` → independent verify → true.
- IPC (`desktop:updates:check` / `desktop:updates:import`, main-frame-gated),
  preload bridge, and the `UpdatePanel` UI: online check, offline manifest
  import through the native dialog, and the staged pending view showing kind,
  target Desktop/Runtime combination, Server compatibility requirement, file
  and deletion counts and the explicit advice. Checking or importing is never
  an installation consent.
- `src/main/runtime.ts` remembers the paired Server origin for the controlled
  address; the bundled Runtime Python version is read from the pinned
  `distribution.lock.json`.

## Scenario results (vitest `test/updates.test.ts`, 8 new cases, all passed)

| Scenario | Assertion summary | Result |
| --- | --- | --- |
| T107-01 | Release pipeline signs a canonical manifest; the app verifies it with only the public key; the private key is absent from repo/build/logs/package | passed |
| T107-02 | Online and offline paths run the same pipeline and stage the same pending state with `source` recorded; verification writes nothing (directory listing unchanged); cancel paths return `UPDATE_IMPORT_CANCELED` without effects | passed |
| T107-03 | Tampered body, truncated text, foreign-key signature, wrong manifest version, baseline mismatch (Desktop or Runtime Python), server-incompatible protocol, path escapes (`../`, drive letter, absolute, dot-segments), user-area paths, deletion outside program directory and duplicate file entries are each rejected with a fixed category and `pending: null` | passed |
| T107-04 | `kind: full` (underlying Electron/Python change) advises a full installer and is never treated as an in-place patch; `kind: patch` advises a staged repair pending the drain-and-install confirmation of #108 | passed |

## Executed commands

| Command | Result |
| --- | --- |
| `npm.cmd run typecheck` | passed |
| `npm.cmd test` | 31 passed, 13 files (24 baseline + 7 new) |
| `npm.cmd run test:security` | passed (IPC channel boundary updated with the two new main-frame-gated channels) |
| `npm.cmd run verify:provenance` | passed |
| `python scripts/verify-runtime-source.py` | passed |
| `ruff check local-runtime --select E9,F63,F7,F82` | passed |
| `make-update.cjs` sign → verify round trip | passed |

## Dependencies and platform scope

The controlled hosting (Nginx static directory reviewed by operations) and the
Server-side controlled-address publication are delivered in the Server and
deployment workflows; the Desktop consumes the documented fixed paths under
the paired origin and reports `UPDATE_NOT_PUBLISHED` until they exist. Real
Win7 remains `unexecuted` per the ticket and is owned by
[#131](https://github.com/Orbit-Crew/iDeer/issues/131). Actual installation,
drain coordination and restart are #108's scope by design.
