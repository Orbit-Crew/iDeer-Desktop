const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, rmdirSync, renameSync } = require('node:fs')
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
  // Issue 86: the smoke's own close-preference bytes and any real file they
  // replaced, restored in finally.
  let preferencesFile = null
  let existingPreferences = null
  try {
    app = await electron.launch(options)
    const page = await app.firstWindow()
    page.setDefaultTimeout(15000)
    // Issue 71: startup is the dock workspace — the chat anchor carries the
    // platform login fallback and the Runtime companion pane carries the
    // device connection surfaces.
    await page.locator('[data-desktop-ready="true"]').waitFor()
    await recordProcesses('initial-launch', 'running')
    const initialText = await page.locator('body').innerText()
    assert.match(initialText, /请先在系统浏览器登录并绑定设备/)
    assert.match(initialText, /本机 Runtime/)
    assert.match(initialText, /设备连接：/)
    assert.equal(await page.title(), 'iDeer Desktop')
    // Issue 107 adds the browser pane entry (browser + onBrowserEvents);
    // issue 109 adds the remote browser entry (remoteBrowser +
    // onRemoteBrowserEvents) — the two push channels never merge.
    // Issue 106 adds the officialTemplates door: a second typed entry over
    // the templates family's one pinned channel (the channel inventory in
    // test/security.test.ts stays one desktop:templates entry).
    // Issue 115 adds the CAD viewer's one read entry (`cad`).
    // Issue 96 adds the doc library's four bridge keys: the folder import
    // (directory pick and confirmation stay in the trusted main process, the
    // Runtime runs the job in background), its cancel command, and the
    // record-management doors deleteKnowledgeImports + retryKnowledgeImport
    // (both confirmed in the trusted main process).
    // Issue 102 adds the datasets entry: 表格数据集导入 — the renderer names
    // the action and the project association only; file picking and both
    // confirmations stay in the trusted main process.
    assert.deepEqual(await page.evaluate(() => Object.keys(window.ideer).sort()), [
      'beginLogin', 'browser', 'cad', 'cancelKnowledgeIndexRebuild', 'chat', 'checkUpdates', 'chooseWorkspace', 'connectors', 'datasets', 'deleteKnowledgeImports', 'files', 'getStatus',
      'importKnowledge', 'importUpdate', 'installUpdate', 'knowledgeFolderCancel', 'knowledgeFolderImport', 'knowledgeGraph', 'knowledgeSearch', 'knowledgeWiki',
      'manage', 'models', 'notifications', 'officialTemplates', 'onBrowserEvents', 'onNotificationActivate', 'onNotifications', 'onRemoteBrowserEvents', 'preferences', 'projects', 'publishKnowledge', 'quit', 'rebuildKnowledgeIndex', 'receipts', 'recoveryState', 'refreshCompatibility', 'remoteBrowser', 'retryKnowledgeImport', 'schedules', 'skillPreferences', 'skillScripts', 'skills', 'startRuntime', 'stopRuntime', 'templates', 'threads'
    ])
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.aeromind), 'undefined')
    const expectedRuntime = process.platform === 'win32' ? 'running' : 'missing'
    const ownedRuntime = await waitRuntimeState(page, expectedRuntime)
    assert.equal(ownedRuntime.version, require('../package.json').version)
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
    // Issue 107 restores the browser pane: the main window may embed webviews
    // again, gated by the will-attach-webview validation in window.ts.
    assert.equal(runtime.webview, true)
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
      await page.locator('[data-desktop-ready="true"]').waitFor({ state: 'visible' })
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

    // Issue 86: the device-local close preference lives in main's userData;
    // the smoke writes the exact bytes it needs and restores any real file.
    const preferenceTarget = join(runtime.data, 'preferences.json')
    preferencesFile = preferenceTarget
    existingPreferences = existsSync(preferenceTarget) ? readFileSync(preferenceTarget, 'utf8') : null
    const writeClosePreference = (closeToTray) => {
      mkdirSync(runtime.data, { recursive: true })
      writeFileSync(preferenceTarget, JSON.stringify({ closeToTray }))
    }
    // Issue 86: closing the native window must hide to the tray and keep
    // running (Runtime included) — a close never exits by itself. The true
    // exit happens through the real exit path: the renderer's 退出应用, which
    // runs the drain coordinator and then quits.
    writeClosePreference(true)
    app = await electron.launch(options)
    const reopenedPage = await app.firstWindow()
    await reopenedPage.locator('[data-desktop-ready="true"]').waitFor()
    if (process.platform === 'win32') await waitRuntimeState(reopenedPage, 'running')
    const beforeCloseRuntime = await reopenedPage.evaluate(() => window.ideer.getStatus())
    await recordProcesses('restart-before-native-close', 'running')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    const hiddenDeadline = Date.now() + 5000
    for (;;) {
      const state = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0]
        return { present: Boolean(win), visible: win ? win.isVisible() : false }
      })
      if (state.present && !state.visible) break
      if (Date.now() > hiddenDeadline) throw new Error('Window close did not hide to the tray')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    await recordProcesses('after-native-close-still-resident', 'running')
    const residentExited = app.waitForEvent('close')
    await reopenedPage.evaluate(() => window.ideer.quit())
    await residentExited
    app = null
    await recordProcesses('after-resident-quit', 'exited')
    if (beforeCloseRuntime.runtime.pid) assertRuntimeExited(beforeCloseRuntime.runtime.pid)
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')

    // Issue 86: with 关窗即退出 set, the native close itself is the true exit —
    // it routes through the drain coordinator and then quits.
    writeClosePreference(false)
    app = await electron.launch(options)
    const prefPage = await app.firstWindow()
    await prefPage.locator('[data-desktop-ready="true"]').waitFor()
    const beforeExitRuntime = await prefPage.evaluate(() => window.ideer.getStatus())
    const prefExited = app.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await prefExited
    app = null
    await recordProcesses('after-close-to-exit', 'exited')
    if (beforeExitRuntime.runtime.pid) assertRuntimeExited(beforeExitRuntime.runtime.pid)
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')
    console.log(JSON.stringify({ result: 'passed', platform: process.platform, elapsedMs: Date.now() - started, runtime,
      checks: ['unconnected-ui', 'session-directory', 'sandbox', 'ipc-rejection', 'navigation-popup-csp',
        'sidebar', 'resize', ...(process.env.DESKTOP_EXECUTABLE ? ['second-instance'] : []), 'ui-quit',
        'native-close-resident', 'resident-quit', 'close-to-exit']
    }, null, 2))
  } finally {
    if (app) await app.close()
    // Issue 86: the smoke's own preference bytes are removed again; a real
    // preference file that existed before is restored verbatim — written
    // unconditionally (the file may have vanished mid-run) through a staged
    // file + rename so a partial write can never clobber the real bytes
    // (same idiom as src/main/preferences.ts's atomic store write).
    if (typeof preferencesFile === 'string') {
      if (existingPreferences === null) {
        rmSync(preferencesFile, { force: true })
      } else {
        const staged = `${preferencesFile}.smoke-restore-${process.pid}`
        try {
          writeFileSync(staged, existingPreferences)
          renameSync(staged, preferencesFile)
        } finally {
          rmSync(staged, { force: true })
        }
      }
    }
    rmSync(oldData, { force: true })
    if (!legacyDirExisted) rmdirSync(legacyDir)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
