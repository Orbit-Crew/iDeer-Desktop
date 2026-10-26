// Real NSIS installations and shipped maintenance helper. No host-method mocks.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const crypto = require('node:crypto'), assert = require('node:assert/strict')
const { spawn, spawnSync } = require('node:child_process')
const { buildSync } = require('esbuild')
const asar = require('@electron/asar')
const { _electron } = require('playwright-core')
const { nsisInvocation } = require('../../../resources/nsis/command.cjs')
const root = path.resolve(__dirname, '../../..')
const [mode, output, installer, privateKey] = process.argv.slice(2)
assert(['copy-failure', 'interruption', 'startup-failure', 'combination-mismatch', 'unreadable-format', 'recovery-failure'].includes(mode))
for (const p of [output, installer, privateKey]) assert(path.isAbsolute(p))
assert(!privateKey.startsWith(root + path.sep))
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const digest = b => crypto.createHash('sha256').update(b).digest('hex')
const pause = ms => new Promise(r => setTimeout(r, ms))
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function wait(fn, text, timeout = 120000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await fn()) return; await pause(50) }
  throw new Error('Timeout: ' + text)
}
fs.mkdirSync(path.dirname(output), { recursive: true })
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer109-'))
const program = path.join(fixture, 'installed'), profile = path.join(fixture, 'profile')
fs.mkdirSync(profile)
const evidence = { mode, startedAt: new Date().toISOString(), fixture,
  driverSHA256: sha(__filename),
  installerSHA256: sha(installer), sourceHead: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  injection: 'External isolated filesystem/process fault; shipped helper and installed Desktop/Runtime execute unchanged.',
  scenarios: {}, timeline: [] }
