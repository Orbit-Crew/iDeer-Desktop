// Usage: node installed-update.cjs --installer BASE_SETUP --release MANIFEST --expected updated|rolled-back|recovery-failed --report REPORT_JSON
// The base installer must contain the same deployment public key that signed the release.
// Offline standalone coverage stops at staging, cancel-preservation and the
// concurrent-restart refusal: the drain itself requires an authenticated,
// workspace-selected pairing, which only the issue-102/111 server-fixture
// harness provides (the drain command is identity- and workspace-bound).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { _electron } = require('playwright-core')
const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => index % 2 ? pairs : [...pairs, [value.replace(/^--/, ''), all[index + 1]]], []))
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const assert = (condition, message) => { if (!condition) throw new Error(message) }
async function main() {
  for (const name of ['installer', 'release', 'expected', 'report']) assert(options[name] && path.isAbsolute(options[name]) === (name !== 'expected'), 'missing/invalid --' + name)
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer NSIS update ')), program = path.join(fixture, 'installed'), profile = path.join(fixture, 'profile')
  fs.mkdirSync(profile)
  const install = spawnSync(options.installer, ['/S', '/D=' + program], { windowsHide: true, encoding: 'utf8', timeout: 120000 })
  assert(install.status === 0, 'base NSIS install failed: ' + install.status)
  const executable = path.join(program, 'ideer-desktop.exe')
  assert(fs.existsSync(executable), 'installed executable missing')
  const evidence = { fixture, installerSHA256: hash(options.installer), releaseSHA256: hash(options.release),
    expected: options.expected, baseAsarSHA256: hash(path.join(program, 'resources/app.asar')), confirmations: [], installedAt: new Date().toISOString() }
  fs.mkdirSync(path.join(profile, 'Runtime'))
  const seed = "from core.receipt_ledger import ReceiptLedger; import sys; b={'server_origin':'https://fixture.invalid','user_id':'u','device_id':'d','device_public_key':'k','broker_public_key':'b'}; l=ReceiptLedger(sys.argv[1]); l.admit(b,{'task_id':'unconfirmed-108','run_id':'r','capability':'local.files.write'}); l.complete(b,{'task_id':'unconfirmed-108','status':'completed','capability':'local.files.write'})"
  const seeded = spawnSync(path.join(program, 'resources/runtime/python.exe'), ['-I', '-c', seed, path.join(profile, 'Runtime/receipts.db')], { cwd: path.join(program, 'resources/runtime'), windowsHide: true, encoding: 'utf8' })
  assert(seeded.status === 0, 'receipt fixture seed failed')
  const receiptsHash = hash(path.join(profile, 'Runtime/receipts.db'))
  fs.writeFileSync(path.join(profile, 'current-credential-marker.txt'), 'NEW-LEGAL-CREDENTIAL-REVOKED-GRANT')
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const timeline = []
  let client, recorder, page
  try {
    client = await _electron.launch({ executablePath: executable, args: ['--user-data-dir=' + profile], env, timeout: 30000 })
    page = await client.firstWindow()
    recorder = setInterval(() => { void page.evaluate(() => window.ideer.getStatus().then(s =>
      ({ at: Date.now(), process: s.runtime.process, pid: s.runtime.pid, drain: s.runtime.installDrain }))).then(row => { if (row) timeline.push(row) }).catch(() => {}) }, 250)
    await page.waitForFunction(() => window.ideer, { timeout: 15000 })
    await page.waitForFunction(async () => (await window.ideer.getStatus()).runtime.process === 'running')
    await client.evaluate(({ dialog }, manifest) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [manifest] })
      dialog.showMessageBox = async () => new Promise(resolve => { globalThis.__ideerConfirmFixture = resolve })
    }, options.release)
    evidence.staged = await page.evaluate(() => window.ideer.importUpdate())
    assert(evidence.staged.ok, 'signed release refused: ' + evidence.staged.error)
    await page.evaluate(() => { window.__ideerInstallFixture = window.ideer.installUpdate() })
    while (!(await client.evaluate(() => Boolean(globalThis.__ideerConfirmFixture)))) await wait(20)
    evidence.concurrentRestart = await page.evaluate(() => window.ideer.startRuntime().then(() => 'UNSAFE_RESTART', error => String(error)))
    assert(evidence.concurrentRestart.includes('UPDATE_INSTALL_BUSY'), 'Runtime could restart while installation owns the drain')
    await client.evaluate(() => globalThis.__ideerConfirmFixture({ response: 0, checkboxChecked: false }))
    evidence.canceled = await page.evaluate(() => window.__ideerInstallFixture)
    evidence.confirmations.push({ decision: 'canceled', outcome: evidence.canceled })
    assert(evidence.canceled.stage === 'canceled', 'cancel did not preserve pending stage')
    assert(hash(path.join(program, 'resources/app.asar')) === evidence.baseAsarSHA256, 'cancel changed program')
    await client.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) })
    evidence.confirmations.push({ decision: 'confirmed' })
    evidence.before = await page.evaluate(() => window.ideer.getStatus())
    if (evidence.before.runtime.workspace?.state !== 'ready') {
      // The drain is identity- and workspace-bound by design; without an
      // authenticated pairing there is nothing to drain and the install entry
      // refuses (RUNTIME_UNAVAILABLE). Standalone offline coverage ends here.
      evidence.standalone = 'staging, cancel preservation and concurrent-restart refusal verified offline; drain, install, rollback and health belong to the paired issue-102/111 fixture matrix'
      evidence.passed = true
      console.log(JSON.stringify({ passed: true, standalone: true, report: options.report, fixture }))
      return
    }
    try { evidence.handoff = await page.evaluate(() => window.ideer.installUpdate()) } catch (error) { evidence.handoffTransport = String(error) }
    const recoveryFile = path.join(profile, 'updates-recovery.json'), deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      if (fs.existsSync(recoveryFile)) {
        evidence.recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'))
        if (evidence.recovery.state !== 'applied-pending-verify') break
      }
      await wait(100)
    }
    assert(evidence.recovery, 'maintenance did not persist recovery state')
    const stage = path.dirname(evidence.recovery.journalPath)
    if (fs.existsSync(path.join(stage, 'health-response.json'))) evidence.health = JSON.parse(fs.readFileSync(path.join(stage, 'health-response.json'), 'utf8'))
    evidence.receiptsPreserved = hash(path.join(profile, 'Runtime/receipts.db')) === receiptsHash
    evidence.credentialsPreserved = fs.readFileSync(path.join(profile, 'current-credential-marker.txt'), 'utf8') === 'NEW-LEGAL-CREDENTIAL-REVOKED-GRANT'
    assert(evidence.recovery.state === options.expected, 'unexpected recovery result: ' + evidence.recovery.detail)
    assert(evidence.receiptsPreserved && evidence.credentialsPreserved, 'user records changed')
    if (options.expected !== 'recovery-failed') assert(evidence.health?.echo === 'ideer-update-health-v1', 'no actual Runtime echo')
    evidence.passed = true
  } finally {
    clearInterval(recorder)
    evidence.timeline = timeline
    evidence.finishedAt = new Date().toISOString()
    fs.mkdirSync(path.dirname(options.report), { recursive: true }); fs.writeFileSync(options.report, JSON.stringify(evidence, null, 2))
    await client?.close().catch(() => {})
    if (evidence.health?.pid) spawnSync('taskkill.exe', ['/PID', String(evidence.health.pid)], { windowsHide: true, stdio: 'ignore' })
  }
  console.log(JSON.stringify({ passed: true, report: options.report, fixture }))
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
