# Final 0.2.0 candidate binding for the issue 105–111 installed acceptance

Executed 2026-10-25/26, Windows 11 Pro 10.0.26300 x64, by the root
integration run after two review passes (artifacts/dev-log/integration/
code-review.md, concurrent-session.md).

- Desktop branch `codex/complete-issues-105-110`, HEAD `a32d7c9`
  (13 ticket-grouped commits on develop `dc104ea`).
- Final installer `ideer-desktop-0.2.0-windows-x64-setup.exe`
  (92,394,783 bytes), SHA-256
  `d89450a0b01ad8f69f58086ad44068d09dceac575da75f29b4a2339f4ae7e4e0`,
  installed per-user at `D:\software\iDeer Desktop\ideer-desktop`.
- Deployment public key (isolated test keypair outside the repository):
  fingerprint `2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db`;
  packaged trust-anchor.json, the installer `.updates-trust.json` sidecar,
  the signed update releases and the Server trust file all bind this key.
- Signed patch releases for the update scenarios:
  `published-updated` (tray.py marker patch, expectation `updated`) and
  `published-rollback` (deliberately broken desktop.py, expectation
  `rolled-back`), both verified against the same key.
- Server: isolated worktree at Server candidate `591f80cf3` (branch
  codex/complete-issues-105-110, uncommitted hardening on top), real Gateway
  fixture `scripts/acceptance/issue-102/server_fixture.py`, deterministic
  model; `SERVER_RELEASE_VERSION=591f80c-runtime-compat-20261025`;
  `UPDATES_CONTROLLED_DIR` served the signed compatibility cases.
- Isolation: every run passed the standard `--user-data-dir` below its own
  fresh state directory; the real user profile was never read, moved or
  replaced. Each attempt used a fresh fixture state and fresh prepared
  profiles (`profiles.py prepare`, synthetic identities).
- Gates before the runs: typecheck 0, vitest 21 files / 94 tests passed,
  pytest 389 passed / 6 skipped, provenance verified, ruff clean on changed
  files; PR CI `static-and-contract` and `windows-package` recorded on the
  final PR.

Run map (all `status: passed`, result JSON in the per-issue evidence dir):

| Run | Ticket | Content |
| --- | --- | --- |
| E1 | #111 | installed full matrix T111-01..03 (14 cases) + gates record |
| C8 | #108 | paired drain-and-install, expectation `updated` (5 cases incl. product usability record) |
| D1 | #109 | paired rollback of a broken patch, expectation `rolled-back` (5 cases) |
| E2b | #106, #105 | installed switch-over matrix T106-01..04 (13 cases) incl. the artifact flow: grant upload, idempotent repeat, second-device download, cross-account refusal |
| E4 | #110 | old-client-first leg: unchanged 0.1.0 client against the upgraded Server |
| E6 | #110 | new-client leg: compatible/capability/core/refusals/release order (8 cases) |

Standalone installed offline coverage (issue-108/installed-update.cjs):
silent NSIS install into an isolated fixture, signed release staged, cancel
preserves the pending stage and program bytes, concurrent runtime start
refused with `UPDATE_INSTALL_BUSY`.

Win7 remains `unexecuted` under issue #131 in every ticket.
