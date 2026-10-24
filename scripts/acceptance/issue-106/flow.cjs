// Issue 106 switch-over matrix on the Desktop-owned independent Runtime package.
async function reopen(item) {
  await wait(async () => (await status()).server === 'connected', 'device reconnected')
  const current = await command({ action: 'refresh' })
  assert.equal(current.error, '')
  const opened = await command({ action: 'open', scope: current.scope, threadId: item.threadId })
  assert.equal(opened.error, '')
  assert.equal(opened.run.id, item.runId)
  return opened
}
async function taskView(item, expected) {
  let view, task
  await wait(async () => {
    view = await snapshot()
    assert.equal(view.thread.id, item.threadId)
    task = view.localTasks?.find(row => row.task_id === item.approval.taskId)
    if (!task || (expected && !expected(task))) return false
    return !!task.localResult
  }, item.name + ' original Thread task view')
  return task
}
async function taskCard(operation) {
  let view, task
  await wait(async () => {
    view = await snapshot()
    task = view.localTasks?.find(row => row.task_id === operation.approval.taskId)
    return !!task && !!task.localResult
  }, operation.name + ' local result view')
  return task
}

async function uploadClick(operation) {
  const marker = page.getByText(`Run：${operation.runId} · 任务：${operation.approval.taskId}`, { exact: true })
  assert.equal(await marker.count(), 1, 'unique task card for upload')
  const button = marker.locator('..').getByRole('button', { name: '明确授权上传为 Thread 附件', exact: true })
  assert.equal(await button.count(), 1, 'explicit upload control rendered')
  await button.click()
}

