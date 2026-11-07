import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { PANEL_REGISTRY } from '../src/renderer/src/dock/panelRegistry'
import BrowserSlotPane from '../src/renderer/src/dock/panels/browserSlotPane'
import CadPane from '../src/renderer/src/dock/panels/viewer3dPane'
import DocLibraryPane from '../src/renderer/src/dock/panels/docLibraryPane'
import ExternalPanePlaceholder from '../src/renderer/src/dock/panels/externalPanes'
import UnwiredNativePane from '../src/renderer/src/dock/panels/unwiredPanes'
import TerminalPane from '../src/renderer/src/dock/panels/terminalPane'
import FieldPane from '../src/renderer/src/dock/panels/fieldPane'
import SynapsePane from '../src/renderer/src/dock/panels/synapsePane'

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
    // Issue 110 adds node-pty as the human terminal's desktop-local PTY host
    // (decision #59: the terminal is the Desktop's own process, not the
    // Runtime's). The prohibited model/MCP/terminal-wrapper dependencies stay
    // out of every entry, and node-pty itself is pinned below to the trusted
    // main entry alone — it must never appear in the preload or renderer graph.
    expect(imports.filter((path) => /langchain|pi-coding-agent|modelcontextprotocol|ollama/.test(path))).toEqual([])
    const ptyImporters = Object.entries(result.metafile.inputs)
      .filter(([, input]) => input.imports.some((item) => item.path === 'node-pty')).map(([path]) => path)
    expect(ptyImporters).toEqual(['src/main/terminal.ts'])
    const ptyOutputs = Object.keys(result.metafile.outputs)
      .filter((path) => result.metafile.outputs[path].imports.some((item) => item.path === 'node-pty'))
    expect(ptyOutputs.map((path) => path.replace(/\\/g, '/'))).toEqual(['out/security-check/main/index.js'])
    // The renderer terminal pane renders with xterm.js only (content, not
    // trusted UI); no other entry touches it.
    const xtermOutputs = Object.keys(result.metafile.outputs)
      .filter((path) => result.metafile.outputs[path].imports.some((item) => item.path.includes('@xterm/')))
    expect(xtermOutputs.map((path) => path.replace(/\\/g, '/'))).toEqual(['out/security-check/renderer/src/main.js'])
    const launchers = Object.entries(result.metafile.inputs).filter(([, input]) => input.imports.some((item) => /child_process/.test(item.path))).map(([path]) => path)
    // Runtime owns the bundled interpreter. Maintenance launches only its
    // independent fixed helper, whose native installer/app launches consume a
    // signature-revalidated durable transaction, never renderer argv/paths.
    // The separate shipped helper is an entry here so its imports cannot evade
    // the same model/MCP/terminal dependency prohibition.
    expect(launchers.sort()).toEqual(['src/main/maintenance.ts', 'src/main/runtime.ts', 'src/main/update-helper.ts'])
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    // Issue 110: node-pty hosts the desktop-local PTY in main; @xterm/xterm
    // and @xterm/addon-fit render the terminal content in the renderer.
    // Issue 115: three.js renders the CAD pane's desktop-local WebGL geometry
    // (with the software 2D canvas as its honest fallback) in the renderer.
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@ant-design/icons', '@xterm/addon-fit', '@xterm/xterm', 'antd', 'node-pty', 'react', 'react-dom', 'three', 'zustand'
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
    // Issue 110 adds the terminal: family for the human terminal: spawn,
    // write, resize and kill on desktop-local PTY sessions plus the data/exit
    // push channels. It is a separate minimal bridge — terminal output is
    // content, not trusted UI, and never rides the desktop:* trusted bridge.
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
    // Issue 84 adds desktop:templates for the prompt-template plaza: the
    // rows, their categories, usage counts and visibility live on the
    // Server's own endpoints; creation carries no visibility field (always
    // the Server's private default), a delete is confirmed in the trusted
    // main process, and a click's prefill stays a renderer-local draft that
    // never rides this channel as a send.
    // Issue 91 adds desktop:projects for platform project management: every
    // action rides the Server's own Project API behind the chat-session
    // fence, a delete is confirmed in the trusted main process first, and no
    // operation on the channel touches local files or directory grants.
    // Issue 92 adds the device-local bind-folder/unbind-folder actions to the
    // same desktop:projects channel — no new invoke or push channel. The
    // renderer names the project only; the folder is chosen and confirmed in
    // the trusted main process, and the binding rows stay device-local.
    // Issue 85 adds desktop:schedules for the platform scheduled-tasks
    // management surface: the renderer names the action and task fields only;
    // the platform owns timing, previews and execution records through the
    // Runtime's pinned contract client, a delete is confirmed in the trusted
    // main process, and 补跑/跳过 facts are device-local display truth.
    // Issue 102 adds desktop:datasets for 表格数据集导入: the renderer names
    // the action and the project association only; the file is picked and
    // both import and delete are confirmed in the trusted main process, the
    // device parses XLSX/CSV into a real registry row (multi-sheet, inferred
    // column types, content fingerprints), duplicate content answers an
    // explicit duplicate instead of a second row, and the original file
    // never leaves the machine — a delete removes the registry row only.
    // Issue 110 adds the terminal bridge's four invoke entries: spawn, write,
    // resize and kill on desktop-local PTY sessions — a separate minimal
    // bridge that never rides the trusted desktop:* channel.
    // Issue 115 adds desktop:cad for the CAD viewer's one read entry: the
    // renderer names a workspace-logical model file; the Runtime's own locate
    // gate stays authoritative, the OCCT/local conversion and its honest size
    // and triangle caps run in the trusted main process, and the reply is one
    // bounded mesh payload — never a physical path or raw file bytes.
    // Issue 96 adds desktop:knowledge:folder + desktop:knowledge:folder-cancel
    // for the doc library's recursive folder import: the renderer names the
    // platform KB identity only, the directory picking and confirmation stay
    // in the trusted main process, and the Runtime runs the walk/dedup/
    // registration job in background with cancel. It also adds
    // desktop:knowledge:delete + desktop:knowledge:retry for the batch
    // management of the import records: deletes and retries are confirmed in
    // the trusted main process, a delete only removes device-local display
    // rows, and the retry's stored workspace-logical sources are re-verified
    // by the Runtime against the grant of this moment.
    // Issue 97 adds desktop:knowledge:index-rebuild + cancel for one
    // registered revision's background BM25 index rebuild: the renderer
    // names the frozen identity only, the Runtime re-verifies every document
    // against the live workspace bytes device-side, and a cancel lands at
    // the next document boundary.
    // Issue 86 adds desktop:preferences for the shell's device-local
    // window-lifecycle preference (close-to-tray vs 关窗即退出): the renderer
    // reads and writes the one boolean; the store itself lives in the trusted
    // main process because main needs it at close time.
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:browser', 'desktop:cad', 'desktop:chat', 'desktop:compatibility:refresh', 'desktop:connectors', 'desktop:datasets', 'desktop:files', 'desktop:knowledge:delete', 'desktop:knowledge:folder', 'desktop:knowledge:folder-cancel', 'desktop:knowledge:graph', 'desktop:knowledge:import', 'desktop:knowledge:index-rebuild', 'desktop:knowledge:index-rebuild-cancel', 'desktop:knowledge:publish', 'desktop:knowledge:retry', 'desktop:knowledge:wiki', 'desktop:login:begin', 'desktop:manage', 'desktop:models', 'desktop:notifications', 'desktop:preferences', 'desktop:projects', 'desktop:quit', 'desktop:receipts', 'desktop:remote-browser', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:schedules', 'desktop:skill-preferences', 'desktop:skill-scripts', 'desktop:skills', 'desktop:status', 'desktop:templates', 'desktop:terminal:history', 'desktop:terminal:stop', 'desktop:threads', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose', 'terminal:kill', 'terminal:resize', 'terminal:spawn', 'terminal:write'])
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
      .toEqual(['desktop:browser:events', 'desktop:notification:activate', 'desktop:notifications', 'desktop:remote-browser:events', 'terminal:data', 'terminal:exit'])
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
    // Issue 110 moves the `terminal` slot to the native runtime: the human
    // terminal is a desktop-local native-hosted pane (xterm.js over its own
    // minimal terminal bridge, decision #59) — it leaves the external-content
    // seam and is pinned to its own component plus a trusted-bridge-free
    // module graph below. Issue 115 wires the `viewer3d` slot the same way:
    // the CAD pane renders desktop-local converted geometry (no external
    // content) and is pinned to its own component and graph constraints in
    // test/cad-bridge.test.ts. Issue 113 moves the `synapse` map the same
    // way: it is a read-only projection of the platform's own Thread rows
    // and this device's observed branch edges — it never hosts external
    // content. Issue 116 moves `field` the same way: the Tecplot pane
    // renders desktop-local results over the #94 guarded read seam on a
    // software 2D canvas — no webview, no WebGL, no external content. No
    // external-content slot remains; the browser slot hosts the explicit
    // 本机/远端 choice.
    const external = PANEL_REGISTRY.filter((p) => p.runtime !== 'native')
    expect(external.map((p) => p.id).sort()).toEqual(['browser'])
    for (const def of external) {
      expect(def.component).toBe(def.id === 'browser' ? BrowserSlotPane : ExternalPanePlaceholder)
    }
    expect(PANEL_REGISTRY.find((p) => p.id === 'terminal')!.component).toBe(TerminalPane)
    expect(PANEL_REGISTRY.find((p) => p.id === 'viewer3d')!.component).toBe(CadPane)
    expect(PANEL_REGISTRY.find((p) => p.id === 'field')!.component).toBe(FieldPane)

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
    // Issue 110 wires the native `terminal` pane the same way; it uses only
    // the separate minimal terminal bridge (pinned in its own graph test).
    // Issue 84 wires the native `templates` pane the same way — the plaza
    // uses the trusted bridge for the Server's own template rows only.
    // Issue 112 wires the native `office` pane the same way — a read-only
    // observer on the existing chat state read, with zero own IPC surface
    // (pinned in test/office-bridge.test.ts). Issue 115 wires the native
    // `viewer3d` pane the same way — one bounded CAD mesh read on its own
    // channel (pinned in test/cad-bridge.test.ts).
    // Issue 96 wires the native `kb` pane the same way — the doc library uses
    // the trusted desktop:knowledge:* family only (folder import with cancel,
    // batch delete/retry), pinned in its own pane test.
    // Issue 113 wires the native `synapse` pane the same way — the map uses
    // the trusted bridge for the Server's own thread rows and the read-only
    // state read, and its open/branch actions ride the session store into
    // the conversation's serialized command path.
    // Issue 116 wires the native `field` pane the same way — it reads over
    // the guarded files seam and renders desktop-local results only.
    const unwiredNative = PANEL_REGISTRY.filter((p) => p.runtime === 'native' && !p.anchorOnly &&
      // Issue 111 wires the native `agentTerminal` pane the same way — a
    // read-only projection of the Runtime's own recorded history and
    // in-flight tails on the trusted desktop:terminal:* family.
    !['runtime', 'notifications', 'files', 'terminal', 'agentTerminal', 'templates', 'office', 'viewer3d', 'kb', 'synapse', 'field'].includes(p.id))
    expect(unwiredNative.map((p) => p.id).sort()).toEqual([])
    for (const def of unwiredNative) expect(def.component).toBe(UnwiredNativePane)
    expect(PANEL_REGISTRY.find((p) => p.id === 'kb')!.component).toBe(DocLibraryPane)

    expect(PANEL_REGISTRY.find((p) => p.id === 'synapse')!.component).toBe(SynapsePane)
    for (const id of ['chat', 'runtime', 'notifications', 'files', 'browser', 'templates', 'terminal', 'agentTerminal', 'office', 'viewer3d', 'kb', 'synapse', 'field']) {
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

  it('keeps the human terminal pane free of the trusted bridge and executable seams', async () => {
    const result = await build({
      entryPoints: ['src/renderer/src/dock/panels/terminalPane.tsx'],
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
    // Terminal data is content, not trusted UI (decision #59.6): the pane
    // touches only the minimal terminal bridge (window.ideerTerminal) — never
    // the trusted desktop:* bridge, never a webview or an executable host.
    expect(text).not.toMatch(/window\.ideer\b|desktop:|sendToHost|openExternal|webview|node-pty/i)
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

  it('keeps every trusted invoke handler behind the main-frame sender check', () => {
    // The trusted-channel convention: every registered invoke handler
    // verifies the invoking frame before it touches the Runtime or local
    // state — one unchecked registration leaves that command family open to
    // a rogue-frame sender, so the counts can never drift apart.
    const wiring = readFileSync('src/main/index.ts', 'utf8')
    const registrations = wiring.match(/ipcMain\.handle\(/g) ?? []
    const senderChecks = wiring.match(/requireMainFrame\(event\)/g) ?? []
    expect(registrations.length).toBeGreaterThan(30)
    expect(senderChecks.length).toBe(registrations.length)
  })
})