const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2))
let stage, locker, app, helperPID
async function stopLaunched() {
  if (!stage) return
  const file = path.join(stage, 'launched.json')
  if (!fs.existsSync(file)) return
  const row = JSON.parse(fs.readFileSync(file))
  if (alive(row.pid)) {
    spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${row.pid} -ErrorAction SilentlyContinue;if($p){$p.CloseMainWindow() | Out-Null}`], { windowsHide: true, stdio: 'ignore' })
    await pause(500)
    if (alive(row.pid)) spawnSync('taskkill.exe', ['/PID', String(row.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    if (row.runtimePid && alive(row.runtimePid)) spawnSync('taskkill.exe', ['/PID', String(row.runtimePid), '/F'], { windowsHide: true, stdio: 'ignore' })
  }
  await wait(() => !alive(row.pid) && (!row.runtimePid || !alive(row.runtimePid)), 'owned launched processes stop', 25000)
}
async function main() {
  const invocation = nsisInvocation(installer, program)
  const installed = spawnSync(invocation.file, invocation.args, { ...invocation.options, encoding: 'utf8', timeout: 120000 })
  assert.equal(installed.status, 0)
  const executable = path.join(program, 'ideer-desktop.exe')
  evidence.installed = { executableSHA256: sha(executable), appASARSHA256: sha(path.join(program, 'resources/app.asar')) }
  const api = path.join(fixture, 'api.cjs')
  buildSync({ stdin: { contents: "export * from './src/main/maintenance'; export * from './src/main/update-stage'", resolveDir: root },
    bundle: true, external: ['original-fs'], platform: 'node', target: 'node16', format: 'cjs', outfile: api })
  const { UpdateService, prepareTransaction, launchMaintenance } = require(api)
  const helper = path.join(fixture, 'shipped-update-helper.cjs')
  fs.writeFileSync(helper, asar.extractFile(path.join(program, 'resources/app.asar'), path.join('out', 'main', 'update-helper.cjs')))
  evidence.shippedHelperSHA256 = sha(helper)
  const current = { desktopVersion: '0.2.0', electronVersion: '22.3.27', runtimePython: '3.12.10', protocolVersion: 1, dataFormat: 1, readableFormats: [1] }
  const publicKey = fs.readFileSync(path.join(program, 'resources/updates/updates-public-key.pem'), 'utf8')
  const release = path.join(fixture, 'release'), files = []
  const old = Object.fromEntries(['resources/app.asar', 'resources/runtime/core/tray.py', 'resources/runtime/core/desktop.py', 'resources/runtime/distribution.lock.json'].map(p => [p, sha(path.join(program, p))]))
  function payload(relative, bytes) {
    const target = path.join(release, 'files', relative)
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes)
    files.push({ path: relative, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })
  }
  payload('resources/runtime/core/tray.py', Buffer.concat([fs.readFileSync(path.join(program, 'resources/runtime/core/tray.py')), Buffer.from('\n# T109 signed changed program\n')]))
  if (['copy-failure', 'interruption', 'startup-failure'].includes(mode)) {
    const bytes = fs.readFileSync(path.join(program, 'resources/runtime/core/desktop.py'))
    payload('resources/runtime/core/desktop.py', mode === 'startup-failure' ? Buffer.from('def T109 BROKEN PYTHON\n') : Buffer.concat([bytes, Buffer.from('\n# T109 signed second file\n')]))
  }
  if (['combination-mismatch', 'recovery-failure'].includes(mode)) {
    // A declared Desktop version change requires an explicit signed ASAR
    // payload. The bytes intentionally still declare 0.2.0, so staging is
    // valid and the real startup handshake detects the 0.2.1 mismatch.
    payload('resources/app.asar', fs.readFileSync(path.join(program, 'resources/app.asar')))
  }
  if (mode === 'unreadable-format') {
    const unpacked = path.join(fixture, 'migrating-app')
    asar.extractAll(path.join(program, 'resources/app.asar'), unpacked)
    const entry = path.join(unpacked, 'out/main/index.js')
    const migration = "const f=require('node:fs'),p=require('node:path');const a=process.argv.find(v=>v.startsWith('--user-data-dir='));f.writeFileSync(p.join(a.slice('--user-data-dir='.length),'data-format.json'),'{\"format\":2}');require('electron').app.exit(73);\n"
    fs.writeFileSync(entry, migration + fs.readFileSync(entry, 'utf8'))
    const changed = path.join(fixture, 'migrating.asar'); await asar.createPackage(unpacked, changed)
    payload('resources/app.asar', fs.readFileSync(changed))
  }
  const manifest = { version: 1, kind: 'patch', publishedAt: '2026-10-26T00:00:00Z',
    desktop: { version: ['combination-mismatch', 'recovery-failure'].includes(mode) ? '0.2.1' : '0.2.0', electron: '22.3.27', asarSHA256: files.find(f => f.path === 'resources/app.asar')?.sha256 || old['resources/app.asar'] },
    runtime: { python: '3.12.10', lockSHA256: old['resources/runtime/distribution.lock.json'] },
    baseline: { desktopVersion: '0.2.0', electronVersion: '22.3.27', runtimePython: '3.12.10', dataFormat: 1 },
    dataCompatibility: { targetFormat: 1, readableFormats: [1] }, serverCompatibility: { minProtocol: 1, notes: 'T109 isolated failure candidate' }, files, deletions: [] }
  const text = JSON.stringify(manifest)
  fs.writeFileSync(path.join(release, 'manifest.json'), text)
  fs.writeFileSync(path.join(release, 'manifest.sig'), crypto.sign(null, Buffer.from(text), fs.readFileSync(privateKey)).toString('hex'))
  evidence.release = { manifest, sha256: digest(text), signature: fs.readFileSync(path.join(release, 'manifest.sig'), 'utf8') }
  // These are preservation canaries. Real identity/grant/receipt/KB behavior is
  // separately exercised by paired.cjs, not inferred from these files.
  const protectedFiles = { 'documents/current.txt': 'T109-USER-DOCUMENT', 'kb/current.json': '{"id":"T109-KB","content":"T109-FACT"}',
    'current-credential-ref.txt': 'T109-CURRENT-REFERENCE-NOT-AN-AUTHENTICATION-CLAIM', 'revoked-grant.txt': 'T109-REVOKED' }
  for (const [relative, bytes] of Object.entries(protectedFiles)) { const p = path.join(profile, relative); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, bytes) }
  fs.mkdirSync(path.join(profile, 'Runtime'))
  const seed = "from core.receipt_ledger import ReceiptLedger; import sys; b={'server_origin':'https://fixture.invalid','user_id':'u109','device_id':'d109','device_public_key':'k','broker_public_key':'b'}; l=ReceiptLedger(sys.argv[1]); l.admit(b,{'task_id':'pending109','run_id':'run109','capability':'local.files.write'}); l.complete(b,{'task_id':'pending109','status':'completed','capability':'local.files.write'})"
  const seeded = spawnSync(path.join(program, 'resources/runtime/python.exe'), ['-I', '-c', seed, path.join(profile, 'Runtime/receipts.db')], { cwd: path.join(program, 'resources/runtime'), windowsHide: true, encoding: 'utf8' })
  assert.equal(seeded.status, 0, seeded.stderr)
  protectedFiles['Runtime/receipts.db'] = null
  const before = Object.fromEntries(Object.keys(protectedFiles).map(p => [p, sha(path.join(profile, p))]))
  const service = new UpdateService({ directory: path.join(profile, 'Updates'), publicKeyPem: publicKey, current: () => current })
  evidence.staging = await service.import(path.join(release, 'manifest.json'))
  assert.equal(evidence.staging.ok, true, evidence.staging.error)
  const journal = prepareTransaction({ stage: service.validateStaged(), programRoot: program, userData: profile, executable, current, publicKeyPem: publicKey, parentPid: 0 })
  stage = path.dirname(journal)
  evidence.expected = ['unreadable-format', 'recovery-failure'].includes(mode) ? 'recovery-failed' : 'rolled-back'
  evidence.protectedBefore = before; save()
  if (mode === 'copy-failure') {
    const target = path.join(program, 'resources/runtime/core/desktop.py')
    fs.unlinkSync(target); fs.mkdirSync(target)
    evidence.fault = { point: 'second destination is an empty directory after durable backup', affected: 'resources/runtime/core/desktop.py' }
  }
  if (mode === 'recovery-failure') {
    fs.appendFileSync(path.join(stage, 'backup/resources/runtime/core/tray.py'), '\n# corrupted isolated backup\n')
    evidence.fault = { point: 'signed combination version mismatch and corrupt backup before restoration', affected: 'backup/resources/runtime/core/tray.py' }
  }
  if (mode === 'interruption') {
    const target = path.join(program, 'resources/runtime/core/desktop.py').replace(/'/g, "''")
    const releaseLock = path.join(fixture, 'release-lock').replace(/'/g, "''")
    locker = spawn(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$f=[IO.File]::Open('${target}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);[Console]::WriteLine('LOCKED');while(-not(Test-Path -LiteralPath '${releaseLock}')){Start-Sleep -Milliseconds 30};$f.Dispose()`], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    await new Promise((res, rej) => { locker.stdout.once('data', res); locker.once('error', rej) })
  }
  await launchMaintenance(journal, helper)
  helperPID = JSON.parse(fs.readFileSync(path.join(stage, 'helper-ready.json'))).pid
  if (mode === 'interruption') {
    await wait(() => JSON.parse(fs.readFileSync(journal)).state === 'applying' && sha(path.join(program, 'resources/runtime/core/tray.py')) === files[0].sha256, 'first real copy committed before interrupt', 15000)
    process.kill(helperPID)
    await wait(() => !alive(helperPID), 'owned helper killed')
    evidence.interrupted = { pid: helperPID, journalState: JSON.parse(fs.readFileSync(journal)).state, firstFileSHA256: sha(path.join(program, files[0].path)), secondFileSHA256: sha(path.join(program, files[1].path)) }
    fs.writeFileSync(path.join(fixture, 'release-lock'), 'release isolated sharing lock')
    await new Promise(resolve => locker.once('close', resolve)); locker = null
    await launchMaintenance(journal, helper)
    helperPID = JSON.parse(fs.readFileSync(path.join(stage, 'helper-ready.json'))).pid
  }
  const recoveryFile = path.join(profile, 'updates-recovery.json')
  await wait(() => {
    const r = JSON.parse(fs.readFileSync(recoveryFile)); const t = JSON.parse(fs.readFileSync(journal))
    if (evidence.timeline.at(-1)?.state !== t.state) { evidence.timeline.push({ at: new Date().toISOString(), state: t.state, detail: t.detail }); save() }
    evidence.recovery = r; return r.state !== 'applied-pending-verify'
  }, 'native helper terminal recovery', 180000)
  assert.equal(evidence.recovery.state, evidence.expected, evidence.recovery.detail)
  evidence.protectedAfter = Object.fromEntries(Object.keys(before).map(p => [p, sha(path.join(profile, p))]))
  assert.deepEqual(evidence.protectedAfter, before)
  evidence.programAfter = Object.fromEntries(Object.keys(old).map(p => [p, sha(path.join(program, p))]))
  evidence.programBefore = old
  evidence.repairInstructions = JSON.parse(fs.readFileSync(path.join(stage, 'repair-instructions.json')))
  assert.equal(evidence.repairInstructions.profileToPreserve, profile)
  assert(fs.existsSync(evidence.repairInstructions.backupToPreserve))
  if (evidence.expected === 'rolled-back') {
    assert.deepEqual(evidence.programAfter, old)
    evidence.health = JSON.parse(fs.readFileSync(path.join(stage, 'health-response.json')))
    evidence.usable = JSON.parse(fs.readFileSync(path.join(stage, 'health-usable.json')))
    assert.equal(evidence.health.echo, 'ideer-update-health-v1')
    assert(evidence.usable.windowLoaded && evidence.usable.rendererReady && evidence.usable.ipcReady && evidence.usable.runtimeUnfenced)
  } else {
    assert(evidence.recovery.detail.includes('manual repair'))
    if (mode === 'unreadable-format') { assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'data-format.json'))).format, 2); assert(evidence.recovery.detail.includes('RECOVERY_DATA_FORMAT_UNREADABLE')) }
    if (mode === 'recovery-failure') assert(evidence.recovery.detail.includes('RECOVERY_BACKUP_INTEGRITY_FAILED'))
    const journalBefore = sha(journal), helperBefore = helperPID
    await launchMaintenance(journal, helper)
    await pause(1500)
    assert.equal(sha(journal), journalBefore, 'terminal failure must not retry update or restoration')
    evidence.repeatedHelperStart = { previousPID: helperBefore, journalUnchanged: true, state: JSON.parse(fs.readFileSync(journal)).state }
  }
  await stopLaunched()
  // A normal readable-profile restart must show the durable lock in the UI.
  // Unreadable-profile startup is deliberately not forced past its data guard.
  if (mode !== 'unreadable-format') {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    app = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 45000 })
    const page = await app.firstWindow(); await page.waitForFunction(() => Boolean(window.ideer))
    await wait(async () => (await page.locator('body').innerText()).includes(evidence.expected === 'rolled-back' ? '已恢复到更新前程序' : '自动恢复失败'), 'actual durable recovery UI')
    evidence.restartUI = await page.locator('body').innerText()
    evidence.secondInstall = await page.evaluate(() => window.ideer.installUpdate().then(value => value, e => String(e)))
    assert(String(evidence.secondInstall).includes('UPDATE_RECOVERY_LOCKED'))
    await page.screenshot({ path: output.replace(/\.json$/, '.png'), fullPage: true })
    const closed = app.waitForEvent('close'); await page.evaluate(() => window.ideer.quit()); await closed; app = null
  }
  evidence.status = 'passed'
}
main().catch(error => { evidence.status = 'failed'; evidence.error = String(error); evidence.stack = error.stack; console.error(error.stack); process.exitCode = 1 }).finally(async () => {
  try { if (app) await app.close() } catch {}
  try { await stopLaunched() } catch (e) { evidence.cleanupError = String(e); evidence.status = 'failed'; process.exitCode = 1 }
  if (locker) { fs.writeFileSync(path.join(fixture, 'release-lock'), 'cleanup'); locker.kill() }
  evidence.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ mode, status: evidence.status, output }))
})
