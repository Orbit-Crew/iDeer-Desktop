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
    return task && (!expected || expected(task))
  }, item.name + ' original Thread task view')
  assert.equal(task.run_id, item.runId)
  assert.equal(task.logical_target, item.path)
  item.recoveredTask = task
  item.finalRun = view.run
  save()
  return task
}
async function uiStop(item) {
  await page.getByRole('button', { name: '停止当前 Turn', exact: true }).click()
  const stopped = await snapshot()
  assert.equal(stopped.stop.runId, item.runId)
  assert.equal(stopped.stop.state, 'requested')
  item.stopRequest = stopped.stop
  await wait(async () => (await page.locator('body').innerText()).includes('已请求停止'), 'requested stop rendered')
  await page.screenshot({ path: path.join(state, item.name + '-stop.png'), fullPage: true })
  await finish(item)
  assert.equal(item.runStatus, 'interrupted')
}
async function duplicate(item) {
  const request = { id: randomUUID(), taskId: item.approval.taskId }
  fs.writeFileSync(path.join(state, 'duplicate-request.json'), JSON.stringify(request))
  await wait(() => {
    const file = path.join(state, 'duplicate-applied.json')
    return fs.existsSync(file) && JSON.parse(fs.readFileSync(file)).id === request.id
  }, 'duplicate signed task delivered')
}
async function reupload(item) {
  for (const name of ['hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
  await restartRuntime()
  await reopen(item)
  await taskView(item, task => task.status === 'completed' && task.local?.delivery_state === 'confirmed')
  assert.equal(executionCount(item), 1)
  noRedispatch(item)
}
async function crashRuntime() {
  const before = await status()
  assert.equal(before.runtime.process, 'running')
  const pid = before.runtime.pid
  assert(Number.isInteger(pid) && pid > 0)
  process.kill(pid)
  await wait(async () => (await status()).runtime.process === 'crashed', 'isolated Runtime crash observed')
  await page.evaluate(() => window.ideer.startRuntime())
  await wait(async () => (await status()).server === 'connected', 'Runtime restarted')
  return { previousPid: pid, nextPid: (await status()).runtime.pid }
}
async function restartServer() {
  const previous = JSON.parse(fs.readFileSync(path.join(state, 'server-generation.json')))
  flag('restart-server')
  await wait(() => {
    const generation = JSON.parse(fs.readFileSync(path.join(state, 'server-generation.json')))
    return generation.pid !== previous.pid
  }, 'real Server process restarted')
  await wait(async () => (await status()).server === 'connected', 'device reconnect after Server restart')
  return { previous, current: JSON.parse(fs.readFileSync(path.join(state, 'server-generation.json'))) }
}
async function main() {
  try {
    for (const name of ['stop-pending', 'first', 'second', 'disconnect-before', 'disconnect-after', 'late-stop', 'runtime-restart', 'desktop-restart', 'server-restart', 'duplicate']) fixture('W/' + name + '.txt')
    await launch(); await choose()

    let item = await submit('T104-01', 'stop-pending', 'stop-pending.txt')
    await approval(item); await uiStop(item)
    exact('W/stop-pending.txt', BEFORE)
    const pending = await taskView(item, row => row.local?.status === 'cancelled')
    assert.equal(executionCount(item), 0); noRedispatch(item)
    pass('T104-01', item.name, { operationId: item.id, task: pending, file: exact('W/stop-pending.txt', BEFORE), executions: 0 })

    item = await submit('T104-01', 'stop-after-first-write', 'first.txt', AFTER, {
      next: { operation: 'write', arguments: { path: logical + '/second.txt', content: 'SECOND' } }
    })
    await approval(item); await click(item, true)
    await wait(async () => (await snapshot()).localConsents?.some(row => row.runId === item.runId && row.taskId !== item.approval.taskId), 'second operation awaiting approval')
    exact('W/first.txt', AFTER); exact('W/second.txt', BEFORE)
    await uiStop(item)
    exact('W/first.txt', AFTER); exact('W/second.txt', BEFORE)
    await taskView(item, row => row.status === 'completed')
    assert.equal(executionCount(item), 1)
    pass('T104-01', item.name, { operationId: item.id, first: exact('W/first.txt', AFTER), second: exact('W/second.txt', BEFORE), executions: 1 })

    item = await submit('T104-02', 'disconnect-before', 'disconnect-before.txt')
    await approval(item); await disconnect()
    await finish(item)
    await reopen(item)
    await taskView(item, row => ['cancelled', 'unknown'].includes(row.local?.status))
    assert.equal(executionCount(item), 0); noRedispatch(item)
    pass('T104-02', item.name, { operationId: item.id, file: exact('W/disconnect-before.txt', BEFORE), executions: 0 })

    for (const [name, stop] of [['disconnect-after', false], ['late-stop', true]]) {
      flag('hold-results'); flag('hold-uploads'); flag('drop-acks')
      if (!stop) flag('disconnect-after-result')
      item = await submit(stop ? 'T104-03' : 'T104-02', name, name + '.txt')
      await approval(item); await click(item, true)
      await wait(() => wireEvents().some(row => row.event === 'task-result-dropped' && row.taskId === item.approval.taskId), 'effect committed before lost result')
      exact('W/' + name + '.txt', AFTER)
      if (stop) await uiStop(item)
      else await finish(item)
      await reopen(item)
      const unknown = await taskView(item, row => row.status === 'result_not_verified' && row.local?.status === 'completed')
      assert.equal(unknown.local.delivery_state, 'pending')
      const terminalBefore = (await snapshot()).run.status
      await page.screenshot({ path: path.join(state, name + '-pending-upload.png'), fullPage: true })
      await reupload(item)
      const terminalAfter = (await snapshot()).run.status
      assert.equal(terminalAfter, terminalBefore, 'late evidence cannot restart or re-finalize Run')
      pass(stop ? 'T104-03' : 'T104-02', item.name, { operationId: item.id, file: exact('W/' + name + '.txt', AFTER), unknown, terminalBefore, terminalAfter, executions: 1 })
    }

    flag('drop-acks')
    item = await submit('T104-03', 'duplicate', 'duplicate.txt')
    await approval(item); await click(item, true); await finish(item)
    await duplicate(item)
    await wait(() => wireEvents().filter(row => row.event === 'upload-received' && row.taskId === item.approval.taskId).length >= 2, 'duplicate original receipt observed')
    await taskView(item, row => row.status === 'completed' && row.local?.delivery_state === 'pending')
    assert.equal(executionCount(item), 1); noRedispatch(item)
    const duplicateRunStatus = (await snapshot()).run.status
    await reupload(item)
    assert.equal((await snapshot()).run.status, duplicateRunStatus)
    pass('T104-03', item.name, { operationId: item.id, file: exact('W/duplicate.txt', AFTER), executions: 1,
      uploadCount: wireEvents().filter(row => row.event === 'upload-received' && row.taskId === item.approval.taskId).length })

    for (const component of ['runtime', 'desktop', 'server']) {
      const name = component + '-restart'
      item = await submit('T104-04', name, name + '.txt')
      await approval(item)
      let restart
      if (component === 'runtime') restart = await crashRuntime()
      else if (component === 'desktop') { await quit(); await launch(); restart = { appReopened: true } }
      else restart = await restartServer()
      await reopen(item); await finish(item)
      const restored = await taskView(item, row => ['result_not_verified', 'cancelled', 'failed'].includes(row.status))
      assert.equal(executionCount(item), 0); noRedispatch(item)
      exact('W/' + name + '.txt', BEFORE)
      await page.screenshot({ path: path.join(state, name + '-restored.png'), fullPage: true })
      pass('T104-04', name, { operationId: item.id, restart, restored, file: exact('W/' + name + '.txt', BEFORE), executions: 0 })
    }
    for (const scenario of Object.values(evidence.scenarios)) scenario.status = 'passed'
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.stack = String(error.stack)
    try { evidence.failureSnapshot = await snapshot(); evidence.failureUI = await page.locator('body').innerText() } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error) } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
    for (const name of ['hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
    flag('stop')
    assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(work, { recursive: true, force: true })
    evidence.finishedAt = new Date().toISOString(); save()
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
