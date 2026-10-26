assert(installed && path.isAbsolute(installed), 'isolated installed package required')
const programRoot = path.dirname(installed)
const programHashes = () => Object.fromEntries(['resources/app.asar', 'resources/runtime/core/transport.py', 'resources/runtime/core/tray.py']
  .map(name => [name, sha(fs.readFileSync(path.join(programRoot, name)))]))
const originalProgram = programHashes()
const release = path.resolve(process.env.IDEER_ACCEPTANCE_UPDATE_RELEASE || '')
for (const name of ['blockers.cjs', 'flow-blockers.cjs']) evidence.candidate.acceptanceFiles.push({
  path: 'scripts/acceptance/issue-108/' + name, sha256: sha(fs.readFileSync(path.join(sourceRoot, 'scripts/acceptance/issue-108', name)))
})
async function assertBlocked(name) {
  await page.getByRole('button', { name: '确认并排空安装', exact: true }).click()
  await wait(async () => await page.getByRole('button', { name: '确认并排空安装', exact: true }).isEnabled() &&
    (await page.locator('body').innerText()).includes('安装未执行（blocked）'), name + ' refused installation')
  const view = (await status()).runtime
  assert.equal(view.process, 'running')
  assert.equal(view.installDrain, false)
  assert.deepEqual(programHashes(), originalProgram)
  assert.equal((await page.evaluate(() => window.ideer.checkUpdates('staged'))).ok, true)
  const reason = (await page.locator('body').innerText()).split('\n').find(line => line.includes('安装未执行（blocked）'))
  assert.match(reason, /durably|unknown/)
  await page.getByRole('button', { name: '确认并排空安装', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(state, name + '.png'), fullPage: true })
  pass('T108-02', name, { reason, runtime: view, unchangedProgramHashes: programHashes() })
}
async function main() {
  try {
    fixture('W/uncertain.txt'); fixture('W/health.txt')
    await launch(); await choose()
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) }, release)
    await page.getByRole('button', { name: '导入离线补丁清单', exact: true }).click()
    await wait(async () => (await page.getByRole('button', { name: '确认并排空安装', exact: true }).count()) === 1, 'signed pending patch')
    evidence.staged = await page.evaluate(() => window.ideer.checkUpdates('staged'))
    assert.equal(evidence.staged.ok, true)
    controls('fault', 'completion')
    const write = await submit('T108-02', 'real-completion-storage-failure', 'uncertain.txt')
    await approval(write); await click(write, true); await finish(write)
    exact('W/uncertain.txt', AFTER)
    await wait(async () => (await status()).runtime.receiptStorageError === 'RECEIPT_STORAGE_UNAVAILABLE', 'real completion latch')
    const uncertain = controls('history').rows.find(row => row.task_id === write.approval.taskId)
    assert.equal(uncertain.delivery_state, 'uncertain')
    evidence.originalUnknownReceipt = uncertain
    await assertBlocked('real-storage-failure-blocks-install')
    controls('fault', 'none')
    const read = await submit('T108-02', 'real-durable-read-clears-only-storage-latch', 'health.txt', BEFORE, { operation: 'read' })
    await finish(read, /BEFORE/)
    await wait(async () => !(await status()).runtime.receiptStorageError, 'real saved read clears storage latch')
    const stateBefore = (await status()).runtime
    assert(stateBefore.unknownWriteEffects > 0)
    assert.equal(stateBefore.activeTasks, 0)
    await assertBlocked('real-unknown-write-effect-blocks-install')
    assert.deepEqual(controls('history').rows.find(row => row.task_id === write.approval.taskId), uncertain)
    exact('W/uncertain.txt', AFTER)
    assert.equal(wireEvents().filter(row => row.event === 'task-dispatched' && row.runId === write.runId).length, 1)
    evidence.scenarios['T108-02'].status = 'passed'
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.errorStack = String(error.stack)
    try { evidence.failureStatus = await status(); evidence.failureUI = await page.locator('body').innerText() } catch {}
    throw error
  } finally {
    try { controls('fault', 'none') } catch {}
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error) } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error) }
    flag('stop'); evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(error.stack || String(error)); process.exitCode = 1 })
