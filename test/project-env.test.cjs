const assert = require('node:assert/strict')
const { test } = require('node:test')
const { spawnSync } = require('node:child_process')
const { join, resolve, isAbsolute, relative } = require('node:path')
const { projectPaths, projectEnvironment } = require('../scripts/project-env.cjs')

const root = resolve(__dirname, '..')
const runner = join(root, 'scripts/project-env.cjs')

test('paths follow a relocated checkout, including spaces', () => {
  const relocated = join(root, 'artifacts', 'a different checkout')
  for (const [name, value] of Object.entries(projectPaths(relocated))) {
    assert.ok(isAbsolute(value))
    if (['TEMP', 'TMP', 'TMPDIR'].includes(name)) assert.equal(value, relocated + '.tmp')
    else assert.ok(!relative(join(relocated, '.cache'), value).startsWith('..'))
  }
})

test('project paths replace inherited Windows case variants without moving credentials', () => {
  const parent = { temp: 'old-temp', NPM_CONFIG_CACHE: 'old-npm', HF_HOME: 'existing-token-home', APPDATA: 'existing-profile' }
  const env = projectEnvironment(parent)
  assert.equal(env.TEMP, root + '.tmp')
  assert.equal(env.npm_config_cache, join(root, '.cache', 'npm'))
  assert.ok(!Object.hasOwn(env, 'temp'))
  assert.ok(!Object.hasOwn(env, 'NPM_CONFIG_CACHE'))
  assert.equal(env.HF_HOME, parent.HF_HOME)
  assert.equal(env.APPDATA, parent.APPDATA)
  assert.equal(parent.NPM_CONFIG_CACHE, 'old-npm')
})

test('child and grandchild receive project paths even when launched elsewhere', () => {
  const childCode = `
    const assert = require('node:assert/strict')
    const { spawnSync } = require('node:child_process')
    const { join } = require('node:path')
    assert.equal(process.cwd(), ${JSON.stringify(root)})
    assert.equal(require('node:os').tmpdir(), process.cwd() + '.tmp')
    const result = spawnSync(process.execPath, ['-e', 'console.log(require("node:os").tmpdir())'], { encoding: 'utf8' })
    assert.equal(result.status, 0)
    assert.equal(result.stdout.trim(), require('node:os').tmpdir())
    assert.equal(process.argv[1], 'a path with spaces & literal text')
  `
  const result = spawnSync(process.execPath, [runner, 'node', '-e', childCode, 'a path with spaces & literal text'], {
    cwd: __dirname, encoding: 'utf8', env: { ...process.env, TEMP: 'old-temp' }
  })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

test('runner propagates command failures', () => {
  const result = spawnSync(process.execPath, [runner, 'node', '-e', 'process.exit(7)'], { encoding: 'utf8' })
  assert.equal(result.status, 7)
})
