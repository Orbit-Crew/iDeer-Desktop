const assert = require('node:assert/strict')
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, rmdirSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { _electron: electron } = require('playwright-core')

async function main() {
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
    await page.getByRole('heading', { name: '未连接 Server' }).waitFor()
    assert.match(await page.locator('body').innerText(), /当前无法登录、聊天或执行本地任务/)
    assert.equal(await page.title(), 'iDeer Desktop')
    assert.deepEqual(await page.evaluate(() => Object.keys(window.ideer).sort()), ['getStatus', 'quit'])
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.aeromind), 'undefined')
    assert.deepEqual(await page.evaluate(() => window.ideer.getStatus()), {
      version: '0.1.0', server: 'not-configured', runtime: 'not-installed'
    })
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
    assert.equal(runtime.software, true)
    assert.equal(runtime.sandbox, true)
    assert.equal(runtime.isolation, true)
    assert.equal(runtime.nodeIntegration, false)
    assert.equal(runtime.webview, false)
    assert.equal(runtime.cloneWorks, true)
    assert.equal(runtime.decoded, '你')

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
    await page.screenshot({ path: 'artifacts/desktop-startup.png' })
    const exited = app.waitForEvent('close')
    await page.getByRole('button', { name: '退出应用' }).click()
    await exited
    app = null
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')

    // Closing the native window must exit, without a background tray process.
    app = await electron.launch(options)
    await (await app.firstWindow()).getByRole('heading', { name: '未连接 Server' }).waitFor()
    const closed = app.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await closed
    app = null
    assert.equal(readFileSync(oldData, 'utf8'), 'legacy-history-must-survive')
    console.log(JSON.stringify({ result: 'passed', platform: process.platform, runtime }, null, 2))
  } finally {
    if (app) await app.close()
    rmSync(oldData, { force: true })
    if (!legacyDirExisted) rmdirSync(legacyDir)
    rmSync(profile, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
