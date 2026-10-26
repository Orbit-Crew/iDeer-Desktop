// Real product app, bundled Runtime and copied external maintenance executable.
// Run after npm run build. Artifacts and profiles are isolated under a fresh TEMP root.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const { createPackage } = require('@electron/asar')
const root = path.resolve(__dirname, '../../..')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function run(mode) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer native helper '))
  const program = path.join(fixture, 'installed'), profile = path.join(fixture, 'profile'), appSource = path.join(fixture, 'app')
  fs.mkdirSync(profile); fs.mkdirSync(appSource)
  fs.cpSync(path.join(root, 'node_modules/electron/dist'), program, { recursive: true })
  fs.renameSync(path.join(program, 'electron.exe'), path.join(program, 'ideer-desktop.exe'))
  fs.cpSync(path.join(root, 'out'), path.join(appSource, 'out'), { recursive: true })
  fs.copyFileSync(path.join(root, 'package.json'), path.join(appSource, 'package.json'))
  await createPackage(appSource, path.join(program, 'resources/app.asar'))
  fs.cpSync(path.join(root, '.runtime'), path.join(program, 'resources/runtime'), { recursive: true })
  const keys = crypto.generateKeyPairSync('ed25519'), pem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  fs.mkdirSync(path.join(program, 'resources/updates'), { recursive: true })
  fs.writeFileSync(path.join(program, 'resources/updates/updates-public-key.pem'), pem)
  const library = path.join(fixture, 'update-api.cjs')
  buildSync({ stdin: { contents: "export * from './src/main/maintenance'; export * from './src/main/update-stage'", resolveDir: root },
    bundle: true, external: ['original-fs'], platform: 'node', format: 'cjs', outfile: library })
  const { UpdateService, prepareTransaction, launchMaintenance } = require(library)
  const current = { desktopVersion: require(path.join(root, 'package.json')).version, electronVersion: '22.3.27',
    runtimePython: '3.12.10', protocolVersion: 1, dataFormat: 1, readableFormats: [1] }
  const asarFailure = ['desktop-failure', 'renderer-failure', 'renderer-throw'].includes(mode)
  const relative = asarFailure ? 'resources/app.asar' : mode === 'startup-failure' ? 'resources/runtime/core/desktop.py' : 'resources/runtime/core/update_probe.py'
  let content = mode === 'startup-failure' ? 'def BROKEN PYTHON\n' : '# signed probe\n'
  if (asarFailure) {
    const broken = path.join(fixture, 'broken-app')
    fs.cpSync(appSource, broken, { recursive: true })
    if (mode === 'desktop-failure') fs.rmSync(path.join(broken, 'out/renderer/index.html'))
    else {
      const assets = path.join(broken, 'out/renderer/assets')
      const entry = path.join(assets, fs.readdirSync(assets).find(name => name.endsWith('.js')))
      if (mode === 'renderer-throw') fs.writeFileSync(entry, 'throw new Error("T109 fixture renderer failed")')
      else fs.rmSync(entry)
    }
    const candidate = path.join(fixture, 'broken.asar')
    await createPackage(broken, candidate)
    content = fs.readFileSync(candidate)
  }
  const release = path.join(fixture, 'release')
  fs.mkdirSync(path.dirname(path.join(release, 'files', relative)), { recursive: true })
  fs.writeFileSync(path.join(release, 'files', relative), content)
  const manifest = { version: 1, kind: 'patch', publishedAt: '2026-10-25T00:00:00Z',
    desktop: { version: current.desktopVersion, electron: current.electronVersion, asarSHA256: asarFailure ? crypto.createHash('sha256').update(content).digest('hex') : hash(path.join(program, 'resources/app.asar')) },
    runtime: { python: current.runtimePython, lockSHA256: hash(path.join(program, 'resources/runtime/distribution.lock.json')) },
    baseline: { desktopVersion: current.desktopVersion, electronVersion: current.electronVersion, runtimePython: current.runtimePython, dataFormat: 1 },
    dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: '' },
    files: [{ path: relative, sha256: crypto.createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content) }], deletions: [] }
  const text = JSON.stringify(manifest)
  fs.writeFileSync(path.join(release, 'manifest.json'), text)
  fs.writeFileSync(path.join(release, 'manifest.sig'), crypto.sign(null, Buffer.from(text), keys.privateKey).toString('hex'))
  fs.writeFileSync(path.join(profile, 'credentials-preserved.txt'), 'CURRENT-REVOKED-AUTH')
  fs.mkdirSync(path.join(profile, 'Runtime'))
  const seed = "from core.receipt_ledger import ReceiptLedger; import sys; b={'server_origin':'https://fixture.invalid','user_id':'u','device_id':'d','device_public_key':'k','broker_public_key':'b'}; l=ReceiptLedger(sys.argv[1]); l.admit(b,{'task_id':'unconfirmed-108','run_id':'r','capability':'local.files.write'}); l.complete(b,{'task_id':'unconfirmed-108','status':'completed','capability':'local.files.write'})"
  const seeded = spawnSync(path.join(program, 'resources/runtime/python.exe'), ['-I', '-c', seed, path.join(profile, 'Runtime/receipts.db')], { cwd: path.join(program, 'resources/runtime'), encoding: 'utf8', windowsHide: true })
  if (seeded.status !== 0) throw new Error('receipt seed failed: ' + seeded.stderr)
  const ledgerHash = hash(path.join(profile, 'Runtime/receipts.db'))
  const service = new UpdateService({ directory: path.join(profile, 'Updates'), publicKeyPem: pem, current: () => current })
  const staged = await service.import(path.join(release, 'manifest.json'))
  if (!staged.ok) throw new Error(staged.error)
  const journal = prepareTransaction({ stage: service.validateStaged(), programRoot: program, userData: profile,
    executable: path.join(program, 'ideer-desktop.exe'), current, publicKeyPem: pem, parentPid: 0 })
  await launchMaintenance(journal, path.join(root, 'out/main/update-helper.cjs'))
  const recovery = path.join(profile, 'updates-recovery.json'), deadline = Date.now() + 90000
  let state
  while (Date.now() < deadline) {
    state = JSON.parse(fs.readFileSync(recovery, 'utf8'))
    if (state.state !== 'applied-pending-verify') break
    await wait(100)
  }
  const expected = mode === 'success' ? 'updated' : 'rolled-back'
  const stageRoot = path.dirname(journal)
  let health = fs.existsSync(path.join(stageRoot, 'health-response.json')) ? JSON.parse(fs.readFileSync(path.join(stageRoot, 'health-response.json'), 'utf8')) : null
  const usable = fs.existsSync(path.join(stageRoot, 'health-usable.json')) ? JSON.parse(fs.readFileSync(path.join(stageRoot, 'health-usable.json'), 'utf8')) : null
  const evidence = { mode, fixture, expected, state, health, usable, credentialsPreserved: fs.readFileSync(path.join(profile, 'credentials-preserved.txt'), 'utf8') === 'CURRENT-REVOKED-AUTH',
    unconfirmedReceiptsPreserved: hash(path.join(profile, 'Runtime/receipts.db')) === ledgerHash }
  fs.writeFileSync(path.join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2))
  // Close the verified GUI normally; forced cleanup is only a failed-fixture fallback.
  if (health && alive(health.pid)) {
    spawnSync('taskkill.exe', ['/PID', String(health.pid)], { windowsHide: true, stdio: 'ignore' })
    for (let i = 0; i < 50 && alive(health.pid); i++) await wait(100)
    if (alive(health.pid)) spawnSync('taskkill.exe', ['/PID', String(health.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  if (state.state !== expected || !evidence.credentialsPreserved || !evidence.unconfirmedReceiptsPreserved || health?.echo !== 'ideer-update-health-v1' || usable?.ipcReady !== true || usable?.windowLoaded !== true || usable?.rendererReady !== true || usable?.runtimeUnfenced !== true) throw new Error(JSON.stringify(evidence))
  return evidence
}
;(async () => {
  const results = []
  for (const mode of (process.argv[2] ? [process.argv[2]] : ['success', 'startup-failure', 'desktop-failure', 'renderer-failure', 'renderer-throw'])) results.push(await run(mode))
  console.log(JSON.stringify({ passed: true, results }, null, 2))
})().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
