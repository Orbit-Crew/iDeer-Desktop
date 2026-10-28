// Installed Desktop hybrid-retrieval contract and device surface against a real isolated Gateway (#114).
// No Desktop code change ships in this ticket: the entry surface is the #113 retrieval
// capability, so this driver exercises the Server/Web contract and the device face of it.
// Real-model hybrid answers are recorded unexecuted on the model-credentials dependency.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash, randomUUID } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer114-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace)
const local = 'T114_LOCAL_R1\nThe frozen local phrase is COPPER-HARBOR-7 and the shelf code is SHELF-114.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const manifestHash = docs => sha(canonical([...docs].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)))
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '2bf0b2f7151e9250ea69b86081c7aa4a41fcaf2a',
  desktopCandidateMeaning: 'acceptance worktree base commit (no Desktop code change for #114); actual installed app bytes bound by installerSHA256/appASARSHA256',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  expected: { localSHA256: sha(local) },
  authentication: manifest.authentication,
  automation: 'Native picker/confirmation callbacks supply synthetic paths/choices only; IPC, Runtime, HTTP, authorization and the device broker remain real. No model is configured: hybrid model answers stay unexecuted on that dependency.',
  scenarios: Object.fromEntries(['T114-01','T114-02','T114-03','T114-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, label = 'A'
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const pass = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const staged = (id, name, dependency, facts) => { evidence.scenarios[id].cases.push({ name, status: 'unexecuted', dependency, ...facts }); save() }
const done = id => { evidence.scenarios[id].status = evidence.scenarios[id].cases.every(row => row.status === 'passed') ? 'passed' : 'incomplete'; save() }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(150) }
  throw Error('Timeout: ' + description)
}
function invoke(action, ...args) {
  const run = spawnSync(python, ['-I', path.join(root, 'scripts/acceptance/issue-102/profiles.py'), action, state, ...args], { windowsHide: true, encoding: 'utf8', timeout: 90000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
const api = (who, route, body) => invoke(body === undefined ? 'api' : 'api-post', who, route, ...(body === undefined ? [] : [JSON.stringify(body)]))
const put = (who, route, body) => { const r = spawnSync(python, ['-I', path.join(root, 'scripts/acceptance/issue-120/api.py'), state, who, 'PUT', route, JSON.stringify(body)], { windowsHide: true, encoding: 'utf8', timeout: 60000 }); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout.trim()) }
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.knowledgeImports || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const posts = () => wire().filter(row => row.method === 'POST' && row.path.endsWith('/knowledge-revisions/local-imports'))
const runEvidence = detail => (detail.body && detail.body.run_evidence) || ((detail.body && detail.body.metadata) || {}).run_evidence || {}
async function launch(who) {
  label = who
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.copyFileSync(manifest.identities[who].profile, settings)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: meta.executable, args: ['--user-data-dir=' + profile], env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  await wait(async () => (await status()).runtime.login?.state === 'authenticated' && (await status()).server === 'connected', 'authenticated signed connection ' + who)
  const actual = await app.evaluate(({ app, BrowserWindow }) => ({ packaged: app.isPackaged, version: app.getVersion(),
    electron: process.versions.electron, node: process.versions.node, preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences() }))
  assert(actual.packaged); assert.equal(actual.version, '0.2.0'); assert.equal(actual.electron, '22.3.27')
  assert(actual.preferences.sandbox); assert(actual.preferences.contextIsolation); assert.equal(actual.preferences.nodeIntegration, false)
  evidence.launches.push({ identity: who, ...actual }); save()
}
async function quit() {
  if (!app) return
  const close = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ideer.quit()); await close; app = null
  fs.copyFileSync(settings, manifest.identities[label].profile)
}
async function dialogs(paths) {
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: paths })
    dialog.showMessageBox = async (_owner, options) => {
      global.t114Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: 1, checkboxChecked: false }
    }
  }, paths)
}
async function choose() {
  await dialogs([workspace])
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function importUI(paths, target) {
  const before = (await rows()).map(row => row.id)
  await dialogs(paths)
  await page.getByRole('textbox', { name: '平台知识库 UUID', exact: true }).fill(target)
  await page.getByRole('button', { name: '选择文件并导入', exact: true }).click()
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row && row.status === 'registered' }, 'registered import row')
  const confirmation = await app.evaluate(() => global.t114Confirmation)
  assert.equal(confirmation.title, '确认本地知识导入')
  assert.match(confirmation.detail, /原文件与设备侧索引不会自动上传/)
  assert.match(row.manifestHash, /^[0-9a-f]{64}$/)
  await wait(async () => !(await page.getByRole('button', { name: '选择文件并导入', exact: true }).getAttribute('class') || '').includes('ant-btn-loading'), 'import UI settled')
  return { row, confirmation }
}
function revision(row, who = 'A') {
  const read = api(who, `/api/resources/${row.kbId}/knowledge-revisions/${row.revisionId}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.status, 'draft')
  assert.equal(read.body.manifest_hash, row.manifestHash)
  assert.equal(read.body.manifest_hash, manifestHash(read.body.documents))
  return read.body
}
async function startApiRun(who, agentId, context) {
  const thread = api(who, '/api/threads', {})
  assert.equal(thread.status, 200)
  const started = api(who, `/api/threads/${thread.body.thread_id}/runs`,
    { assistant_id: agentId, input: { messages: [{ role: 'user', content: 'Knowledge probe.' }] }, context })
  return { threadId: thread.body.thread_id, started }
}
async function awaitTerminal(who, threadId, runId, timeout = 300000) {
  let detail
  await wait(async () => {
    detail = api(who, `/api/threads/${threadId}/runs/${runId}`)
    assert.equal(detail.status, 200)
    return !['pending', 'running'].includes(detail.body.status)
  }, 'terminal Run ' + runId, timeout)
  return detail
}
async function dispatchSearchTask(who, deviceId, revisionId, frozenHash, documents, query) {
  const dispatched = api(who, `/api/devices/${deviceId}/tasks/local`, { run_id: 't114-direct-' + randomUUID().slice(0, 8),
    tool_call_id: randomUUID(), operation: 'local.knowledge.search',
    payload: { arguments: { query, revision_id: revisionId, manifest_hash: frozenHash, documents }, thread_id: 't114-direct' } })
  return { dispatched, taskId: dispatched.status === 200 ? dispatched.body.task_id : null }
}
async function pollTask(who, taskId) {
  let record
  await wait(async () => {
    record = api(who, `/api/devices/tasks/${taskId}`)
    assert.equal(record.status, 200)
    return !['created', 'sent', 'acked', 'progress', 'cancel_requested'].includes(record.body.status)
  }, 'device task ' + taskId)
  return record.body
}
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), local)
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't114-hybrid', display_name: 'T114 hybrid local', storage_kind: 'database' })
    assert.equal(created.status, 201); const kb = created.body.id
    assert.equal(created.body.owner_id, manifest.identities.A.id)
    const unanchored = api('A', '/api/resources', { type: 'knowledge_base', slug: 't114-unanchored', display_name: 'T114 unanchored', storage_kind: 'database' })
    assert.equal(unanchored.status, 201); const kb2 = unanchored.body.id

    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    await choose()
    const imported = (await importUI([path.join(workspace, 'guide.md')], kb)).row
    const r1 = revision(imported)
    const moved = api('A', `/api/resources/${kb}/knowledge-revisions/${imported.revisionId}/activate-local`, {})
    assert.equal(moved.status, 200); assert.equal(moved.body.revision_no, 1); assert.equal(moved.body.status, 'draft')
    const agentA = api('A', '/api/resources', { type: 'agent', slug: 't114-scope-agent', display_name: 'T114 scope agent', storage_kind: 'filesystem' })
    assert.equal(agentA.status, 201)
    const draft = put('A', `/api/resources/${agentA.body.id}/agent-draft`, { config: { name: 't114-scope-agent', model: 'acceptance-unused', thinking_enabled: false, memory_enabled: false },
      soul: 'Contract probe agent.', expected_revision: 0, knowledge_dependencies: [{ resource_id: kb, dependency_mode: 'live' }] })
    assert.equal(draft.status, 200)
    const publishedAgent = api('A', `/api/resources/${agentA.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(publishedAgent.status, 200)
    const imported2 = (await importUI([path.join(workspace, 'guide.md')], kb2)).row
    revision(imported2)

    // T114-01 — one scope behind both entries; the view reads exactly what a Run binds.
    const scopeView = api('A', `/api/resources/${agentA.body.id}/knowledge-scope`)
    assert.equal(scopeView.status, 200)
    assert.equal(scopeView.body.selection, 'narrow_only')
    assert.equal(scopeView.body.agent_id, agentA.body.id)
    assert.equal(scopeView.body.sources.length, 1)
    const source = scopeView.body.sources[0]
    assert.equal(source.resource_id, kb); assert.equal(source.origin, 'local_import')
    assert.equal(source.dataset, 'local:' + imported.revisionId)
    assert.equal(source.revision_id, imported.revisionId); assert.equal(source.revision_no, 1)
    assert.equal(source.manifest_hash, imported.manifestHash)
    assert.equal(source.device_id, manifest.identities.A.deviceId); assert.equal(source.device_online, true)
    pass('T114-01', 'scope-view-reads-the-frozen-run-surface', { scopeView: scopeView.body, frozenRow: { revisionId: imported.revisionId, manifestHash: imported.manifestHash } })
    const narrowed = await startApiRun('A', agentA.body.id, { runtime_knowledge_scope: [kb] })
    assert.equal(narrowed.started.status, 200)
    const narrowedDetail = await awaitTerminal('A', narrowed.threadId, narrowed.started.body.run_id)
    assert.deepEqual(runEvidence(narrowedDetail).knowledge_scope, { logical_selectors: [kb] })
    pass('T114-01', 'runtime-selection-binds-the-authorized-frozen-scope', { runId: narrowed.started.body.run_id,
      runStatus: narrowedDetail.body.status, knowledgeScope: runEvidence(narrowedDetail).knowledge_scope,
      note: 'The isolated Gateway intentionally configures no real model, so the Run ends in a synthetic-model error after freeze; the scope evidence is the prep-time frozen fact, which is why the terminal status is recorded, not asserted. The local:<revision> dataset binding behind the selector is evidenced by the scope view and the receipt identity fields.' })
    const restriction = await startApiRun('A', agentA.body.id, { runtime_knowledge_scope: ['00000000-0000-4000-8000-000000000099'] })
    assert.equal(restriction.started.status, 200)
    const restrictionDetail = await awaitTerminal('A', restriction.threadId, restriction.started.body.run_id)
    assert.deepEqual(runEvidence(restrictionDetail).knowledge_scope, { logical_selectors: [] })
    pass('T114-01', 'runtime-restriction-cannot-add-unknown-knowledge', { runId: restriction.started.body.run_id,
      runStatus: restrictionDetail.body.status, knowledgeScope: runEvidence(restrictionDetail).knowledge_scope })
    const agentB = api('A', '/api/resources', { type: 'agent', slug: 't114-unanchored-agent', display_name: 'T114 unanchored agent', storage_kind: 'filesystem' })
    assert.equal(agentB.status, 201)
    const draftB = put('A', `/api/resources/${agentB.body.id}/agent-draft`, { config: { name: 't114-unanchored-agent', model: 'acceptance-unused', thinking_enabled: false, memory_enabled: false },
      soul: 'Contract probe agent.', expected_revision: 0, knowledge_dependencies: [{ resource_id: kb2, dependency_mode: 'live' }] })
    assert.equal(draftB.status, 200)
    const refusedB = api('A', `/api/resources/${agentB.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(refusedB.status, 409)
    const unanchoredView = api('A', `/api/resources/${agentB.body.id}/knowledge-scope`)
    assert.equal(unanchoredView.status, 409)
    pass('T114-01', 'unanchored-local-kb-stays-out-of-the-view', { publishStatus: refusedB.status, scopeViewStatus: unanchoredView.status })
    staged('T114-01', 'installed-dual-ui-walkthrough',
      'The Web chat entry needs the Next.js frontend served against this Gateway plus a browser login; the selector contract is exercised here through the scope-view API it reads, and the component itself is covered by knowledge-scope-selector tests recorded in the Server report.', {})
    await page.screenshot({ path: path.join(state, 'T114-01-scope-view.png'), fullPage: true })
    done('T114-01')

    // T114-02 — another caller's local KB is invisible, not an error leak.
    const bView = api('B', `/api/resources/${agentA.body.id}/knowledge-scope`)
    assert.equal(bView.status, 404)
    const bActivation = api('B', `/api/resources/${kb}/knowledge-revisions/${imported.revisionId}/activate-local`, {})
    assert.equal(bActivation.status, 404)
    const bRevision = api('B', `/api/resources/${kb}/knowledge-revisions/${imported.revisionId}`)
    assert.equal(bRevision.status, 404)
    const bRun = await startApiRun('B', agentA.body.id, {})
    assert.equal(bRun.started.status, 404)
    const bTask = await dispatchSearchTask('B', manifest.identities.A.deviceId, imported.revisionId, imported.manifestHash, r1.documents, 'phrase')
    assert.equal(bTask.dispatched.status, 403)
    // The devices router answers a cross-account dispatch with 403; the
    // resource-error envelope flattens the specific code to INTERNAL_ERROR,
    // so the deny is asserted by status and the raw body is retained.
    const bTaskCode = bTask.dispatched.body.error?.code ?? bTask.dispatched.body.detail?.code
    pass('T114-02', 'unauthorized-kb-invisible-to-a-teammate', { scopeViewStatus: bView.status, activationStatus: bActivation.status,
      revisionStatus: bRevision.status, runStatus: bRun.started.status, deviceTaskStatus: bTask.dispatched.status, deviceTaskCode: bTaskCode })
    await page.screenshot({ path: path.join(state, 'T114-02-isolation.png'), fullPage: true })
    done('T114-02')

    // T114-03 — device surface: completed search, consent gate, unknown revision, offline.
    const valid = await dispatchSearchTask('A', manifest.identities.A.deviceId, imported.revisionId, imported.manifestHash, r1.documents, 'phrase')
    assert.equal(valid.dispatched.status, 200)
    const completed = await pollTask('A', valid.taskId)
    assert.equal(completed.status, 'completed')
    assert(completed.result.chunks.length >= 1)
    for (const chunk of completed.result.chunks) {
      assert(chunk.content.includes('COPPER-HARBOR-7'))
      assert(chunk.position.logical_path.startsWith('/workspace/'))
      assert(Number.isInteger(chunk.position.line))
    }
    assert.deepEqual(completed.result.missing, [])
    assert(completed.receipt && completed.receipt.capability === 'local.knowledge.search')
    pass('T114-03', 'device-search-completes-with-validated-chunks', { taskId: valid.taskId, result: completed.result, receipt: completed.receipt })
    const consent = api('A', `/api/devices/tasks/${valid.taskId}/consent`, { approved: true, actor_id: manifest.identities.A.id })
    // Same envelope flattening as the cross-account dispatch: the deny is
    // asserted by status, the raw body is retained as the evidence.
    assert.equal(consent.status, 403)
    pass('T114-03', 'remote-consent-cannot-approve-device-gated-search', { taskId: valid.taskId, httpStatus: consent.status, body: consent.body })
    const tampered = await dispatchSearchTask('A', manifest.identities.A.deviceId, imported.revisionId, '0'.repeat(64), r1.documents, 'phrase')
    assert.equal(tampered.dispatched.status, 200)
    const refused = await pollTask('A', tampered.taskId)
    assert.equal(refused.status, 'failed')
    // The typed category is carried in the archived receipt (server-side
    // truth); the task projection nests or flattens it, so assert on the
    // serialized record.
    // The typed category lives in the archived device receipt (the task
    // projection omits it); read the archive for the refusal category.
    let archivedRefusal
    await wait(async () => {
      archivedRefusal = api('A', `/api/devices/receipts/${tampered.taskId}`)
      return archivedRefusal.status === 200 && archivedRefusal.body.receipt
    }, 'archived refusal receipt')
    const refusalBody = JSON.stringify(archivedRefusal.body)
    assert(refusalBody.includes('KNOWLEDGE_SEARCH_REVISION_UNKNOWN'),
      'archived receipt must carry the typed refusal: ' + refusalBody.slice(0, 400))
    assert.equal(refused.result, null)
    pass('T114-03', 'tampered-manifest-refused-with-typed-error', { taskId: tampered.taskId, taskStatus: refused.status, errorCode: refused.error_code })
    await quit()
    let offlineView
    await wait(async () => {
      offlineView = api('A', `/api/resources/${agentA.body.id}/knowledge-scope`)
      assert.equal(offlineView.status, 200)
      return offlineView.body.sources[0].device_online === false
    }, 'scope view reports the device offline after the Runtime stops', 30000)
    pass('T114-03', 'offline-device-reported-in-the-scope-view', { device_online: offlineView.body.sources[0].device_online })
    const offline = await dispatchSearchTask('A', manifest.identities.A.deviceId, imported.revisionId, imported.manifestHash, r1.documents, 'phrase')
    assert.equal(offline.dispatched.status, 200)
    const offlineRecord = await pollTask('A', offline.taskId)
    assert.equal(offlineRecord.status, 'device_offline')
    assert.equal(offlineRecord.result, null)
    pass('T114-03', 'offline-device-task-is-structured-not-raised', { taskId: offline.taskId, taskStatus: offlineRecord.status, error: offlineRecord.error })
    staged('T114-03', 'paused-local-required-live-run',
      'A local-only Run that pauses instead of answering needs the model to invoke retrieval against the paused projection; the isolated Gateway has no real model, and paused_local_required receipts are covered by backend automated evidence.', {})
    staged('T114-03', 'mid-retrieval-disconnect',
      'A disconnect injected between task dispatch and completion needs broker fault injection against the paired device; covered by backend automated evidence (test_mid_disconnect_failure_is_structured_not_raised).', {})
    await launch('A')
    await page.screenshot({ path: path.join(state, 'T114-03-device-surface.png'), fullPage: true })
    done('T114-03')

    // T114-04 — receipts name the engine path and stay tied to the Run.
    let archived
    await wait(async () => {
      archived = api('A', `/api/devices/receipts/${valid.taskId}`)
      return archived.status === 200 && archived.body.receipt && archived.body.receipt.status === 'completed'
    }, 'archived completed device receipt ' + valid.taskId)
    assert.equal(archived.body.receipt.capability, 'local.knowledge.search')
    assert.equal(archived.body.receipt.run_id, valid.dispatched.body.run_id)
    assert.equal(archived.body.receipt.status, 'completed')
    assert(archived.body.receipt.result_hash)
    let ledgerRow
    await wait(async () => {
      try {
        ledgerRow = (await page.evaluate(() => window.ideer.receipts('history'))).rows.find(row => row.task_id === valid.taskId)
      } catch (error) {
        if (!String(error).includes('RECEIPT_BUSY')) throw error
        return false
      }
      return !!ledgerRow
      return !!ledgerRow
    }, 'ledger receipt for ' + valid.taskId, 90000)
    const ledgerServer = await pollTask('A', valid.taskId)
    assert.equal(ledgerServer.status, 'completed')
    assert.equal(ledgerRow.capability, 'local.knowledge.search')
    assert.equal(ledgerRow.run_id, valid.dispatched.body.run_id)
    assert.equal(ledgerRow.status, 'completed')
    pass('T114-04', 'device-receipt-consistent-across-archive-and-ledger', {
      archived: { receipt_id: archived.body.receipt_id, capability: archived.body.receipt.capability, run_id: archived.body.receipt.run_id, result_hash: archived.body.receipt.result_hash },
      ledger: { task_id: ledgerRow.task_id, run_id: ledgerRow.run_id, capability: ledgerRow.capability, status: ledgerRow.status, deliveryState: ledgerRow.delivery_state } })
    staged('T114-04', 'retrieval-receipt-engine-labels-and-statuses-in-run-evidence',
      'engine=local_device/server_provider attribution and source_unavailable/paused_local_required retrieval-receipt statuses are produced inside a Run; that needs a real model to invoke retrieval, staged on the model-credentials dependency.', {})
    staged('T114-04', 'no-cross-engine-score-merge-live',
      'Merging never happens across engines; the provider engine itself requires a configured knowledge provider (RAGFlow), which is unavailable in the isolated Gateway — recorded like the T112-03 provider dependency.', {})
    staged('T114-04', 'web-knowledge-scope-selector-visual-walkthrough',
      'The Web selector (frontend/src/components/workspace/chats/knowledge-scope-selector.tsx) needs the Next.js frontend served and a browser session; the selection surface it reads (GET knowledge-scope, narrow_only, device_online) is verified live above and the component is covered by frontend unit tests in the Server report.', {})
    await page.screenshot({ path: path.join(state, 'T114-04-receipts.png'), fullPage: true })
    done('T114-04')
    assert(posts().every(row => row.containsContentMarker === false))
    evidence.status = Object.values(evidence.scenarios).every(row => row.status === 'passed') ? 'passed' : 'incomplete'
    if (evidence.status !== 'passed') process.exitCode = 1
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.stack = error.stack
    if (page) { try { evidence.failureStatus = await status(); evidence.failureUI = await page.locator('body').innerText(); await page.screenshot({ path: path.join(state, 'failure.png'), fullPage: true }) } catch {} }
    process.exitCode = 1
  } finally {
    try { await quit() } catch (error) {
      evidence.shutdownError = String(error); evidence.status = 'failed'; process.exitCode = 1
      if (app) { try { await app.close(); app = null } catch (closeError) { evidence.forcedCloseError = String(closeError) } }
    }
    try { evidence.credentialCleanup = invoke('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed'; process.exitCode = 1 }
    fs.writeFileSync(path.join(state, 'stop'), 'Task-owned Gateway shutdown')
    evidence.finishedAt = new Date().toISOString(); evidence.workFixture = work
    save(); console.log(JSON.stringify({ status: evidence.status, result: path.join(state, 'result.json') }))
  }
}
save(); main().catch(error => { console.error(error); process.exitCode = 1 })
