---
id: issue-112-desktop-installed-acceptance
kind: evidence
status: current
owner: Neowyh
scope: Issue 112 installed combination acceptance on modern Windows
last-verified: 2026-10-28
verified-against: Desktop candidate 2bf0b2f (tree identical to develop de3b6ef, merge of #35); Server candidate ci/develop-green-20261028 4f45d5c8 (tree identical to develop f77261ce, merge of #166)
---

# Issue 112 installed combination acceptance, 2026-10-28

The prepared driver `scripts/acceptance/issue-112/run.ps1` was executed
end-to-end on this host. It installed the actual NSIS package into a fresh
TEMP directory, started the real isolated Gateway from the Server candidate,
registered and paired synthetic accounts A/B through the public
registration/login/device APIs with credentials in the real Windows secret
store, observed the upload boundary through a raw TCP proxy, and drove the
installed application's own import UI through Playwright. Only the native
file picker and confirmation dialog callbacks received synthetic inputs; IPC,
the bundled Runtime, HTTP, authorization and storage stayed real.

## Bindings

- Installer `ideer-desktop-0.2.0-windows-x64-setup.exe`, 94,004,594 bytes,
  SHA-256 `5bb8fb587d25e1705cd21f7753d105c6d9c9f6abae46767b6fe9ead206f18ba2`;
  app.asar SHA-256 `2d1c60436a0bfc702dc29b3d5291caf92e3837c591620ea0cb4dce691efdc391`.
  Built from the Desktop candidate whose tree equals develop `de3b6ef` after
  PR #35 (`git rev-parse de3b6ef^{tree} 2bf0b2f^{tree}` →
  `f9c29a345606648cd5b49997306618e7ab635272` for both).
- Server candidate branch `ci/develop-green-20261028` (4f45d5c8), whose tree
  equals develop `f77261ce` after PR #166. The Gateway hashed every backend
  Python file at startup:
  `serverSourceSHA256 3e8a3923ba727770…` (full per-file list in the archived
  `server-source-files.json`), so the acceptance binds the actual executed
  tree, not just the base commit.
- Windows 11 Pro 10.0.26300 x64; installed app reported version 0.2.0,
  Electron 22.3.27, in-app Node 16.17.1, sandbox/contextIsolation on and
  nodeIntegration off (asserted in `result.json`).
- Driver `desktop.cjs` SHA-256 `a08afb126fb3b31a…`; run window
  2026-10-28T14:10:13Z–14:11:29Z plus install/server setup steps recorded in
  `command.json`.

## Results

Evidence: [evidence/installed-20261028/](evidence/installed-20261028/)
(`result.json` per-case facts, `request-summary.json` upload-boundary
observations, `ready.json`, cleanups and uninstall record; profiles, app data
and credential references are deliberately not archived).

| Scenario | Status | Installed-run coverage |
| --- | --- | --- |
| T112-01 | passed | Real three-end run: A picked `guide.md` through the installed UI; the confirmation dialog stated no automatic upload; the platform received exactly one `POST …/knowledge-revisions/local-imports` with body keys `{device_id, documents}`, identity-only document fields, under 2 KiB, without the original marker bytes; the platform revision list and the Desktop registry showed the same revision id and independently recomputed manifest hash; screenshot archived. |
| T112-02 | passed | Unconfirmed workspace refused with zero reads/posts; protected (`node_modules`), unsupported (`.env`), outside-root and Windows-junction escapes all refused through the installed UI with zero registration posts and zero server revisions; B received 404 on A's revision. |
| T112-03 | passed except provider-gated pair | Changed content produced R2 with a different manifest hash while R1 stayed frozen at its own content hash; the draft `prepare`/`publish` refusal pair is recorded **unexecuted**: without a configured RAGFlow provider the facade answers 503 before reaching the local-import check, and the driver records that honestly instead of calling it the expected 409. The 409 refusal itself is covered by the Server-side automated suite (see the companion Server report); a live provider deployment stays a named dependency, and the retrieval tail remains draft-only by design. |
| T112-04 | passed | Restart of the installed app restored both frozen registry rows for A; account/device isolation held (B saw no rows, no workspace, 404 on the KB, and its import into A's KB was refused); replacing the workspace directory was detected through the recorded generation and refused without any registration post. |

Overall driver verdict: `incomplete` solely because of the two
provider-gated T112-03 cases above; every case that could execute in this
environment passed. The uninstaller ran and the installation directory was
verified gone; credentials were cleaned from the OS store (archived cleanup
records).

Win7 remains unexecuted and is owned by [iDeer #131](https://github.com/Orbit-Crew/iDeer/issues/131);
modern Windows passes must not be read as Win7 passes.
