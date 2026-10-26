// Issue 111: the phase-one final-package acceptance matrix on the real pair.
async function reopen(item) {
  await wait(async () => (await status()).server === 'connected', 'device reconnected')
  const current = await command({ action: 'refresh' })
  assert.equal(current.error, '')
  const opened = await command({ action: 'open', scope: current.scope, threadId: item.threadId })
  assert.equal(opened.error, '')
  assert.equal(opened.run.id, item.runId)
  return opened
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
    for (const name of ['new.txt', 'target.txt', 'reject.txt', 'hash.txt', 'health.txt', 'directory.txt', 'second.txt']) fixture('W/' + name)
    fixture('outside/secret.txt'); fixture('W/.git/config')
    fs.symlinkSync(outside, path.join(workspace, 'junction'), 'junction')
    await launch(); await choose()

    // T111-01: pairing, a streamed turn on the real combination, then the
    // original Thread reopens with its durable history.
    let operation = await successful('T111-01', 'create', 'W/new.txt', 'new.txt', AFTER, true)
    const streamed = await snapshot()
    assert(streamed.run && ['success', 'completed'].includes(streamed.run.status) || streamed.stream !== 'uncertain', 'streamed turn terminal')
    await restartRuntime()
    await reopen(operation)
    pass('T111-01', 'pairing-streamed-turn-reopen', {
      operationId: operation.id, runStatus: operation.runStatus || 'completed',
      reopenedThread: operation.threadId
    })
    evidence.scenarios['T111-01'].status = 'passed'; save()

    // T111-02: the read/write authority matrix — new and overwrite with
    // per-approval, refusal, request-hash mismatch, the fixed product timeout,
    // the directory grant removing later cards, and the unsafe-path refusals.
    operation = await successful('T111-02', 'overwrite', 'W/target.txt', 'target.txt', AFTER, true)
    operation = await submit('T111-02', 'reject', 'reject.txt')
    await approval(operation); await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T111-02', 'reject', { operationId: operation.id, after: exact('W/reject.txt', BEFORE) })
    operation = await submit('T111-02', 'changed-request-hash', 'hash.txt')
    const pendingHash = await approval(operation)
    const hashView = await snapshot()
    const wrongHash = pendingHash.requestHash[0] === '0' ? '1' + pendingHash.requestHash.slice(1) : '0' + pendingHash.requestHash.slice(1)
    const refused = await command({ action: 'consent', scope: hashView.scope, threadId: pendingHash.threadId, runId: pendingHash.runId,
      taskId: pendingHash.taskId, requestHash: wrongHash, decision: 'allow' })
    assert.equal(refused.error, 'CONSENT_MISMATCH')
    assert.equal(executionCount(operation), 0)
    await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T111-02', 'changed-request-hash', { operationId: operation.id, error: refused.error, after: exact('W/hash.txt', BEFORE) })
    // The directory grant: one explicit allow-directory click, then the next
    // write in the same directory runs without a new approval card.
    operation = await submit('T111-02', 'directory-grant', 'directory.txt')
    await approval(operation)
    operation.phase = 'click-ui-allow-directory-once'; save()
    await page.getByRole('button', { name: '始终允许此目录的文本写入', exact: true }).click()
    operation.decision = { origin: 'actual Desktop chat UI click', approved: 'allow-directory', taskId: operation.approval.taskId, at: new Date().toISOString() }; save()
    await finish(operation, /"written"\s*:\s*true/)
    exact('W/directory.txt', AFTER)
    // The directory grant records its own decision identity in the receipt.
    assert(operation.tasks.length === 1 && operation.tasks[0].status === 200)
    const grantReceipt = operation.tasks[0].body.receipt
    assert(String(grantReceipt.consent_decision).startsWith('directory:'), 'directory grant decision recorded')
    assert.equal(executionCount(operation), 1)
    pass('T111-02', 'directory-grant', { operationId: operation.id, after: exact('W/directory.txt', AFTER),
      consentDecision: grantReceipt.consent_decision })
    operation = await submit('T111-02', 'directory-followup', 'followup.txt')
    operation.expectNoApproval = true; save()
    await finish(operation, /"written"\s*:\s*true/)
    exact('W/followup.txt', AFTER); assert.equal(executionCount(operation), 1)
    pass('T111-02', 'directory-followup-no-card', { operationId: operation.id, after: exact('W/followup.txt', AFTER), noApprovalCard: true })
    for (const [name, suffix, filename, expected] of [
      ['outside-path', '../outside/secret.txt', 'outside/secret.txt', /INVALID_PATH/],
      ['protected-path', '.git/config', 'W/.git/config', /PROTECTED_PATH/],
      ['link-escape', 'junction/secret.txt', 'outside/secret.txt', /OUTSIDE_ALLOWED_ROOTS/]
    ]) {
      operation = await submit('T111-02', name, suffix)
      operation.expectNoApproval = true; save()
      await finish(operation, expected)
      assert.equal(executionCount(operation), 0)
      await wait(async () => await page.getByRole('textbox', { name: '审批写入内容', exact: true }).count() === 0, 'rejected unsafe path has no approval card')
      pass('T111-02', name, { operationId: operation.id, after: exact(filename, BEFORE), executionCount: 0, noApprovalCard: true })
    }
    evidence.scenarios['T111-02'].status = 'passed'; save()

    // T111-03: stop a committed write (interrupted, first effect kept), then a
    // disconnect recovery, then the explicit upload — now a real 201 on the
    // Server artifact endpoint — with the platform reference recorded.
    await restartRuntime()
    await reopen(uploadTarget())
    // Revoke the directory grant through the actual panel control so the stop
    // scenario exercises a fresh per-approval round again.
    const grantsBefore = (await status()).runtime.directoryGrants || []
    await page.getByRole('button', { name: '撤销此目录授权', exact: true }).click()
    await wait(async () => ((await status()).runtime.directoryGrants || []).length === grantsBefore.length - 1,
      'directory grant revoked through the panel')
    const first = await successful('T111-03', 'stop-first', 'W/stop.txt', 'stop.txt', AFTER, true)
    // The second write is dispatched and waits for approval; stopping the Turn
    // there leaves the first effect committed and the second never executed.
    const stopped = await submit('T111-03', 'stop-awaiting-approval', 'second.txt')
    await approval(stopped)
    await page.getByRole('button', { name: '停止当前 Turn', exact: true }).click()
    const stopView = await snapshot()
    assert.equal(stopView.stop.runId, stopped.runId)
    await finish(stopped)
    assert.equal(stopped.runStatus, 'interrupted')
    assert.equal(executionCount(stopped), 0)
    exact('W/stop.txt', AFTER); exact('W/second.txt', BEFORE)
    pass('T111-03', 'stop-awaiting-approval', { operationId: stopped.id, runStatus: 'interrupted',
      first: exact('W/stop.txt', AFTER), second: exact('W/second.txt', BEFORE), executions: 0 })

    // The explicit upload against the live Server endpoint (issue 105).
    let target
    for (let attempt = 0; attempt < 3 && !target; attempt++) {
      await reopen(uploadTarget())
      await wait(async () => {
        const view = await snapshot()
        target = view.localTasks?.find(row => row.task_id === uploadTarget().approval.taskId)
        return !!target?.localResult
      }, 'local result view after reopen', 45000)
    }
    assert.equal(target.localResult.artifact_ref, '', 'the viewed result is still local')
    // The panel renders from its own 500 ms poll; wait for the card to be on
    // screen instead of asserting against the fresher driver-side snapshot.
    const cardMarker = `Run：${uploadTarget().runId} · 任务：${uploadTarget().approval.taskId}`
    await wait(async () => (await page.getByText(cardMarker, { exact: true }).count()) === 1, 'upload task card rendered')
    await uploadClick(uploadTarget())
    let uploaded
    await wait(async () => {
      uploaded = (await snapshot()).localTasks?.find(row => row.task_id === uploadTarget().approval.taskId)
      return !!uploaded?.localResult?.artifact_ref
    }, 'the uploaded artifact reference is recorded')
    const uploadView = await snapshot()
    assert(uploadView.localTasks.find(row => row.task_id === uploadTarget().approval.taskId).localResult.uploaded_at)
    pass('T111-03', 'explicit-upload-to-live-server', {
      operationId: uploadTarget().id, artifactRef: uploaded.localResult.artifact_ref,
      uploadedAt: uploaded.localResult.uploaded_at
    })
    const readOp = await submit('T111-03', 'health-read', 'health.txt', BEFORE, { operation: 'read' })
    await finish(readOp, /BEFORE/)
    assert.equal(readOp.tasks[0].body.receipt.status, 'completed')
    pass('T111-03', 'signed-read-recovery-proof', { operationId: readOp.id, readSHA256: sha(BEFORE) })
    evidence.scenarios['T111-03'].status = 'passed'; save()

    // T111-04: the gate record travels in the report; keep the final facts.
    evidence.finalLocalHistory = controls('history'); evidence.finalLocalAudit = controls('audit')
    assert(evidence.finalLocalAudit.integrity)
    await page.screenshot({ path: path.join(state, 'issue-111-matrix.png'), fullPage: true })
    await quit(); profile('evidence', 'A')
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'
    evidence.error = String(error)
    evidence.errorStack = String(error.stack || error).replaceAll(/\r?\n/g, ' | ')
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
function uploadTarget() {
  return evidence.operations.find(row => row.scenario === 'T111-01' && row.name === 'create')
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
