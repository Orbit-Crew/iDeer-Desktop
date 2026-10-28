import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

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
    // in the trusted main process.
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:chat', 'desktop:compatibility:refresh', 'desktop:knowledge:import', 'desktop:knowledge:publish', 'desktop:login:begin', 'desktop:manage', 'desktop:quit', 'desktop:receipts', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:status', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose'])
    expect(preload).not.toMatch(/\.send\(|\.on\(|openExternal|aeromind/)
  })
})
