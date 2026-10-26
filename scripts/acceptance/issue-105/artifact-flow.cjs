// Shared real UI artifact checks. Every device gets a separate app-data profile.
const artifactDataRoots = { A: appData }
function artifactProfile(action, label, ...args) {
  return python(path.join(__dirname, '../issue-105/artifact_profiles.py'), action, state, label, ...args)
}
async function switchArtifactDevice(label) {
  await quit()
  identityLabel = label
  appData = artifactDataRoots[label] || (artifactDataRoots[label] = path.join(state, 'appdata-' + label))
  config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
  owner = path.join(path.dirname(config), '.issue102-owner')
  fs.writeFileSync(entry, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});app.setAppPath(${JSON.stringify(root)});require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
  await launch()
}
async function openArtifactThread(operation) {
  const fresh = await command({ action: 'refresh' })
  assert.equal(fresh.error, '')
  const opened = await command({ action: 'open', scope: fresh.scope, threadId: operation.threadId })
  assert.equal(opened.error, '')
  return opened
}
async function exerciseArtifacts(operation, scenario) {
  manifest.identities.A2 = artifactProfile('pair-secondary', 'A')
  await switchArtifactDevice('A2')
  let view = await openArtifactThread(operation)
  assert.deepEqual(view.artifacts, [], 'D2 cannot see an attachment before explicit upload')
  assert(!view.localTasks.some(row => row.localResult), 'D2 has no original-device local results')
  assert(!(await status()).runtime.workspace || (await status()).runtime.workspace.state === 'unavailable')
  pass(scenario, 'second-device-local-result-remains-unavailable', { deviceId: manifest.identities.A2.deviceId,
    threadId: operation.threadId, artifacts: 0, localResults: 0 })

  await switchArtifactDevice('A')
  view = await openArtifactThread(operation)
  assert.equal(view.artifacts.length, 0)
  await uploadClick(operation)
  await wait(async () => {
    view = await snapshot()
    const row = view.localTasks.find(row => row.task_id === operation.approval.taskId)
    if (view.error) throw new Error('Explicit upload failed: ' + view.error)
    return !!row?.localResult?.artifact_ref && view.artifacts.length === 1
  }, 'explicit upload creates a real Server artifact')
  const artifact = view.artifacts[0]
  assert.equal(artifact.sha256, operation.requested.sha256)
  assert.equal(artifact.bytes, operation.requested.bytes)
  const replay = await command({ action: 'upload', scope: view.scope, threadId: operation.threadId,
    runId: operation.runId, taskId: operation.approval.taskId, decision: 'allow' })
  assert.equal(replay.error, '')
  assert.equal(replay.artifacts.length, 1, 'repeat does not create another attachment')
  assert.equal(replay.artifacts[0].artifact_id, artifact.artifact_id)
  pass(scenario, 'explicit-upload-and-repeat-real-server', { threadId: operation.threadId, artifact,
    sourceDeviceId: manifest.identities.A.deviceId })

  await switchArtifactDevice('A2')
  view = await openArtifactThread(operation)
  assert.equal(view.artifacts[0].artifact_id, artifact.artifact_id)
  assert(!view.localTasks.some(row => row.localResult))
  const destination = path.join(work, 'second-device-download.txt')
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async (_owner, options) => {
      global.artifactSaveDialog = { title: options.title, suggestedName: options.defaultPath }
      return { canceled: false, filePath: filename }
    }
  }, destination)
  await page.getByRole('button', { name: '下载附件 ' + artifact.name, exact: true }).click()
  await wait(() => fs.existsSync(destination), 'native-selected D2 download saved')
  assert.deepEqual(fs.readFileSync(destination), Buffer.from(operation.requested.text, 'utf8'))
  const body = await page.locator('body').innerText()
  assert(!body.includes(destination), 'download destination never enters Renderer')
  pass(scenario, 'second-device-ui-download-exact-bytes', { deviceId: manifest.identities.A2.deviceId,
    bytes: fs.statSync(destination).size, sha256: sha(fs.readFileSync(destination)),
    dialog: await app.evaluate(() => global.artifactSaveDialog) })

  await switchArtifactDevice('B')
  const b = await command({ action: 'refresh' })
  assert.equal(b.error, '')
  assert(!b.threads.some(row => row.id === operation.threadId), 'other account cannot list the owned Thread')
  const refused = await command({ action: 'open', scope: b.scope, threadId: operation.threadId })
  assert(['CHAT_NOT_FOUND', 'CHAT_FORBIDDEN'].includes(refused.error))
  const deniedDownload = artifactProfile('download', 'B', operation.threadId, artifact.artifact_id)
  assert([403, 404].includes(deniedDownload.status), 'other account HTTP download must be rejected')
  pass(scenario, 'other-account-ui-and-http-download-refused', { openError: refused.error,
    downloadStatus: deniedDownload.status })
  await switchArtifactDevice('A')
  await openArtifactThread(operation)
  return artifact
}
async function revokedArtifactProducer(operation, scenario) {
  const revoked = artifactProfile('revoke', 'A')
  assert.equal(revoked.status, 200)
  const attempted = artifactProfile('grant', 'A', operation.threadId, JSON.stringify({
    device_id: manifest.identities.A.deviceId, run_id: operation.runId, task_id: operation.approval.taskId,
    name: path.basename(operation.path), sha256: operation.requested.sha256, bytes: operation.requested.bytes
  }))
  assert([401, 403].includes(attempted.status), 'revoked producer cannot obtain another upload grant')
  pass(scenario, 'revoked-producer-old-session-refused', { deviceId: manifest.identities.A.deviceId,
    grantStatus: attempted.status })
}
