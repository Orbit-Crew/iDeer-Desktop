// Compiled with the issue-102 preamble by acceptance.cjs. No product mocks.
assert(installed && path.isAbsolute(installed), 'DESKTOP_EXECUTABLE must be an isolated installed package')
const updateSource = process.env.IDEER_ACCEPTANCE_UPDATE_SOURCE
assert(['online', 'offline'].includes(updateSource), 'choose online or offline explicitly')
const releasePath = path.resolve(process.env.IDEER_ACCEPTANCE_UPDATE_RELEASE || '')
assert.equal(path.basename(releasePath), 'manifest.json')
const programRoot = path.dirname(installed)
const userData = path.join(appData, 'iDeer Desktop')
const recoveryFile = path.join(userData, 'updates-recovery.json')
const coreFile = name => path.join(programRoot, 'resources/runtime/core', name)
const originalHashes = {
  tray: sha(fs.readFileSync(coreFile('tray.py'))),
  asar: sha(fs.readFileSync(path.join(programRoot, 'resources/app.asar')))
}
const declaredRelease = JSON.parse(fs.readFileSync(releasePath, 'utf8'))
assert.equal(declaredRelease.kind, 'patch')
assert.notEqual(originalHashes.tray, declaredRelease.files.find(row => row.path === 'resources/runtime/core/tray.py').sha256,
  'the patch must actually change the base program')
