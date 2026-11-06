import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { PANEL_REGISTRY } from '../src/renderer/src/dock/panelRegistry'
import BrowserSlotPane from '../src/renderer/src/dock/panels/browserSlotPane'
import ExternalPanePlaceholder from '../src/renderer/src/dock/panels/externalPanes'
import UnwiredNativePane from '../src/renderer/src/dock/panels/unwiredPanes'

describe('bootstrap capability boundary', () => {
  it('has no executable model, MCP, terminal or tool dependency in the shipped graph', async () => {
    const result = await build({
      entryPoints: ['src/main/index.ts', 'src/main/update-helper.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false,
      metafile: true
    })
    const imports = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((item) => item.path))
    expect(imports.filter((path) => /node-pty|langchain|pi-coding-agent|modelcontextprotocol|ollama/.test(path))).toEqual([])
    const launchers = Object.entries(result.metafile.inputs).filter(([, input]) => input.imports.some((item) => /child_process/.test(item.path))).map(([path]) => path)
    // Runtime owns the bundled interpreter. Maintenance launches only its
    // independent fixed helper, whose native installer/app launches consume a
    // signature-revalidated durable transaction, never renderer argv/paths.
    // The separate shipped helper is an entry here so its imports cannot evade
    // the same model/MCP/terminal dependency prohibition.
    expect(launchers.sort()).toEqual(['src/main/maintenance.ts', 'src/main/runtime.ts', 'src/main/update-helper.ts'])
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@ant-design/icons', 'antd', 'react', 'react-dom', 'zustand'
    ])
    const preload = result.outputFiles.find((file) => file.path.replace(/\\/g, '/').endsWith('preload/index.js'))!.text
    // Issue 112 adds desktop:knowledge:import; issue 115 adds desktop:knowledge:publish.
    // Both are explicit knowledge flows whose file picking and confirmation stay
    // in the trusted main process. Issue 116 adds desktop:knowledge:graph for the
    // controlled graph entry (view/generate plus the device-local source locate).
    // Issue 118 adds desktop:knowledge:wiki for the controlled wiki entry
    // (page list, generation, and single-page reading — the Server owns every page).
    // Issue 120 adds desktop:skills for the skill package preview import: the
    // device-side preview uploads nothing, the confirmed upload lands a private
    // draft, and publication rides the platform's own draft/publish flow.
    // Issue 121 adds desktop:skill-preferences for the trigger-preference
    // configuration: the command only reaches the Server endpoints; matching
    // and model driving stay Server-side by construction.
    // Issue 122 adds desktop:skill-scripts for the device's own remembered
    // Skill script grants (list/revoke only): the pinned channel can never
    // create a grant — approvals live in the consent flow on the device.
    // Issue 123 adds desktop:connectors for the optional local connector
    // install: the renderer names the action only; package location and the
    // install/remove confirmations stay in the trusted main process, and the
    // runnable binding never leaves the device.
    // Issue 72 adds desktop:threads for the session sidebar's Thread
    // management: the renderer names the action only; the Server's own
    // permission and owner checks stay authoritative, and a delete is
    // confirmed in the trusted main process before it reaches the wire.
    // Issue 77 adds desktop:notifications for the notification center's one
    // ledger entry; the ledger itself lives in the trusted main process.
    // Issue 73 adds desktop:models for the model settings surface: the
    // authorized list, the account default (the same preference the Web
    // writes) and the device-local fallback pick ride the Server's own
    // endpoints. The channel carries no provider, Base URL or key field —
    // the Desktop never holds a model credential.
    // Issue 94 adds desktop:files for the human file-browsing seam: the
    // renderer names workspace-logical paths only; listing and previews ride
    // the Runtime's guarded read path with no consent step, and an external
    // open/reveal resolves the physical path inside the trusted main
    // process — the renderer never receives or supplies a physical path.
    // Issue 107 adds desktop:browser for the browser pane's partition clear:
    // the renderer names the action only, and the confirmation dialog plus the
    // storage clearing stay in the trusted main process.
    // Issue 109 adds desktop:remote-browser for the remote browser entry:
    // the renderer names the fixed action set (open/close/input/retrieve);
    // the stream socket, the platform access token and the paired origin
    // stay inside the bundled Runtime, and a remote file is retrieved only
    // through the artifact path with the main process's native save dialog.
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:browser', 'desktop:chat', 'desktop:compatibility:refresh', 'desktop:connectors', 'desktop:files', 'desktop:knowledge:graph', 'desktop:knowledge:import', 'desktop:knowledge:publish', 'desktop:knowledge:wiki', 'desktop:login:begin', 'desktop:manage', 'desktop:models', 'desktop:notifications', 'desktop:quit', 'desktop:receipts', 'desktop:remote-browser', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:skill-preferences', 'desktop:skill-scripts', 'desktop:skills', 'desktop:status', 'desktop:threads', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose'])
    // Issue 77 opens the bridge's first push channels: the full bounded
    // notification-center list after every ledger change, and the activate
    // payload behind an OS-toast click. Issue 107 adds desktop:browser:events
    // for the browser pane's bounded facts (denied permission asks, download
    // phases, blocked navigations, routed popups, cleared partitions).
    // Issue 109 adds the remote browser's bounded display facts (frames,
    // url/tabs, honest errors) on their own main-owned channel. All are
    // fixed main-owned names; the preload never subscribes to anything else
    // and never sends on its own.
    expect([...preload.matchAll(/\.on\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:browser:events', 'desktop:notification:activate', 'desktop:notifications', 'desktop:remote-browser:events'])
    expect(preload).not.toMatch(/\.send\(|openExternal|aeromind/)
  })
})

// Issue 71 restores the dock pane framework. Panes that will one day host
// external content (webview/pty/webgl) must never reach the trusted bridge:
// the registry maps them to the seam placeholder component, and that
// component's module graph stays free of the bridge surface. The main window
// guards stay closed so no pane can attach a webview around the seam.
// Issue 107 restores the 本机 browser: every page lives in a webview pinned
// to the fixed browser partition, validated again by the main process at
// attachment time (see issue 107's blocks below). Issue 109 adds the 远端
// browser: its pane embeds no webview and renders only pixel frames drawn by
// a surface module that stays free of the trusted bridge. Since #136/#139
// the browser slot hosts BOTH behind one explicit 本机/远端 choice
// (browserSlotPane) — never a silent switch, never a placeholder.
describe('dock pane security seam (issue 71)', () => {
  /** Bundles one renderer module exactly like the placeholder check below. */
  const buildModule = async (entryPoint: string) => {
    const result = await build({
      entryPoints: [entryPoint],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false,
      metafile: true
    })
    return { metafile: result.metafile, text: result.outputFiles.map((file) => file.text).join('') }
  }

  it('maps every external-content panel type to the seam placeholder component except the browser slot', async () => {
    const external = PANEL_REGISTRY.filter((p) => p.runtime !== 'native')
    expect(external.map((p) => p.id).sort()).toEqual(['browser', 'field', 'synapse', 'terminal', 'viewer3d'])
    for (const def of external) {
      expect(def.component).toBe(def.id === 'browser' ? BrowserSlotPane : ExternalPanePlaceholder)
    }

    // Issue 107: the browser pane is the one non-native pane with its own
    // component — never the placeholder, never the unwired native pane.
    const browser = PANEL_REGISTRY.find((p) => p.id === 'browser')!
    expect(browser.multiInstance).toBe(true)
    expect(browser.runtime).toBe('webview')
    expect(browser.component).toBe(BrowserSlotPane)

    // Issue 77 wires the notifications pane; like `runtime` it maps to its
    // own component instead of the unwired placeholder. Issue 94 wires the
    // native `files` pane the same way — it may use the trusted bridge for
    // guarded reads, but it must never become an external-content surface.
    const unwiredNative = PANEL_REGISTRY.filter((p) => p.runtime === 'native' && !p.anchorOnly &&
      !['runtime', 'notifications', 'files'].includes(p.id))
    expect(unwiredNative.map((p) => p.id).sort()).toEqual(['kb'])
    for (const def of unwiredNative) expect(def.component).toBe(UnwiredNativePane)

    for (const id of ['chat', 'runtime', 'notifications', 'files', 'browser']) {
      const def = PANEL_REGISTRY.find((p) => p.id === id)!
      expect(def.component).not.toBe(ExternalPanePlaceholder)
      expect(def.component).not.toBe(UnwiredNativePane)
    }
  })

  it('keeps the remote browser screen surface and pane free of embedded content', async () => {
    const surface = await buildModule('src/renderer/src/dock/panels/remoteBrowser/RemoteScreenSurface.tsx')
    // The pixel surface's module graph carries no bridge surface at all.
    expect(Object.keys(surface.metafile.inputs).some((path) => /preload|shared\/desktop|components\//.test(path))).toBe(false)
    expect(surface.text).not.toMatch(/window\.ideer|desktop:|ipcRenderer|sendToHost|openExternal|webview/i)
    const pane = readFileSync('src/renderer/src/dock/panels/remoteBrowserPane.tsx', 'utf8')
    // The pane never embeds or attaches content: the remote page runs on the
    // server; the renderer draws frames and forwards gestures, nothing else.
    expect(pane).not.toMatch(/<webview|sendToHost|openExternal|executeJavaScript|insertCSS|allowpopups/i)
    const registry = readFileSync('src/renderer/src/dock/panelRegistry.tsx', 'utf8')
    expect(registry).toContain('BrowserSlotPane')
  })

  it('keeps the external-content placeholder module free of the trusted bridge', async () => {
    const result = await build({
      entryPoints: ['src/renderer/src/dock/panels/externalPanes.tsx'],
      bundle: true,
      packages: 'external',
      platform: 'node',
      outdir: 'out/security-check',
      write: false,
      metafile: true
    })
    const inputs = Object.keys(result.metafile.inputs)
    expect(inputs.some((path) => /preload|shared\/desktop|components\//.test(path))).toBe(false)
    const text = result.outputFiles.map((file) => file.text).join('')
    expect(text).not.toMatch(/window\.ideer|desktop:|sendToHost|openExternal|webview/i)
  })

  it('keeps the main window guards closed for the trusted frame itself', () => {
    const source = readFileSync('src/main/window.ts', 'utf8')
    // Issue 107: webview attachment is possible, but only through the
    // validated gate — the main frame's own navigation and window policies
    // stay closed, and its session's permission gates stay denied.
    expect(source).toContain('webviewTag: true')
    expect(source).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
    expect(source).toMatch(/will-navigate', \(event\) => event\.preventDefault\(\)/)
    expect(source).toContain('setPermissionRequestHandler')
    expect(source).toContain('setPermissionCheckHandler')
    // The attach gate: the fixed partition, no node integration, no preload,
    // no popups, the sandbox/isolation pair intact, and a first document
    // that is already a web document.
    expect(source).toContain("params.partition !== BROWSER_PARTITION")
    expect(source).toContain('webPreferences.nodeIntegration ||')
    expect(source).toContain('webPreferences.preload ||')
    expect(source).toContain('attachPreferences.allowpopups === true ||')
    expect(source).toContain('webPreferences.contextIsolation === false ||')
    expect(source).toContain('webPreferences.sandbox === false ||')
    expect(source).toMatch(/!isWebUrl\(params\.src\)/)
  })

  it('pins the browser partition invariants on the guest seam (issue 107)', async () => {
    const source = readFileSync('src/renderer/src/dock/panels/browserPane.tsx', 'utf8')
    // Every guest mounts with exactly the fixed persistent partition.
    expect(source).toContain('partition={BROWSER_PARTITION}')
    // No node integration, sandboxed and isolated, in the attach attributes.
    expect(source).toContain('webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"')
    // No popups and no preload can be smuggled through the pane's webviews.
    expect(source).not.toMatch(/allowpopups/i)
    expect(source).not.toMatch(/preload=/i)

    // The main-side chokepoint: one persistent partition, session-level
    // permission denial with visible records, the http(s) document gate,
    // download confinement to the confirmed workspace, and per-guest popup
    // routing — all wired for every webview the app ever creates.
    const service = readFileSync('src/main/browserPane.ts', 'utf8')
    expect(service).toContain('setPermissionRequestHandler')
    expect(service).toContain('setPermissionCheckHandler')
    expect(service).toMatch(/will-download/)
    expect(service).toContain('resolveWorkspaceRoot')
    expect(service).toContain("resourceType === 'mainFrame'")
    expect(service).toContain("resourceType === 'subFrame'")
    expect(service).toContain('destroyPartitionGuests')
    const wiring = readFileSync('src/main/index.ts', 'utf8')
    expect(wiring).toMatch(/session\.fromPartition\(BROWSER_PARTITION\)/)
    expect(wiring).toMatch(/getType\(\) === 'webview'/)
    expect(wiring).toMatch(/desktop:browser'/)
    expect(wiring).toMatch(/desktop:browser:events'/)
    expect(wiring).toMatch(/webContents\.getAllWebContents\(\)/)
    expect(wiring).toMatch(/forcefullyCrashRenderer\(\)/)
    // The renderer frame only allows http(s) frames because the restored
    // browser pane embeds validated webviews; everything else stays closed.
    const csp = readFileSync('src/renderer/index.html', 'utf8')
    expect(csp).toContain("frame-src http: https:")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toMatch(/default-src 'none'/)
  })
})