async function main() {
  try {
    for (const name of ['new.txt', 'target.txt', 'reject.txt', 'hash.txt', 'health.txt']) fixture('W/' + name)
    fixture('outside/secret.txt'); fixture('W/.git/config')
    fs.symlinkSync(outside, path.join(workspace, 'junction'), 'junction')
    await launch(); await choose()

    // T106-01: pairing, signed workspace write, durable receipt, and the
    // device-local result fact — registered, displayed, never auto-uploaded.
    let operation = await successful('T106-01', 'create', 'W/new.txt', 'new.txt', AFTER, true)
    const uploadTarget = await successful('T106-01', 'overwrite', 'W/target.txt', 'target.txt', AFTER, true)
    await wait(() => controls('history').rows.some(row => row.task_id === uploadTarget.approval.taskId && row.delivery_state === 'confirmed'),
      'durable confirmed receipt for the completed write')
    const task = await taskCard(uploadTarget)
    assert.equal(task.localResult.name, 'target.txt')
    assert.equal(task.localResult.sha256, operation.requested.sha256)
    assert.equal(task.localResult.bytes, operation.requested.bytes)
    assert.equal(task.localResult.task_id, uploadTarget.approval.taskId)
    assert.equal(task.localResult.run_id, uploadTarget.runId)
    assert.equal(task.localResult.thread_id, uploadTarget.threadId)
    assert.equal(task.localResult.capability, 'local.files.write')
    assert.equal(task.localResult.logical_path, uploadTarget.path)
    assert.equal(task.localResult.artifact_ref, '', 'viewing never uploads')
    assert(!task.artifacts?.length, 'no fabricated platform attachment for a local result')
    const rendered = await page.locator('body').innerText()
    assert(rendered.includes('本地生成结果（仅原设备可用）'), 'device-local marker rendered')
    assert(rendered.includes(operation.requested.sha256), 'content hash rendered instead of a physical path')
    assert(!rendered.includes(workspace), 'absolute workspace path must never render')
    assert(!rendered.includes('· 附件 '), 'no platform attachment fabricated by display')
    pass('T106-01', 'pairing-write-receipt-local-result', {
      operationId: uploadTarget.id, file: exact('W/target.txt', AFTER), localResult: task.localResult,
      receiptDeliveryState: 'confirmed'
    })
    evidence.scenarios['T106-01'].status = 'passed'; save()

    // T106-02: the only upload path is the explicit user control; the Server
    // artifact endpoint is delivered by the Server workflow, so the honest
    // behavior today is a fixed failure that never fakes success.
    await uploadClick(uploadTarget)
    let rejected
    await wait(async () => {
      rejected = await snapshot()
      return rejected.error !== ''
    }, 'explicit upload rejection surfaced')
    assert(['CHAT_NOT_FOUND', 'CHAT_SERVER_ERROR', 'CHAT_FORBIDDEN', 'CHAT_SERVER_UNAVAILABLE'].includes(rejected.error),
      'fixed upload rejection category, got ' + rejected.error)
    const afterUpload = (await snapshot()).localTasks.find(row => row.task_id === uploadTarget.approval.taskId)
    assert.equal(afterUpload.localResult.artifact_ref, '', 'a failed upload never marks the local fact')
    const bodyAfterUpload = await page.locator('body').innerText()
    assert(!bodyAfterUpload.includes('· 附件 '), 'no platform attachment appears after a failed upload')
    pass('T106-02', 'explicit-upload-fails-honestly-without-server-endpoint', {
      operationId: uploadTarget.id, error: rejected.error, localResultArtifactRef: ''
    })
    evidence.scenarios['T106-02'].status = 'passed'; save()

    // T106-03: the safety contract survives the package switch unchanged.
    operation = await submit('T106-03', 'reject', 'reject.txt')
    await approval(operation); await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T106-03', 'reject', { operationId: operation.id, after: exact('W/reject.txt', BEFORE) })

    operation = await submit('T106-03', 'changed-request-hash', 'hash.txt')
    const pending = await approval(operation)
    const current = await snapshot()
    const wrongHash = pending.requestHash[0] === '0' ? '1' + pending.requestHash.slice(1) : '0' + pending.requestHash.slice(1)
    const refused = await command({ action: 'consent', scope: current.scope, threadId: pending.threadId, runId: pending.runId,
      taskId: pending.taskId, requestHash: wrongHash, decision: 'allow' })
    assert.equal(refused.error, 'CONSENT_MISMATCH')
    assert.equal(executionCount(operation), 0)
    exact('W/hash.txt', BEFORE)
    await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T106-03', 'changed-request-hash', { operationId: operation.id, error: refused.error, after: exact('W/hash.txt', BEFORE) })

    for (const [name, suffix, filename, expected] of [
      ['outside-path', '../outside/secret.txt', 'outside/secret.txt', /INVALID_PATH/],
      ['protected-path', '.git/config', 'W/.git/config', /PROTECTED_PATH/],
      ['link-escape', 'junction/secret.txt', 'outside/secret.txt', /OUTSIDE_ALLOWED_ROOTS/]
    ]) {
      operation = await submit('T106-03', name, suffix)
      operation.expectNoApproval = true; save()
      await finish(operation, expected)
      assert.equal(executionCount(operation), 0)
      await wait(async () => await page.getByRole('textbox', { name: '审批写入内容', exact: true }).count() === 0, 'rejected unsafe path has no approval card')
      pass('T106-03', name, { operationId: operation.id, after: exact(filename, BEFORE), executionCount: 0, noApprovalCard: true })
    }
    evidence.scenarios['T106-03'].status = 'passed'; save()

    // T106-04: reconnect and receipt history survive a Runtime restart on the
    // independent package; a read task proves the signed echo-style contract.
    await restartRuntime()
    await reopen(uploadTarget)
    await taskView(uploadTarget, row => row.status === 'completed' && row.localResult?.artifact_ref === '')
    const readOp = await submit('T106-04', 'health-read', 'health.txt', BEFORE, { operation: 'read' })
    await finish(readOp, /BEFORE/)
    assert.equal(readOp.tasks.length, 1); assert.equal(readOp.tasks[0].status, 200)
    assert.equal(readOp.tasks[0].body.receipt.status, 'completed')
    assert.equal(readOp.tasks[0].body.result.content, BEFORE)
    // The panel's own history polling owns the single receipt slot at times.
    let history
    for (let attempt = 0; ; attempt++) {
      try { history = await page.evaluate(() => window.ideer.receipts('history')); break }
      catch (error) {
        if (attempt >= 20 || !String(error).includes('RECEIPT_BUSY')) throw error
        await pause(400)
      }
    }
    assert.equal(history.storageError, '')
    assert(history.total > 0 && history.rows.length > 0, 'durable receipt history readable after restart')
    await wait(async () => (await status()).runtime.receiptStorageError === '', 'no storage latch after restart')
    pass('T106-04', 'restart-reconnect-receipt-history', {
      operationId: readOp.id, readSHA256: sha(BEFORE), receiptTotal: history.total,
      recoveredLocalResultRef: ''
    })
    evidence.scenarios['T106-04'].status = 'passed'; save()

    await page.screenshot({ path: path.join(state, 'issue-106-matrix.png'), fullPage: true })
    evidence.finalLocalHistory = controls('history'); evidence.finalLocalAudit = controls('audit')
    assert(evidence.finalLocalAudit.integrity)
    await quit(); profile('evidence', 'A')
    evidence.status = 'passed'
  } catch (error) {
    try { if (page) { evidence.failureSnapshot = await snapshot(); evidence.failureUI = await page.locator('body').innerText() } } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error); evidence.status = 'failed' } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
    for (const name of ['hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
    flag('stop')
    assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(work, { recursive: true, force: true })
    evidence.fixtureCleanup = { removed: true, appClosed: app === null }
    evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
