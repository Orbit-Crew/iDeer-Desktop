// Paired drain-and-install plus rollback verification on the real installed
// package, merged into the issue-111 final matrix. Uses the issue-102 preamble
// (launch, choose, status, profile helpers) with the standard --user-data-dir
// isolation; the real user profile is never read, moved or replaced.
const programRoot = path.dirname(installed)
const userData = path.join(appData, 'iDeer Desktop')
const recoveryFile = path.join(userData, 'updates-recovery.json')
const coreFile = name => path.join(programRoot, 'resources/runtime/core', name)
const original = {
  traySHA256: sha(fs.readFileSync(coreFile('tray.py'))),
  desktopSHA256: sha(fs.readFileSync(coreFile('desktop.py'))),
  asarSHA256: sha(fs.readFileSync(path.join(programRoot, 'resources/app.asar')))
}
const releasePath = path.resolve(process.env.IDEER_ACCEPTANCE_UPDATE_RELEASE || '')
if (!fs.existsSync(releasePath)) throw new Error('IDEER_ACCEPTANCE_UPDATE_RELEASE missing')
const expected = process.env.IDEER_ACCEPTANCE_UPDATE_EXPECTED === 'rolled-back' ? 'rolled-back' : 'updated'
async function main() {
  try {
    evidence.releasePath = releasePath
    evidence.expected = expected
    evidence.originalHashes = original
    await launch(); await choose()
    pass('T108-04', 'paired installed launch and workspace', { userData, workspace: logical })
    // One completed write receipt must survive the whole installation unchanged.
    const receiptsDb = path.join(userData, 'Runtime/receipts.db')
    const seed = spawnSync(path.join(runtimeDirectory, 'python.exe'), ['-I', '-c',
      'import sys, json; sys.path.insert(0, "resources/runtime"); ' +
      'from core.receipt_ledger import ReceiptLedger, profile_binding; from core.settings import load_settings; ' +
      'b = profile_binding(load_settings(sys.argv[2])); l = ReceiptLedger(sys.argv[1]); ' +
      "l.admit(b, {'task_id': 'paired-108', 'run_id': 'r-paired', 'capability': 'local.files.write'}); " +
      "l.complete(b, {'task_id': 'paired-108', 'status': 'completed', 'capability': 'local.files.write'}); " +
      'print(json.dumps(True))', receiptsDb, path.join(userData, 'Runtime/settings.json')],
      { cwd: programRoot, windowsHide: true, encoding: 'utf8', timeout: 60000 })
    assert.equal(seed.status, 0, 'receipt seed failed: ' + seed.stderr)
    const receiptsSHA256 = sha(fs.readFileSync(receiptsDb))
    evidence.receiptSeedSHA256 = receiptsSHA256
    // Stage the release offline; the real file dialog returns the reviewed manifest.
    await app.evaluate(({ dialog }, manifestPath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [manifestPath] })
    }, releasePath)
    evidence.staged = await page.evaluate(() => window.ideer.importUpdate())
    assert.ok(evidence.staged.ok, 'signed release refused: ' + evidence.staged.error)
    pass('T108-04', 'signed patch staged', { kind: evidence.staged.pending.kind, fileCount: evidence.staged.pending.fileCount })
    // choose() already leaves the confirm dialog auto-approving; the single
    // install entry runs drain → stop → out-of-process handoff.
    await page.evaluate(() => { window.__ideerPairedInstall = window.ideer.installUpdate(); window.__ideerPairedInstall.catch(() => {}) })
    try { evidence.install = await page.evaluate(() => window.__ideerPairedInstall) } catch (error) { evidence.installTransport = String(error) }
    pass('T108-04', 'install entry accepted', { install: evidence.install || evidence.installTransport })
    let recovery = null
    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      try {
        recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'))
        if (recovery.state !== 'applied-pending-verify') break
      } catch {}
      await pause(200)
    }
    assert.ok(recovery, 'maintenance did not persist a terminal recovery state')
    evidence.recovery = recovery
    assert.equal(recovery.state, expected, 'unexpected recovery outcome: ' + recovery.detail)
    const stage = path.dirname(recovery.journalPath)
    const health = JSON.parse(fs.readFileSync(path.join(stage, 'health-response.json'), 'utf8'))
    evidence.health = health
    assert.equal(health.echo, 'ideer-update-health-v1', 'no real Runtime health echo')
    assert.equal(sha(fs.readFileSync(receiptsDb)), receiptsSHA256, 'receipt ledger changed during the update')
    if (expected === 'updated') {
      const payloadTray = path.join(path.dirname(releasePath), 'files', 'resources/runtime/core/tray.py')
      assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), sha(fs.readFileSync(payloadTray)), 'installed tray.py does not match the signed payload')
      assert.equal(sha(fs.readFileSync(path.join(programRoot, 'resources/app.asar'))), original.asarSHA256, 'patch touched the asar')
      pass('T108-04', 'installed combination health-verified', { echo: health.echo, desktopVersion: recovery.desktopVersion, runtimePython: recovery.runtimePython })
    } else {
      const brokenTray = path.join(path.dirname(releasePath), 'files', 'resources/runtime/core/desktop.py')
      assert.equal(sha(fs.readFileSync(coreFile('desktop.py'))), original.desktopSHA256, 'rollback did not restore exact prior bytes')
      assert.notEqual(sha(fs.readFileSync(coreFile('desktop.py'))), sha(fs.readFileSync(brokenTray)), 'rollback kept the broken bytes')
      assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), original.traySHA256, 'rollback disturbed an unrelated file')
      pass('T109-04', 'rollback restored the exact prior program', { detail: recovery.detail })
    }
    // The updated app verifies its own real window, IPC and Runtime usability
    // into health-usable.json (a failure would have written health-error.json
    // and forced a rollback instead). That product-level fact is the restart
    // verification; the detached instance is only cleaned up afterwards.
    const usable = JSON.parse(fs.readFileSync(path.join(stage, 'health-usable.json'), 'utf8'))
    evidence.usable = usable
    assert.equal(usable.nonce, health.nonce, 'usable record belongs to another maintenance run')
    assert.equal(usable.echo, 'ideer-update-health-v1', 'product usability record lacks the runtime echo')
    assert.ok(usable.windowLoaded && usable.rendererReady && usable.ipcReady && usable.runtimeUnfenced, 'product usability record incomplete')
    pass(expected === 'updated' ? 'T108-04' : 'T109-04', 'updated app verified real window, IPC and echo', {
      desktopVersion: usable.desktopVersion, windowLoaded: usable.windowLoaded, ipcReady: usable.ipcReady })
    // Cleanup only: the detached instance holds no verification role any more.
    const launched = JSON.parse(fs.readFileSync(path.join(stage, 'launched.json'), 'utf8'))
    evidence.launched = launched
    for (const pid of [launched.pid, launched.runtimePid].filter(Boolean)) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    await pause(1500)
    app = null
    evidence.scenarios['T108-04'].status = expected === 'updated' ? 'passed' : evidence.scenarios['T108-04'].status
    evidence.scenarios['T109-04'].status = expected === 'rolled-back' ? 'passed' : evidence.scenarios['T109-04'].status
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'
    evidence.error = String(error)
    evidence.errorStack = String(error.stack || error).replaceAll(/\r?\n/g, ' | ')
    try { if (page) { evidence.failureSnapshot = await snapshot(); evidence.failureUI = await page.locator('body').innerText() } } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (e) { evidence.shutdownError = String(e) } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (e) { evidence.cleanupError = String(e) }
    for (const name of ['hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
    flag('stop')
    evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
