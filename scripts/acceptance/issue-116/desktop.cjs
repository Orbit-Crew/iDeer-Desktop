// Installed Desktop controlled knowledge-graph entry (#116) against a real isolated Gateway with a real model.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer116-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace)
const original = 'T116_FROZEN_MATERIAL_R1\n甲零件属于乙组件。\nThe frozen first revision is the only graph source.\n'
const changed = 'T116_FROZEN_MATERIAL_R2\n乙组件包含甲零件。\nThe changed second revision stays isolated from R1.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete', realProvider: manifest.realProvider,
  model: manifest.model,
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '82d336eae531067ba8daea0c936bfd17c67cc5dd',
  desktopCandidateMeaning: 'candidate worktree HEAD; the tested tree is bound by installerSHA256/appASARSHA256/runtimeLockSHA256 below',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning,
  sourceConfigSHA256: manifest.sourceConfigSHA256,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  expected: { originalSHA256: sha(original), changedSHA256: sha(changed) },
  authentication: manifest.authentication,
  picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP, broker and the real model remain real.',
  scenarios: Object.fromEntries(['T116-01','T116-02','T116-03','T116-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, label = 'A', kb, first
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const pass = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const done = id => { evidence.scenarios[id].status = 'passed'; save() }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(150) }
  throw Error('Timeout: ' + description)
}
function invoke(action, ...args) {
  const run = spawnSync(python, ['-I', path.join(root, 'scripts/acceptance/issue-102/profiles.py'), action, state, ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
const api = (who, route, body) => invoke(body === undefined ? 'api' : 'api-post', who, route, ...(body === undefined ? [] : [JSON.stringify(body)]))
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.knowledgeImports || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const graphWire = (from = 0) => wire().slice(from).filter(row => row.path.includes('/graph'))
const materialRows = () => fs.existsSync(path.join(state, 'material-summary.json')) ? JSON.parse(fs.readFileSync(path.join(state, 'material-summary.json'))) : []
const bodyText = () => page.locator('body').innerText()
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
  await app.evaluate(({ dialog }, value) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: value })
    dialog.showMessageBox = async (_owner, options) => ({ response: 1, checkboxChecked: false })
  }, paths)
}
async function choose() {
  await dialogs([workspace])
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function importUI(paths, expectedError) {
  const before = (await rows()).map(row => row.id)
  await dialogs(paths)
  await page.getByRole('textbox', { name: '平台知识库 UUID', exact: true }).fill(kb)
  await page.getByRole('button', { name: '选择文件并导入', exact: true }).click()
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row }, 'import registry outcome')
  if (expectedError) { assert.equal(row.status, 'failed'); assert.equal(row.errorCode, expectedError) }
  else { assert.equal(row.status, 'registered'); assert.match(row.manifestHash, /^[0-9a-f]{64}$/) }
  await wait(async () => !(await page.getByRole('button', { name: '选择文件并导入', exact: true }).getAttribute('class') || '').includes('ant-btn-loading'), 'import UI settled')
  return row
}
async function graphView(revisionNo, expectedStatusPart) {
  const from = wire().length
  await page.getByRole('button', { name: `查看图谱 R${revisionNo}`, exact: true }).click()
  await wait(async () => (await bodyText()).includes(expectedStatusPart), `graph view R${revisionNo} rendered (${expectedStatusPart})`)
  return { from, view: await page.evaluate(ids => window.ideer.knowledgeGraph({ action: 'view', kbId: ids.kb, revisionId: ids.revision }), { kb, revision: revisionIdOf(revisionNo) }) }
}
let revisions = {}
const revisionIdOf = no => revisions[no]
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), original)
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't116-owned', display_name: 'T116 owned knowledge', storage_kind: 'database' })
    assert.equal(created.status, 201); kb = created.body.id
    assert.equal(created.body.visibility, 'private'); assert.equal(created.body.owner_id, manifest.identities.A.id)
    await launch('A')
    await choose()
    first = await importUI([path.join(workspace, 'guide.md')])
    revisions[first.revisionNo] = first.revisionId
    assert.equal(first.documentCount, 1)

    const before = await graphView(first.revisionNo, '尚未生成')
    assert.equal(before.view.status, 'not_generated'); assert.equal(before.view.manifestHash, first.manifestHash)
    assert.equal(before.view.sources.length, 1); assert.equal(before.view.sources[0].contentHash, sha(original))
    assert.match(await bodyText(), /清单指纹：/)
    const from = wire().length
    await page.getByRole('button', { name: `生成图谱 R${first.revisionNo}`, exact: true }).click()
    await wait(async () => (await bodyText()).includes('生成失败'), 'generation outcome rendered')
    const view = await page.evaluate(ids => window.ideer.knowledgeGraph({ action: 'view', kbId: ids.kb, revisionId: ids.revision }), { kb, revision: first.revisionId })
    assert.equal(view.status, 'failed'); assert.equal(view.generated, 0); assert.equal(view.failed, 1)
    assert.equal(view.manifestHash, first.manifestHash)
    assert.equal(view.sources[0].status, 'failed'); assert.equal(view.sources[0].errorCode, 'GRAPH_DEVICE_UNAVAILABLE')
    assert.equal(view.sources[0].contentHash, sha(original)); assert.equal(view.sources[0].filename, 'guide.md')
    const text = await bodyText()
    assert.match(text, /版本 R1 · 生成失败 · 成功 0 · 失败 1/)
    assert.match(text, /guide\.md · 失败：GRAPH_DEVICE_UNAVAILABLE/)
    const graphRows = graphWire(from)
    assert(graphRows.some(row => row.method === 'POST' && row.path.endsWith('/graph') && row.status === 200))
    assert(graphRows.filter(row => row.method === 'GET' && row.path.endsWith('/graph') && row.status === 200).length >= 2)
    assert.deepEqual(materialRows(), [])
    pass('T116-01', 'server-orchestrated-generation-structured-failure', { view, graphRows,
      materialDispatchRows: 0, expectedSourceSHA256: sha(original) })
    evidence.scenarios['T116-01'].cases.push({ name: 'completed-real-model-graph', status: 'unexecuted',
      observed: { perDocumentError: 'GRAPH_DEVICE_UNAVAILABLE', materialDispatchRows: materialRows().length },
      dependency: 'The candidate gateway seam (backend/app/gateway/knowledge_seam.py) constructs the knowledge facade without graph_broker_factory, so the observed generation stores a per-document GRAPH_DEVICE_UNAVAILABLE failure and never dispatches local.knowledge.material (material-summary.json stays empty). A completed real-model graph for a device-local revision is staged on that seam wiring, with the model already configured here.' })
    evidence.scenarios['T116-01'].cases.push({ name: 'material-consent-card-ask-first-remember-deny', status: 'unexecuted',
      dependency: 'The consent legs need a material dispatch to observe: no local.knowledge.material task reaches the device in this candidate, and the installed Desktop exposes no surface that resolves a device material consent (the chat consent card covers local.files.write only). The ask-first/allow-once contract stays pinned by local-runtime tests.' })
    save()
    evidence.scenarios['T116-01'].status = 'incomplete'; save()
    await page.screenshot({ path: path.join(state, 'T116-01-generation.png'), fullPage: true })

    const sources = view.sources, documentId = sources[0].documentId
    assert.match(await bodyText(), new RegExp(`文档指纹：${sha(original)}`))
    assert.match(await bodyText(), /暂无已生成实体。/); assert.match(await bodyText(), /暂无已生成关系。/)
    const locateFrom = wire().length
    await page.getByRole('button', { name: `定位来源 guide.md`, exact: true }).click()
    await wait(async () => (await bodyText()).includes('本机位置：'), 'located source path rendered')
    const locate = await page.evaluate(ids => window.ideer.knowledgeGraph({ action: 'locate', kbId: ids.kb, revisionId: ids.revision, documentId: ids.documentId }), { kb, revision: first.revisionId, documentId })
    assert.equal(locate.missing, undefined); assert.equal(locate.filename, 'guide.md')
    assert(locate.logicalPath.endsWith('/guide.md'))
    assert.match(await bodyText(), new RegExp(`本机位置：${locate.logicalPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const locateRows = graphWire(locateFrom)
    assert(locateRows.every(row => row.method === 'GET' && row.path.endsWith('/graph')))
    pass('T116-02', 'sources-digests-and-local-locate', { locate, locateRows,
      note: 'The located workspace path never travels to the Server: the locate leg adds only a graph-view GET.' })
    await page.screenshot({ path: path.join(state, 'T116-02-render-locate.png'), fullPage: true })
    evidence.scenarios['T116-02'].cases.push({ name: 'manual-usability-pass-with-model-generated-graph', status: 'unexecuted',
      dependency: 'A click-through usability pass over a completed model-generated graph is staged on T116-01\'s completed-graph leg.' })
    save()
    evidence.scenarios['T116-02'].status = 'incomplete'; save()

    const hiddenView = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/graph`)
    const hiddenGenerate = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/graph`, {})
    const hiddenQuery = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/graph/query`, { document_ids: [documentId], query: '甲零件' })
    assert.deepEqual([hiddenView.status, hiddenGenerate.status, hiddenQuery.status], [404, 404, 404])
    await quit(); await launch('B')
    assert.equal((await rows()).length, 0)
    assert.match(await bodyText(), /当前账号与设备尚无可查看图谱的已登记版本。/)
    assert.equal(await page.getByRole('button', { name: '查看图谱', exact: true }).count(), 0)
    await page.screenshot({ path: path.join(state, 'T116-03-other-account.png'), fullPage: true })
    pass('T116-03', 'cross-account-invisibility', { hiddenView: hiddenView.status, hiddenGenerate: hiddenGenerate.status,
      hiddenQuery: hiddenQuery.status, graphEntryButtonsForB: 0 })
    await quit(); await launch('A')
    fs.writeFileSync(path.join(workspace, 'guide.md'), changed)
    const second = await importUI([path.join(workspace, 'guide.md')])
    revisions[second.revisionNo] = second.revisionId
    const r2 = await graphView(second.revisionNo, '尚未生成')
    assert.equal(r2.view.status, 'not_generated')
    const r1 = await graphView(first.revisionNo, '生成失败')
    assert.equal(r1.view.status, 'failed'); assert.equal(r1.view.sources[0].errorCode, 'GRAPH_DEVICE_UNAVAILABLE')
    pass('T116-03', 'revision-isolation-R1-R2', { R2: r2.view.status, R1AfterR2View: r1.view.status,
      R2ManifestHash: r2.view.manifestHash, R1ManifestHash: r1.view.manifestHash })
    done('T116-03')

    await quit(); await launch('A')
    const reopened = await graphView(first.revisionNo, '生成失败')
    assert.equal(reopened.view.manifestHash, first.manifestHash)
    assert.equal(reopened.view.sources[0].errorCode, 'GRAPH_DEVICE_UNAVAILABLE')
    assert.equal(reopened.view.sources[0].contentHash, sha(original))
    await page.screenshot({ path: path.join(state, 'T116-04-reopen-persistence.png'), fullPage: true })
    pass('T116-04', 'reopen-page-persistence', { view: reopened.view,
      note: 'Stored artifacts survive quit and relaunch: the reopened page renders the same frozen manifest, digests, and per-source outcome.' })
    evidence.scenarios['T116-04'].cases.push({ name: 'device-drift-and-offline-structured-failures', status: 'unexecuted',
      dependency: 'GRAPH_CONTENT_DRIFTED and device-offline failures arise only when material is dispatched and the device answers; no dispatch occurs in this candidate. The structured per-source failure presentation itself is executed above with the observed fixed category.' })
    save()
    evidence.scenarios['T116-04'].status = 'incomplete'; save()
    evidence.status = Object.values(evidence.scenarios).every(item => item.status === 'passed') ? 'passed' : 'incomplete'
    if (evidence.status !== 'passed') process.exitCode = 1
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.stack = error.stack
    if (page) { try { evidence.failureStatus = await status(); evidence.failureUI = await bodyText(); await page.screenshot({ path: path.join(state, 'failure.png'), fullPage: true }) } catch {} }
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
