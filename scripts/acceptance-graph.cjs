const assert = require('node:assert/strict')
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { build } = require('esbuild')

async function main() {
  const directory = process.argv[2]
  if (!directory) throw new Error('Provide an acceptance evidence directory')
  mkdirSync(directory, { recursive: true })
  const result = await build({
    entryPoints: ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/main.tsx'],
    bundle: true, packages: 'external', platform: 'node', outdir: 'out/security-check', write: false, metafile: true
  })
  writeFileSync(join(directory, 'dependency-graph.json'), JSON.stringify(result.metafile, null, 2))
  const dependencies = Object.values(result.metafile.outputs).flatMap((output) => output.imports.map((item) => item.path))
  assert.deepEqual(dependencies.filter((path) => /node-pty|langchain|pi-coding-agent|modelcontextprotocol|ollama/.test(path)), [])
  assert.deepEqual(Object.entries(result.metafile.inputs).filter(([, input]) => input.imports.some(item => /child_process/.test(item.path))).map(([path]) => path), ['src/main/runtime.ts'])
  const preload = result.outputFiles.find((file) => file.path.replace(/\\/g, '/').endsWith('preload/index.js')).text
  const ipc = [...preload.matchAll(/invoke\("([^"]+)"/g)].map((match) => match[1]).sort()
  assert.deepEqual(ipc, ['desktop:quit', 'desktop:runtime:start', 'desktop:runtime:stop', 'desktop:status'])
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
  assert.equal(pkg.version, '0.1.0')
  assert.equal(pkg.devDependencies.electron, '22.3.27')
  const summary = { result: 'passed', electron: pkg.devDependencies.electron, ipc, dependencies: [...new Set(dependencies)].sort() }
  writeFileSync(join(directory, 'dependency-boundary.json'), JSON.stringify(summary, null, 2))
  const { getConfig } = require('app-builder-lib/out/util/config')
  const configuration = await getConfig(process.cwd())
  writeFileSync(join(directory, 'builder-effective-config.json'), JSON.stringify(configuration, null, 2))
  console.log(JSON.stringify(summary, null, 2))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
