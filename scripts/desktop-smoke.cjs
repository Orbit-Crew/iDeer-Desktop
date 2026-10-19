const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, rmdirSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { spawn, execFileSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')

async function main() {
  const started = Date.now()
  const evidenceDir = process.env.DESKTOP_EVIDENCE_DIR || 'artifacts'
  mkdirSync(evidenceDir, { recursive: true })
  const processEvidence = []
  function assertRuntimeExited(pid) {
    if (process.platform === 'win32') {
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if ($null -eq $p -or $p.HasExited) { exit 0 }; exit 1`
      ], { windowsHide: true, timeout: 15000 })
    } else assert.throws(() => process.kill(pid, 0))
  }
  async function waitRuntimeState(page, expected) {
    const deadline = Date.now() + 15000
    let snapshot
    do {
      snapshot = await page.evaluate(() => window.ideer.getStatus())
      if (snapshot.runtime.process === expected) return snapshot
      await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    throw new Error(`Runtime did not reach ${expected}: ${JSON.stringify(snapshot.runtime)}`)
  }
  const expectedExecutable = process.env.DESKTOP_EXECUTABLE || require('electron')
  async function recordProcesses(stage, expected) {
    if (process.platform !== 'win32') return
    const quotedPath = expectedExecutable.replace(/'/g, "''")
    const query = `$items = @(Get-CimInstance Win32_Process -Filter "Name='${expectedExecutable.split(/[\\/]/).pop().replace(/'/g, "''")}'" | Where-Object { $_.ExecutablePath -eq '${quotedPath}' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath); ConvertTo-Json -InputObject $items -Compress`
    const deadline = Date.now() + 20000
    let processes
    do {
      processes = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
        encoding: 'utf8', windowsHide: true, timeout: 15000
      }).replace(/^\uFEFF/, '').trim())
      if (expected !== 'exited' || processes.length === 0) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    } while (Date.now() < deadline)
    processEvidence.push({ stage, expected, timestamp: new Date().toISOString(), elapsedMs: Date.now() - started, processes })
    writeFileSync(join(evidenceDir, 'desktop-processes.json'), JSON.stringify(processEvidence, null, 2))
    if (expected === 'exited') assert.equal(processes.length, 0, `Residual processes after ${stage}`)
    else assert.ok(processes.length > 0, `No running processes at ${stage}`)
  }
  const profile = mkdtempSync(join(tmpdir(), 'ideer-desktop-smoke-'))
  // Windows known-folder resolution does not follow an APPDATA override.
  // Use only a new, uniquely named fixture, never an existing history/config file.
  const appData = process.platform === 'win32' ? process.env.APPDATA : profile
  const legacyDir = join(appData, 'linz')
  const legacyDirExisted = existsSync(legacyDir)
  const oldData = join(legacyDir, `ideer-smoke-${randomUUID()}.txt`)
  mkdirSync(legacyDir, { recursive: true })
  writeFileSync(oldData, 'legacy-history-must-survive')
  const env = { ...process.env, XDG_CONFIG_HOME: profile }
  delete env.ELECTRON_RUN_AS_NODE
  const options = {
    env,
    timeout: 30000,
    ...(process.env.DESKTOP_EXECUTABLE
      ? { executablePath: process.env.DESKTOP_EXECUTABLE, args: [] }
      : { args: ['.'] })
  }
  let app
  try {
    app = await electron.launch(options)
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    await page.getByRole('heading', { name: '平台登录与设备连接' }).waitFor()
    await recordProcesses('initial-launch', 'running')
    assert.match(await page.locator('body').innerText(), /可在系统浏览器登录并绑定设备，聊天入口尚未接入/)
    assert.equal(await page.title(), 'iDeer Desktop')
    assert.deepEqual(await page.evaluate(() => Object.keys(window.ideer).sort()), ['beginLogin', 'getStatus', 'quit', 'startRuntime', 'stopRuntime'])
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.aeromind), 'undefined')
    const expectedRuntime = process.platform === 'win32' ? 'running' : 'missing'
    const ownedRuntime = await waitRuntimeState(page, expectedRuntime)
    assert.equal(ownedRuntime.version, '0.1.0')
    assert.equal(ownedRuntime.server, process.platform === 'win32' ? 'not-configured' : 'offline')
    if (process.platform === 'win32') assert.ok(ownedRuntime.runtime.pid)
    const runtimeStages = [{ stage: 'started', ...ownedRuntime.runtime }]
    if (process.platform === 'win32') {
      await page.getByRole('button', { name: '停止 Runtime' }).click()
      await waitRuntimeState(page, 'stopped')
      assertRuntimeExited(ownedRuntime.runtime.pid)
      runtimeStages.push({ stage: 'stopped', ...(await page.evaluate(() => window.ideer.getStatus())).runtime })
      await page.getByRole('button', { name: '启动 Runtime' }).click()
      const recovered = await waitRuntimeState(page, 'running')
      process.kill(recovered.runtime.pid)
      await waitRuntimeState(page, 'crashed')
      runtimeStages.push({ stage: 'crashed', ...(await page.evaluate(() => window.ideer.getStatus())).runtime })
      await page.getByRole('button', { name: '启动 Runtime' }).click()
      runtimeStages.push({ stage: 'recovered', ...(await waitRuntimeState(page, 'running')).runtime })
    }
    writeFileSync(join(evidenceDir, 'runtime-lifecycle.json'), JSON.stringify(runtimeStages, null, 2))
    const runtime = await app.evaluate(async ({ app, BrowserWindow }) => {
      const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
      const cyclic = { value: 1 }
      cyclic.self = cyclic
      const copy = structuredClone(cyclic)
      const decoder = new TextDecoderStream()
      const writer = decoder.writable.getWriter()
      const reader = decoder.readable.getReader()
      const decoded = (async () => {
        let text = ''
        for (;;) {
          const next = await reader.read()
          if (next.done) return text
          text += next.value
        }
      })()
      await writer.write(new Uint8Array([0xe4, 0xbd]))
      await writer.write(new Uint8Array([0xa0]))
      await writer.close()
      return {
        electron: process.versions.electron,
        node: process.versions.node,
        data: app.getPath('userData'),
        sessionData: app.getPath('sessionData'),
        software: app.commandLine.hasSwitch('disable-gpu'),
        sandbox: preferences.sandbox,
        isolation: preferences.contextIsolation,
        nodeIntegration: preferences.nodeIntegration,
        webview: preferences.webviewTag,
        cloneWorks: copy !== cyclic && copy.self === copy,
        decoded: await decoded
      }
    })
    assert.equal(runtime.electron, '22.3.27')
    assert.match(runtime.node, /^16\./)
    assert.equal(runtime.data, join(appData, 'iDeer Desktop'))
    assert.equal(runtime.sessionData, join(appData, 'iDeer Desktop', 'Session'))
    assert.equal(runtime.software, true)
    assert.equal(runtime.sandbox, true)
    assert.equal(runtime.isolation, true)
    assert.equal(runtime.nodeIntegration, false)
    assert.equal(runtime.webview, false)
    assert.equal(runtime.cloneWorks, true)
    assert.equal(runtime.decoded, '你')

    // A second installed instance must activate the existing window and exit.
    if (process.env.DESKTOP_EXECUTABLE) {
      await app.evaluate(({ app, BrowserWindow }) => {
        globalThis.__desktopSecondInstance = false
        app.once('second-instance', () => { globalThis.__desktopSecondInstance = true })
        BrowserWindow.getAllWindows()[0].minimize()
      })
      const second = spawn(process.env.DESKTOP_EXECUTABLE, [], { env, windowsHide: true, stdio: 'ignore' })
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Second instance did not exit')), 15000)
        second.once('error', (error) => { clearTimeout(timeout); reject(error) })
        second.once('exit', (code) => {
          clearTimeout(timeout)
          code === 0 ? resolve() : reject(new Error(`Second instance exit code: ${code}`))
        })
      })
      const activated = await app.evaluate(({ BrowserWindow }) => ({
        received: globalThis.__desktopSecondInstance,
        windowCount: BrowserWindow.getAllWindows().length,
        minimized: BrowserWindow.getAllWindows()[0].isMinimized()
      }))
      assert.deepEqual(activated, { received: true, windowCount: 1, minimized: false })
    }

    for (const [width, height] of [[960, 600], [1440, 900], [1280, 800]]) {
      await app.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setSize(...bounds), [width, height])
      await page.getByRole('heading', { name: '平台登录与设备连接' }).waitFor({ state: 'visible' })
      assert.equal(await page.locator('textarea, input[type="password"], input[type="submit"]').count(), 0)
    }

    // Invoke the real preload bridge from a different webContents.
    const rejection = await app.evaluate(async ({ app, BrowserWindow }) => {
      const preload = app.getAppPath() + '/out/preload/index.js'
      const foreign = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true } })
      try {
        await foreign.loadURL('data:text/html,<title>foreign</title>')
        const bridge = await foreign.webContents.executeJavaScript('typeof window.ideer')
        if (bridge !== 'object') throw new Error(`Foreign preload unavailable: ${preload}, ${bridge}`)
        return await foreign.webContents.executeJavaScript(
          'window.ideer.getStatus().then(() => "unexpected success", error => error.message)'
        )
      } finally {
        foreign.destroy()
      }
    })
    assert.match(rejection, /Untrusted desktop IPC sender/)

    const originalURL = page.url()
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.href = 'https://example.com/'
      document.body.appendChild(link)
      link.click()
      window.open('https://example.com/')
    })
    await page.getByRole('button', { name: '隐藏侧边栏' }).click()
    await page.getByRole('button', { name: '显示侧边栏' }).click()
    assert.equal(page.url(), originalURL)
    assert.equal(app.windows().length, 1)
    const networkBlocked = await page.evaluate(async () => {
      try { await fetch('https://example.com/'); return false } catch { return true }
    })
    assert.equal(networkBlocked, true)
    mkdirSync('artifacts', { recursive: true })
    await page.screenshot({ path: join(evidenceDir, 'desktop-startup.png') })
    await recordProcesses('before-ui-quit', 'running')
    const exited = app.waitForEvent('close')
    const beforeQuitRuntime = await page.evaluate(() => window.ideer.getStatus())
    await page.getByRole('button', { name: '退出应用' }).click()
    await exited
    app = null
    await recordProcesses('after-ui-quit', 'exited')
    if (beforeQuitRuntime.runtime.pid) assertRuntimeExited(beforeQuitRuntime.runtime.pid)
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')

    // Closing the native window must exit, without a background tray process.
    app = await electron.launch(options)
    const reopenedPage = await app.firstWindow()
    await reopenedPage.getByRole('heading', { name: '平台登录与设备连接' }).waitFor()
    if (process.platform === 'win32') await waitRuntimeState(reopenedPage, 'running')
    const beforeCloseRuntime = await reopenedPage.evaluate(() => window.ideer.getStatus())
    await recordProcesses('restart-before-native-close', 'running')
    const closed = app.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    app = null
    await recordProcesses('after-native-close', 'exited')
    if (beforeCloseRuntime.runtime.pid) assertRuntimeExited(beforeCloseRuntime.runtime.pid)
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')
    console.log(JSON.stringify({ result: 'passed', platform: process.platform, elapsedMs: Date.now() - started, runtime,
      checks: ['unconnected-ui', 'session-directory', 'sandbox', 'ipc-rejection', 'navigation-popup-csp',
        'sidebar', 'resize', ...(process.env.DESKTOP_EXECUTABLE ? ['second-instance'] : []), 'ui-quit', 'native-close']
    }, null, 2))
  } finally {
    if (app) await app.close()
    rmSync(oldData, { force: true })
    if (!legacyDirExisted) rmdirSync(legacyDir)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
