assert(installed && path.isAbsolute(installed))
const program = path.dirname(installed), userData = path.join(appData, 'iDeer Desktop')
const recoveryFile = path.join(userData, 'updates-recovery.json')
const release = path.resolve(process.env.IDEER_ACCEPTANCE_UPDATE_RELEASE)
const immutable = row => { const { delivery_state, acknowledgment, ...fixed } = row; return fixed }
const receiptFor = item => controls('history').rows.find(row => row.task_id === item.approval.taskId)
const beforeProgram = Object.fromEntries(['resources/app.asar', 'resources/runtime/core/desktop.py', 'resources/runtime/core/tray.py'].map(p => [p, sha(fs.readFileSync(path.join(program, p)))]))
let recoveryStage, detached
async function stopDetached() {
  if (!detached) return
  const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
  if (alive(detached.pid)) spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${detached.pid} -ErrorAction SilentlyContinue;if($p){$p.CloseMainWindow() | Out-Null}`], { windowsHide: true, stdio: 'ignore' })
  await pause(500)
  // Only completed synthetic verification processes are cleaned up here. No
  // in-flight task participates in this fixture teardown.
  if (alive(detached.pid)) spawnSync('taskkill.exe', ['/PID', String(detached.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  if (detached.runtimePid && alive(detached.runtimePid)) spawnSync('taskkill.exe', ['/PID', String(detached.runtimePid), '/F'], { windowsHide: true, stdio: 'ignore' })
  await wait(() => !alive(detached.pid) && (!detached.runtimePid || !alive(detached.runtimePid)), 'owned recovered app exits', 30000)
  detached = null
}
function credentialFacts() {
  const settings = JSON.parse(fs.readFileSync(config))
  return Object.fromEntries(['server_url', 'user_id', 'device_id', 'business_token_ref', 'session_token_ref', 'device_key_ref'].map(key => [key, key.endsWith('_ref') ? sha(settings[key]) : settings[key]]))
}
async function main() {
  try {
    for (const name of ['pending.txt', 'grant.txt', 'revoked.txt', 'after.txt']) fixture('W/' + name)
    await launch(); await choose()
    const kb = api('/api/resources', { type: 'knowledge_base', slug: 't109-' + randomUUID(), display_name: 'T109 isolated knowledge base', storage_kind: 'database' }, true)
    assert.equal(kb.status, 201, JSON.stringify(kb))
    const kbID = kb.body.id
    assert(kbID)
    let knowledgeBefore
    await wait(() => {
      knowledgeBefore = api('/api/resources/' + kbID + '/knowledge')
      assert.equal(knowledgeBefore.status, 200)
      return ['ready', 'failed'].includes(knowledgeBefore.body.initialization_status)
    }, 'KB provider initialization settled before preservation snapshot')
    const otherBefore = profile('api', 'B', '/api/resources/' + kbID + '/knowledge')
    assert([403, 404].includes(otherBefore.status))
    const resourceBefore = api('/api/resources?type=knowledge_base')
    assert.equal(resourceBefore.status, 200)
    assert(resourceBefore.body.items.some(row => row.id === kbID))
    evidence.kb = { id: kbID, creation: kb.body, before: knowledgeBefore, ownerListBefore: resourceBefore, otherUserBefore: otherBefore,
      scope: 'Real canonical KB resource and provider-binding metadata; no external RAG content ingestion/retrieval claim.' }
    const grantWrite = await submit('T109-01', 'create-directory-grant', 'grant.txt')
    await approval(grantWrite)
    await page.getByRole('button', { name: '始终允许此目录的文本写入', exact: true }).click()
    await finish(grantWrite, /"written"\s*:\s*true/)
    exact('W/grant.txt', AFTER)
    const grants = (await status()).runtime.directoryGrants
    assert.equal(grants.length, 1)
    const revokedID = grants[0].id
    await page.evaluate(id => window.ideer.manage('revoke', id), revokedID)
    await wait(async () => {
      const observedGrants = (await status()).runtime.directoryGrants
      return Array.isArray(observedGrants) && !observedGrants.some(row => row.id === revokedID)
    }, 'actual authorization revoked')
    // Revocation replaces the real broker controller. Its new connection must
    // finish HELLO before creating another Run; an empty grant list can be
    // observed while that controller is still connecting.
    await wait(async () => (await status()).server === 'connected', 'broker reconnected after authorization revocation')
    const deniedBefore = await submit('T109-01', 'revocation-before-update', 'revoked.txt')
    await approval(deniedBefore); await click(deniedBefore, false); await finish(deniedBefore, /DENIED|denied/)
    exact('W/revoked.txt', BEFORE)
    evidence.revokedGrant = { id: revokedID, beforeUpdateAbsent: true }
    flag('drop-acks')
    const original = await successful('T109-01', 'pending-before-rollback', 'W/pending.txt', 'pending.txt', AFTER, true)
    const pendingBefore = receiptFor(original)
    assert.equal(pendingBefore.delivery_state, 'pending')
    evidence.pendingBefore = pendingBefore
    evidence.currentIdentityBefore = credentialFacts()
    evidence.programBefore = beforeProgram
    await app.evaluate(({ dialog }, manifestPath) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [manifestPath] }); dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false }) }, release)
    const staged = await page.evaluate(() => window.ideer.importUpdate())
    assert.equal(staged.ok, true, staged.error)
    evidence.staged = staged; save()
    await page.evaluate(() => { window.__t109Install = window.ideer.installUpdate(); window.__t109Install.catch(() => {}) })
    await wait(() => {
      if (!fs.existsSync(recoveryFile)) return false
      evidence.recovery = JSON.parse(fs.readFileSync(recoveryFile)); return evidence.recovery.state !== 'applied-pending-verify'
    }, 'real rollback terminal state', 240000)
    assert.equal(evidence.recovery.state, 'rolled-back', evidence.recovery.detail)
    app = null
    recoveryStage = path.dirname(evidence.recovery.journalPath)
    detached = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'launched.json')))
    evidence.health = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'health-response.json')))
    evidence.usable = JSON.parse(fs.readFileSync(path.join(recoveryStage, 'health-usable.json')))
    assert.equal(evidence.health.echo, 'ideer-update-health-v1')
    assert(evidence.usable.windowLoaded && evidence.usable.rendererReady && evidence.usable.ipcReady && evidence.usable.runtimeUnfenced)
    evidence.programAfter = Object.fromEntries(Object.keys(beforeProgram).map(p => [p, sha(fs.readFileSync(path.join(program, p)))]))
    assert.deepEqual(evidence.programAfter, beforeProgram)
    assert.deepEqual(credentialFacts(), evidence.currentIdentityBefore)
    const pendingAfter = receiptFor(original)
    assert.equal(pendingAfter.delivery_state, 'pending'); assert.deepEqual(immutable(pendingAfter), immutable(pendingBefore))
    evidence.pendingAfter = pendingAfter
    exact('W/pending.txt', AFTER); exact('W/revoked.txt', BEFORE)
    pass('T109-01', 'real pending receipt, current credential references and user effects preserved', { pendingReceiptID: pendingAfter.receipt_id, userID: pendingAfter.user_id, deviceID: pendingAfter.device_id })
    pass('T109-02', 'previous readable combination restored and actual health verified', { health: evidence.health, usable: evidence.usable, program: evidence.programAfter })
    await stopDetached()
    fs.copyFileSync(config, manifest.identities.A.profile)
    await launch()
    await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'same workspace restored after rollback')
    logical = (await status()).runtime.workspace.logicalRoot
    evidence.restartUI = await page.locator('body').innerText()
    assert(evidence.restartUI.includes('已恢复到更新前程序'))
    assert(!(await status()).runtime.directoryGrants.some(row => row.id === revokedID), 'revoked grant resurrected')
    const locked = await page.evaluate(() => window.ideer.installUpdate().then(v => v, e => String(e)))
    assert(String(locked).includes('UPDATE_RECOVERY_LOCKED'))
    evidence.installLock = locked
    pass('T109-03', 'actual post-recovery UI and repeat-install lock', { lock: locked, revokedGrantAbsent: true })
    flag('drop-acks', false)
    const reconnect = await disconnect()
    await wait(() => receiptFor(original)?.delivery_state === 'confirmed', 'original pending receipt replay confirmed')
    const confirmed = receiptFor(original)
    assert.deepEqual(immutable(confirmed), immutable(pendingBefore)); assert(confirmed.acknowledgment)
    assert.equal(executionCount(original), 1); noRedispatch(original)
    const write = await successful('T109-04', 'real-write-after-recovery', 'W/after.txt', 'after.txt', AFTER, true)
    const read = await submit('T109-04', 'real-read-after-recovery', 'after.txt', AFTER, { operation: 'read' })
    await finish(read, /AFTER/)
    assert.equal(read.tasks[0].body.result.sha256, sha(AFTER))
    assert.equal(read.tasks[0].body.receipt.status, 'completed')
    assert.equal(executionCount(read), 1)
    assert(!(await status()).runtime.directoryGrants.some(row => row.id === revokedID))
    evidence.kb.after = api('/api/resources/' + kbID + '/knowledge')
    evidence.kb.ownerListAfter = api('/api/resources?type=knowledge_base')
    evidence.kb.otherUserAfter = profile('api', 'B', '/api/resources/' + kbID + '/knowledge')
    assert.deepEqual(evidence.kb.after, knowledgeBefore)
    assert(evidence.kb.ownerListAfter.body.items.some(row => row.id === kbID))
    assert.equal(evidence.kb.otherUserAfter.status, otherBefore.status)
    evidence.confirmedOriginal = confirmed; evidence.currentIdentityAfter = credentialFacts()
    assert.deepEqual(evidence.currentIdentityAfter, evidence.currentIdentityBefore)
    pass('T109-04', 'recovered real write/read, original receipt replay, KB ownership and revoked authorization', { writeOperationID: write.id, readOperationID: read.id, reconnectID: reconnect, originalDispatches: noRedispatch(original), originalExecutions: executionCount(original), receipt: confirmed, kbID })
    await page.screenshot({ path: path.join(state, 'recovered-functional.png'), fullPage: true })
    evidence.finalAudit = controls('audit'); assert(evidence.finalAudit.integrity)
    for (const item of Object.values(evidence.scenarios)) item.status = 'passed'
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.errorStack = String(error.stack)
    try { if (app && page) { evidence.failureUI = await page.locator('body').innerText(); evidence.failureStatus = await status(); await page.screenshot({ path: path.join(state, 'failure.png'), fullPage: true }) } } catch {}
    throw error
  } finally {
    try { await stopDetached() } catch (e) { evidence.detachedCleanupError = String(e); evidence.status = 'failed' }
    if (app) { try { await quit() } catch (e) { evidence.shutdownError = String(e); evidence.status = 'failed' } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (e) { evidence.cleanupError = String(e); evidence.status = 'failed' }
    flag('drop-acks', false); flag('stop'); evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save(); main().catch(error => { console.error(error.stack); process.exitCode = 1 })
