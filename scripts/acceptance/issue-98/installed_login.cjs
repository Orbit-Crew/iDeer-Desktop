// Run only against the isolated T98 deployment and an unused installed profile.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { execFileSync, spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')

const desktop = path.resolve(__dirname, '../../..')
const server = path.resolve(process.env.IDEER_T98_SERVER_ROOT || path.join(desktop, 'artifacts/issue-98/server'))
const { chromium } = require(path.join(server, 'frontend/node_modules/@playwright/test'))
const executable = path.resolve(process.env.IDEER_T98_INSTALLED_EXECUTABLE || process.env.DESKTOP_EXECUTABLE || 'D:/software/iDeer Desktop/ideer-desktop/ideer-desktop.exe')
const origin = 'http://127.0.0.1:21980'
const evidence = path.join(desktop, 'artifacts/issue-98/installed-login', Date.now() + '-' + randomUUID().slice(0, 8))
const deviceName = 'T98-installed-' + randomUUID()
const accountName = 'user98a@test.com'
const started = Date.now()
const result = { startedAt: new Date().toISOString(), origin, executable, deviceName, result: 'incomplete', stages: [] }
const runtimePids = new Set()
let app, browser, page, snapshot, config, ownsProfile = false, launchAttempted = false

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const hash = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function powershell(code) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 15000
  }).replace(/^\uFEFF/, '').trim()
}
function assertGone(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0)
  powershell(`if ($null -ne (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit 1 }`)
}
async function waitFor(predicate, label, timeout = 45000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await sleep(150)
  }
  throw new Error('Acceptance timeout: ' + label)
}
async function status() {
  snapshot = await page.evaluate(() => window.ideer.getStatus())
  const runtime = snapshot.runtime
  if (runtime.pid) runtimePids.add(runtime.pid)
  assert(!/session_token|business_token|PRIVATE KEY/.test(JSON.stringify(snapshot)))
  return runtime
}
async function launch() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  launchAttempted = true
  app = await electron.launch({ executablePath: executable, args: [], env, timeout: 45000 })
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await page.getByRole('heading', { name: '平台登录与设备连接' }).waitFor()
  const actual = await app.evaluate(({ app }) => ({ userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged }))
  assert.equal(path.normalize(actual.userData).toLowerCase(), path.dirname(path.dirname(config)).toLowerCase())
  assert.equal(actual.packaged, true)
  result.application = actual
}
async function quit() {
  if (!app) return
  const current = await status()
  const closed = app.waitForEvent('close', { timeout: 25000 })
  await page.getByRole('button', { name: '退出应用' }).click()
  await closed
  app = null
  if (current.pid) assertGone(current.pid)
}
function ownedSettings() {
  if (!fs.existsSync(config)) return null
  const value = JSON.parse(fs.readFileSync(config, 'utf8'))
  assert(value.device_name === deviceName, 'Profile ownership changed; refusing cleanup')
  assert(value.server_url === origin, 'Profile origin changed; refusing cleanup')
  const references = [value.device_key_ref, value.session_token_ref, value.business_token_ref]
  assert.equal(new Set(references).size, 3)
  for (const reference of references) assert.match(reference, /^desktop-[a-f0-9]{32}-(device-key|device-session|business-session)$/)
  assert.equal(value.session_token, '')
  ownsProfile = true
  return { value, references, sha256: hash(config) }
}
async function run() {
  assert.equal(process.platform, 'win32', 'Installed acceptance requires Windows')
  assert(process.env.APPDATA, 'APPDATA is required')
  const knownAppData = powershell("[Environment]::GetFolderPath('ApplicationData')")
  assert(path.normalize(knownAppData).toLowerCase() === path.normalize(process.env.APPDATA).toLowerCase(),
    'APPDATA differs from the Windows known folder; refusing to select a user profile')
  config = path.join(process.env.APPDATA, 'iDeer Desktop', 'Runtime', 'settings.json')
  // Refuse even an empty file. No existing configuration is a test fixture.
  assert(!fs.existsSync(config), 'Existing Runtime settings found; refusing to touch the user profile')
  assert(!fs.existsSync(config + '.tmp'), 'Existing temporary settings found; refusing to touch the user profile')
  assert(fs.existsSync(executable), 'Installed executable is missing')
  const executableLiteral = executable.replace(/'/g, "''")
  const running = powershell(`@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${executableLiteral}' }).Count`)
  assert.equal(Number(running), 0, 'Installed Desktop is already running; refusing to attach to an existing instance')
  fs.mkdirSync(evidence, { recursive: true })
  result.executableSha256 = hash(executable)
  const asar = path.join(path.dirname(executable), 'resources', 'app.asar')
  if (fs.existsSync(asar)) result.appAsarSha256 = hash(asar)
  await launch()
  await waitFor(async () => (await status()).login?.state === 'unauthenticated', 'initial unauthenticated status')
  assert.notEqual(snapshot.runtime.connection, 'connected')
  await app.evaluate(({ shell }) => {
    const original = shell.openExternal.bind(shell)
    globalThis.__t98External = null
    shell.openExternal = async (url, ...args) => {
      await original(url, ...args)
      globalThis.__t98External = { url, opened: true }
    }
  })
  await page.getByLabel('平台统一入口').fill(origin)
  await page.getByLabel('设备名称').fill(deviceName)
  await page.getByRole('button', { name: '在浏览器登录并绑定此设备' }).click()
  let external
  await waitFor(async () => {
    external = await app.evaluate(() => globalThis.__t98External)
    return external?.opened
  }, 'real shell.openExternal', 30000)
  const url = new URL(external.url)
  assert.equal(url.origin, origin)
  assert.equal(url.pathname, '/desktop-login')
  assert.deepEqual([...url.searchParams.keys()], ['login_id'])
  assert.match(url.searchParams.get('login_id'), /^[a-zA-Z0-9-]{1,64}$/)
  const pending = await status()
  assert.equal(pending.login.state, 'awaiting-confirmation')
  assert.notEqual(pending.connection, 'connected')
  await page.screenshot({ path: path.join(evidence, 'desktop-awaiting-confirmation.png') })
  // The URL is read by the test from the main process, never via renderer IPC.
  browser = await chromium.launch({ headless: true })
  const web = await browser.newPage({ viewport: { width: 1100, height: 850 } })
  await web.goto(url.href, { timeout: 120000 })
  await web.locator('input[type=email]').waitFor({ timeout: 120000 })
  await web.locator('input[type=email]').fill(accountName)
  await web.locator('input[type=password]').fill(accountName)
  await web.locator('button[type=submit]').click()
  await web.getByRole('heading', { name: '绑定 iDeer Desktop' }).waitFor({ timeout: 120000 })
  await web.getByText('设备：' + deviceName, { exact: true }).waitFor()
  assert.equal(await web.locator('code').textContent(), pending.login.verification)
  assert.equal((await status()).login.state, 'awaiting-confirmation')
  assert.notEqual(snapshot.runtime.connection, 'connected')
  await web.screenshot({ path: path.join(evidence, 'browser-own-device-confirmation.png') })
  await web.getByRole('checkbox').check()
  await web.getByRole('button', { name: '确认绑定本人设备' }).click()
  await web.getByRole('status').filter({ hasText: '本人设备已确认' }).waitFor()
  await waitFor(async () => {
    const runtime = await status()
    return runtime.login?.state === 'authenticated' && runtime.connection === 'connected'
  }, 'installed login completion and signed WS')
  assert.equal(snapshot.runtime.login.account, accountName)
  assert.equal(snapshot.runtime.login.device, deviceName)
  const { value: settings } = ownedSettings()
  const meResponse = await web.request.get(origin + '/api/v1/auth/me')
  assert(meResponse.ok())
  const me = await meResponse.json()
  assert.equal(settings.user_id, me.id)
  const devicesResponse = await web.request.get(origin + '/api/devices')
  assert(devicesResponse.ok())
  const devices = await devicesResponse.json()
  assert(devices.some(device => device.id === settings.device_id && device.owner_id === me.id && device.status === 'online'))
  await page.screenshot({ path: path.join(evidence, 'desktop-authenticated-connected.png') })
  await web.screenshot({ path: path.join(evidence, 'browser-completed.png') })
  result.stages.push({ stage: 'installed-login', result: 'passed', runtime: snapshot.runtime,
    realShellOpenExternal: true, ownerMatches: true, deviceOnline: true, separateSecureReferences: true })
  const firstPid = snapshot.runtime.pid
  await quit()
  result.stages.push({ stage: 'first-exit', result: 'passed', runtimePid: firstPid, runtimeExited: true })
  await launch()
  await waitFor(async () => {
    const runtime = await status()
    return runtime.login?.state === 'authenticated' && runtime.connection === 'connected'
  }, 'installed restart and OS credential restore')
  assert.equal(snapshot.runtime.login.account, accountName)
  assert.equal(snapshot.runtime.login.device, deviceName)
  assert.equal(ownedSettings().value.device_id, settings.device_id)
  await page.screenshot({ path: path.join(evidence, 'desktop-restart-restored.png') })
  result.stages.push({ stage: 'installed-restart', result: 'passed', runtime: snapshot.runtime, sameDevice: true })
  await quit()
  result.result = 'passed'
}
async function cleanup() {
  const errors = []
  if (app) {
    try { await quit() } catch {
      try { await app.close(); app = null } catch { errors.push('Installed Desktop did not close') }
    }
  }
  if (browser) try { await browser.close() } catch { errors.push('Acceptance Chromium did not close') }
  for (const pid of runtimePids) {
    try { assertGone(pid) } catch { errors.push('Runtime remains alive: ' + pid) }
  }
  if (launchAttempted && config && fs.existsSync(config)) {
    try {
      const settings = ownedSettings()
      assert(ownsProfile)
      assert(!errors.length, 'Processes must exit before credential cleanup')
      const bundled = path.join(path.dirname(executable), 'resources', 'runtime')
      const script = [
        'import json,sys', 'from core.secrets import create_default_secret_store, SecretNotFound',
        'store=create_default_secret_store()', 'refs=json.loads(sys.stdin.read())',
        'assert len(refs)==3 and len(set(refs))==3',
        'for ref in refs:',
        '    try: store.delete(ref)', '    except SecretNotFound: pass',
        'for ref in refs:', '    try: store.get(ref)', '    except SecretNotFound: continue',
        '    raise RuntimeError("Scoped credential cleanup failed")'
      ].join('\n')
      const removed = spawnSync(path.join(bundled, 'python.exe'), ['-I', '-c', script], {
        cwd: bundled, input: JSON.stringify(settings.references), encoding: 'utf8', windowsHide: true, timeout: 20000
      })
      assert.equal(removed.status, 0, 'Scoped OS credential cleanup failed')
      // Delete only this run's identified settings, retaining all other data.
      assert.equal(hash(config), settings.sha256, 'Profile changed during cleanup; refusing settings removal')
      fs.unlinkSync(config)
      result.cleanup = { referencesDeleted: 3, settingsRemoved: true, runtimePidsExited: [...runtimePids] }
    } catch (error) { errors.push(error.message) }
  }
  if (errors.length) throw new Error(errors.join('; '))
}
run().catch(error => {
  result.result = 'failed'
  result.error = error.message
  process.exitCode = 1
}).finally(async () => {
  try { await cleanup() } catch (error) {
    result.result = 'failed'
    result.cleanupError = error.message
    process.exitCode = 1
  }
  result.finishedAt = new Date().toISOString()
  result.elapsedMs = Date.now() - started
  if (fs.existsSync(evidence)) fs.writeFileSync(path.join(evidence, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify({ result: result.result, error: result.error, cleanupError: result.cleanupError, evidence }))
})
