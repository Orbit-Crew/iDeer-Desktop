import { readFileSync } from 'node:fs'
import { build } from 'esbuild'
import { describe, expect, it } from 'vitest'

describe('bootstrap capability boundary', () => {
  it('has no executable model, MCP, terminal or tool dependency in the shipped graph', async () => {
    const result = await build({
      entryPoints: ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx'],
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
    // runtime.ts owns the bundled interpreter. The installer entry (issue 108)
    // may launch only the user-confirmed full installer after a drained queue;
    // esbuild attributes its dynamic child_process import to the entry bundle.
    expect(launchers.sort()).toEqual(['src/main/index.ts', 'src/main/runtime.ts'])
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
    expect(Object.keys(pkg.dependencies).sort()).toEqual([
      '@ant-design/icons', 'antd', 'react', 'react-dom', 'zustand'
    ])
    const preload = result.outputFiles.find((file) => file.path.replace(/\\/g, '/').endsWith('preload/index.js'))!.text
    expect([...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort())
      .toEqual(['desktop:chat', 'desktop:compatibility:refresh', 'desktop:login:begin', 'desktop:manage', 'desktop:quit', 'desktop:receipts', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:status', 'desktop:updates:check', 'desktop:updates:import', 'desktop:updates:install', 'desktop:updates:recovery', 'desktop:workspace:choose'])
    expect(preload).not.toMatch(/\.send\(|\.on\(|openExternal|aeromind/)
  })
})
