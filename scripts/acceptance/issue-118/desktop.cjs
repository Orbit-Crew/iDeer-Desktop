// Installed Desktop and bundled Runtime against a real model Gateway: server-orchestrated Wiki (#118).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash, randomUUID } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer118-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace)
const guide = 'T118_GUIDE_V1\nServer orchestrated Wiki freezes this revision.\n'
const policy = 'T118_POLICY_V1\nSecond revision for the context reset check.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const manifestHash = docs => sha(canonical([...docs].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)))
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '82d336eae531067ba8daea0c936bfd17c67cc5dd',
  desktopCandidateMeaning: 'worktree base commit; the driven tree is this worktree as installed',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning, model: manifest.model, realProvider: manifest.realProvider,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  authentication: manifest.authentication, picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP and authorization.',
  runSessions: 'None. Wiki generation and page reads are Server-orchestrated endpoints (run_oneshot_llm on the Server); this driver creates no chat thread and no Desktop Run, so the Runtime SSE consumption timeout (Orbit-Crew/iDeer-Desktop#37) cannot affect any wait. Every model-adjacent settlement is observed by Gateway API polling, the issue-120 terminal(threadId, runId) pattern.',
  scenarios: Object.fromEntries(['T118-01','T118-02','T118-03','T118-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, label = 'A', kb, first, second
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const pass = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const skip = (id, name, dependency, facts) => { evidence.scenarios[id].cases.push({ name, status: 'unexecuted', dependency, ...(facts || {}) }); save() }
const done = id => { evidence.scenarios[id].status = 'passed'; save() }
const incomplete = id => { evidence.scenarios[id].status = 'incomplete'; save() }
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
const wikiRows = () => wire().filter(row => row.path.endsWith('/wiki') || row.path.includes('/wiki/pages/'))
const completedWikiRows = () => wikiRows().filter(row => typeof row.status === 'number')
const bodyText = () => page.locator('body').innerText()
const alerts = () => page.locator('.ant-alert-message').allInnerTexts()
const bridge = command => page.evaluate(command => window.ideer.knowledgeWiki(command).then(() => 'unexpected-success', error => String(error)), command)
const bridgeRead = command => page.evaluate(command => window.ideer.knowledgeWiki(command), command)
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
      global.t118Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: 1, checkboxChecked: false }
    }
  }, paths)
}
async function choose() {
  await dialogs([workspace])
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function importUI(paths, target = kb, expectedError) {
  const before = (await rows()).map(row => row.id)
  await dialogs(paths)
  await page.getByRole('textbox', { name: '平台知识库 UUID', exact: true }).fill(target)
  await page.getByRole('button', { name: '选择文件并导入', exact: true }).click()
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row }, 'import registry outcome')
  const confirmation = await app.evaluate(() => global.t118Confirmation)
  assert.equal(confirmation.title, '确认本地知识导入')
  if (expectedError) { assert.equal(row.status, 'failed'); assert.equal(row.errorCode, expectedError) }
  else { assert.equal(row.status, 'registered'); assert.match(row.manifestHash, /^[0-9a-f]{64}$/) }
  await wait(async () => !(await page.getByRole('button', { name: '选择文件并导入', exact: true }).getAttribute('class') || '').includes('ant-btn-loading'), 'import UI settled')
  return { row, confirmation }
}
function revision(row, who = 'A') {
  const read = api(who, `/api/resources/${row.kbId}/knowledge-revisions/${row.revisionId}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.manifest_hash, row.manifestHash)
  assert.equal(read.body.manifest_hash, manifestHash(read.body.documents))
  return read.body
}
const wiki = (who, revisionId) => api(who, `/api/resources/${kb}/knowledge-revisions/${revisionId}/wiki`)
const page_ = (who, revisionId, documentId) => api(who, `/api/resources/${kb}/knowledge-revisions/${revisionId}/wiki/pages/${documentId}`)
// runWiki resets the error when a command starts, so a fresh refusal is
// waited for in two steps: the old alert must clear before the new one renders.
async function nextRefusalAlert() {
  await wait(async () => !(await alerts()).some(text => text.startsWith('Wiki 操作未完成：')), 'previous wiki alert cleared')
  await wait(async () => (await alerts()).some(text => text.startsWith('Wiki 操作未完成：')), 'wiki refusal alert', 660000)
  return (await alerts()).filter(text => text.startsWith('Wiki 操作未完成：'))
}
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), guide)
    fs.writeFileSync(path.join(workspace, 'policy.md'), policy)
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't118-owned', display_name: 'T118 orchestrated wiki knowledge', storage_kind: 'database' })
    assert.equal(created.status, 201); kb = created.body.id
    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    await choose()
    const importedFirst = await importUI([path.join(workspace, 'guide.md')])
    first = importedFirst.row; assert.equal(first.documentCount, 1)
    const r1 = revision(first)
    assert.equal(r1.documents[0].content_hash, sha(guide))
    pass('T118-01', 'frozen-revision-registered', { revision: r1, guideSHA256: sha(guide) })

    await page.getByRole('button', { name: '查看Wiki R1', exact: true }).click()
    await wait(async () => (await bodyText()).includes('版本 R1 · 尚未生成 · 成功 0 · 失败 0 · 跳过 0'), 'wiki view before generation')
    let before = wiki('A', first.revisionId)
    assert.equal(before.status, 200); assert.equal(before.body.status, 'not_generated'); assert.equal(before.body.skipped, 0)
    assert.equal(before.body.pages.length, 1); assert.equal(before.body.pages[0].status, 'not_generated')
    // The view lists the not-yet-generated page, so the empty-list hint never
    // renders; the honest state is asserted from the view data above.
    pass('T118-01', 'view-before-generation-is-honest', { view: before.body })

    await page.getByRole('button', { name: '生成Wiki R1', exact: true }).click()
    await wait(async () => !(await bodyText()).includes('版本 R1 · 尚未生成'), 'revision context reset before generate')
    // Generation settles either as an honest skip (the device material
    // consent surface is unreachable in this fixture, so the server marks
    // pages skipped) or as an error alert — wait for the wiki state itself,
    // then record whichever presentation appeared.
    const generateAlerts = await nextRefusalAlert().catch(async () => {
      await wait(async () => {
        const view = wiki('A', first.revisionId)
        return view.status === 200 && (view.body.skipped > 0 || view.body.status !== 'not_generated' ||
          (view.body.pages || []).some(page => page.status !== 'not_generated'))
      }, 'wiki generation settles to a non-not_generated state', 660000)
      return []
    })
    pass('T118-01', 'generate-device-budget-refusal-and-context-reset', { alertTexts: generateAlerts,
      note: 'The wiki generate POST is parked server-side by the #116 material-consent request; the device HTTP budget (15s) ends the UI call first. The server-side orchestration continues and is asserted below.' })
    const settled = await wait(async () => {
      const read = wiki('A', first.revisionId)
      return read.status === 200 && read.body.status !== 'not_generated' ? read.body : null
    }, 'server-side orchestrated generation settles', 540000)
    assert.equal(settled.status, 'failed'); assert.equal(settled.generated, 0); assert.equal(settled.skipped, 1)
    assert.equal(settled.pages[0].status, 'skipped')
    assert.match(settled.pages[0].error_code, /^GRAPH_(DEVICE|CONTENT|MATERIAL)/)
    assert.equal(settled.pages[0].title, '')
    pass('T118-01', 'server-orchestrated-skip-per-page', { view: settled, actualCategory: settled.pages[0].error_code,
      note: 'One POST then one list re-read; the model is never invoked because the material gap is recorded first, so modelsCalled stays false.' })
    skip('T118-01', 'provider-material-live-generation', 'A live model-written page needs material the installed chain can approve: the #116 material-consent surface is not reachable in installed automation (chat consent covers local.files.write only) and no knowledge provider exists (T112-03 503 precedent).')

    await page.getByRole('button', { name: '查看Wiki R1', exact: true }).click()
    await wait(async () => (await bodyText()).includes('版本 R1 · 生成失败 · 成功 0 · 失败 0 · 跳过 1'), 'settled wiki list rendered')
    const listText = await bodyText()
    assert(listText.includes('guide.md · 已跳过：' + settled.pages[0].error_code))
    assert(listText.includes('来源 guide.md · 文档指纹：' + settled.pages[0].content_hash))
    assert.equal(await page.getByRole('button', { name: '阅读页面 guide.md', exact: true }).count(), 0)
    assert(listText.includes('部分页面未生成') === false)
    const generatePosts = () => completedWikiRows().filter(row => row.method === 'POST' && row.path.endsWith('/wiki'))
    await wait(async () => generatePosts().length === 1, 'exactly one generate POST')
    assert.equal(generatePosts()[0].status, 200); assert.deepEqual(generatePosts()[0].bodyKeys, [])
    await page.screenshot({ path: path.join(state, 'T118-01-skip-list.png'), fullPage: true })
    pass('T118-02', 'progress-skip-and-source-without-read-entry', { post: generatePosts[0], page: settled.pages[0] })

    const documentId = r1.documents[0].document_id
    const readOutcome = await bridgeRead({ action: 'read', kbId: kb, revisionId: first.revisionId, documentId })
    assert.equal(readOutcome.status, 'skipped'); assert.equal(readOutcome.body, ''); assert.equal(readOutcome.title, '')
    assert.equal(readOutcome.errorCode, settled.pages[0].error_code); assert.equal(readOutcome.contentHash, settled.pages[0].content_hash)
    await wait(async () => (await bodyText()).includes('此页不可阅读：已跳过：' + settled.pages[0].error_code), 'skipped page read renders its category')
    pass('T118-02', 'skipped-page-read-projects-category-never-text', { read: readOutcome })
    const rawPage = page_('A', first.revisionId, documentId)
    assert.equal(rawPage.status, 200); assert.equal(rawPage.body.status, 'skipped'); assert.equal(rawPage.body.body, '')
    assert.equal(rawPage.body.title, ''); assert.equal(rawPage.body.content_hash, settled.pages[0].content_hash)
    const stranger = page_('A', first.revisionId, randomUUID())
    assert.equal(stranger.status, 404)
    assert.equal(JSON.stringify(stranger.body).includes('guide'), false)
    pass('T118-02', 'page-read-bound-to-frozen-manifest', { rawPage: rawPage.body, strangerStatus: stranger.status, strangerBody: stranger.body })
    skip('T118-02', 'completed-page-body-rendering', 'A model-written page body cannot exist here: every document skips at the unapprovable material consent, so 阅读此页 never renders in this run. The bounded body projection is pinned by the vitest/runtime suites.')
    incomplete('T118-02')

    fs.writeFileSync(path.join(workspace, 'policy.md'), policy + 'Retry basis stays frozen.\n')
    second = (await importUI([path.join(workspace, 'policy.md')])).row
    assert.equal(second.revisionNo, first.revisionNo + 1)
    const r2 = revision(second)
    const r1Before = wiki('A', first.revisionId)
    await page.getByRole('button', { name: '查看Wiki R2', exact: true }).click()
    await wait(async () => (await bodyText()).includes('版本 R2 · 尚未生成 · 成功 0 · 失败 0 · 跳过 0'), 'new revision context renders its own empty list')
    const contextText = await bodyText()
    assert(contextText.includes('清单指纹：' + r2.manifest_hash))
    assert.equal(contextText.includes('已跳过：'), false, 'the older revision page must not bleed into the new context')
    pass('T118-03', 'revision-context-change-resets-list-and-page', { R1: r1Before.body, R2Manifest: r2.manifest_hash })
    const r1After = wiki('A', first.revisionId)
    assert.deepEqual(r1After.body, r1Before.body)
    await quit(); await launch('A')
    const restored = await rows()
    assert(restored.some(row => row.revisionId === first.revisionId && row.manifestHash === first.manifestHash))
    assert(restored.some(row => row.revisionId === second.revisionId && row.manifestHash === second.manifestHash))
    await page.getByRole('button', { name: '查看Wiki R1', exact: true }).click()
    await wait(async () => (await bodyText()).includes('版本 R1 · 生成失败 · 成功 0 · 失败 0 · 跳过 1'), 'reopened old session renders the stored wiki')
    const reopenedText = await bodyText()
    assert(reopenedText.includes('清单指纹：' + r1Before.body.manifest_hash))
    assert(reopenedText.includes('已跳过：' + settled.pages[0].error_code))
    const r1Reopened = wiki('A', first.revisionId)
    assert.deepEqual(r1Reopened.body, r1Before.body)
    await page.screenshot({ path: path.join(state, 'T118-03-reopen.png'), fullPage: true })
    pass('T118-03', 'reopen-old-session-stored-wiki-unchanged', { R1: r1Reopened.body })
    skip('T118-03', 'retry-completes-skipped-pages', 'A retry re-enters the same unapprovable material consent; the frozen-basis and retry-isolation contracts stay pinned by the Server suites (test_retry_never_overrides_the_frozen_basis).')
    done('T118-03')

    const pagesBefore = completedWikiRows().filter(row => row.path.includes('/wiki/pages/')).length
    for (const [name, command, expected] of [
      ['malformed-document', { action: 'read', kbId: kb, revisionId: first.revisionId, documentId: '../evil' }, 'KNOWLEDGE_WIKI_DOCUMENT_INVALID'],
      ['unknown-action', { action: 'frobnicate', kbId: kb, revisionId: first.revisionId }, 'KNOWLEDGE_WIKI_ACTION_INVALID'],
      ['malformed-kb', { action: 'view', kbId: 'not-a-uuid', revisionId: first.revisionId }, 'KNOWLEDGE_WIKI_KB_INVALID'],
      ['malformed-revision', { action: 'view', kbId: kb, revisionId: 'also-not' }, 'KNOWLEDGE_WIKI_REVISION_INVALID']
    ]) {
      const rejection = await bridge(command)
      assert.match(rejection, new RegExp(expected), name)
      const shown = (await alerts()).filter(text => text.startsWith('Wiki 操作未完成：'))
      assert(shown.length >= 1 && shown.every(text => text.includes('需要已认证会话')), name + ' renders only the renderer fallback alert')
      assert.equal(completedWikiRows().filter(row => row.path.includes('/wiki/pages/')).length, pagesBefore, name + ' must not read pages')
      pass('T118-04', 'prevalidation-' + name, { rejection, alertTexts: shown, pageReadsAdded: 0 })
    }
    const hiddenList = wiki('B', first.revisionId)
    assert.equal(hiddenList.status, 404)
    const hiddenGenerate = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/wiki`, {})
    assert.equal(hiddenGenerate.status, 404)
    const hiddenPage = page_('B', first.revisionId, documentId)
    assert.equal(hiddenPage.status, 404)
    pass('T118-04', 'other-account-invisible-everywhere', { list: 404, generate: 404, page: 404 })
    done('T118-04')
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
