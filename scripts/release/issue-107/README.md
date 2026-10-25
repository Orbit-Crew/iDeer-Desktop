# Signed Desktop releases

The same release directory is served at `/updates/desktop/` and copied for
offline import. It contains `manifest.json`, its detached Ed25519
`manifest.sig`, and either `files/resources/...` for a patch or
`installer.exe` for a full installation. Offline import selects exactly
`manifest.json`. The signature covers its exact UTF-8 bytes.

`make-update.cjs` takes a manifest definition and a complete target installed
directory. It calculates file sizes and SHA-256 hashes, reads the target
Desktop version from `resources/app.asar/package.json`, and reads the target
Python version from `resources/runtime/distribution.lock.json`. Neither
private keys nor input definitions are copied into the release directory.

```powershell
node scripts/release/issue-107/make-update.cjs --manifest definition.json `
  --payload-root C:\release\target-installed --out C:\release\published `
  --private-key C:\private\updates-ed25519.pem
```

A full definition has `kind: "full"`, empty `files` and `deletions`, and adds
`--installer C:\release\setup.exe` to the command. The tool signs its fixed
published name, `installer.exe`, and its actual hash and size. A patch cannot
change Electron or Python. Program paths use the installation root, for
example `resources/app.asar` and `resources/runtime/core/desktop.py`.
User data, interpreter binaries, reparse points, Windows aliases and
intersecting file/deletion entries are rejected.

Every new definition includes these fields alongside the existing version,
publication time, file lists and Server protocol requirement:

```json
{
  "desktop": { "version": "0.2.0", "electron": "22.3.27", "asarSHA256": "computed" },
  "runtime": { "python": "3.12.10", "lockSHA256": "computed" },
  "baseline": {
    "desktopVersion": "0.1.0", "electronVersion": "22.3.27",
    "runtimePython": "3.12.10", "dataFormat": 1
  },
  "dataCompatibility": { "targetFormat": 1, "readableFormats": [1] }
}
```

The legacy manifest without explicit Electron and data compatibility fields
is rejected. A patch must retain a data format readable by the previous
program. Changing file contents never implies data format compatibility.

Production builds retain the repository's pinned public key. A deployment
can set `IDEER_UPDATES_PUBLIC_KEY_FILE` to an absolute external public PEM
path when running electron-builder. The `afterPack` hook accepts only an
Ed25519 public key, packages it, and records its SPKI SHA-256 fingerprint in
`resources/updates/trust-anchor.json`. The completed installer gets a
`.updates-trust.json` sidecar binding the installer hash to that fingerprint.
The running application always reads its packaged pin; it does not read
this environment setting. Keep private keys outside the repository.

`UpdateService` stages complete verified payloads in a private profile
directory. `check(origin)` and `import(manifestPath)` share verification and
return the same pending view. `cancel()` and failed replacements clear the
old pending release. `restore()` verifies a durable stage after restart;
`validateStaged()` checks the signature and every staged file again before
installation. Its `StagedUpdate` supplies one `id`, `stageRoot`,
`payloadRoot`, optional `installerPath`, and the verified `pending` manifest
to the installation coordinator.

HTTP uses Node's `http` and `https` modules, including Electron 22's Node 16
runtime. Reads have byte limits and deadlines. Redirects stay on the exact
paired origin, so cross-origin redirects and HTTPS downgrade are refused.
