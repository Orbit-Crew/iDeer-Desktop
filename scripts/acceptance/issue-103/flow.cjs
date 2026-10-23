async function chooseDirectory(directory) {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false })
  }, directory)
  const previous = (await status()).runtime.workspace?.logicalRoot
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready' &&
    (await status()).runtime.workspace.logicalRoot !== previous && (await status()).server === 'connected', 'selected directory')
  logical = (await status()).runtime.workspace.logicalRoot
}
function syncProfile() { fs.copyFileSync(config, manifest.identities.A.profile) }
async function autoWrite(name, suffix, content = AFTER) {
  const item = await submit('T103-01', name, suffix, content)
  item.expectNoApproval = true
  await finish(item, /"written"\s*:\s*true/)
  assert.equal(item.tasks[0].body.receipt.consent_decision, 'directory:' + evidence.grantId)
  assert.equal(item.tasks[0].body.result.sha256, sha(content))
  assert.equal(noRedispatch(item), 1)
  return item
}
async function permit(name) {
  const item = await submit('T103-01', name, 'target.txt')
  await approval(item)
  assert.equal(item.approval.directory, workspace)
  await page.getByRole('textbox', { name: '审批写入内容', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(state, name + '.png'), fullPage: true })
  await page.getByRole('button', { name: '始终允许此目录的文本写入', exact: true }).click()
  await finish(item, /"written"\s*:\s*true/)
  await wait(async () => (await status()).runtime.directoryGrants?.length === 1, 'persisted directory grant')
  const grant = (await status()).runtime.directoryGrants[0]
  evidence.grantId = grant.id
  assert.equal(item.tasks[0].body.receipt.consent_decision, 'directory:' + grant.id)
  assert.equal(grant.userId, manifest.identities.A.id)
  assert.equal(grant.deviceId, manifest.identities.A.deviceId)
  evidence.grant = grant; save()
  exact('W/target.txt', AFTER)
  return item
}
async function main() {
  try {
    for (const file of ['target.txt', 'once.txt', 'pending.txt', 'deny.txt']) fixture('W/' + file)
    fixture('W/sub/existing.txt'); fixture('W/.git/config'); fixture('outside/secret.txt')
    fs.symlinkSync(outside, path.join(workspace, 'junction'), 'junction')
    const W2 = path.join(work, 'W2'); fs.mkdirSync(W2); fixture('W2/pending.txt')
    await launch(); await choose()
    await permit('explicit-directory-approval')
    for (const [suffix, text] of [['target.txt', 'CHANGED'], ['sub/existing.txt', AFTER], ['sub/new.txt', 'NEW'], ['new.txt', NEWLINES]]) {
      const item = await autoWrite('automatic-' + suffix.replaceAll('/', '-'), suffix, text)
      pass('T103-01', item.name, { operationId: item.id, file: exact('W/' + suffix, text), grantId: evidence.grantId })
    }
    await page.getByRole('button', { name: '撤销此目录授权', exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(state, 'settings-grant.png'), fullPage: true })
    pass('T103-01', 'settings-visible', { grant: evidence.grant })

    for (const [suffix, expected, file] of [['../outside/secret.txt', /INVALID_PATH/, 'outside/secret.txt'],
      ['.git/config', /PROTECTED_PATH/, 'W/.git/config'], ['junction/secret.txt', /OUTSIDE_ALLOWED_ROOTS/, 'outside/secret.txt']]) {
      const item = await submit('T103-02', 'deny-' + suffix.replaceAll('/', '-'), suffix)
      item.expectNoApproval = true
      await finish(item, expected)
      pass('T103-02', item.name, { operationId: item.id, file: exact(file, BEFORE) })
    }
    controls('policy', 'deny')
    let item = await submit('T103-02', 'local-deny-with-grant', 'deny.txt')
    item.expectNoApproval = true
    await finish(item, /LOCAL_POLICY_DENIED/)
    pass('T103-02', item.name, { operationId: item.id, file: exact('W/deny.txt', BEFORE) })
    controls('policy', 'ask_first')
    stage('before-revoke', { runtime: await status() })
    await page.getByRole('button', { name: '撤销此目录授权', exact: true }).click()
    await pause(1000)
    stage('after-revoke-click', { runtime: await status(), ui: await page.locator('body').innerText() })
    await wait(async () => !(await status()).runtime.directoryGrants?.length && (await status()).server === 'connected', 'revoked grant')
    item = await submit('T103-04', 'one-time-after-revoke', 'once.txt')
    await approval(item); await click(item, true); await finish(item, /"written"\s*:\s*true/)
    assert.equal(item.tasks[0].body.receipt.consent_decision, 'approved')
    assert.equal((await status()).runtime.directoryGrants.length, 0)
    pass('T103-04', item.name, { operationId: item.id, file: exact('W/once.txt', AFTER), basis: 'approved' })

    item = await submit('T103-04', 'pending-directory-switch', 'pending.txt')
    await approval(item); await chooseDirectory(W2)
    await finish(item, /CANCELLED|cancelled|DEVICE_OFFLINE|DENIED|failed|RESULT_UNCERTAIN/i)
    assert.equal(executionCount(item), 0)
    pass('T103-04', item.name, { operationId: item.id, file: exact('W/pending.txt', BEFORE) })
    await chooseDirectory(workspace); await permit('renewed-directory-approval')
    await chooseDirectory(W2)
    item = await submit('T103-03', 'pending-logout', 'pending.txt')
    await approval(item)
    await page.getByRole('button', { name: '退出账号', exact: true }).click()
    await wait(async () => (await status()).runtime.login?.state === 'unauthenticated', 'logged out')
    exact('W2/pending.txt', BEFORE)
    const retained = lifecycle('observe')
    assert(retained.signedOut); assert(retained.grants.some(row => row.id === evidence.grantId))
    await quit(); await launch(false)
    assert.equal((await status()).server, 'offline')
    assert.deepEqual((await status()).runtime.directoryGrants, [])
    await page.screenshot({ path: path.join(state, 'logout-reopened.png'), fullPage: true })
    await quit()
    let login = lifecycle('login'); assert(login.authenticated && login.bindingUnchanged && login.sessionChanged)
    syncProfile(); evidence.relogin = login
    await launch(); await chooseDirectory(workspace)
    item = await autoWrite('restored-after-relogin', 'restored.txt')
    pass('T103-03', item.name, { login, file: exact('W/restored.txt', AFTER), grantId: evidence.grantId })
    await quit()
    login = lifecycle('login'); assert(login.authenticated && login.bindingUnchanged && login.sessionChanged)
    syncProfile(); evidence.rotation = login
    await launch(); logical = (await status()).runtime.workspace.logicalRoot
    item = await autoWrite('preserved-after-rotation', 'rotated.txt')
    pass('T103-03', item.name, { login, file: exact('W/rotated.txt', AFTER), grantId: evidence.grantId })
    await chooseDirectory(W2)
    item = await submit('T103-03', 'pending-device-revoked', 'pending.txt')
    await approval(item)
    const revoked = api('/api/devices/' + manifest.identities.A.deviceId + '/revoke', undefined, true)
    assert.equal(revoked.status, 200)
    await wait(async () => (await status()).server !== 'connected', 'revoked device disconnected')
    exact('W2/pending.txt', BEFORE)
    await quit(); await launch(false)
    assert.notEqual((await status()).runtime.login?.state, 'authenticated')
    assert.deepEqual((await status()).runtime.directoryGrants, [])
    pass('T103-03', 'device-revoked', { deviceId: manifest.identities.A.deviceId, revoked: revoked.body.status, file: exact('W2/pending.txt', BEFORE) })
    await page.getByRole('button', { name: '切换账号或重新绑定设备', exact: true }).click()
    await wait(async () => (await status()).runtime.login?.state === 'unauthenticated', 'identity detached')
    await quit()
    evidence.activeIdentity = 'B'
    login = lifecycle('login'); assert(login.authenticated && !login.bindingUnchanged)
    assert.equal(login.userId, manifest.identities.B.id)
    assert.notEqual(login.deviceId, manifest.identities.A.deviceId)
    syncProfile(); await launch(); await chooseDirectory(workspace)
    assert.deepEqual((await status()).runtime.directoryGrants, [])
    item = await submit('T103-03', 'account-B-no-inheritance', 'pending.txt')
    await approval(item); await click(item, false); await finish(item, /DENIED|denied/)
    pass('T103-03', item.name, { login, file: exact('W/pending.txt', BEFORE), grants: [] })
    await page.screenshot({ path: path.join(state, 'account-B-isolated.png'), fullPage: true })
    for (const scenario of Object.values(evidence.scenarios)) scenario.status = 'passed'
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.stack = String(error.stack)
    try { evidence.failureSnapshot = await snapshot() } catch (error) { evidence.failureSnapshotError = String(error) }
    try { evidence.runtime = await status(); evidence.failureUI = await page.locator('body').innerText() } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error) } }
    try { evidence.credentialCleanup = lifecycle('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
    flag('stop')
    // Delete only this run's resolved temporary fixture, after the app closes.
    if (fs.existsSync(path.join(workspace, 'junction'))) fs.unlinkSync(path.join(workspace, 'junction'))
    assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(work, { recursive: true, force: true })
    evidence.finishedAt = new Date().toISOString(); save()
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
