const assets = path.resolve(process.env.IDEER_ACCEPTANCE_COMPAT_ASSETS || '')
const controlled = path.resolve(process.env.IDEER_ACCEPTANCE_COMPAT_ROOT || '')
assert(process.env.IDEER_ACCEPTANCE_COMPAT_ASSETS && process.env.IDEER_ACCEPTANCE_COMPAT_ROOT, 'explicit isolated compatibility directories required')
assert(controlled !== assets && controlled !== path.parse(controlled).root)
const legacy = process.env.IDEER_ACCEPTANCE_LEGACY_CLIENT === '1'
evidence.scope = legacy ? 'unchanged old Desktop 0.1.0' : 'new Desktop combination matrix'
evidence.candidate.acceptanceFiles.push(...['desktop.cjs', 'flow.cjs', 'prepare-assets.cjs'].map(name => ({
  path: 'scripts/acceptance/issue-110/' + name, sha256: sha(fs.readFileSync(path.join(__dirname, '../issue-110', name))) })))
function publish(level) {
  fs.mkdirSync(controlled, { recursive: true })
  for (const suffix of ['json', 'sig']) {
    const destination = path.join(controlled, 'compatibility.' + suffix)
    fs.copyFileSync(path.join(assets, level, 'compatibility.' + suffix), destination + '.next')
    fs.renameSync(destination + '.next', destination)
  }
  const text = fs.readFileSync(path.join(controlled, 'compatibility.json'), 'utf8')
  evidence.stages.push({ id: 'publish-' + level, at: new Date().toISOString(), declaration: JSON.parse(text), sha256: sha(text) })
  save()
}
async function effective(level) {
  await page.getByRole('button', { name: '刷新兼容声明', exact: true }).click()
  await wait(async () => (await status()).runtime.compatibility?.level === level, 'effective Runtime compatibility ' + level)
  const view = await page.evaluate(() => window.ideer.refreshCompatibility())
  assert.equal(view.level, level)
  assert.equal(view.actualCombo.desktop, (await status()).version)
  assert.equal(view.actualCombo.runtime, '3.12.10')
  await page.screenshot({ path: path.join(state, 'compatibility-' + level + '.png'), fullPage: true })
  return view
}
async function blockedWrite(name, expected, scenario) {
  const operation = await submit(scenario, name, 'blocked.txt')
  operation.expectNoApproval = true
  // The Server gate refuses before any signed TASK frame, so no durable
  // localTasks row is created; the refusal is observable in the Turn's own
  // deterministic result together with the absent dispatch and unchanged file.
  await finish(operation, new RegExp(expected))
  assert.equal(executionCount(operation), 0)
  assert.equal(operation.dispatches.length, 0, 'Server gate refuses before a signed TASK frame')
  exact('W/blocked.txt', BEFORE)
  pass(scenario, name, { operationId: operation.id, error: expected, taskFrames: 0, executionCount: 0 })
}
async function main() {
  try {
    for (const name of ['allowed.txt', 'blocked.txt', 'health.txt', 'pending.txt']) fixture('W/' + name)
    publish('compatible')
    await launch(); await choose()
    evidence.observedApiVersion = (await status()).version
    evidence.observedDesktopVersion = legacy ? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version : evidence.observedApiVersion
    evidence.candidate.desktopPackageSHA256 = sha(fs.readFileSync(path.join(root, 'package.json')))
    evidence.candidate.desktopEntrySHA256 = sha(fs.readFileSync(installed ? path.join(path.dirname(installed), 'resources/app.asar') : path.join(root, 'out/main/index.js')))
    if (legacy) evidence.legacyVersionEvidence = 'Unchanged archive package metadata and compiled-entry hash. The isolation bootstrap reports the Electron API version separately; getVersion is not mocked.'
    assert.equal(evidence.observedDesktopVersion, legacy ? '0.1.0' : '0.2.0')
    if (legacy) {
      const old = await successful('T110-04', 'unchanged-old-client-write', 'W/allowed.txt', 'allowed.txt', AFTER, true)
      pass('T110-04', 'real-old-client-against-upgraded-server', { operationId: old.id, version: '0.1.0' })
      evidence.scenarios['T110-04'].status = 'passed'
    } else {
      const compatible = await effective('compatible')
      const allowed = await successful('T110-01', 'compatible-write', 'W/allowed.txt', 'allowed.txt', AFTER, true)
      publish('capability')
      const capability = await effective('capability')
      assert.deepEqual(capability.disabledCapabilities, ['local.files.write'])
      await blockedWrite('single-capability-write-refused', 'COMPAT_CAPABILITY_DISABLED', 'T110-01')
      const read = await submit('T110-01', 'unaffected-read', 'health.txt', BEFORE, { operation: 'read' })
      await finish(read, /BEFORE/)
      assert.equal(read.tasks[0].body.receipt.status, 'completed')
      pass('T110-01', 'unaffected-read-succeeds', { operationId: read.id, sha256: read.tasks[0].body.result.sha256 })

      publish('compatible'); await effective('compatible')
      const deniedResource = profile('api', 'B', '/api/resources/' + manifest.identities.A.agentId + '/published')
      assert([403, 404].includes(deniedResource.status))
      controls('policy', 'deny')
      const denied = await submit('T110-02', 'local-deny-with-compatible-switch', 'blocked.txt')
      denied.expectNoApproval = true
      await finish(denied, /LOCAL_POLICY_DENIED|DENIED/)
      assert.equal(executionCount(denied), 0)
      exact('W/blocked.txt', BEFORE)
      controls('policy', 'ask_first')
      pass('T110-02', 'feature-switch-does-not-grant-resource-or-local-permission', {
        resourceStatus: deniedResource.status, localOperationId: denied.id, executionCount: 0 })
      evidence.scenarios['T110-02'].status = 'passed'

      flag('drop-acks')
      const pending = await successful('T110-03', 'unconfirmed-write', 'W/pending.txt', 'pending.txt', AFTER, true)
      const before = controls('history').rows.find(row => row.task_id === pending.approval.taskId)
      assert.equal(before.delivery_state, 'pending')
      publish('core')
      const core = await effective('core')
      await blockedWrite('core-write-refused', 'COMPAT_CORE_INCOMPATIBLE', 'T110-01')
      evidence.scenarios['T110-01'].status = 'passed'; save()
      await restartRuntime()
      const fresh = await command({ action: 'refresh' })
      const reopened = await command({ action: 'open', scope: fresh.scope, threadId: pending.threadId })
      assert.equal(reopened.error, '')
      const after = controls('history').rows.find(row => row.task_id === pending.approval.taskId)
      assert.equal(after.receipt_id, before.receipt_id)
      assert.equal(after.receipt_hash, before.receipt_hash)
      assert.equal(after.delivery_state, 'pending')
      exact('W/pending.txt', AFTER)
      noRedispatch(pending)
      pass('T110-03', 'core-restart-preserves-original-file-and-unconfirmed-receipt', {
        taskId: pending.approval.taskId, before, after, core, dispatches: 1 })
      evidence.scenarios['T110-03'].status = 'passed'
      const previous = process.env.IDEER_ACCEPTANCE_OLD_RESULT
      assert(previous, 'real old-client result is required for deployment-order acceptance')
      const old = JSON.parse(fs.readFileSync(previous, 'utf8'))
      assert.equal(old.status, 'passed'); assert.equal(old.observedDesktopVersion, '0.1.0')
      assert.equal(old.candidate.serverSourceSHA256, evidence.candidate.serverSourceSHA256)
      assert(Date.parse(old.finishedAt) < Date.parse(evidence.startedAt), 'old client verified before new-client matrix')
      pass('T110-04', 'server-first-old-then-new-exact-combinations', { oldResultSHA256: sha(fs.readFileSync(previous)),
        oldVersion: '0.1.0', newVersion: evidence.observedDesktopVersion, compatible, capability, core })
      evidence.scenarios['T110-04'].status = 'passed'
    }
    await page.screenshot({ path: path.join(state, 'issue-110-final.png'), fullPage: true })
    await quit(); profile('evidence', 'A')
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.failure = String(error.stack || error)
    for (const row of Object.values(evidence.scenarios)) if (row.status === 'unexecuted' && row.cases.length) row.status = 'incomplete'
    try { if (page) { evidence.failureSnapshot = await snapshot(); evidence.failureUI = await page.locator('body').innerText() } } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error); evidence.status = 'failed' } }
    if (evidence.status !== 'passed' && process.env.IDEER_ACCEPTANCE_PRESERVE_FAILURE === '1') {
      evidence.preservedForDiagnosis = { work, credentials: 'synthetic references retained', server: 'running' }
    } else {
      try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
      flag('drop-acks', false); flag('stop')
      assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
      fs.rmSync(work, { recursive: true, force: true })
    }
    evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
