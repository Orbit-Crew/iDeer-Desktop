import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'
import { PANEL_REGISTRY } from '../src/renderer/src/dock/panelRegistry'
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
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:chat', 'desktop:compatibility:refresh', 'desktop:connectors', 'desktop:knowledge:graph', 'desktop:knowledge:import', 'desktop:knowledge:publish', 'desktop:knowledge:wiki', 'desktop:login:begin', 'desktop:manage', 'desktop:quit', 'desktop:receipts', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:skill-preferences', 'desktop:skill-scripts', 'desktop:skills', 'desktop:status', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose'])
    expect(preload).not.toMatch(/\.send\(|\.on\(|openExternal|aeromind/)
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
    expect(external.map((p) => p.id).sort()).toEqual(['browser', 'field', 'synapse', 'terminal', 'viewer3d'])
    for (const def of external) expect(def.component).toBe(ExternalPanePlaceholder)

    const unwiredNative = PANEL_REGISTRY.filter((p) => p.runtime === 'native' && !p.anchorOnly && p.id !== 'runtime')
    expect(unwiredNative.map((p) => p.id).sort()).toEqual(['files', 'kb'])
    for (const def of unwiredNative) expect(def.component).toBe(UnwiredNativePane)

    for (const id of ['chat', 'runtime']) {
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
