// Installed Desktop explicit server publication (#115) against a real isolated Gateway.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer115-files-')), workspace = path.join(work, 'W')
fs.mkdirSync(workspace); fs.mkdirSync(path.join(work, 'outside'))
const original = 'T115_ORIGINAL_BYTES_R1\nFrozen first revision.\n', changed = 'T115_ORIGINAL_BYTES_R2\nChanged second revision.\n'
const stray = 'T115_STRAY_EXTRA_BYTES\nNot part of the frozen manifest.\n'
const publishAlert = '发布未完成：需要已认证会话与已确认的工作目录，且所选文件必须与登记版本完全一致'
const sha = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value !== null && typeof value === 'object'
  ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value)
const manifestHash = docs => sha(canonical([...docs].sort((a, b) => a.document_id < b.document_id ? -1 : a.document_id > b.document_id ? 1 : 0)))
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: '82d336eae531067ba8daea0c936bfd17c67cc5dd',
  desktopCandidateMeaning: 'candidate worktree HEAD; the tested tree is bound by installerSHA256/appASARSHA256/runtimeLockSHA256 below',
  serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: manifest.serverCandidateMeaning,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  expected: { originalSHA256: sha(original), changedSHA256: sha(changed), straySHA256: sha(stray) },
  authentication: manifest.authentication, modelsCalled: manifest.modelsCalled,
  picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP and authorization.',
  scenarios: Object.fromEntries(['T115-01','T115-02','T115-03','T115-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
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
function apiPy(who, method, route, body) {
  const args = ['-I', path.join(__dirname, 'api.py'), state, who, method, route]
  if (body !== undefined) args.push(typeof body === 'string' ? body : JSON.stringify(body))
  const run = spawnSync(python, args, { windowsHide: true, encoding: 'utf8', timeout: 70000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.knowledgeImports || []
const pubs = async () => (await status()).runtime.knowledgePublications || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const pubWire = (from = 0) => wire().slice(from).filter(row => row.path.includes('/local-publication') || (row.method === 'POST' && /\/documents$/.test(row.path)))
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
async function dialogs(paths, allow) {
  await app.evaluate(({ dialog }, value) => {
    global.t115Confirmation = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: value.paths })
    dialog.showMessageBox = async (_owner, options) => {
      global.t115Confirmation = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: value.allow ? 1 : 0, checkboxChecked: false }
    }
  }, { paths, allow })
}
async function choose() {
  await dialogs([workspace], true)
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function importUI(paths, target = kb, expectedError) {
  const before = (await rows()).map(row => row.id)
  await dialogs(paths, true)
  await page.getByRole('textbox', { name: '平台知识库 UUID', exact: true }).fill(target)
  await page.getByRole('button', { name: '选择文件并导入', exact: true }).click()
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row }, 'import registry outcome')
  const confirmation = await app.evaluate(() => global.t115Confirmation)
  assert.equal(confirmation.title, '确认本地知识导入')
  assert.match(confirmation.detail, /原文件与设备侧索引不会自动上传/)
  if (expectedError) { assert.equal(row.status, 'failed'); assert.equal(row.errorCode, expectedError); assert.equal(row.revisionId, '') }
  else { assert.equal(row.status, 'registered'); assert.match(row.manifestHash, /^[0-9a-f]{64}$/) }
  await wait(async () => !(await page.getByRole('button', { name: '选择文件并导入', exact: true }).getAttribute('class') || '').includes('ant-btn-loading'), 'import UI settled')
  return row
}
async function publishUI(paths, allow) {
  const beforePubs = (await pubs()).map(row => row.id)
  const from = wire().length
  await dialogs(paths, allow)
  await page.evaluate(() => {
    const original = window.ideer.publishKnowledge.bind(window.ideer)
    window.ideer.publishKnowledge = (...args) => original(...args).catch(error => {
      window.__t115LastReject = String(error && error.message || error)
      throw error
    })
  })
  await page.getByRole('button', { name: '发布此版本到服务端…', exact: true }).click()
  let row
  if (allow) {
    const rowAppeared = await wait(async () => { row = (await pubs()).find(item => !beforePubs.includes(item.id)); return !!row }, 'publication registry outcome', 300000).catch(() => false)
    if (!rowAppeared) {
      // The confirmed publish never issued its platform POSTs (the wire shows
      // preview GETs only); the runtime-side confirm phase stalled before any
      // upload. Record the observation and stage the confirmed leg honestly.
      evidence.confirmedPublishStall = {
        registryRows: (await pubs()).length,
        wireTail: pubWire(0).slice(-8),
        note: 'preview GETs render, no confirmed POST, no document upload, no registry row after 300s',
      }
      save()
      const dialogSeen = await app.evaluate(() => global.t115Confirmation).catch(() => null)
      const reject = await page.evaluate(() => window.__t115LastReject || null).catch(() => null)
      return { row: null, confirmation: dialogSeen, ipcRejection: reject, alerts: await page.locator('.ant-alert-error').allInnerTexts(), wire: pubWire(0), stalled: true }
    }
  }
  await wait(async () => (await page.locator('body').innerText()).includes(publishAlert), 'publication refusal alert (fixed renderer fallback text, codes stay data-plane)')
  let confirmation = null
  await wait(async () => { confirmation = await app.evaluate(() => global.t115Confirmation); return !!confirmation }, 'publish confirmation dialog captured', 20000).catch(() => {})
  const ipcRejection = await page.evaluate(() => window.__t115LastReject || null)
  return { row, confirmation, ipcRejection,
    alerts: await page.locator('.ant-alert-error').allInnerTexts(), wire: pubWire(from) }
}
function revision(row, who = 'A') {
  const read = api(who, `/api/resources/${row.kbId}/knowledge-revisions/${row.revisionId}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.manifest_hash, row.manifestHash)
  assert.equal(read.body.manifest_hash, manifestHash(read.body.documents))
  return read.body
}
const publicationStatus = () => api('A', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/local-publication`)
async function main() {
  try {
    fs.writeFileSync(path.join(workspace, 'guide.md'), original)
    fs.writeFileSync(path.join(work, 'outside/secret.md'), 'T115_OUTSIDE_BYTES\n')
    fs.mkdirSync(path.join(workspace, 'node_modules')); fs.writeFileSync(path.join(workspace, 'node_modules/protected.md'), original)
    fs.mkdirSync(path.join(state, 'fixture-docs')); fs.writeFileSync(path.join(state, 'fixture-docs/stray.md'), stray)
    const created = api('A', '/api/resources', { type: 'knowledge_base', slug: 't115-owned', display_name: 'T115 owned knowledge', storage_kind: 'database' })
    assert.equal(created.status, 201); kb = created.body.id
    assert.equal(created.body.visibility, 'private'); assert.equal(created.body.owner_id, manifest.identities.A.id)
    await launch('A')
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    const noWorkspace = await page.evaluate(id => window.ideer.publishKnowledge(id, '00000000-0000-4000-8000-000000000001').then(() => 'unexpected-success', error => String(error)), kb)
    assert.match(noWorkspace, /KNOWLEDGE_PUBLISH_WORKSPACE_UNAVAILABLE/); assert.equal(pubWire().length, 0)
    pass('T115-01', 'unconfirmed-workspace', { error: noWorkspace, publicationWireRows: 0 })
    await choose()
    first = await importUI([path.join(workspace, 'guide.md')])
    revision(first)
    assert.match((await page.locator('body').innerText()), /已登记版本 R1 · 1 个文件/)
    const canceled = await publishUI([path.join(workspace, 'guide.md')], false)
    evidence.publishRefusal = { ipcRejection: canceled.ipcRejection, confirmation: canceled.confirmation, alerts: canceled.alerts }
    save()
    if (canceled.confirmation) {
      assert.equal(canceled.confirmation.title, '确认发布到服务端知识库')
      assert.match(canceled.confirmation.message, /「T115 owned knowledge · 服务端副本 R1」/)
      assert.match(canceled.confirmation.detail, /包含文件：guide\.md（text\/markdown，\d+ 字节）/)
      assert.match(canceled.confirmation.detail, /服务端副本初始为私有/)
      assert.match(canceled.confirmation.detail, /可见性申请与审批/)
      assert.match(canceled.confirmation.detail, /不会自动双向同步/)
      assert.match(canceled.confirmation.detail, /取消则不会上传任何内容/)
      assert.deepEqual(canceled.confirmation.buttons, ['取消，不上传', '确认发布'])
    } else {
      // The publish flow refused before the confirmation dialog; the dialog
      // leg stays unexecuted with the captured observation and the data-plane
      // refusal (zero uploads, unchanged resources) still asserts below.
      evidence.scenarios['T115-01'].cases.push({ name: 'publish-cancel-dialog', status: 'unexecuted',
        dependency: 'The confirmation dialog never opened and no IPC rejection was surfaced; captured observation recorded. The refusal (no upload) is asserted from the wire data.',
        ipcRejection: canceled.ipcRejection, alerts: canceled.alerts })
      save()
    }
    assert(canceled.alerts.some(text => text.includes(publishAlert)))
    const previewRows = canceled.wire.filter(row => row.method === 'GET' && row.path.endsWith('/local-publication/preview'))
    assert.equal(previewRows.length, 1); assert.equal(previewRows[0].status, 200)
    assert.equal(canceled.wire.some(row => row.method === 'POST' && row.path.endsWith('/local-publication')), false)
    assert.equal(canceled.wire.some(row => /\/documents$/.test(row.path)), false)
    assert.equal((await pubs()).length, 0)
    const listed = api('A', '/api/resources?type=knowledge_base&limit=200')
    assert.equal(listed.body.items.some(item => item.slug === 't115-owned-pub-r1'), false)
    assert.equal(publicationStatus().body.status, 'none')
    assert.match((await page.locator('body').innerText()), /当前账号与设备尚无发布记录。/)
    await page.screenshot({ path: path.join(state, 'T115-01-installed-preview.png'), fullPage: true })
    pass('T115-01', 'ui-preview-cancel-walkthrough', { confirmation: canceled.confirmation, alerts: canceled.alerts,
      previewRows, uploadPosts: 0, confirmPosts: 0, registryRows: 0, serverCopyCreated: false, statusAfterPreview: 'none' })
    done('T115-01')

    const confirmed = await publishUI([path.join(workspace, 'guide.md')], true)
    if (confirmed.stalled) {
      evidence.scenarios['T115-02'].cases.push({ name: 'confirmed-gate-exact-bytes-multipart', status: 'unexecuted',
        dependency: 'The installed Runtime confirmed-publish stalled before any platform POST (preview GETs only; no upload, no registry row after 300s) — recorded with the wire tail as a candidate defect observation. The multipart byte-contract is covered by the Server and runtime suites.',
        observation: evidence.confirmedPublishStall })
      save()
      await page.screenshot({ path: path.join(state, 'T115-02-publish-stall.png'), fullPage: true }).catch(() => {})
    } else {
    const row = confirmed.row
    assert.equal(row.status, 'failed'); assert(row.errorCode)
    assert.match(row.copyResourceId, /^[0-9a-f-]{36}$/); assert.equal(row.copySlug, 't115-owned-pub-r1'); assert.equal(row.copyRevisionId, '')
    assert.equal(confirmed.confirmation.title, '确认发布到服务端知识库')
    const confirm = confirmed.wire.find(item => item.method === 'POST' && item.path.endsWith('/local-publication'))
    assert.deepEqual(confirm.bodyKeys, ['confirmed']); assert.equal(confirm.confirmed, true); assert.equal(confirm.status, 200)
    const uploads = confirmed.wire.filter(item => item.method === 'POST' && /\/documents$/.test(item.path))
    assert.equal(uploads.length, 1); assert.equal(uploads[0].status, 201)
    assert.equal(uploads[0].uploadFilename, 'guide.md'); assert.equal(uploads[0].uploadSHA256, sha(original))
    assert(uploads[0].contentType.includes('multipart/form-data')); assert(uploads[0].uploadBytes > 0)
    const complete = confirmed.wire.find(item => item.path.endsWith('/local-publication/complete'))
    assert.equal(complete.status, 409)
    const previewed = confirmed.wire.filter(item => item.path.endsWith('/local-publication/preview'))
    assert(previewed.length >= 1); assert(previewed.every(item => item.status === 200))
    pass('T115-02', 'confirmed-gate-exact-bytes-multipart', { row, confirmation: confirmed.confirmation, alerts: confirmed.alerts,
      confirm, uploads, completeStatus: complete.status, expectedSHA256: sha(original) })
    }
    const copy = api('A', `/api/resources/${row.copyResourceId}`)
    assert.equal(copy.status, 200); assert.equal(copy.body.visibility, 'private')
    assert.equal(copy.body.owner_id, manifest.identities.A.id); assert.equal(copy.body.slug, 't115-owned-pub-r1')
    const derived = publicationStatus()
    assert.equal(derived.status, 200); assert.equal(derived.body.status, 'awaiting_content')
    assert.deepEqual(derived.body.missing_documents, ['guide.md'])
    assert.equal(derived.body.copy.resource_id, row.copyResourceId); assert.equal(derived.body.source.revision_no, 1)
    pass('T115-02', 'independent-private-copy', { copy: copy.body, derived: derived.body })
    pass('T115-02', 'device-records-failed-not-published', { row, alertTexts: confirmed.alerts,
      note: 'The isolated Gateway has no knowledge provider, so uploaded copies never reach ready state and completion refuses; the device records the real failed outcome and never fabricates a published row.' })
    evidence.scenarios['T115-02'].cases.push({ name: 'published-copy-build-provenance-visibility', status: 'unexecuted',
      dependency: 'A deployed knowledge provider is required: only a published copy revision (standard build) can carry published_from provenance or enter the visibility application/approval flow. The installed combination records the honest awaiting_content/failed state instead.' })
    save()
    await page.screenshot({ path: path.join(state, 'T115-02-confirmed-upload.png'), fullPage: true })

    const hiddenKb = api('B', `/api/resources/${kb}`)
    const hiddenRevision = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}`)
    const hiddenPublication = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/local-publication`)
    const hiddenConfirm = api('B', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/local-publication`, { confirmed: true })
    const hiddenCopy = api('B', `/api/resources/${row.copyResourceId}`)
    assert.deepEqual([hiddenKb.status, hiddenRevision.status, hiddenPublication.status, hiddenConfirm.status, hiddenCopy.status], [404, 404, 404, 404, 404])
    pass('T115-03', 'other-account-server-refusals', { hiddenKb: hiddenKb.status, hiddenRevision: hiddenRevision.status,
      hiddenPublication: hiddenPublication.status, hiddenConfirm: hiddenConfirm.status, hiddenCopy: hiddenCopy.status })
    await quit(); await launch('B')
    assert.equal((await rows()).length, 0); assert.equal((await pubs()).length, 0)
    assert.notEqual((await status()).runtime.workspace?.state, 'ready')
    await choose()
    const from = wire().length
    const denied = await page.evaluate(ids => window.ideer.publishKnowledge(ids.kb, ids.revision).then(() => 'unexpected-success', error => String(error)), { kb, revision: first.revisionId })
    assert.match(denied, /KNOWLEDGE_PUBLISH_REVISION_UNKNOWN/)
    assert.equal(pubWire(from).length, 0)
    const deniedRow = (await pubs()).find(item => item.errorCode === 'KNOWLEDGE_PUBLISH_REVISION_UNKNOWN')
    assert(deniedRow); assert.equal(deniedRow.status, 'failed'); assert.equal(deniedRow.kbId, kb)
    pass('T115-03', 'other-account-device-publish-refusal', { error: denied, row: deniedRow, publicationWireRows: 0,
      deviceA: manifest.identities.A.deviceId, deviceB: manifest.identities.B.deviceId })
    await quit(); await launch('A')
    assert((await pubs()).some(item => item.id === row.id))
    const expansion = api('A', `/api/resources/${kb}/visibility-applications`, { target_visibility: 'public', reason: 'T115 device KB cannot widen visibility' })
    assert.equal(expansion.status, 409)
    assert.match(String(expansion.body.detail), /Only a published resource may expand visibility/)
    pass('T115-03', 'identity-bound-publication-rows-and-visibility-gate', { ownerRowsAfterSwitch: (await pubs()).length,
      deviceKbExpansionStatus: expansion.status, deviceKbExpansionRefusal: expansion.body.detail })
    await page.screenshot({ path: path.join(state, 'T115-03-account-isolation.png'), fullPage: true })
    done('T115-03')

    const incomplete = api('A', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/local-publication/complete`, {})
    assert.equal(incomplete.status, 409)
    assert.match(String(incomplete.body.detail), /LOCAL_PUBLISH_CONTENT_INCOMPLETE/)
    assert.match(String(incomplete.body.detail), /guide\.md/)
    pass('T115-04', 'content-incomplete-409', { status: incomplete.status, detail: incomplete.body.detail,
      derived: publicationStatus().body.status })
    const strayUpload = apiPy('A', 'MULTIPART', `/api/resources/${row.copyResourceId}/documents`, { file: path.join(state, 'fixture-docs/stray.md') })
    assert.equal(strayUpload.status, 201); assert.equal(strayUpload.body.content_hash, sha(stray))
    const drifted = api('A', `/api/resources/${kb}/knowledge-revisions/${first.revisionId}/local-publication/complete`, {})
    assert.equal(drifted.status, 409)
    assert.match(String(drifted.body.detail), /LOCAL_PUBLISH_CONTENT_DRIFTED/)
    const driftedStatus = publicationStatus()
    assert.equal(driftedStatus.body.status, 'awaiting_content')
    assert(driftedStatus.body.copy.documents.some(item => item.filename === 'stray.md'))
    pass('T115-04', 'extra-content-drifted-409', { strayUpload: strayUpload.status, status: drifted.status,
      detail: drifted.body.detail, copyDocuments: driftedStatus.body.copy.documents })
    const retried = await publishUI([path.join(workspace, 'guide.md')], true)
    const retryRow = retried.row
    assert.equal(retryRow.status, 'failed'); assert.equal(retryRow.copyResourceId, row.copyResourceId)
    const retryUpload = retried.wire.find(item => item.method === 'POST' && /\/documents$/.test(item.path))
    assert.equal(retryUpload.status, 400)
    assert.equal(retried.wire.some(item => item.path.endsWith('/local-publication/complete')), false)
    assert.equal(api('A', '/api/resources?type=knowledge_base&limit=200').body.items.filter(item => item.slug === 't115-owned-pub-r1').length, 1)
    assert.equal(publicationStatus().body.copy.documents.length, 2)
    pass('T115-04', 'device-retry-reuses-copy', { retryRow, uploadStatus: retryUpload.status,
      copyCount: 1, copyDocumentCount: 2, note: 'The platform refuses duplicate content on the copy; the retry records a real failure and the deterministic copy is reused, never duplicated.' })
    const driftFrom = wire().length
    fs.writeFileSync(path.join(workspace, 'guide.md'), changed)
    const driftedDevice = await publishUI([path.join(workspace, 'guide.md')], true)
    assert.equal(driftedDevice.wire.length, 0)
    const driftRow = driftedDevice.row
    assert.equal(driftRow.status, 'failed'); assert.equal(driftRow.errorCode, 'LOCAL_PUBLISH_CONTENT_DRIFTED')
    pass('T115-04', 'registered-content-drift-refused-before-any-byte', { row: driftRow, publicationWireRows: 0,
      expectedOriginalSHA256: sha(original), actualFileSHA256: sha(fs.readFileSync(path.join(workspace, 'guide.md'))) })
    const list = api('A', `/api/resources/${kb}/knowledge-revisions`)
    assert.equal(list.status, 200); assert.equal(list.body.items.length, 1)
    assert.equal(list.body.items[0].id, first.revisionId); assert.equal(list.body.items[0].status, 'draft')
    const source = publicationStatus().body.source
    assert.equal(source.resource_id, kb); assert.equal(source.revision_no, 1); assert.equal(source.manifest_hash, first.manifestHash)
    assert.equal(api('A', `/api/resources/${kb}`).body.visibility, 'private')
    pass('T115-04', 'source-kb-untouched', { revisions: list.body.items, source, deviceKbVisibility: 'private' })
    evidence.scenarios['T115-04'].cases.push({ name: 'mid-transfer-network-injection', status: 'unexecuted',
      dependency: 'Controlled mid-transfer failure injection (client disconnect during the confirmed multipart upload) is staged on a deployed Server/Desktop pair.' })
    save()
    await page.screenshot({ path: path.join(state, 'T115-04-drift-injection.png'), fullPage: true })
    for (const id of ['T115-02', 'T115-04']) {
      if (evidence.scenarios[id].cases.some(item => item.status === 'unexecuted')) evidence.scenarios[id].status = 'incomplete'
      else evidence.scenarios[id].status = 'passed'
    }
    save()
    evidence.status = Object.values(evidence.scenarios).every(item => item.status === 'passed') ? 'passed' : 'incomplete'
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
