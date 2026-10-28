// Installed Desktop and bundled Runtime against a real isolated Gateway with the real model.
// Issue 119: the wiki navigation index over one frozen revision, through the installed UI.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer119-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace)
const original = 'T119_ORIGINAL_BYTES_R1\n# Overview\n\nThis page links [[manual.md]] and [policy](policy.txt); the external\n[site](https://example.com) and the anchor [skip](#anchor) are not internal links.\nMissing target: [[ghost-page]].\n'
const changed = 'T119_ORIGINAL_BYTES_R2\n# Overview (second revision)\n\nSecond frozen revision; the first revision index must stay its own.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '82d336eae531067ba8daea0c936bfd17c67cc5dd', desktopCandidateMeaning: 'base commit; actual tested app bound by installerSHA256/appASARSHA256',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning, realProvider: manifest.realProvider, model: manifest.model,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  launches: [],
  expected: { originalSHA256: sha(original), changedSHA256: sha(changed) },
  authentication: manifest.authentication, picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP and authorization.',
  scenarios: Object.fromEntries(['T119-01','T119-02','T119-03','T119-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, label = 'A', kb, row1, row2, navigation
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const pass = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const skipped = (id, name, dependency) => { evidence.scenarios[id].cases.push({ name, status: 'unexecuted', dependency }); save() }
const done = id => { evidence.scenarios[id].status = 'passed'; save() }
const incomplete = id => { evidence.scenarios[id].status = 'incomplete'; save() }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(150) }
  throw Error('Timeout: ' + description)
}
function call(who, method, route, body) {
  const args = ['-I', path.join(__dirname, 'api.py'), state, who, method, route]
  if (body !== undefined) args.push(JSON.stringify(body))
  const run = spawnSync(python, args, { windowsHide: true, encoding: 'utf8', timeout: 120000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.knowledgeImports || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const wikiWire = () => wire().filter(row => row.path.includes('/wiki'))
const wikiPosts = () => wikiWire().filter(row => row.method === 'POST')
const viewRoute = revisionId => `/api/resources/${kb}/knowledge-revisions/${revisionId}/wiki`
const navRoute = revisionId => `${viewRoute(revisionId)}/navigation`
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
      global.t119Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: 1, checkboxChecked: false }
    }
  }, paths)
}
async function choose() {
  await dialogs([workspace])
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function importUI(filename, target = kb) {
  const before = (await rows()).map(row => row.id)
  await dialogs([filename])
  await page.getByRole('textbox', { name: '平台知识库 UUID', exact: true }).fill(target)
  await page.getByRole('button', { name: '选择文件并导入', exact: true }).click()
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row }, 'import registry outcome')
  const confirmation = await app.evaluate(() => global.t119Confirmation)
  assert.equal(confirmation.title, '确认本地知识导入')
  assert.match(confirmation.detail, /原文件与设备侧索引不会自动上传/)
  assert.equal(row.status, 'registered'); assert.match(row.manifestHash, /^[0-9a-f]{64}$/)
  await wait(async () => !(await page.getByRole('button', { name: '选择文件并导入', exact: true }).getAttribute('class') || '').includes('ant-btn-loading'), 'import UI settled')
  return row
}
async function clickEnabled(name) {
  const button = page.getByRole('button', { name, exact: true })
  await wait(async () => await button.isEnabled(), 'button enabled: ' + name)
  await button.click()
}
const bodyText = () => page.locator('body').innerText()
// The import registry always renders every revision's manifest hash, so the
// wiki fragment itself is addressed through the paragraphs only it renders.
const navHeader = () => page.locator('p', { hasText: ' · 导航索引 · ' })
const digestRows = digest => page.locator('p', { hasText: '文档指纹：' + digest })
async function main() {
  try {
    assert.equal(manifest.realProvider, true)
    fs.writeFileSync(path.join(workspace, 'overview.md'), original)
    const created = call('A', 'POST', '/api/resources', { type: 'knowledge_base', slug: 't119-owned', display_name: 'T119 owned knowledge', storage_kind: 'database' })
    assert.equal(created.status, 201); kb = created.body.id
    assert.equal(created.body.visibility, 'private'); assert.equal(created.body.owner_id, manifest.identities.A.id)
    evidence.scenarios['T119-01'].status = 'incomplete'
    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    await choose()
    row1 = await importUI(path.join(workspace, 'overview.md'))
    assert.equal(row1.revisionNo, 1); assert.equal(row1.documents[0].filename, 'overview.md')

    // Generation rides the Server's own model and the device broker. The
    // material ask is a LEVEL_1 local consent; the installed app parks it, so
    // the runtime's own 60 s discipline fires while the Server finishes and
    // records the honest per-document skip.
    const generateRefused = await page.evaluate(revision => window.ideer.knowledgeWiki(
      { action: 'generate', kbId: revision.kbId, revisionId: revision.revisionId }
    ).then(() => 'unexpected-success', error => String(error)), row1)
    // The runtime's 60s discipline usually fires (KNOWLEDGE_WIKI_TIMEOUT);
    // when the Server settles the material gap faster the command succeeds —
    // either way the honest per-page state is asserted from the wiki view
    // below, so only a silent failure is fatal here.
    assert(['unexpected-success'].includes(generateRefused) || /KNOWLEDGE_WIKI_/.test(generateRefused),
      'generate ended unexpectedly: ' + generateRefused)
    pass('T119-01', 'generate-command-bounded-at-60s', { rejection: generateRefused })
    let viewBody = ''
    await wait(async () => {
      if (await page.getByRole('button', { name: '查看Wiki R1', exact: true }).isEnabled()) {
        await page.getByRole('button', { name: '查看Wiki R1', exact: true }).click()
        await pause(1500)
      }
      viewBody = await bodyText()
      return viewBody.includes('已跳过：')
    }, 'honest skip record after the material ask times out', 660000)
    assert.match(viewBody, /版本 R1 · 生成失败 · 成功 0 · 失败 0 · 跳过 1/)
    assert.match(viewBody, /overview\.md · 已跳过：[A-Z0-9_]+/)
    assert.match(viewBody, new RegExp('清单指纹：' + row1.manifestHash))
    assert.equal(await page.getByRole('button', { name: '阅读页面 overview.md', exact: true }).count(), 0)
    const view = call('A', 'GET', viewRoute(row1.revisionId))
    assert.equal(view.status, 200); assert.equal(view.body.status, 'failed')
    assert.equal(view.body.generated, 0); assert.equal(view.body.failed, 0); assert.equal(view.body.skipped, 1)
    assert.equal(view.body.pages[0].status, 'skipped'); assert.match(view.body.pages[0].error_code, /^[A-Z0-9_]+$/)
    await page.screenshot({ path: path.join(state, 'T119-01-honest-skips.png'), fullPage: true })
    pass('T119-01', 'skipped-page-has-no-read-entry', { view: view.body, code: view.body.pages[0].error_code })

    const postsBeforeNavigation = wikiPosts().length
    await clickEnabled('导航Wiki R1')
    await wait(async () => (await navHeader().count()) === 1, 'navigation index rendered')
    const navBody = await bodyText()
    const navHeaderText = await navHeader().innerText()
    assert.ok(navHeaderText.includes('版本 R1 · 导航索引 · 生成失败 · 成功 0 · 失败 0 · 跳过 1'))
    assert.ok(navBody.includes('关联图')); assert.ok(navBody.includes('尚未生成'))
    assert.ok((await digestRows(sha(original)).count()) >= 1, 'the frozen source digest renders inside the R1 index')
    assert.ok(navBody.includes('overview.md · 已跳过：'))
    assert.ok(!navBody.includes('缺失目标'))
    assert.equal(await page.locator('h5', { hasText: '页面正文' }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^前往/ }).count(), 0)
    assert.equal(await page.getByRole('button', { name: /^返回/ }).count(), 0)
    navigation = call('A', 'GET', navRoute(row1.revisionId))
    assert.equal(navigation.status, 200)
    const index = navigation.body
    assert.equal(index.revision_no, 1); assert.equal(index.manifest_hash, row1.manifestHash); assert.equal(index.status, 'failed')
    assert.equal(index.pages.length, 1); assert.equal(index.pages[0].status, 'skipped')
    assert.deepEqual(index.pages[0].links, []); assert.deepEqual(index.pages[0].missing_links, []); assert.deepEqual(index.pages[0].backlinks, [])
    assert.equal(index.associations.status, 'not_generated')
    assert.deepEqual(index.associations.sources.map(row => [row.filename, row.status, row.content_hash]),
      [['overview.md', 'not_generated', sha(original)]])
    const wireRows = wikiWire()
    const navigationReads = wireRows.filter(row => row.method === 'GET' && row.path.endsWith('/wiki/navigation'))
    assert(navigationReads.length >= 1); assert(navigationReads.every(row => row.status === 200))
    assert.equal(wikiPosts().length, postsBeforeNavigation, 'navigate must not POST')
    assert(wireRows.findIndex(row => row.method === 'GET' && row.path.endsWith('/wiki/navigation'))
      > wireRows.map((row, at) => row.method === 'POST' ? at : -1).reduce((a, b) => Math.max(a, b), -1),
      'the only wiki POST is the earlier generate; navigation is read-only')
    await page.screenshot({ path: path.join(state, 'T119-01-navigation.png'), fullPage: true })
    pass('T119-01', 'navigate-read-only-honest-projection', { index, navigationReads, wikiPosts: wikiPosts().length })
    const completedDepends = 'A completed page is unreachable in this environment: the frozen-document material ask '
      + '(local.knowledge.material) is a LEVEL_1 local consent, and the installed app has no answerable surface for it '
      + '(the tray decide path is tray-UI-only and the chat consent surface matches local.files.write only), so the ask '
      + 'times out and the page is honestly recorded as skipped. The isolated environment also has no knowledge provider '
      + '(same dependency precedent as T112-03).'
    skipped('T119-01', 'completed-target-qianwang-fanhui-walk', completedDepends)
    skipped('T119-01', 'backlinks-name-completed-sources', completedDepends)
    incomplete('T119-01')

    evidence.scenarios['T119-02'].status = 'incomplete'
    const bView = call('B', 'GET', viewRoute(row1.revisionId))
    assert.equal(bView.status, 404)
    const bNavigation = call('B', 'GET', navRoute(row1.revisionId))
    assert.equal(bNavigation.status, 404)
    await quit(); await launch('B')
    assert.equal((await rows()).length, 0)
    const bBody = await bodyText()
    assert.ok(bBody.includes('当前账号与设备尚无可查看 Wiki 的已登记版本。'))
    assert.equal(await page.getByRole('button', { name: '查看Wiki R1', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '导航Wiki R1', exact: true }).count(), 0)
    await page.screenshot({ path: path.join(state, 'T119-02-visibility.png'), fullPage: true })
    pass('T119-02', 'other-account-navigation-invisible', { viewStatus: bView.status, navigationStatus: bNavigation.status })
    done('T119-02')

    evidence.scenarios['T119-03'].status = 'incomplete'
    await quit(); await launch('A')
    assert((await rows()).some(row => row.revisionId === row1.revisionId))
    for (const [name, bound] of [['pages', index.pages.length <= 200], ['links', index.pages.every(row => row.links.length <= 100)],
      ['missing', index.pages.every(row => row.missing_links.length <= 100)], ['backlinks', index.pages.every(row => row.backlinks.length <= 100)],
      ['sources', index.associations.sources.length <= 200], ['entities', index.associations.entities.length <= 200],
      ['relations', index.associations.relations.length <= 200]]) assert(bound, name + ' bound')
    pass('T119-03', 'projection-shape-bounds-on-real-payload', { pages: index.pages.length, associations: index.associations.sources.length })
    const boundsDepends = 'Flooding the projection to its caps (200 pages / 100 resolved links / 100 missing targets / 200 '
      + 'association rows) needs that many completed model-generated pages or model-extracted graph rows; links only '
      + 'derive from completed bodies, and completed pages are unreachable here for the dependency recorded on T119-01. '
      + 'The caps themselves are pinned end to end by the runtime and Server unit suites.'
    skipped('T119-03', 'missing-link-dead-end-presentation', completedDepends)
    skipped('T119-03', 'non-completed-target-not-clickable', completedDepends)
    skipped('T119-03', 'flood-bounds-200-100-100-200', boundsDepends)
    await page.screenshot({ path: path.join(state, 'T119-03-bounds.png'), fullPage: true })
    incomplete('T119-03')

    evidence.scenarios['T119-04'].status = 'incomplete'
    fs.writeFileSync(path.join(workspace, 'overview.md'), changed)
    row2 = await importUI(path.join(workspace, 'overview.md'))
    assert.equal(row2.revisionNo, 2); assert.notEqual(row2.manifestHash, row1.manifestHash)
    await clickEnabled('导航Wiki R1')
    await wait(async () => (await navHeader().count()) === 1, 'R1 index open beside R2 row')
    await clickEnabled('查看Wiki R2')
    await wait(async () => (await bodyText()).includes('版本 R2 · 尚未生成'), 'R2 plain list replaces the context')
    assert.equal(await navHeader().count(), 0, 'the R1 index closed with the revision change')
    assert.equal(await digestRows(sha(original)).count(), 0, 'no R1 page card survives the context change')
    await clickEnabled('导航Wiki R1')
    await wait(async () => (await navHeader().count()) === 1, 'R1 index reopens in its own context')
    assert.ok((await digestRows(sha(original)).count()) >= 1)
    assert.equal(await digestRows(sha(changed)).count(), 0, 'the R2 digest never renders inside the R1 index')
    await page.screenshot({ path: path.join(state, 'T119-04-context-reset.png'), fullPage: true })
    pass('T119-04', 'revision-context-change-resets-index-and-body', { R1: row1.manifestHash, R2: row2.manifestHash })
    await quit(); await launch('A')
    await clickEnabled('导航Wiki R1')
    await wait(async () => (await navHeader().count()) === 1, 'reopened session renders the old index')
    const reopened = call('A', 'GET', navRoute(row1.revisionId))
    assert.equal(reopened.status, 200); assert.equal(reopened.body.revision_no, 1)
    assert.equal(reopened.body.manifest_hash, row1.manifestHash)
    assert.ok((await digestRows(sha(original)).count()) >= 1)
    assert.equal(await digestRows(sha(changed)).count(), 0)
    await page.screenshot({ path: path.join(state, 'T119-04-reopen.png'), fullPage: true })
    pass('T119-04', 'reopen-old-session-binds-old-revision', { index: reopened.body })
    done('T119-04')

    evidence.readOnlyProof = { wikiPostsTotal: wikiPosts().length, posts: wikiPosts().map(row => ({ path: row.path, status: row.status })) }
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
function invoke(action, ...args) {
  const run = spawnSync(python, ['-I', path.join(root, 'scripts/acceptance/issue-102/profiles.py'), action, state, ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
save(); main().catch(error => { console.error(error); process.exitCode = 1 })
