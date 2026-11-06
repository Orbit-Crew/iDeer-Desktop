import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { PANEL_REGISTRY } from '../src/renderer/src/dock/panelRegistry'
import ExternalPanePlaceholder from '../src/renderer/src/dock/panels/externalPanes'
import UnwiredNativePane from '../src/renderer/src/dock/panels/unwiredPanes'
import TerminalPane from '../src/renderer/src/dock/panels/terminalPane'

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
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@ant-design/icons', '@xterm/addon-fit', '@xterm/xterm', 'antd', 'node-pty', 'react', 'react-dom', 'zustand'
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
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:chat', 'desktop:compatibility:refresh', 'desktop:connectors', 'desktop:files', 'desktop:knowledge:graph', 'desktop:knowledge:import', 'desktop:knowledge:publish', 'desktop:knowledge:wiki', 'desktop:login:begin', 'desktop:manage', 'desktop:models', 'desktop:notifications', 'desktop:quit', 'desktop:receipts', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:skill-preferences', 'desktop:skill-scripts', 'desktop:skills', 'desktop:status', 'desktop:threads', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose', 'terminal:kill', 'terminal:resize', 'terminal:spawn', 'terminal:write'])
    // Issue 77 opens the bridge's only two push channels: the full bounded
    // notification-center list after every ledger change, and the activate
    // payload behind an OS-toast click. Both are fixed main-owned names; the
    // preload never subscribes to anything else and never sends on its own.
    expect([...preload.matchAll(/\.on\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:notification:activate', 'desktop:notifications', 'terminal:data', 'terminal:exit'])
    expect(preload).not.toMatch(/\.send\(|openExternal|aeromind/)
  })
})

// Issue 71 restores the dock pane framework. Panes that will one day host
// external content (webview/pty/webgl) must never reach the trusted bridge:
// the registry maps them to the seam placeholder component, and that
// component's module graph stays free of the bridge surface. The main window
// guards stay closed so no pane can attach a webview around the seam.
describe('dock pane security seam (issue 71)', () => {
  it('maps every external-content panel type to the seam placeholder component', () => {
    const external = PANEL_REGISTRY.filter((p) => p.runtime !== 'native')
    // Issue 110 wires the `terminal` slot: the human terminal is a
    // desktop-local native-hosted pane (xterm.js over its own minimal
    // terminal bridge, decision #59) — it leaves the external-content seam
    // and is pinned to its own component plus a trusted-bridge-free module
    // graph below. The remaining webview/webgl slots keep the placeholder.
    expect(external.map((p) => p.id).sort()).toEqual(['browser', 'field', 'synapse', 'viewer3d'])
    for (const def of external) expect(def.component).toBe(ExternalPanePlaceholder)
    expect(PANEL_REGISTRY.find((p) => p.id === 'terminal')!.component).toBe(TerminalPane)

    // Issue 77 wires the notifications pane; like `runtime` it maps to its
    // own component instead of the unwired placeholder. Issue 94 wires the
    // native `files` pane the same way — it may use the trusted bridge for
    // guarded reads, but it must never become an external-content surface.
    // Issue 110 wires the native `terminal` pane the same way; it uses only
    // the separate minimal terminal bridge (pinned in its own graph test).
    const unwiredNative = PANEL_REGISTRY.filter((p) => p.runtime === 'native' && !p.anchorOnly &&
      !['runtime', 'notifications', 'files', 'terminal'].includes(p.id))
    expect(unwiredNative.map((p) => p.id).sort()).toEqual(['kb'])
    for (const def of unwiredNative) expect(def.component).toBe(UnwiredNativePane)

    for (const id of ['chat', 'runtime', 'notifications', 'files', 'terminal']) {
      const def = PANEL_REGISTRY.find((p) => p.id === id)!
      expect(def.component).not.toBe(ExternalPanePlaceholder)
      expect(def.component).not.toBe(UnwiredNativePane)
    }
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

  it('keeps the main window external-content guards closed', () => {
    const source = readFileSync('src/main/window.ts', 'utf8')
    expect(source).toContain('webviewTag: false')
    expect(source).toContain("setWindowOpenHandler(() => ({ action: 'deny' }))")
    expect(source).toMatch(/will-attach-webview', \(event\) => event\.preventDefault\(\)/)
    expect(source).toMatch(/will-navigate', \(event\) => event\.preventDefault\(\)/)
    expect(source).toContain('setPermissionRequestHandler')
    expect(source).toContain('setPermissionCheckHandler')
  })
})
