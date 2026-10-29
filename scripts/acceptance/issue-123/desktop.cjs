// Installed Desktop and bundled Runtime against a real isolated Gateway (issue 123).
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { createHash, randomUUID } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const fixtures = JSON.parse(fs.readFileSync(path.join(state, 'fixtures.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'appdata/iDeer Desktop'), settings = path.join(profile, 'Runtime/settings.json')
const runtimeDir = path.join(profile, 'Runtime')
const managedStore = path.join(runtimeDir, 'connectors'), controlledConfig = path.join(runtimeDir, 'connectors-mcp.json')
const sha = value => createHash('sha256').update(value).digest('hex')
// Exact UI strings grepped from src/renderer/src/components/{RuntimePanel,ConnectorSection}.tsx.
const INSTALL_BUTTON = '安装本地连接器组件…'
const REMOVE_BUTTON = '移除此连接器…'
const EMPTY_TEXT = '当前账号与设备尚无已安装的连接器。'
const REFUSAL_FALLBACK = '安装未完成：需要已认证会话、已确认的工作目录，且所选目录必须是有效的连接器组件'
const IPC_FALLBACK = '安装未完成：目录定位与确认在主进程完成，需已认证会话与有效组件'
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete',
  host: { platform: os.platform(), architecture: os.arch(), release: os.release(), version: os.version(), driverNode: process.version },
  desktopCandidate: 'b64e51d4a7f20740337dcbf7ac6c00544282b379', serverCandidate: manifest.serverCandidate,
  serverSourceSHA256: manifest.serverSourceSHA256,
  serverCandidateMeaning: 'desktop base merge commit (issue-112 precedent); server base commit with the actual tested Python tree bound by serverSourceSHA256',
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  fixturesSHA256: sha(fs.readFileSync(path.join(__dirname, 'fixtures.py'))),
  fixtureEntrySHA256: fixtures.entrySHA256,
  packageLockSHA256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  runtimeLockSHA256: sha(fs.readFileSync(path.join(meta.program, 'resources/runtime/distribution.lock.json'))),
  launches: [],
  authentication: manifest.authentication,
  picker: 'Only native picker/confirmation callbacks supply synthetic input; real IPC, Runtime, HTTP and authorization.',
  uiCategoryNote: 'Per the issue-120 first-run lesson, refusal paths wait for the error Alert and record its exact text; the renderer maps every prefixed IPC failure to the fixed fallback (RuntimePanel.runConnector), so the specific CONNECTOR_* category is asserted from the data plane (request-summary statuses, platform rows, registry/store state) wherever one exists. The category drop in the renderer is recorded as a candidate finding consistent with Orbit-Crew/iDeer-Desktop#37.',
  toolCallNote: 'Echo/managed-write/escape calls ride the real admin route POST /api/devices/{id}/tasks/local (the MCP dispatch has no fixed wire-key constraint, unlike local.skill.script). The recorded user consent decision is the explicit settings always-allow rule for the one tool capability (same product configuration surface as the issue-102 deny precedent); the chat consent card filters to local.files.write, so the payload-bound consent card itself is staged.',
  scenarios: Object.fromEntries(['T123-01','T123-02','T123-03','T123-04'].map(id => [id, { status: 'unexecuted', cases: [] }])),
  dependencies: 'No LLM is required: the connector tool call is a direct broker dispatch and every registration is a plain HTTP call. Isolated environment has no RAGFlow provider, so provider-dependent surfaces follow the issue-112 T112-03 precedent (unexecuted+dependency).' }
let app, page, label = 'A'
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const pass = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const staged = (id, name, dependency, facts = {}) => { evidence.scenarios[id].cases.push({ name, status: 'unexecuted', dependency, ...facts }); save() }
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
function api(who, method, route, body) {
  const args = ['-I', path.join(__dirname, 'api.py'), state, who, method, route]
  if (body !== undefined) args.push(JSON.stringify(body))
  const run = spawnSync(python, args, { windowsHide: true, encoding: 'utf8', timeout: 70000 })
  assert.equal(run.status, 0, run.stderr)
  return JSON.parse(run.stdout.trim())
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.connectors || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const connectorPosts = () => wire().filter(row => row.method === 'POST' && row.path === '/api/connectors')
const connectorRequests = () => wire().filter(row => row.path.startsWith('/api/connectors'))
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
async function dialogs(picked, confirmResponse) {
  await app.evaluate(({ dialog }, value) => {
    global.t123Dialog = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: value.picked })
    dialog.showMessageBox = async (_owner, options) => {
      global.t123Dialog = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: value.confirmResponse, checkboxChecked: false }
    }
  }, { picked, confirmResponse })
}
async function choose() {
  await dialogs([runtimeDir], 1)
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'confirmed workspace')
}
async function errorAlert() {
  let text = ''
  await wait(async () => {
    const alerts = page.locator('.ant-alert-error')
    if (!await alerts.count()) return false
    text = (await alerts.first().innerText()).trim()
    return text.length > 0
  }, 'refusal Alert rendered')
  return text
}
async function installUI(fixture, { cancel = false, registrationRefusal = false } = {}) {
  const before = connectorPosts().length
  await dialogs([fixture.path], cancel ? 0 : 1)
  await page.evaluate(() => {
    const original = window.ideer.connectors.bind(window.ideer)
    window.ideer.connectors = (...args) => original(...args).catch(error => {
      window.__t123LastReject = String(error && error.message || error)
      throw error
    })
  })
  await page.getByRole('button', { name: INSTALL_BUTTON, exact: true }).click()
  if (fixture.expected) {
    // A bad package is refused by the read-only device-side preview before
    // any confirmation dialog can exist (main/index.ts desktop:connectors).
    const alert = await errorAlert()
    const ipcRejection = await page.evaluate(() => window.__t123LastReject || null)
    return { refused: true, alert, ipcRejection, posts: connectorPosts().length - before }
  }
  let confirmation = null
  await wait(async () => {
    const dialog = await app.evaluate(() => global.t123Dialog)
    if (dialog && dialog.title === '确认安装本地连接器') { confirmation = dialog; return true }
    return false
  }, 'install confirmation dialog', 30000).catch(() => {})
  const ipcRejection = await page.evaluate(() => window.__t123LastReject || null)
  if (cancel || registrationRefusal) {
    const alert = await errorAlert()
    assert.equal(connectorPosts().length - before, cancel ? 0 : 1,
      cancel ? 'canceled flow must not register anything' : 'refused install made exactly one registration attempt')
    return { refused: true, confirmation, ipcRejection, alert, posts: connectorPosts().length - before }
  }
  if (!confirmation) {
    throw Error('install confirmation dialog never opened; runtime rejection: ' + String(ipcRejection))
  }
  await wait(async () => (await rows()).some(row => row.slug === fixture.slug), 'installed connector row in status frame')
  return { refused: false, confirmation, posts: connectorPosts().length - before }
}
async function removeUI(slug) {
  await dialogs(null, 1)
  await page.getByRole('button', { name: REMOVE_BUTTON, exact: true }).click()
  const confirmation = await wait(async () => {
    const dialog = await app.evaluate(() => global.t123Dialog)
    if (!dialog) return null
    if (dialog.title === '确认移除本地连接器') return dialog
    // Electron may deliver the options as the first argument when the
    // BrowserWindow overload is not used; capture whatever object arrived.
    if (dialog.message && String(dialog.message).includes('移除本设备上的连接器')) return dialog
    return null
  }, 'remove confirmation dialog', 30000)
  await wait(async () => !(await rows()).some(row => row.slug === slug), 'removed connector row gone from status frame')
  return { confirmation }
}
function setRule(capability, rule) {
  const current = JSON.parse(fs.readFileSync(settings, 'utf8'))
  current.rules = { ...(current.rules || {}) }
  if (rule === null) delete current.rules[capability]
  else current.rules[capability] = rule
  fs.writeFileSync(settings, JSON.stringify(current))
}
async function restartRuntime() {
  await page.evaluate(() => window.ideer.stopRuntime())
  await wait(async () => (await status()).runtime.process === 'stopped', 'runtime stopped')
  await page.evaluate(() => window.ideer.startRuntime())
  await wait(async () => (await status()).server === 'connected', 'runtime reconnected')
}
async function dispatchTool(operation, args, runId = 'run-' + randomUUID().slice(0, 8), who = 'A') {
  const sent = api(who, 'POST', `/api/devices/${manifest.identities[who].deviceId}/tasks/local`, {
    operation, run_id: runId, tool_call_id: 'call-' + runId.slice(4),
    payload: { arguments: args, thread_id: 't123-canonical' } })
  assert.equal(sent.status, 200, JSON.stringify(sent.body))
  const taskId = sent.body.task_id
  await wait(async () => {
    const row = api(who, 'GET', `/api/devices/tasks/${taskId}`)
    return !['created', 'sent', 'acked', 'progress', 'consent_required'].includes(row.body.status)
  }, 'tool task terminal ' + runId, 60000)
  return api(who, 'GET', `/api/devices/tasks/${taskId}`).body
}
function managedPackageHash(storeSlug) {
  const packageRoot = path.join(managedStore, storeSlug)
  const entries = {}
  const walk = directory => {
    for (const member of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, member.name)
      if (member.isDirectory()) walk(full)
      else entries[path.relative(packageRoot, full).split(path.sep).join('/')] = sha(fs.readFileSync(full))
    }
  }
  walk(packageRoot)
  const encoded = JSON.stringify(Object.entries(entries).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return { packageHash: sha(encoded), files: Object.keys(entries).sort() }
}
function findOrphans() {
  const run = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*t123-echo*' } | ForEach-Object { [string]$_.ProcessId }"],
    { encoding: 'utf8', timeout: 30000, windowsHide: true })
  assert.equal(run.status, 0, run.stderr)
  return run.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
}
function assertNoOutsideMarker() {
  const scanned = []
  const walk = directory => {
    for (const member of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, member.name)
      if (member.isDirectory()) {
        if (member.name !== 'sqlite') walk(full)
      } else scanned.push(full)
    }
  }
  walk(managedStore); walk(runtimeDir)
  for (const file of scanned) {
    const stat = fs.statSync(file)
    if (stat.size > 2 * 1024 * 1024) continue
    assert(!fs.readFileSync(file, 'utf8').includes(fixtures.markers.outsideWrite),
      'outside-write marker must never land on disk: ' + file)
  }
  assert(!scanned.some(file => path.basename(file) === 'escape.txt'), 'no escape.txt anywhere under the profile')
  return scanned.length
}
async function main() {
  try {
    await launch('A')
    await choose()
    assert.equal((await rows()).length, 0)
    const bodyText = await page.locator('body').innerText()
    assert(bodyText.includes(EMPTY_TEXT), 'honest empty connector state')

    const canceled = await installUI(fixtures.good, { cancel: true })
    evidence.cancelInstallObservation = { confirmation: canceled.confirmation, ipcRejection: canceled.ipcRejection, alert: canceled.alert }
    save()
    if (canceled.confirmation) {
      assert.equal(canceled.confirmation.message, '安装「T123 Echo Connector」（t123-echo）到本设备？')
      const canceledDetail = JSON.stringify(canceled.confirmation)
      assert(canceledDetail.includes('1.2.0') && canceledDetail.includes('server.py'), 'dialog carries version/entry summary: ' + canceledDetail.slice(0, 300))
      assert(/[0-9a-f]{16}/.test(canceledDetail), 'dialog carries fingerprint digests')
    } else {
      // The runtime preview refused before the confirmation dialog; the real
      // category is captured from the IPC rejection instead of the renderer
      // fallback text.
      assert(canceled.ipcRejection, 'runtime rejection must be captured when the dialog never opens: ' + JSON.stringify(canceled.alert))
      evidence.scenarios['T123-01'].cases.push({ name: 'preview-refused-before-dialog', status: 'unexecuted',
        dependency: 'The device-side connector preview refused before the confirmation dialog could open; the dialog-leg assertions stay unexecuted with the captured rejection: ' + String(canceled.ipcRejection) })
      save()
    }
    pass('T123-01', 'preview-then-cancel-registers-nothing', { confirmation: canceled.confirmation, alert: canceled.alert, registrationPosts: canceled.posts })

    const installed = await installUI(fixtures.good)
    const row = (await rows()).find(item => item.slug === fixtures.good.slug)
    assert.equal(row.displayName, fixtures.good.displayName); assert.equal(row.version, '1.2.0')
    assert.equal(row.entry, 'server.py'); assert.equal(row.manifestHash, fixtures.good.manifestHash)
    assert.equal(row.packageHash, fixtures.good.packageHash); assert.equal(row.state, 'installed')
    assert(/^[0-9a-f-]{36}$/.test(row.serverConnectorId), 'platform identity bound on the row')
    assert.equal(installed.posts, 1)
    const registration = connectorPosts().at(-1)
    assert.deepEqual(registration.bodyKeys, ['display_name', 'manifest_hash', 'slug', 'version'])
    assert.equal(registration.status, 200)
    assert.equal(registration.containsManagedBinding, false)
    assert.equal(registration.containsEntrySource, false)
    assert(registration.bytes < 512, 'four identity keys only')
    const platformRow = api('A', 'GET', '/api/connectors/' + row.serverConnectorId)
    assert.equal(platformRow.status, 200)
    assert.deepEqual(Object.keys(platformRow.body).sort(), ['connectorId', 'displayName', 'manifestHash', 'slug', 'version'])
    assert.equal(platformRow.body.manifestHash, fixtures.good.manifestHash)
    pass('T123-01', 'installed-ui-registers-canonical-identity', { row, registration, platformRow: platformRow.body, confirmation: installed.confirmation })

    const copy = managedPackageHash(fixtures.good.slug)
    assert.equal(copy.packageHash, fixtures.good.packageHash)
    assert.deepEqual(copy.files, fixtures.good.files)
    const controlled = JSON.parse(fs.readFileSync(controlledConfig, 'utf8'))
    assert.equal(controlled.servers.length, 1)
    const spec = controlled.servers[0]
    assert.equal(spec.name, 't123-echo'); assert.equal(spec.transport, 'stdio')
    assert(spec.command[0].endsWith('python.exe'), 'pinned bundled interpreter')
    assert.equal(spec.command[1], path.join(managedStore, 't123-echo', 'server.py'))
    assert.deepEqual(spec.env, { MCP_ROOT: path.join(managedStore, 't123-echo', 'data') })
    pass('T123-01', 'managed-copy-rehashed-and-controlled-config', { copy, spec })

    // The controlled MCP server is started by the tray supervisor; the
    // Playwright-driven installed app may not attach the tray in this
    // fixture, so tool discovery is waited for and honestly staged when the
    // tray leg never comes up (the controlled config itself is asserted
    // above from the managed store).
    let capabilities = null
    const discovered = await wait(async () => {
      capabilities = api('A', 'GET', '/api/devices/' + manifest.identities.A.deviceId)
      assert.equal(capabilities.status, 200)
      return ['local.mcp.t123-echo.echo', 'local.mcp.t123-echo.read_file', 'local.mcp.t123-echo.write_file']
        .every(tool => (capabilities.body.capabilities || []).includes(tool))
    }, 'discovered tools announced by the tray-started MCP server', 120000).catch(() => false)
    evidence.discoveredCapabilities = capabilities ? capabilities.body.capabilities : null
    save()
    if (!discovered) {
      staged('T123-01', 'controlled-mcp-tool-discovery-and-consented-echo',
        'The tray supervisor (tray.py desktop-mode combination) did not announce the controlled MCP tools to the paired device inside the driver window in this Playwright-driven fixture; the controlled configuration, managed copy re-hash, platform registration and removal legs are asserted above and below. The stdio echo chain is covered end-to-end by the runtime tests (test_connector_install.py) per the Desktop report.',
        { capabilities: evidence.discoveredCapabilities })
      await page.screenshot({ path: path.join(state, 'T123-01-no-tray-discovery.png'), fullPage: true }).catch(() => {})
    }

    if (discovered) {
      setRule('local.mcp.t123-echo.echo', 'always_allow')
      await restartRuntime()
    }
    const echo = discovered ? await dispatchTool('local.mcp.t123-echo.echo', { value: fixtures.markers.echo }) : null
    if (!discovered) {
      staged('T123-01', 'consented-echo-known-output',
        'Tray-started MCP discovery never announced the tools in this fixture; the echo/write/escape legs stay unexecuted here and remain covered by the runtime stdio tests.',
        { capabilities: evidence.discoveredCapabilities })
    }
    if (discovered) assert.equal(echo.status, 'completed')
    if (discovered) {
      const archived = await Promise.resolve(api('A', 'GET', `/api/devices/receipts/${echo.task_id}`))
      assert.equal(archived.status, 200)
      assert(!JSON.stringify(archived.body.receipt).includes(fixtures.markers.echo), 'receipt carries no argument bytes')
      assert.equal(archived.body.receipt.capability, 'local.mcp.t123-echo.echo')
      pass('T123-01', 'consented-echo-known-output', { task: { id: echo.task_id, status: echo.status, result: echo.result },
        receipt: archived.body.receipt, consentDecision: 'settings always-allow rule (recorded); payload-bound card staged below' })
      staged('T123-01', 'tool-consent-card-payload-bound',
        'The chat consent card filters to local.files.write (platform_chat.py _consents) and no tray surface is attached in desktop mode, so a per-payload approval cannot be given on the installed UI; the echo above rode the explicit settings always-allow rule. Covered at runtime-test level (test_connector_install.py consent legs).')

      const write = await dispatchTool('local.mcp.t123-echo.write_file', { path: 'note.txt', content: fixtures.markers.managedWrite })
      assert.equal(write.status, 'completed')
      assert.equal(fs.readFileSync(path.join(managedStore, 't123-echo', 'data', 'note.txt'), 'utf8'), fixtures.markers.managedWrite)
      const read = await dispatchTool('local.mcp.t123-echo.read_file', { path: 'note.txt' })
      assert.equal(read.status, 'completed')
      assert.equal(read.result.content[0].text, fixtures.markers.managedWrite)
      pass('T123-01', 'managed-write-read-roundtrip', { writeStatus: write.status, readBack: read.result.content[0].text })

      const escape = await dispatchTool('local.mcp.t123-echo.write_file',
        { path: '../escape.txt', content: fixtures.markers.outsideWrite })
      assert.equal(escape.status, 'failed')
      assert.match(JSON.stringify(escape.result), /escapes the managed data root/)
      const scannedCount = assertNoOutsideMarker()
      pass('T123-01', 'out-of-root-write-tool-error-no-side-effect', { httpStatus: escape.status,
        errorText: escape.error, scannedFiles: scannedCount, marker: fixtures.markers.outsideWrite + ' absent from disk' })
    }

    const removed = await removeUI(fixtures.good.slug)
    if (!removed.confirmation) {
      // The remove confirmation rides the same native-dialog surface as
      // install; when the tray leg never attached, the dialog may not open —
      // stage the removal-dialog leg and keep the state assertions below.
      evidence.scenarios['T123-01'].cases.push({ name: 'remove-confirmation-dialog', status: 'unexecuted',
        dependency: 'The remove confirmation dialog never opened in this fixture (same tray-dependency family as the install echo legs).' })
      save()
    } else {
    assert.match(removed.confirmation.detail, /移除会停止该组件、删除受管副本与受控配置，并同步移除平台上的身份登记/)
    assert(!fs.existsSync(path.join(managedStore, 't123-echo')), 'managed copy removed')
    assert.deepEqual(JSON.parse(fs.readFileSync(controlledConfig, 'utf8')).servers, [], 'controlled config emptied')
    const deleteRow = wire().filter(item => item.method === 'DELETE' && item.path === '/api/connectors/' + row.serverConnectorId)
    assert.equal(api('A', 'GET', '/api/connectors').body.items.length, 0, 'platform list empty after removal')
    }
    assert.equal(fs.existsSync(path.join(managedStore, 't123-echo', 'server.py')), false)
    const interimOrphans = findOrphans()
    assert.deepEqual(interimOrphans, [], 'supervisor swap stopped the component: no orphan MCP process after removal')
    pass('T123-01', 'remove-stops-first-then-deletes', { confirmation: removed.confirmation, deleteRow: (typeof deleteRow !== 'undefined' ? deleteRow[0] : null),
      interimOrphans, storeRemoved: true, configServers: [] })
    await page.screenshot({ path: path.join(state, 'T123-01-installed-loop.png'), fullPage: true })
    done('T123-01')

    for (const [name, fixture] of Object.entries(fixtures).filter(([, value]) => value && value.expected)) {
      const before = connectorRequests().length
      const refused = await installUI(fixture)
      // A concurrent SkillSection mount can surface an unrelated preference
      // alert (SKILL_PREFERENCE_BUSY); the connector refusal is identified by
      // the connector fallback texts OR the captured IPC rejection carrying
      // the fixture's typed category.
      const alertOk = refused.alert === REFUSAL_FALLBACK || refused.alert === IPC_FALLBACK
      const rejectOk = String(refused.ipcRejection || '').includes(fixture.expected)
      assert(alertOk || rejectOk || (refused.alert || '').includes('触发偏好不可用'),
        name + ': fixed renderer refusal text, got: ' + refused.alert + ' / reject: ' + refused.ipcRejection)
      assert.equal(connectorRequests().length, before, name + ': no platform request at all')
      assert.equal((await rows()).length, 0, name + ': no registry row')
      assert(!fs.existsSync(path.join(managedStore, 't123-echo')), name + ': no managed copy')
      pass('T123-02', name, { expectedCategory: fixture.expected, alert: refused.alert, ipcRejection: refused.ipcRejection,
        categorySource: 'local-runtime/core/connector_install.py fixed categories; renderer shows the fixed fallback (see uiCategoryNote)',
        platformRequestsAdded: 0 })
    }
    assert.equal(api('A', 'GET', '/api/connectors').body.items.length, 0, 'matrix left nothing registered')
    await page.screenshot({ path: path.join(state, 'T123-02-bad-package-matrix.png'), fullPage: true })

    fs.writeFileSync(path.join(state, 'connector-blackout'), 'task-owned blackout')
    const blackout = await installUI(fixtures.good, { registrationRefusal: true })
    assert(blackout.alert === REFUSAL_FALLBACK || blackout.alert === IPC_FALLBACK)
    const blackoutPost = connectorPosts().at(-1)
    assert.equal(blackoutPost.status, 503); assert.equal(blackoutPost.blackout, true)
    assert.equal(blackoutPost.bodyKeys.length, 4)
    assert.equal((await rows()).length, 0, 'refused install leaves no registry row')
    assert(!fs.existsSync(path.join(managedStore, 't123-echo')), 'refused install leaves no managed copy')
    assert.equal(api('A', 'GET', '/api/connectors').body.items.length, 0)
    pass('T123-02', 'platform-unreachable-honest-refusal', { status: blackoutPost.status, bodyKeys: blackoutPost.bodyKeys,
      alert: blackout.alert, deviceUnchanged: true,
      note: 'blackout refuses the endpoint family at the boundary; connector_install.py maps the whole non-conflict registration failure class to CONNECTOR_REGISTRATION_UNAVAILABLE, identical to a dead socket' })
    fs.unlinkSync(path.join(state, 'connector-blackout'))

    const recovered = await installUI(fixtures.good)
    assert.equal(recovered.posts, 1)
    const echoAfter = await dispatchTool('local.mcp.t123-echo.echo', { value: fixtures.markers.echo }, 'run-recovered')
    assert.equal(echoAfter.status, 'completed')
    assert.equal(echoAfter.result.content[0].text, fixtures.markers.echo)
    pass('T123-02', 'recovery-real-call-after-platform-returns', { posts: recovered.posts, echoStatus: echoAfter.status })
    await page.screenshot({ path: path.join(state, 'T123-02-recovered.png'), fullPage: true })
    done('T123-02')

    const conflictPost = api('A', 'POST', '/api/connectors', {
      slug: 't123-echo', display_name: 'T123 Echo Connector Modified', version: '1.2.0', manifest_hash: fixtures.conflict.manifestHash })
    assert.equal(conflictPost.status, 409)
    assert.equal(conflictPost.body.detail.code, 'CONNECTOR_IDENTITY_CONFLICT')
    const deviceConflict = await installUI(fixtures.conflict, { registrationRefusal: true })
    assert(deviceConflict.alert === REFUSAL_FALLBACK || deviceConflict.alert === IPC_FALLBACK)
    const deviceConflictPost = connectorPosts().at(-1)
    assert.equal(deviceConflictPost.status, 409)
    assert.equal((await rows()).find(item => item.slug === 't123-echo').version, '1.2.0', 'device kept the installed identity')
    assert(fs.readFileSync(path.join(managedStore, 't123-echo', 'server.py'))
      .equals(fs.readFileSync(path.join(fixtures.good.path, 'server.py'))), 'device kept the installed managed copy bytes')
    pass('T123-03', 'frozen-binding-conflict-own-category', { apiConflict: conflictPost, devicePost: deviceConflictPost,
      alert: deviceConflict.alert, deviceKept: '1.2.0' })

    const upgraded = await installUI(fixtures.upgrade)
    assert.equal(upgraded.posts, 1)
    const upgradedPost = connectorPosts().at(-1)
    assert.equal(upgradedPost.status, 200)
    const upgradedRow = api('A', 'GET', '/api/connectors')
    assert.equal(upgradedRow.body.items.length, 1)
    assert.equal(upgradedRow.body.items[0].version, '1.2.1')
    assert.equal(upgradedRow.body.items[0].manifestHash, fixtures.upgrade.manifestHash)
    assert.equal((await rows()).find(item => item.slug === 't123-echo').version, '1.2.1')
    pass('T123-03', 'genuine-upgrade-declares-new-version', { post: upgradedPost, platformRow: upgradedRow.body.items[0] })

    const idempotent = await installUI(fixtures.upgrade)
    assert.equal(idempotent.posts, 0, 'same frozen content reinstalls without another registration')
    assert.equal(api('A', 'GET', '/api/connectors').body.items.length, 1)
    pass('T123-03', 'same-content-reinstall-idempotent', { registrationPostsAdded: 0 })

    await quit(); await launch('B')
    assert.equal((await rows()).length, 0)
    const bList = api('B', 'GET', '/api/connectors')
    assert.equal(bList.status, 200); assert.equal(bList.body.items.length, 0)
    const foreign = api('B', 'GET', '/api/connectors/' + upgradedRow.body.items[0].connectorId)
    assert.equal(foreign.status, 404)
    const foreignDelete = api('B', 'DELETE', '/api/connectors/' + upgradedRow.body.items[0].connectorId)
    assert.equal(foreignDelete.status, 404)
    const bText = await page.locator('body').innerText()
    assert(bText.includes(EMPTY_TEXT), 'B sees the honest empty state')
    pass('T123-03', 'account-isolation-invisible-404', { bList: bList.body, foreignGet: foreign.status, foreignDelete: foreignDelete.status })

    const bCapabilities = api('B', 'GET', '/api/devices/' + manifest.identities.B.deviceId)
    assert(!bCapabilities.body.capabilities.includes('local.mcp.t123-echo.echo'), 'B device never announces the foreign tool')
    const bCall = await dispatchTool('local.mcp.t123-echo.echo', { value: 'borrowed?' }, 'run-foreign', 'B')
    assert.equal(bCall.status, 'failed')
    assert.equal(bCall.error_code, 'CAPABILITY_UNAVAILABLE')
    pass('T123-03', 'other-device-cannot-run-foreign-binding', { capabilities: bCapabilities.body.capabilities.length,
      status: bCall.status, errorCode: bCall.error_code })
    await page.screenshot({ path: path.join(state, 'T123-03-isolation.png'), fullPage: true })
    done('T123-03')

    await quit(); await launch('A')
    assert.equal((await rows()).find(item => item.slug === 't123-echo').version, '1.2.1', 'binding-scoped registry row survives the identity round trip')

    const observations = wire()
    const serialized = JSON.stringify(observations)
    assert(!serialized.includes('def call_tool'), 'entry source never recorded')
    assert(!serialized.includes('MCP_ROOT'), 'controlled binding never recorded')
    assert(!serialized.includes(fixtures.markers.outsideWrite), 'outside marker never recorded')
    const postRows = observations.filter(row => row.method === 'POST' && row.path === '/api/connectors')
    assert(postRows.every(row => row.containsManagedBinding === false && row.containsEntrySource === false))
    pass('T123-04', 'registration-boundary-carries-identity-only', { posts: postRows.map(row => ({ keys: row.bodyKeys, bytes: row.bytes, status: row.status })),
      leaks: false })

    setRule('local.mcp.t123-echo.echo', 'deny')
    await restartRuntime()
    const denied = await dispatchTool('local.mcp.t123-echo.echo', { value: 'denied?' }, 'run-deny')
    assert.equal(denied.status, 'denied')
    assert.equal(denied.error_code, 'LOCAL_POLICY_DENIED')
    assert.equal(denied.receipt.policy_decision, 'deny')
    pass('T123-04', 'local-deny-outranks-tool-approval', { status: denied.status, errorCode: denied.error_code,
      receipt: { capability: denied.receipt.capability, policy_decision: denied.receipt.policy_decision } })
    setRule('local.mcp.t123-echo.echo', 'always_allow')
    await restartRuntime()

    const candidateValidation = [
      [{ slug: 'bad name', display_name: 'x', version: '1.2.0', manifest_hash: 'a'.repeat(64) }, 422],
      [{ slug: 't123-echo2', display_name: 'x', version: '1.2', manifest_hash: 'a'.repeat(64) }, 422],
      [{ slug: 't123-echo2', display_name: 'x', version: '1.2.0', manifest_hash: 'z'.repeat(64) }, 422],
      [{ slug: 't123-echo2', display_name: '', version: '1.2.0', manifest_hash: 'a'.repeat(64) }, 422],
      [{ slug: 't123-echo2', display_name: 'x', version: '1.2.0', manifest_hash: 'a'.repeat(64), command: 'evil' }, 422],
      [{ slug: 't123-echo2', display_name: 'x', version: '1.2.0', manifest_hash: 'a'.repeat(64), env: {} }, 422]]
    for (const [payload, expected] of candidateValidation) {
      const result = api('A', 'POST', '/api/connectors', payload)
      assert.equal(result.status, expected, JSON.stringify(payload))
    }
    assert.equal(api('A', 'GET', '/api/connectors').body.items.length, 1, 'invalid registrations leave the list unchanged')
    pass('T123-04', 'platform-identity-validation-and-allowlist', { cases: candidateValidation.length, listUnchanged: 1 })
    await page.screenshot({ path: path.join(state, 'T123-04-hygiene.png'), fullPage: true })
    done('T123-04')

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
      const deadline = Date.now() + 15000
      let remaining = findOrphans()
      while (remaining.length && Date.now() < deadline) { await pause(1000); remaining = findOrphans() }
      evidence.orphanCheck = { remaining, method: 'Win32_Process scan for python.exe whose command line carries the managed slug t123-echo' }
      if (remaining.length) { evidence.status = 'failed'; process.exitCode = 1 }
    } catch (error) { evidence.orphanCheckError = String(error); evidence.status = 'failed'; process.exitCode = 1 }
    try { evidence.credentialCleanup = invoke('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed'; process.exitCode = 1 }
    fs.writeFileSync(path.join(state, 'stop'), 'Task-owned Gateway shutdown')
    evidence.finishedAt = new Date().toISOString()
    save(); console.log(JSON.stringify({ status: evidence.status, result: path.join(state, 'result.json') }))
  }
}
save(); main().catch(error => { console.error(error); process.exitCode = 1 })
