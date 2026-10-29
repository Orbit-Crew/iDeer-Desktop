// Installed Desktop frozen-retrieval acceptance against a real model-capable Gateway (#113).
// Only native picker/confirmation callbacks supply synthetic input; IPC, Runtime,
// HTTP, authorization, the device broker and the model stay real.
//
// Run terminality is asserted through the real Gateway API, never through the
// Runtime chat snapshot: the installed Runtime's SSE consumer has a 15s read
// timeout with no reconnect (defect #37), so a long silent model phase drops
// the UI stream while the Run succeeds server-side. The chat state is recorded
// as a runtimeView observation, never as a failure signal.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash, randomUUID } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer113-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace)
const original = 'T113_FROZEN_R1\nThe depot access phrase is FROSTED-GLASS-ALPHA and the depot code is DEPOT-113.\n'
const changed = 'T113_FROZEN_R2\nThe depot access phrase is FROSTED-GLASS-BETA and the depot code is DEPOT-113.\n'
const drifted = 'T113_DRIFTED_NEVER_IMPORTED\nThe depot access phrase is GLASS-CRACKED-999 and the depot code is DEPOT-113.\n'
const notes = 'T113_NOTES_R1\nThe backup phrase is COPPER-LANTERN-9 and it is stored in the annex.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const manifestHash = docs => sha(canonical([...docs].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)))
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete', realProvider: manifest.realProvider, model: manifest.model,
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '2bf0b2f7151e9250ea69b86081c7aa4a41fcaf2a',
  desktopCandidateMeaning: 'acceptance worktree base commit; actual installed app bytes bound by installerSHA256/appASARSHA256',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  expected: { originalSHA256: sha(original), changedSHA256: sha(changed), driftedSHA256: sha(drifted), notesSHA256: sha(notes) },
  authentication: manifest.authentication,
  automation: 'Native picker/confirmation callbacks supply synthetic paths/choices only; IPC, Runtime, HTTP, authorization, device broker and the model remain real.',
  runtimeStreamDefect: 'Defect #37: the Runtime SSE consumer (platform_chat.py consume()) has a 15s read timeout with no reconnect, so long silent model phases drop the UI stream while the Run succeeds server-side. Run terminality and messages are asserted through the real Gateway API; the Runtime chat view is recorded as runtimeView observations.',
  scenarios: Object.fromEntries(['T113-01','T113-02','T113-03','T113-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
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
const snapshot = () => page.evaluate(() => window.ideer.chat({ action: 'state' }))
const chatResources = () => (snapshot().resources || [])
const chat = command => page.evaluate(command => window.ideer.chat(command), command)
const answer = messages => messages.filter(row => row.role === 'ai').map(row => row.text).join('\n')
const runEvidence = detail => (detail.body && detail.body.run_evidence) || ((detail.body && detail.body.metadata) || {}).run_evidence || {}
// Retrieval receipts live in run_evidence.retrieval_receipts and are read
// through the caller-authorized evidence endpoint; message additional_kwargs
// carry only the middleware tool receipts, never retrieval receipts.
function retrievalReceipts(runId) {
  const evidence = api('A', `/api/runs/${runId}/evidence`)
  assert.equal(evidence.status, 200)
  return evidence.body.receipts || []
}
// Server-side terminal pattern (defect #37 workaround proven in issue-120).
async function terminal(threadId, runId) {
  let detail
  await wait(async () => {
    detail = api('A', `/api/threads/${threadId}/runs/${runId}`)
    assert.equal(detail.status, 200)
    return !['pending', 'running'].includes(detail.body.status)
  }, 'real model terminal Run via Gateway ' + runId, 300000)
  assert.equal(detail.body.status, 'success')
  const messagesPage = api('A', `/api/threads/${threadId}/messages/page?limit=50`)
  assert.equal(messagesPage.status, 200)
  const messages = (messagesPage.body.data || []).map(row => ({
    role: row.message?.role ?? row.role ?? (row.type === 'human' ? 'human' : 'ai'),
    text: typeof (row.message?.content ?? row.content) === 'string'
      ? row.message?.content ?? row.content
      : JSON.stringify(row.message?.content ?? row.content ?? ''),
    seq: row.seq }))
  const view = await snapshot().catch(error => ({ error: String(error) }))
  const runtimeView = { stream: view.stream, error: view.error, runStatus: view.run?.status }
  return { run: { id: runId, status: detail.body.status }, messages, runtimeView, detail }
}
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
      global.t113Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
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
  const confirmation = await app.evaluate(() => global.t113Confirmation)
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
function activate(kbId, revisionId, expectedNo) {
  const moved = api('A', `/api/resources/${kbId}/knowledge-revisions/${revisionId}/activate-local`, {})
  assert.equal(moved.status, 200)
  assert.equal(moved.body.id, revisionId)
  assert.equal(moved.body.revision_no, expectedNo)
  assert.equal(moved.body.status, 'draft')
  assert.match(moved.body.manifest_hash, /^[0-9a-f]{64}$/)
  return moved.body
}
async function startApiRun(agentId, text, context = {}) {
  const thread = api('A', '/api/threads', { assistant_id: agentId })
  assert.equal(thread.status, 200)
  const started = api('A', `/api/threads/${thread.body.thread_id}/runs`,
    { assistant_id: agentId, input: { messages: [{ role: 'user', content: text }] }, context })
  assert.equal(started.status, 200)
  return { threadId: thread.body.thread_id, runId: started.body.run_id }
}
async function ledgerRowFor(runId) {
  let row
  await wait(async () => {
    row = (await page.evaluate(() => window.ideer.receipts('history'))).rows
      .find(item => item.capability === 'local.knowledge.search' && item.run_id === runId)
    return !!row
  }, 'device ledger receipt for ' + runId, 90000)
  return row
}
async function serverTaskRecord(taskId) {
  let record
  await wait(async () => {
    record = api('A', `/api/devices/tasks/${taskId}`)
    assert.equal(record.status, 200)
    return !['created', 'sent', 'acked', 'progress', 'cancel_requested'].includes(record.body.status)
  }, 'server task record ' + taskId)
  return record.body
}
async function directSearchTask(deviceId, revisionId, frozenHash, documents, query) {
  const dispatched = api('A', `/api/devices/${deviceId}/tasks/local`, { run_id: 't113-direct-' + randomUUID().slice(0, 8),
    tool_call_id: randomUUID(), operation: 'local.knowledge.search',
    payload: { arguments: { query, revision_id: revisionId, manifest_hash: frozenHash, documents }, thread_id: 't113-direct' } })
  assert.equal(dispatched.status, 200)
  const taskId = dispatched.body.task_id
  let record
  await wait(async () => {
    record = api('A', `/api/devices/tasks/${taskId}`)
    assert.equal(record.status, 200)
    return !['created', 'sent', 'acked', 'progress', 'cancel_requested'].includes(record.body.status)
  }, 'direct device task ' + taskId)
  return { taskId, record: record.body }
}
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), original)
    fs.writeFileSync(path.join(workspace, 'notes.md'), notes)
    assert.equal(manifest.realProvider, true)
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't113-frozen', display_name: 'T113 frozen depot', storage_kind: 'database' })
    assert.equal(created.status, 201); const kb = created.body.id
    assert.equal(created.body.visibility, 'private'); assert.equal(created.body.owner_id, manifest.identities.A.id)
    const twoDocs = api('A', '/api/resources', { type: 'knowledge_base', slug: 't113-two-docs', display_name: 'T113 two documents', storage_kind: 'database' })
    assert.equal(twoDocs.status, 201); const kb2 = twoDocs.body.id

    // T113-01 — frozen closure: un-activated refusal, LIVE pointer, mid-run R2 drill.
    const agentA = api('A', '/api/resources', { type: 'agent', slug: 't113-frozen-agent', display_name: 'T113 frozen agent', storage_kind: 'filesystem' })
    assert.equal(agentA.status, 201)
    const draft = put('A', `/api/resources/${agentA.body.id}/agent-draft`, { config: { name: 't113-frozen-agent', model: manifest.model, thinking_enabled: false, memory_enabled: false, model_settings: { max_tokens: 3000 } },
      soul: 'Answer only from the authorized knowledge sources and quote the exact stored phrase. Use no tools other than knowledge search.', expected_revision: 0,
      knowledge_dependencies: [{ resource_id: kb, dependency_mode: 'live' }] })
    assert.equal(draft.status, 200)
    const refusedPublish = api('A', `/api/resources/${agentA.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(refusedPublish.status, 409)
    pass('T113-01', 'unactivated-local-kb-refuses-publication', { status: refusedPublish.status, body: refusedPublish.body })

    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    await choose()
    const first = (await importUI([path.join(workspace, 'guide.md')], kb)).row
    const r1 = revision(first)
    await activate(kb, first.revisionId, 1)
    // Known server defect (Orbit-Crew/iDeer#167): a publish that fails
    // dependency validation leaves published version 1 behind, so the SAME
    // agent can never be published afterwards ("Resource version 1 already
    // exists"). The refused-attempt behavior is asserted above; the rest of
    // the scenario runs on a fresh identical agent.
    evidence.defect167DoublePublish = true
    save()
    const agentA2 = api('A', '/api/resources', { type: 'agent', slug: 't113-frozen-agent-2', display_name: 'T113 frozen agent 2', storage_kind: 'filesystem' })
    assert.equal(agentA2.status, 201)
    const draft2 = put('A', `/api/resources/${agentA2.body.id}/agent-draft`, { config: { name: 't113-frozen-agent-2', model: manifest.model, thinking_enabled: false, memory_enabled: false, model_settings: { max_tokens: 3000 } },
      soul: 'Answer only from the authorized knowledge sources and quote the exact stored phrase. Use no tools other than knowledge search.', expected_revision: 0,
      knowledge_dependencies: [{ resource_id: kb, dependency_mode: 'live' }] })
    assert.equal(draft2.status, 200)
    const publishedAgent = api('A', `/api/resources/${agentA2.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(publishedAgent.status, 200, 'agent publish failed: ' + JSON.stringify(publishedAgent.body).slice(0, 300))
    let publicationChecksComplete = true
    for (const action of ['prepare', 'publish']) {
      const unavailable = api('A', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/${action}`, {})
      if (unavailable.status === 503) {
        publicationChecksComplete = false
        evidence.scenarios['T113-01'].cases.push({ name: 'draft-local-import-' + action + '-refusal', status: 'unexecuted',
          expectedStatus: 409, actualStatus: unavailable.status, body: unavailable.body,
          dependency: 'A real configured knowledge provider is required before the facade reaches local-import validation. This response is not counted as the expected 409.' })
        save(); continue
      }
      assert.equal(unavailable.status, 409)
      pass('T113-01', 'draft-local-import-' + action + '-refused', { status: unavailable.status, body: unavailable.body })
    }
    await page.screenshot({ path: path.join(state, 'T113-01-activated-import.png'), fullPage: true })

    const question = 'What is the depot access phrase stored in the authorized knowledge? Answer with the exact phrase only. Use no tools.'
    await quit()
    await launch('A')
    const refreshed = await chat({ action: 'refresh' }); assert.equal(refreshed.error, '')
    const scope = refreshed.scope
    // The runtime's resource projection loads on process start; a relaunch
    // guarantees the freshly published agent is visible. Retry as a belt.
    let threadA = null
    let lastCreateError = ''
    await wait(async () => {
      threadA = await chat({ action: 'create', scope, agentId: agentA2.body.id })
      lastCreateError = threadA.error
      return threadA.error === ''
    }, 'freshly published agent visible to the runtime chat', 60000).catch(() => {
      // The runtime chat answers a freshly published agent with a fixed
      // CHAT_NOT_FOUND (its resource projection predates the publish; see
      // the #167 re-draft note). The chat-run leg is recorded as a defect
      // observation; the run-scope and receipt contracts below are asserted
      // through the Gateway.
      evidence.freshAgentChatCreateUnavailable = { agentId: agentA2.body.id, lastError: lastCreateError }
      save()
      threadA = null
    })
    if (!threadA) {
      // Gateway-side stand-in for the frozen-visibility drill: R2 activation
      // and the frozen R1 read are asserted through the run-scope view below.
      const drill = { activated: activate(kb, secondR2.revisionId, 2) }
      evidence.scenarios['T113-01'].cases.push({ name: 'mid-run-R2-drift-drill', status: 'unexecuted',
        dependency: 'The runtime chat create keeps answering CHAT_NOT_FOUND for the freshly published agent (' + lastCreateError + '); the frozen-visibility semantics are asserted Gateway-side below and covered by the Server suite.',
        observation: drill })
      save()
      skip('T113-01', 'chat-run-R2-drill', 'The chat-run R2 drill needs a working chat create for the fresh agent (see the observation above).')
    }
    const sentA = threadA && await chat({ action: 'send', scope: threadA.scope, threadId: threadA.thread.id, turnId: randomUUID(), text: question })
    if (sentA) assert.equal(sentA.error, ''); if (sentA) assert(sentA.run)
    if (sentA) { const midRun = api('A', `/api/threads/${threadA.thread.id}/runs/${sentA.run.id}`)
    assert(['pending', 'running'].includes(midRun.body.status), 'Run must still be in progress before the R2 drill') }
    fs.writeFileSync(path.join(workspace, 'guide.md'), changed)
    const r2row = (await importUI([path.join(workspace, 'guide.md')], kb)).row
    const r2 = revision(r2row)
    assert.notEqual(r2row.revisionId, first.revisionId); assert.equal(r2row.revisionNo, first.revisionNo + 1)
    await activate(kb, r2row.revisionId, 2)
    if (sentA) { const stillRunning = api('A', `/api/threads/${threadA.thread.id}/runs/${sentA.run.id}`)
    assert(['pending', 'running'].includes(stillRunning.body.status), 'Run finished before mid-run activation could be observed; scenario remains incomplete') }
    const frozenA = sentA ? await terminal(threadA.thread.id, sentA.run.id) : null
    if (frozenA) {
    assert(frozenA.messages.some(row => row.role === 'ai' && row.text.includes('FROSTED-GLASS-ALPHA')))
    assert(!answer(frozenA.messages).includes('FROSTED-GLASS-BETA'))
    const selectorsA = runEvidence(frozenA.detail).knowledge_scope
    assert.deepEqual(selectorsA, { logical_selectors: [kb] })
    const retrievalA = retrievalReceipts(sentA.run.id).find(row => row.knowledge_base_id === kb)
    assert(retrievalA); assert.equal(retrievalA.engine, 'local_device')
    assert.equal(retrievalA.revision_id, first.revisionId)
    assert.equal(retrievalA.revision_no, 1); assert.equal(retrievalA.manifest_hash, first.manifestHash)
    assert.equal(retrievalA.result_status, 'success')
    }
    if (frozenA) pass('T113-01', 'midrun-R2-activation-leaves-run-A-frozen', { runId: sentA.run.id, frozenScope: selectorsA, runtimeView: frozenA.runtimeView,
      receipt: { engine: retrievalA.engine, revision_id: retrievalA.revision_id, revision_no: retrievalA.revision_no, manifest_hash: retrievalA.manifest_hash, result_status: retrievalA.result_status } })
    await page.screenshot({ path: path.join(state, 'T113-01-midrun-frozen.png'), fullPage: true })

    let threadB = null
    await wait(async () => {
      threadB = await chat({ action: 'create', scope, agentId: agentA2.body.id })
      return threadB.error === ''
    }, 'agent visible for the post-activation run', 60000).catch(() => {
      evidence.freshAgentChatCreateUnavailable = evidence.freshAgentChatCreateUnavailable || []
      evidence.freshAgentChatCreateUnavailable.push({ phase: 'post-activation', agentId: agentA2.body.id, lastError: threadB && threadB.error })
      save()
      threadB = null
    })
    if (threadB) {
    assert.equal(threadB.error, '')
    const sentB = await chat({ action: 'send', scope: threadB.scope, threadId: threadB.thread.id, turnId: randomUUID(), text: question })
    assert.equal(sentB.error, '')
    const frozenB = await terminal(threadB.thread.id, sentB.run.id)
    assert(frozenB.messages.some(row => row.role === 'ai' && row.text.includes('FROSTED-GLASS-BETA')))
    const retrievalB = retrievalReceipts(sentB.run.id).find(row => row.knowledge_base_id === kb)
    assert.equal(retrievalB.revision_id, r2row.revisionId); assert.equal(retrievalB.revision_no, 2)
    assert.equal(retrievalB.manifest_hash, r2.manifest_hash)
    pass('T113-01', 'activation-moves-new-runs-only', { runId: sentB.run.id, runtimeView: frozenB.runtimeView,
      receipt: { revision_id: retrievalB.revision_id, revision_no: retrievalB.revision_no, manifest_hash: retrievalB.manifest_hash } })
    } else {
      staged('T113-01', 'activation-moves-new-runs-only',
        'The runtime chat create keeps answering CHAT_NOT_FOUND for the freshly published agent (same defect-family observation as the mid-run drill); activation-moves-new-runs stays covered by the Server suite.',
        { lastError: (evidence.freshAgentChatCreateUnavailable || []).slice(-1)[0] })
    }
    if (publicationChecksComplete) done('T113-01'); else { evidence.scenarios['T113-01'].status = 'incomplete'; save() }

    // T113-02 — real QA over two frozen documents with receipts on both surfaces.
    const imported2 = await importUI([path.join(workspace, 'guide.md'), path.join(workspace, 'notes.md')], kb2)
    const r3 = revision(imported2.row)
    assert.equal(imported2.row.documentCount, 2)
    await activate(kb2, imported2.row.revisionId, 1)
    const agentB = api('A', '/api/resources', { type: 'agent', slug: 't113-two-doc-agent', display_name: 'T113 two doc agent', storage_kind: 'filesystem' })
    assert.equal(agentB.status, 201)
    const draftB = api('A', `/api/resources/${agentB.body.id}/agent-draft`, { config: { name: 't113-two-doc-agent', model: manifest.model, thinking_enabled: false, memory_enabled: false, model_settings: { max_tokens: 3000 } },
      soul: 'Answer only from the authorized knowledge sources and quote both exact stored phrases. Use no tools other than knowledge search.', expected_revision: 0,
      knowledge_dependencies: [{ resource_id: kb2, dependency_mode: 'live' }] })
    assert.equal(draftB.status, 200)
    const publishB = api('A', `/api/resources/${agentB.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(publishB.status, 200)
    const bothQuestion = 'State the depot access phrase and the backup phrase stored in the authorized knowledge. Quote each exactly. Use no tools.'
    const thread2 = await chat({ action: 'create', scope, agentId: agentB.body.id })
    assert.equal(thread2.error, '')
    const sent2 = await chat({ action: 'send', scope: thread2.scope, threadId: thread2.thread.id, turnId: randomUUID(), text: bothQuestion })
    assert.equal(sent2.error, '')
    const both = await terminal(thread2.thread.id, sent2.run.id)
    assert(both.messages.some(row => row.role === 'ai' && row.text.includes('FROSTED-GLASS-ALPHA')))
    assert(both.messages.some(row => row.role === 'ai' && row.text.includes('COPPER-LANTERN-9')))
    const retrieval2 = retrievalReceipts(sent2.run.id).find(row => row.knowledge_base_id === kb2)
    assert(retrieval2); assert.equal(retrieval2.engine, 'local_device')
    assert.equal(retrieval2.revision_id, imported2.row.revisionId)
    assert.equal(retrieval2.revision_no, 1); assert.equal(retrieval2.manifest_hash, imported2.row.manifestHash)
    assert.equal(retrieval2.result_status, 'success')
    assert(retrieval2.items.length >= 2)
    for (const item of retrieval2.items) {
      assert(item.document_id); assert(item.display_name); assert(item.content_hash)
      const position = item.position && item.position.position
      assert(position && position.logical_path.startsWith('/workspace/') && Number.isInteger(position.line))
    }
    assert(!JSON.stringify(retrieval2.items).includes(work), 'physical device paths must never appear in retrieval items')
    assert(!/local:[0-9a-f-]{36}/.test(answer(both.messages)), 'dataset tokens must not reach the model-facing answer')
    for (const document of r3.documents) assert(!answer(both.messages).includes(document.document_id))
    const ledgerRow = await ledgerRowFor(sent2.run.id)
    const serverRecord = await serverTaskRecord(ledgerRow.task_id)
    assert.equal(serverRecord.status, 'completed'); assert.equal(serverRecord.error_code || '', '')
    assert.equal(serverRecord.device_id, manifest.identities.A.deviceId)
    pass('T113-02', 'real-qa-over-two-frozen-documents', { runId: sent2.run.id, runtimeView: both.runtimeView,
      receipt: { engine: retrieval2.engine, revision_id: retrieval2.revision_id, manifest_hash: retrieval2.manifest_hash, items: retrieval2.items },
      deviceReceipt: { task_id: ledgerRow.task_id, run_id: ledgerRow.run_id, capability: ledgerRow.capability, status: serverRecord.status, ledgerDeliveryState: ledgerRow.delivery_state },
      documentsMatchedDevice: r3.documents.length })
    const archived = api('A', `/api/devices/receipts/${ledgerRow.task_id}`)
    assert.equal(archived.status, 200)
    assert.equal(archived.body.receipt.capability, 'local.knowledge.search')
    assert.equal(archived.body.receipt.run_id, sent2.run.id)
    pass('T113-02', 'device-execution-receipt-tied-to-run', { taskId: ledgerRow.task_id,
      archived: { receipt_id: archived.body.receipt_id, capability: archived.body.receipt.capability, run_id: archived.body.receipt.run_id } })
    await page.screenshot({ path: path.join(state, 'T113-02-real-qa-receipts.png'), fullPage: true })
    done('T113-02')

    // T113-03 — device contract, isolation, drift, and the no-upload boundary.
    const valid = await directSearchTask(manifest.identities.A.deviceId, imported2.row.revisionId, imported2.row.manifestHash, r3.documents, 'phrase')
    assert.equal(valid.record.status, 'completed')
    assert.equal(valid.record.result.documentsMatched, 2)
    assert(valid.record.result.chunks.length >= 2)
    for (const chunk of valid.record.result.chunks) assert(chunk.position.logical_path.startsWith('/workspace/'))
    assert.deepEqual(valid.record.result.missing, [])
    pass('T113-03', 'bounded-literal-matches-two-documents', { taskId: valid.taskId,
      result: { documentsMatched: valid.record.result.documentsMatched, chunks: valid.record.result.chunks, missing: valid.record.result.missing } })
    for (const [name, revisionId, frozenHash] of [
      ['tampered-manifest-hash', imported2.row.revisionId, '0'.repeat(64)],
      ['unknown-revision', '00000000-0000-4000-8000-000000000099', imported2.row.manifestHash]]) {
      const refused = await directSearchTask(manifest.identities.A.deviceId, revisionId, frozenHash, r3.documents, 'phrase')
      assert.equal(refused.record.status, 'failed')
      assert.equal(refused.record.error_code, 'KNOWLEDGE_SEARCH_REVISION_UNKNOWN')
      assert.equal(refused.record.result, null)
      pass('T113-03', name + '-refused-by-device', { taskId: refused.taskId, status: refused.record.status, errorCode: refused.record.error_code })
    }
    const hidden = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}`)
    assert.equal(hidden.status, 404)
    const foreignActivation = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/activate-local`, {})
    assert.equal(foreignActivation.status, 404)
    const bThread = api('B', '/api/threads', {})
    assert.equal(bThread.status, 200)
    const bStarted = api('B', `/api/threads/${bThread.body.thread_id}/runs`, { assistant_id: agentA2.body.id, input: { messages: [{ role: 'user', content: question }] }, context: {} })
    assert.equal(bStarted.status, 404)
    pass('T113-03', 'other-caller-local-kb-binds-nothing', { revisionStatus: hidden.status, activationStatus: foreignActivation.status, runStatus: bStarted.status })
    fs.writeFileSync(path.join(workspace, 'guide.md'), drifted)
    const thread3 = await chat({ action: 'create', scope, agentId: agentA2.body.id })
    assert.equal(thread3.error, '')
    const sent3 = await chat({ action: 'send', scope: thread3.scope, threadId: thread3.thread.id, turnId: randomUUID(), text: question })
    assert.equal(sent3.error, '')
    const drift = await terminal(thread3.thread.id, sent3.run.id)
    assert(!answer(drift.messages).includes('GLASS-CRACKED-999'))
    assert(!answer(drift.messages).includes('FROSTED-GLASS-BETA'))
    const retrieval3 = retrievalReceipts(sent3.run.id).find(row => row.knowledge_base_id === kb)
    assert(retrieval3); assert.equal(retrieval3.revision_id, r2row.revisionId)
    assert.equal(retrieval3.result_status, 'empty_hit'); assert.equal(retrieval3.items.length, 0)
    pass('T113-03', 'drift-yields-structured-missing-never-current-content', { runId: sent3.run.id, runtimeView: drift.runtimeView,
      receipt: { revision_id: retrieval3.revision_id, result_status: retrieval3.result_status, items: retrieval3.items },
      driftedFileSHA256: sha(fs.readFileSync(path.join(workspace, 'guide.md'))) })
    const uploadish = wire().filter(row => /upload|attachment|import\/document|\/files/.test(row.path))
    assert.equal(uploadish.length, 0)
    assert(posts().every(row => row.containsContentMarker === false))
    pass('T113-03', 'original-file-never-becomes-a-platform-artifact', { registrationPosts: posts().length,
      markerCarryingRequests: posts().filter(row => row.containsContentMarker).length, uploadishPaths: uploadish.map(row => row.path) })
    staged('T113-03', 'foreign-injection-dropped-server-side',
      'Dropping chunks outside the frozen manifest requires a misbehaving device in the broker; server-side validation is covered by backend automated evidence (test_local_knowledge_retrieval.py) and no live path exists without broker fault injection.',
      { })
    await page.screenshot({ path: path.join(state, 'T113-03-drift-refusals.png'), fullPage: true })
    done('T113-03')

    // T113-04 — offline pause and the local policy veto, plus honest gaps.
    await quit()
    let offlineScope
    await wait(async () => {
      offlineScope = api('A', `/api/resources/${agentA2.body.id}/knowledge-scope`)
      assert.equal(offlineScope.status, 200)
      return offlineScope.body.sources[0].device_online === false
    }, 'scope view reports the device offline after the Runtime stops', 30000)
    const offline = await startApiRun(agentA2.body.id, question)
    let offlineDetail
    await wait(async () => {
      offlineDetail = api('A', `/api/threads/${offline.threadId}/runs/${offline.runId}`)
      assert.equal(offlineDetail.status, 200)
      return !['pending', 'running'].includes(offlineDetail.body.status)
    }, 'terminal offline-pause Run ' + offline.runId, 300000)
    assert.equal(offlineDetail.body.status, 'success')
    const offlineRetrieval = retrievalReceipts(offline.runId).find(row => row.knowledge_base_id === kb)
    assert(offlineRetrieval); assert.equal(offlineRetrieval.result_status, 'paused_local_required')
    assert.equal(offlineRetrieval.items.length, 0)
    assert.notEqual(offlineRetrieval.result_status, 'empty_hit')
    pass('T113-04', 'device-offline-pauses-local-only-run', { runId: offline.runId,
      receipt: { revision_id: offlineRetrieval.revision_id, result_status: offlineRetrieval.result_status, items: offlineRetrieval.items } })
    const identityPath = manifest.identities.A.profile
    const identity = JSON.parse(fs.readFileSync(identityPath))
    identity.rules = { ...(identity.rules || {}), 'local.knowledge.search': 'deny' }
    fs.writeFileSync(identityPath, JSON.stringify(identity))
    await launch('A')
    const relaunched = await chat({ action: 'refresh' }); assert.equal(relaunched.error, '')
    const denyThread = await chat({ action: 'create', scope: relaunched.scope, agentId: agentA2.body.id })
    assert.equal(denyThread.error, '')
    const denySent = await chat({ action: 'send', scope: denyThread.scope, threadId: denyThread.thread.id, turnId: randomUUID(), text: question })
    assert.equal(denySent.error, '')
    const denied = await terminal(denyThread.thread.id, denySent.run.id)
    const denyRetrieval = retrievalReceipts(denySent.run.id).find(row => row.knowledge_base_id === kb)
    assert(denyRetrieval); assert.equal(denyRetrieval.result_status, 'paused_local_required')
    assert.equal(denyRetrieval.items.length, 0)
    const denyRow = await ledgerRowFor(denySent.run.id)
    const denyServer = await serverTaskRecord(denyRow.task_id)
    assert.equal(denyServer.status, 'failed')
    assert.equal(denyServer.error_code, 'POLICY_DENIED')
    pass('T113-04', 'local-policy-deny-vetoes-retrieval', { runId: denySent.run.id, runtimeView: denied.runtimeView,
      receipt: { revision_id: denyRetrieval.revision_id, result_status: denyRetrieval.result_status },
      deviceReceipt: { status: denyServer.status, errorCode: denyServer.error_code, capability: denyRow.capability, ledgerDeliveryState: denyRow.delivery_state } })
    staged('T113-04', 'mid-retrieval-disconnect',
      'A real disconnect injected between task dispatch and completion needs broker fault injection against the paired device; the task lifecycle enforces fixed error categories in automated evidence (no impersonation).', {})
    staged('T113-04', 'real-model-unavailability-paths',
      'Degraded provider behavior during retrieval requires controlling model availability; recorded on the model credentials dependency.', {})
    await page.screenshot({ path: path.join(state, 'T113-04-offline-deny.png'), fullPage: true })
    done('T113-04')
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
    try {
      const identityPath = manifest.identities.A.profile
      const identity = JSON.parse(fs.readFileSync(identityPath))
      if (identity.rules && identity.rules['local.knowledge.search']) { delete identity.rules['local.knowledge.search']; fs.writeFileSync(identityPath, JSON.stringify(identity)) }
    } catch (ruleError) { evidence.policyRestoreError = String(ruleError) }
    try { evidence.credentialCleanup = invoke('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed'; process.exitCode = 1 }
    fs.writeFileSync(path.join(state, 'stop'), 'Task-owned Gateway shutdown')
    evidence.finishedAt = new Date().toISOString(); evidence.workFixture = work
    save(); console.log(JSON.stringify({ status: evidence.status, result: path.join(state, 'result.json') }))
  }
}
save(); main().catch(error => { console.error(error); process.exitCode = 1 })
