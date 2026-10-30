// Keep development downloads and temporary files with this checkout.
const { mkdirSync, readFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')
const { spawn } = require('node:child_process')

const projectRoot = resolve(__dirname, '..')

function projectPaths(root = projectRoot) {
  const absoluteRoot = resolve(root)
  const cache = join(absoluteRoot, '.cache')
  // Signing tests require private keys outside the repository, including ignored paths.
  const temporary = absoluteRoot + '.tmp'
  return {
    TEMP: temporary,
    TMP: temporary,
    TMPDIR: temporary,
    npm_config_cache: join(cache, 'npm'),
    electron_config_cache: join(cache, 'electron'),
    ELECTRON_CACHE: join(cache, 'electron'),
    ELECTRON_BUILDER_CACHE: join(cache, 'electron-builder'),
    UV_CACHE_DIR: join(cache, 'uv'),
    UV_PYTHON_INSTALL_DIR: join(cache, 'uv-python'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    PLAYWRIGHT_BROWSERS_PATH: join(cache, 'ms-playwright'),
    HF_HUB_CACHE: join(cache, 'huggingface', 'hub'),
    HF_DATASETS_CACHE: join(cache, 'huggingface', 'datasets'),
    HF_XET_CACHE: join(cache, 'huggingface', 'xet'),
    TORCH_HOME: join(cache, 'torch')
  }
}

function projectEnvironment(parent = process.env, root = projectRoot) {
  const env = { ...parent }
  for (const [key, value] of Object.entries(projectPaths(root))) {
    // Windows environment names are case insensitive, including npm's names.
    for (const inherited of Object.keys(env)) {
      if (inherited.toLowerCase() === key.toLowerCase()) delete env[inherited]
    }
    env[key] = value
  }
  return env
}

function resolveCommand(command, args) {
  const packages = {
    'electron-vite': 'electron-vite',
    'electron-builder': 'electron-builder',
    tsc: 'typescript',
    vitest: 'vitest'
  }
  if (command === 'node') return [process.execPath, args]
  if (packages[command]) {
    const manifest = require.resolve(packages[command] + '/package.json')
    const metadata = JSON.parse(readFileSync(manifest, 'utf8'))
    const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin[command]
    return [process.execPath, [resolve(dirname(manifest), bin), ...args]]
  }
  if (command === 'python' && process.env.IDEER_PYTHON) return [process.env.IDEER_PYTHON, args]
  return [command, args]
}

function main(args) {
  const paths = projectPaths()
  for (const directory of new Set(Object.values(paths))) mkdirSync(directory, { recursive: true })
  if (args[0] === '--print-env') {
    console.log(JSON.stringify(paths, null, 2))
    return
  }
  const [command, ...commandArgs] = args
  if (!command) throw new Error('Usage: node scripts/project-env.cjs <command> [args...] or --print-env')
  const [executable, childArgs] = resolveCommand(command, commandArgs)
  const child = spawn(executable, childArgs, {
    cwd: projectRoot, env: projectEnvironment(), stdio: 'inherit', shell: false
  })
  child.on('error', error => { console.error(error.message); process.exitCode = 1 })
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
}

module.exports = { projectPaths, projectEnvironment, resolveCommand }
if (require.main === module) main(process.argv.slice(2))