evidence.updateSource = updateSource
evidence.releaseSHA256 = sha(fs.readFileSync(releasePath))
evidence.originalHashes = originalHashes
for (const name of ['acceptance.cjs', 'flow-acceptance.cjs']) evidence.candidate.acceptanceFiles.push({
  path: 'scripts/acceptance/issue-108/' + name, sha256: sha(fs.readFileSync(path.join(sourceRoot, 'scripts/acceptance/issue-108', name)))
})
let detached, recoveryStage
function receiptFor(operation) {
  return controls('history').rows.find(row => row.task_id === operation.approval.taskId)
}
function immutableReceipt(row) {
  const { delivery_state, acknowledgment, ...immutable } = row
  return immutable
}
async function selectUpdate() {
  if (updateSource === 'offline') await app.evaluate(({ dialog }, manifestPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [manifestPath] })
  }, releasePath)
  await page.getByRole('button', { name: updateSource === 'online' ? '检查更新（在线）' : '导入离线补丁清单', exact: true }).click()
  await wait(async () => (await page.getByRole('button', { name: '确认并排空安装', exact: true }).count()) === 1, 'verified pending update')
  evidence.staged = await page.evaluate(() => window.ideer.checkUpdates('staged'))
  assert.equal(evidence.staged.ok, true)
  assert.equal(evidence.staged.pending.source, updateSource)
  assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), originalHashes.tray, 'checking must not install')
  pass('T108-04', 'signed payload staged through actual update UI', { source: updateSource, pending: evidence.staged.pending })
}
async function beginInstall(confirm) {
  await app.evaluate(({ dialog }, confirmed) => {
    dialog.showMessageBox = async (_owner, options) => {
      globalThis.__issue108Confirmation = { title: options.title, buttons: options.buttons, confirmed }
      return { response: confirmed ? 1 : 0, checkboxChecked: false }
    }
  }, confirm)
  await page.getByRole('button', { name: '确认并排空安装', exact: true }).click()
}
async function main() {
  try {
    fixture('W/unconfirmed.txt'); fixture('W/inflight.txt'); fixture('W/during-drain.txt')
    await launch(); await choose()
    // Lose only Server acknowledgments. The actual broker accepts the real
    // file result, while Runtime must durably retain the original pending row.
    flag('drop-acks')
    const completed = await successful('T108-03', 'real-write-before-update', 'W/unconfirmed.txt', 'unconfirmed.txt', AFTER, true)
    const pendingBefore = receiptFor(completed)
    assert.equal(pendingBefore.delivery_state, 'pending')
    assert.equal(pendingBefore.status, 'completed')
    assert.equal(pendingBefore.user_id, manifest.identities.A.id)
    assert.equal(pendingBefore.device_id, manifest.identities.A.deviceId)
    assert.equal(pendingBefore.server_origin, manifest.origin)
    assert(wireEvents().some(row => row.event === 'ack-dropped' && row.taskId === pendingBefore.task_id))
    evidence.receiptBeforeUpdate = pendingBefore; save()
    await selectUpdate()

    // An admitted write awaiting its explicit local approval remains in flight.
    const inflight = await submit('T108-01', 'inflight-write', 'inflight.txt')
    await approval(inflight)
    await wait(async () => (await status()).runtime.activeTasks > 0, 'real in-flight task observed')
    await beginInstall(false)
    await wait(async () => (await page.locator('body').innerText()).includes('安装未执行（canceled）'), 'cancel outcome')
    assert.equal((await status()).runtime.installDrain, false)
    exact('W/inflight.txt', BEFORE)
    assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), originalHashes.tray)
    pass('T108-01', 'cancel during in-flight write keeps program and pending stage', { source: updateSource })

    await beginInstall(true)
    await wait(async () => (await status()).runtime.installDrain === true, 'confirmed drain began')
    const draining = (await status()).runtime
    assert(draining.activeTasks > 0)
    assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), originalHashes.tray)
    const refused = await submit('T108-01', 'new-write-during-drain', 'during-drain.txt')
    await finish(refused, /UPDATE_DRAINING/)
    exact('W/during-drain.txt', BEFORE)
    assert.equal(executionCount(refused), 0)
    assert(!controls('history').rows.some(row => row.run_id === refused.runId), 'refused task consumed receipt identity')
    pass('T108-01', 'new dispatch refused without execution while original write waits', {
      operationId: refused.id, executions: 0, file: observed('W/during-drain.txt'), draining
    })
    const current = await snapshot()
    const opened = await command({ action: 'open', scope: current.scope, threadId: inflight.threadId })
    assert.equal(opened.error, '')
    await approval(inflight)
    await page.screenshot({ path: path.join(state, 'draining-awaiting-original-write.png'), fullPage: true })
    // Diagnostic timing runs use a separately instrumented TEMP copy of the
    // installed Runtime. The hook pauses only observation, never execution or
    // the ledger, so the real write completes between its two status reads.
    if (process.env.IDEER_ACCEPTANCE_STATUS_BARRIER) {
      const barrier = path.resolve(process.env.IDEER_ACCEPTANCE_STATUS_BARRIER)
      assert.equal(barrier, path.join(state, 'timing-barrier'))
      fs.mkdirSync(barrier, { recursive: true })
      fs.writeFileSync(path.join(barrier, 'arm'), 'one real completion during status observation')
      await wait(() => fs.existsSync(path.join(barrier, 'reached')), 'controlled status interleaving', 15000)
      evidence.timingInjection = { kind: 'complete-during-status', testOnly: true, reachedAt: new Date().toISOString() }
      save()
    }
    await click(inflight, true)
    await wait(() => wireEvents().some(row => row.event === 'task-result-received' && row.taskId === inflight.approval.taskId && row.status === 'completed'), 'in-flight write completed normally')
    exact('W/inflight.txt', AFTER)
    assert.equal(executionCount(inflight), 1)
    pass('T108-01', 'original admitted write finishes before maintenance', { operationId: inflight.id, file: observed('W/inflight.txt'), executions: 1 })

    evidence.maintenanceObservations = []
    await wait(async () => {
      if (!fs.existsSync(recoveryFile)) {
        const ui = await page.locator('body').innerText()
        const runtime = (await status()).runtime
        const outcome = ui.split('\n').find(line => /安装未执行|更新检查失败|维护进程已启动/.test(line)) || ''
        const observation = { at: new Date().toISOString(), process: runtime.process, installDrain: runtime.installDrain,
          activeTasks: runtime.activeTasks, unknownWriteEffects: runtime.unknownWriteEffects,
          receiptStorageError: runtime.receiptStorageError, outcome }
        const previous = evidence.maintenanceObservations.at(-1)
        if (!previous || JSON.stringify({ ...previous, at: '' }) !== JSON.stringify({ ...observation, at: '' })) {
          evidence.maintenanceObservations.push(observation); save()
        }
        const refusal = ui.split('\n').find(line => /安装未执行（(?:blocked|failed)）|更新检查失败/.test(line))
        if (refusal) throw new Error('Actual install UI refused maintenance: ' + refusal)
        return false
      }
      evidence.recovery = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'))
      return ['updated', 'rolled-back', 'recovery-failed'].includes(evidence.recovery.state)
    }, 'real maintenance terminal outcome', 240000)
    assert.equal(evidence.recovery.state, 'updated', evidence.recovery.detail)
    app = null // Original app exited through the product's maintenance handoff.
    recoveryStage = path.dirname(evidence.recovery.journalPath)
    detached = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'launched.json'), 'utf8'))
    evidence.health = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'health-response.json'), 'utf8'))
    evidence.usable = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'health-usable.json'), 'utf8'))
    assert.equal(evidence.health.echo, 'ideer-update-health-v1')
    assert.equal(evidence.usable.nonce, evidence.health.nonce)
    assert(evidence.usable.windowLoaded && evidence.usable.rendererReady && evidence.usable.ipcReady && evidence.usable.runtimeUnfenced)
    assert.equal(sha(fs.readFileSync(coreFile('tray.py'))), declaredRelease.files.find(row => row.path === 'resources/runtime/core/tray.py').sha256)
    assert.equal(sha(fs.readFileSync(path.join(programRoot, 'resources/app.asar'))), originalHashes.asar)
    const pendingAfter = receiptFor(completed)
    assert.equal(pendingAfter.delivery_state, 'pending', 'installation must finish without Server acknowledgment')
    assert.deepEqual(immutableReceipt(pendingAfter), immutableReceipt(pendingBefore))
    exact('W/unconfirmed.txt', AFTER)
    pass('T108-03', 'real original pending receipt survives actual update without acknowledgment', { before: pendingBefore, after: pendingAfter })
    pass('T108-04', 'changed signed program restarted with actual Desktop and Runtime usability', {
      source: updateSource, health: evidence.health, usable: evidence.usable, traySHA256: sha(fs.readFileSync(coreFile('tray.py')))
    })

    // The updated Runtime reconnects to the original peer, replaying evidence
    // rather than dispatching the original file task again.
    flag('drop-acks', false)
    const reconnectId = await disconnect()
    await wait(() => receiptFor(completed)?.delivery_state === 'confirmed', 'updated Runtime replay acknowledged by Server')
    const confirmed = receiptFor(completed)
    assert(confirmed.acknowledgment)
    assert.deepEqual(immutableReceipt(confirmed), immutableReceipt(pendingBefore))
    assert(wireEvents().some(row => row.event === 'upload-received' && row.taskId === confirmed.task_id && row.receiptHash === confirmed.receipt_hash))
    assert(wireEvents().some(row => row.event === 'ack-sent' && row.taskId === confirmed.task_id))
    const serverTask = api('/api/devices/tasks/' + confirmed.task_id)
    assert.equal(serverTask.status, 200)
    assert.equal(serverTask.body.run_id, completed.runId)
    assert.equal(serverTask.body.receipt.task_id, confirmed.task_id)
    assert.equal(serverTask.body.receipt.request_hash, confirmed.request_hash)
    assert.equal(serverTask.body.receipt.status, 'completed')
    assert.equal(serverTask.body.result.sha256, sha(AFTER))
    assert.equal(executionCount(completed), 1)
    assert.equal(executionCount(inflight), 1)
    noRedispatch(completed); noRedispatch(inflight)
    exact('W/unconfirmed.txt', AFTER); exact('W/inflight.txt', AFTER)
    pass('T108-03', 'same receipt replay confirmed under original owner with no task redispatch', {
      reconnectId, receipt: confirmed, serverTask: serverTask.body, originalExecutions: executionCount(completed), originalDispatches: noRedispatch(completed)
    })
    for (const id of ['T108-01', 'T108-03', 'T108-04']) evidence.scenarios[id].status = 'passed'
    evidence.finalLocalAudit = controls('audit')
    assert(evidence.finalLocalAudit.integrity)
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.errorStack = String(error.stack)
    try { if (app && page) { evidence.failureSnapshot = await snapshot(); evidence.failureStatus = await status(); evidence.failureUI = await page.locator('body').innerText(); await page.screenshot({ path: path.join(state, 'failure.png'), fullPage: true }) } } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error) } }
    if (!detached && fs.existsSync(recoveryFile)) {
      try { const recovered = JSON.parse(fs.readFileSync(recoveryFile)); detached = JSON.parse(fs.readFileSync(path.join(path.dirname(recovered.journalPath), 'launched.json'))) } catch {}
    }
    // Cleanup only after all asserted tasks are terminal, scoped to the PIDs
    // returned by this isolated maintenance transaction, never by image name.
    if (detached) for (const pid of [detached.pid, detached.runtimePid].filter(Boolean)) {
      spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    }
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error) }
    for (const name of ['hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
    flag('stop')
    evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1 })
