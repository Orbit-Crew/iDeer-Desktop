// Installed Desktop and bundled Runtime against a real isolated Gateway.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer112-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace); fs.mkdirSync(path.join(work, 'outside'))
const original = 'T112_ORIGINAL_BYTES_R1\nFrozen first revision.\n', changed = 'T112_ORIGINAL_BYTES_R2\nChanged second revision.\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const manifestHash = docs => sha(canonical([...docs].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)))
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: 'b64e51d4a7f20740337dcbf7ac6c00544282b379', serverCandidate: manifest.serverCandidate,
  serverSourceSHA256: manifest.serverSourceSHA256, serverCandidateMeaning: manifest.serverCandidateMeaning,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  expected: { originalSHA256: sha(original), changedSHA256: sha(changed) },
  authentication: manifest.authentication, picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP and authorization.',
  scenarios: Object.fromEntries(['T112-01','T112-02','T112-03','T112-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, label = 'A', kb, first, second
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
const posts = () => wire().filter(row => row.method === 'POST' && row.path.endsWith('/knowledge-revisions/local-imports'))
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
      global.t112Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
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
  const confirmation = await app.evaluate(() => global.t112Confirmation)
  assert.equal(confirmation.title, '确认本地知识导入')
  assert.match(confirmation.detail, /原文件与设备侧索引不会自动上传/)
  if (expectedError) { assert.equal(row.status, 'failed'); assert.equal(row.errorCode, expectedError); assert.equal(row.revisionId, ''); assert.equal(row.manifestHash, '') }
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
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), original)
    fs.writeFileSync(path.join(work, 'outside/secret.md'), 'T112_OUTSIDE_BYTES\n')
    fs.mkdirSync(path.join(workspace, 'node_modules')); fs.writeFileSync(path.join(workspace, 'node_modules/protected.md'), original)
    fs.writeFileSync(path.join(workspace, '.env'), 'T112_SYNTHETIC_SECRET=unused')
    fs.symlinkSync(path.join(work, 'outside'), path.join(workspace, 'junction'), 'junction')
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't112-owned', display_name: 'T112 owned knowledge', storage_kind: 'database' })
    assert.equal(created.status, 201); kb = created.body.id
    assert.equal(created.body.visibility, 'private'); assert.equal(created.body.owner_id, manifest.identities.A.id)
    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    const noWorkspace = await page.evaluate(kb => window.ideer.importKnowledge(kb).then(() => 'unexpected-success', error => String(error)), kb)
    assert.match(noWorkspace, /KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE/); assert.equal(posts().length, 0)
    pass('T112-02', 'unconfirmed-workspace', { error: noWorkspace, posts: 0 })
    await choose()
    const imported = await importUI([path.join(workspace, 'guide.md')]); first = imported.row
    const r1 = revision(first)
    assert.equal(r1.documents[0].content_hash, sha(original))
    const request = posts().at(-1)
    assert.deepEqual(request.bodyKeys, ['device_id', 'documents']); assert.equal(request.status, 201)
    assert.deepEqual(Object.keys(request.documents[0]).sort(), ['content_hash', 'filename', 'mime_type', 'size_bytes'])
    assert.equal(request.containsOriginalMarker, false); assert(request.bytes < Buffer.byteLength(original) + 2048)
    assert.equal(request.documents[0].content_hash, sha(original)); assert.equal(request.documents[0].filename, 'guide.md')
    assert.equal(request.deviceId, manifest.identities.A.deviceId)
    const list = api('A', `/api/resources/${kb}/knowledge-revisions`)
    assert.equal(list.status, 200); assert(list.body.items.some(row => row.id === first.revisionId))
    await page.screenshot({ path: path.join(state, 'T112-01-installed-import.png'), fullPage: true })
    pass('T112-01', 'identity-only-import-through-installed-ui', { row: first, revision: r1, request, confirmation: imported.confirmation, owner: created.body.owner_id, visibility: created.body.visibility })
    done('T112-01')

    for (const [name, filename, expected] of [
      ['protected', path.join(workspace, 'node_modules/protected.md'), 'KNOWLEDGE_IMPORT_PROTECTED_PATH'],
      ['unsupported', path.join(workspace, '.env'), 'KNOWLEDGE_IMPORT_UNSUPPORTED_TYPE'],
      ['outside', path.join(work, 'outside/secret.md'), 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS'],
      ['junction', path.join(workspace, 'junction/secret.md'), 'KNOWLEDGE_IMPORT_OUTSIDE_ALLOWED_ROOTS']
    ]) {
      const isolated = api('A', '/api/resources', { type: 'knowledge_base', slug: 't112-refuse-' + name, display_name: 'T112 refusal ' + name, storage_kind: 'database' })
      assert.equal(isolated.status, 201)
      const before = posts().length, rejected = await importUI([filename], isolated.body.id, expected)
      assert.equal(posts().length, before)
      const empty = api('A', `/api/resources/${isolated.body.id}/knowledge-revisions`)
      assert.equal(empty.status, 200); assert.equal(empty.body.items.length, 0)
      pass('T112-02', name, { row: rejected.row, registrationPostsAdded: 0, serverRevisionCount: 0 })
    }
    const hidden = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}`)
    assert.equal(hidden.status, 404)
    pass('T112-02', 'other-account-server-refusal', { status: hidden.status })
    done('T112-02')

    fs.writeFileSync(path.join(workspace, 'guide.md'), changed)
    second = (await importUI([path.join(workspace, 'guide.md')])).row
    const r2 = revision(second), frozen = revision(first)
    assert.notEqual(first.revisionId, second.revisionId); assert.notEqual(first.manifestHash, second.manifestHash)
    assert.equal(second.revisionNo, first.revisionNo + 1)
    assert.equal(r2.documents[0].content_hash, sha(changed)); assert.equal(frozen.documents[0].content_hash, sha(original))
    pass('T112-03', 'immutable-R1-and-R2', { first: frozen, second: r2, actualFileSHA256: sha(fs.readFileSync(path.join(workspace, 'guide.md'))) })
    let publicationChecksComplete = true
    for (const action of ['prepare', 'publish']) {
      const unavailable = api('A', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/${action}`, {})
      if (unavailable.status === 503) {
        publicationChecksComplete = false
        evidence.scenarios['T112-03'].cases.push({ name: 'draft-local-import-' + action + '-refusal', status: 'unexecuted',
          expectedStatus: 409, actualStatus: unavailable.status, body: unavailable.body,
          dependency: 'A real configured knowledge provider is required before the facade reaches local-import validation. This response is not counted as the expected 409.' })
        save(); continue
      }
      assert.equal(unavailable.status, 409)
      pass('T112-03', 'draft-local-import-' + action + '-unavailable', { status: unavailable.status, body: unavailable.body })
    }
    if (publicationChecksComplete) done('T112-03')
    else { evidence.scenarios['T112-03'].status = 'incomplete'; save() }

    await quit(); await launch('A')
    const restored = await rows()
    assert(restored.some(row => row.revisionId === first.revisionId && row.manifestHash === first.manifestHash))
    assert(restored.some(row => row.revisionId === second.revisionId && row.manifestHash === second.manifestHash))
    pass('T112-04', 'installed-owner-restart', { revisions: restored.filter(row => row.status === 'registered') })
    await quit(); await launch('B')
    assert.equal((await rows()).length, 0); assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    const otherList = api('B', `/api/resources/${kb}/knowledge-revisions`)
    assert.equal(otherList.status, 404)
    await choose()
    const denied = await importUI([path.join(workspace, 'guide.md')], kb, 'CHAT_NOT_FOUND')
    assert.equal(denied.row.revisionNo, 0)
    pass('T112-04', 'account-and-device-isolation', { rowsBefore: 0, hiddenListStatus: 404, refusal: denied.row, deviceA: manifest.identities.A.deviceId, deviceB: manifest.identities.B.deviceId })
    await quit(); await launch('A')
    const postCount = posts().length
    fs.renameSync(workspace, path.join(work, 'W-original')); fs.mkdirSync(workspace)
    fs.writeFileSync(path.join(workspace, 'guide.md'), 'T112_REPLACED_DIRECTORY')
    await dialogs([path.join(workspace, 'guide.md')])
    const drift = await page.evaluate(kb => window.ideer.importKnowledge(kb).then(() => 'unexpected-success', error => String(error)), kb)
    assert.match(drift, /KNOWLEDGE_IMPORT_WORKSPACE_UNAVAILABLE/); assert.equal(posts().length, postCount)
    pass('T112-04', 'workspace-generation-drift', { error: drift, registrationPostsAdded: 0, R1: revision(first), R2: revision(second) })
    done('T112-04')
    assert.equal(posts().some(row => row.containsOriginalMarker), false)
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
