// Fresh NSIS installation and signed broken Runtime release for paired recovery.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { nsisInvocation } = require('../../../resources/nsis/command.cjs')
const [installer, keyFile, output] = process.argv.slice(2)
for (const p of [installer, keyFile, output]) assert(path.isAbsolute(p))
const program = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer109-paired-'))
const invocation = nsisInvocation(installer, program)
const r = spawnSync(invocation.file, invocation.args, { ...invocation.options, timeout: 120000 }); assert.equal(r.status, 0)
const hash = b => crypto.createHash('sha256').update(b).digest('hex')
const release = path.join(path.dirname(output), 'release'), files = []
for (const [relative, bytes] of [['resources/runtime/core/desktop.py', Buffer.from('def T109_REAL_BROKEN_STARTUP\n')], ['resources/runtime/core/tray.py', Buffer.concat([fs.readFileSync(path.join(program, 'resources/runtime/core/tray.py')), Buffer.from('\n# signed T109 recovery candidate\n')])]]) {
  const p = path.join(release, 'files', relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes)
  files.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) })
}
const manifest = { version: 1, kind: 'patch', publishedAt: '2026-10-26T00:00:00Z',
  desktop: { version: '0.2.0', electron: '22.3.27', asarSHA256: hash(fs.readFileSync(path.join(program, 'resources/app.asar'))) },
  runtime: { python: '3.12.10', lockSHA256: hash(fs.readFileSync(path.join(program, 'resources/runtime/distribution.lock.json'))) },
  baseline: { desktopVersion: '0.2.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
  dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: 'T109 recovery test' }, files, deletions: [] }
const text = JSON.stringify(manifest); fs.writeFileSync(path.join(release, 'manifest.json'), text)
fs.writeFileSync(path.join(release, 'manifest.sig'), crypto.sign(null, Buffer.from(text), fs.readFileSync(keyFile)).toString('hex'))
const metadata = { program, executable: path.join(program, 'ideer-desktop.exe'), release: path.join(release, 'manifest.json'), installerSHA256: hash(fs.readFileSync(installer)) }
fs.writeFileSync(output, JSON.stringify(metadata, null, 2)); console.log(JSON.stringify(metadata))
