// Actual Electron/main/preload/Windows Runtime and isolated real Gateway.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { randomUUID, createHash } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const root = path.resolve(__dirname, '../../..')
const state = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json'), 'utf8'))
const installed = process.env.DESKTOP_EXECUTABLE
const appData = installed ? process.env.APPDATA : path.join(state, 'appdata')
const config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer-t100-'))
const w1 = path.join(work, 'W1'), w2 = path.join(work, 'W2'), outside = path.join(work, 'outside')
for (const directory of [w1, w2, outside]) fs.mkdirSync(directory)
const original = 'known_marker = 100\n'
fs.writeFileSync(path.join(w1, 'marker.py'), original)
fs.writeFileSync(path.join(w2, 'other.txt'), 'W2 fixed text\n')
fs.writeFileSync(path.join(outside, 'secret.txt'), 'T100_OUTSIDE_MUST_NOT_LEAK')
const sha = value => createHash('sha256').update(value).digest('hex')
const result = { startedAt: new Date().toISOString(), model: manifest.model,
  fixtures: { 'W1/marker.py': sha(original), 'W2/other.txt': sha('W2 fixed text\n'),
    'outside/secret.txt': sha('T100_OUTSIDE_MUST_NOT_LEAK') }, stages: [],
  picker: 'Native dialog callbacks supply synthetic paths; actual Desktop button and confirmation options are exercised.' }
let app, page, currentLabel
let ownsInstalledSettings = false
const entry = path.join(state, 'electron-entry.cjs')
fs.writeFileSync(entry, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});app.setAppPath(${JSON.stringify(root)});require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)

function profile(action, ...args) {
  const invocation = spawnSync(path.join(root, '.runtime/python.exe'), ['-I', path.join(__dirname, 'profiles.py'), action, state, ...args],
    { encoding: 'utf8', timeout: 60000, windowsHide: true })
  assert.equal(invocation.status, 0, action + ': ' + invocation.stderr)
  return JSON.parse(invocation.stdout.trim())
}
const api = (label, route, body) => profile('api', label, route, ...(body === undefined ? [] : [JSON.stringify(body)]))
async function wait(predicate, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timeout: ' + label)
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const snapshot = () => page.evaluate(() => window.ideer.chat({ action: 'state' }))
async function command(value) { return page.evaluate(value => window.ideer.chat(value), value) }
function save() { fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(result, null, 2)) }
function stage(name, details) { result.stages.push({ name, ...details }); save() }

async function launch(label) {
  currentLabel = label
  fs.mkdirSync(path.dirname(config), { recursive: true })
  const settings = fs.readFileSync(manifest.identities[label].profile)
  fs.writeFileSync(config, settings, { flag: installed && !ownsInstalledSettings ? 'wx' : 'w' })
  if (installed) ownsInstalledSettings = true
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [entry] }), env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !!installed)
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await wait(async () => (await status()).runtime.login?.state === 'authenticated', 'business session')
  await wait(async () => (await status()).server === 'connected', 'signed device connection')
  assert.equal((await command({ action: 'refresh' })).error, '')
}
async function quit() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ideer.quit())
  await closed
  app = null
  fs.copyFileSync(config, manifest.identities[currentLabel].profile)
}
async function choose(directory) {
  await app.evaluate(({ dialog }, directory) => {
    global.t100Confirmation = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    dialog.showMessageBox = async (_owner, options) => {
      global.t100Confirmation = { title: options.title, detail: options.detail.replace(directory, '<synthetic directory>'), buttons: options.buttons }
      return { response: 1, checkboxChecked: false }
    }
  }, directory)
  const previous = (await status()).runtime.workspace?.logicalRoot
  await page.getByRole('button', { name: '选择并授权只读目录' }).click()
  await wait(async () => {
    const current = await status()
    return current.runtime.workspace?.state === 'ready' && current.runtime.workspace.logicalRoot !== previous && current.server === 'connected'
  }, 'selected directory')
  const confirmation = await app.evaluate(() => global.t100Confirmation)
  assert.match(confirmation.detail, /不会自动上传整个目录/)
  assert.match(confirmation.detail, /Resource/)
  return { root: (await status()).runtime.workspace.logicalRoot, confirmation }
}
async function request(operation, arguments_, expected, ui = false) {
  let current = await snapshot()
  current = await command({ action: 'create', scope: current.scope, agentId: manifest.identities[currentLabel].agentId })
  assert.equal(current.error, '', 'Thread create')
  const threadId = current.thread.id
  const text = 'T100_REQUEST ' + JSON.stringify({ operation, arguments: arguments_ })
  if (ui) {
    await page.getByRole('textbox', { name: '聊天消息', exact: true }).fill(text)
    await page.getByRole('button', { name: /^发\s*送$/ }).click()
  } else {
    const submitted = await command({ action: 'send', scope: current.scope, threadId, turnId: randomUUID(), text })
    assert.equal(submitted.error, '', 'Run submit')
  }
  await wait(async () => {
    current = await snapshot()
    return current.run && !['pending', 'running'].includes(current.run.status) && current.stream !== 'streaming'
  }, operation + ' actual Server Run')
  const transcript = current.messages.map(message => message.text).join('\n')
  assert.match(transcript, expected, operation + ': ' + current.messages.filter(m => m.role === 'tool').map(m => m.text).join('; '))
  assert(!transcript.includes('T100_OUTSIDE_MUST_NOT_LEAK'), 'outside content leaked')
  assert(!transcript.includes('T100_PROTECTED_MUST_NOT_LEAK'), 'protected content leaked')
  const ids = [...new Set((await status()).runtime.tasks.filter(task => task.runId === current.run.id).map(task => task.taskId))]
  const tasks = ids.map(id => api(currentLabel, '/api/devices/tasks/' + id))
  for (const task of tasks) {
    assert.equal(task.status, 200)
    assert.equal(task.body.run_id, current.run.id)
    assert(task.body.tool_call_id, 'missing Tool Call correlation')
    assert.equal(task.body.receipt.task_id, task.body.task_id)
  }
  stage(operation, { threadId, runId: current.run.id, runStatus: current.run.status,
    messages: current.messages, tasks })
  return current
}

async function main() {
  try {
    await launch('A')
    const resourcesBefore = api('A', '/api/resources?limit=200').body
    const selected = await choose(w1)
    stage('T100-01 selection', selected)
    const toolResult = response => JSON.parse(response.messages.find(message => message.role === 'tool').text)
    const listing = toolResult(await request('list', { path: selected.root }, /marker.py/, true))
    assert.deepEqual(listing, { entries: [selected.root + '/marker.py'], truncated: false,
      source: { path: selected.root, logicalRoot: selected.root, operation: 'local.files.list' } })
    const reading = toolResult(await request('read', { path: selected.root + '/marker.py' }, /known_marker = 100/))
    assert.deepEqual(reading, { content: original, bytes: Buffer.byteLength(original), sha256: sha(original),
      source: { path: selected.root + '/marker.py', logicalRoot: selected.root, operation: 'local.files.read' } })
    const searching = toolResult(await request('search', { path: selected.root, query: 'known_marker' }, /known_marker = 100/))
    assert.deepEqual(searching, { matches: [{ path: selected.root + '/marker.py', line: 1, text: 'known_marker = 100' }],
      truncated: false, filesScanned: 1,
      source: { path: selected.root, logicalRoot: selected.root, operation: 'local.files.search' } })
    const resourcesAfter = api('A', '/api/resources?limit=200').body
    assert(Number.isInteger(resourcesBefore.total) && Number.isInteger(resourcesAfter.total))
    assert.equal(resourcesAfter.total, resourcesBefore.total, 'workspace registered as Resource')
    const resourceSummary = value => ({ total: value.total,
      items: value.items.map(item => ({ id: item.id, type: item.type, slug: item.slug }))
        .sort((a, b) => a.id.localeCompare(b.id)) })
    assert.deepEqual(resourceSummary(resourcesAfter), resourceSummary(resourcesBefore))
    stage('T100-01 resource comparison', { before: resourceSummary(resourcesBefore), after: resourceSummary(resourcesAfter) })
    await page.screenshot({ path: path.join(state, 'workspace-chat.png'), fullPage: true })
    // Rejection targets appear only after successful root enumeration/search.
    fs.mkdirSync(path.join(w1, '.git'))
    fs.writeFileSync(path.join(w1, '.git/config'), 'T100_PROTECTED_MUST_NOT_LEAK')
    await request('read', { path: selected.root + '/.git/config' }, /PROTECTED_PATH/)
    await request('read', { path: selected.root + '/../outside/secret.txt' }, /OUTSIDE_ALLOWED_ROOTS/)
    fs.symlinkSync(outside, path.join(w1, 'junction'), 'junction')
    await request('read', { path: selected.root + '/junction/secret.txt' }, /OUTSIDE_ALLOWED_ROOTS/)
    try {
      fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(w1, 'symlink.txt'), 'file')
      await request('read', { path: selected.root + '/symlink.txt' }, /OUTSIDE_ALLOWED_ROOTS/)
      stage('symlink', { status: 'passed' })
    } catch (error) {
      if (error.code !== 'EPERM') throw error
      const linuxPath = value => '/mnt/' + value[0].toLowerCase() + value.slice(2).replace(/\\/g, '/')
      const made = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--', 'ln', '-s',
        linuxPath(path.join(outside, 'secret.txt')), linuxPath(path.join(w1, 'symlink.txt'))],
        { encoding: 'utf8', timeout: 15000, windowsHide: true })
      assert.equal(made.status, 0, 'WSL NTFS symlink fixture creation')
      await request('read', { path: selected.root + '/symlink.txt' }, /OUTSIDE_ALLOWED_ROOTS/)
      stage('symlink', { status: 'passed', kind: 'NTFS WSL LX symlink',
        limitation: 'Win32 CreateSymbolicLink privilege unavailable; LX reparse-point symlink tested instead.' })
    }
    fs.writeFileSync(path.join(state, 'hold'), '')
    let pending = await snapshot()
    pending = await command({ action: 'create', scope: pending.scope, agentId: manifest.identities.A.agentId })
    await command({ action: 'send', scope: pending.scope, threadId: pending.thread.id, turnId: randomUUID(),
      text: 'T100_REQUEST ' + JSON.stringify({ operation: 'read', arguments: { path: selected.root + '/marker.py' }, hold: true }) })
    await wait(() => fs.existsSync(path.join(state, 'held')), 'pending request before directory change')
    const switched = await choose(w2)
    fs.unlinkSync(path.join(state, 'hold'))
    await wait(async () => {
      pending = await snapshot()
      return pending.run && !['pending', 'running'].includes(pending.run.status) && pending.stream !== 'streaming'
    }, 'old pending request rejected')
    assert.match(pending.messages.map(m => m.text).join('\n'), /OUTSIDE_ALLOWED_ROOTS/)
    stage('T100-04 pending old directory', { runId: pending.run.id, messages: pending.messages })
    await request('read', { path: selected.root + '/marker.py' }, /OUTSIDE_ALLOWED_ROOTS/)
    const secondRead = toolResult(await request('read', { path: switched.root + '/other.txt' }, /W2 fixed text/))
    assert.equal(secondRead.content, 'W2 fixed text\n')
    assert.equal(secondRead.bytes, 14)
    assert.equal(secondRead.sha256, sha('W2 fixed text\n'))
    const old = api('A', '/api/devices/' + manifest.identities.A.deviceId + '/tasks/local', {
      operation: 'local.files.read', run_id: 'forged-run', tool_call_id: 'forged-call',
      payload: { path: switched.root + '/other.txt' } })
    assert.equal(old.status, 403)
    stage('T100-04 old Server route', old)
    fs.writeFileSync(path.join(state, 'platform-deny'), '')
    await wait(() => {
      try { return JSON.parse(fs.readFileSync(path.join(state, 'platform-state.json'))).denied } catch { return false }
    }, 'trusted Server platform denial')
    await request('read', { path: switched.root + '/other.txt' }, /not a valid tool|LOCAL_AUTHORIZATION_DENIED|unavailable/)
    stage('T100-03 platform denial', { status: 'passed' })
    fs.unlinkSync(path.join(state, 'platform-deny'))
    await wait(() => {
      try { return JSON.parse(fs.readFileSync(path.join(state, 'platform-state.json'))).denied === false } catch { return false }
    }, 'restore platform policy')
    // Persist a local denial, restart the same Runtime, then attempt the tool.
    await page.evaluate(() => window.ideer.stopRuntime())
    const settings = JSON.parse(fs.readFileSync(config, 'utf8'))
    settings.rules = { ...settings.rules, 'local.files.read': 'deny' }
    fs.writeFileSync(config, JSON.stringify(settings))
    await page.evaluate(() => window.ideer.startRuntime())
    await wait(async () => (await status()).server === 'connected', 'denied profile connection')
    await request('read', { path: switched.root + '/other.txt' }, /POLICY_DENIED|LOCAL_POLICY_DENIED/)
    await quit()
    await launch('B')
    assert.equal((await status()).runtime.workspace.state, 'unavailable')
    const denied = api('B', '/api/threads/' + result.stages.find(s => s.threadId).threadId)
    assert([403, 404].includes(denied.status))
    stage('T100-04 B/D2 isolation', { workspace: (await status()).runtime.workspace, threadAccess: denied.status })
    await quit()
    await launch('A')
    assert.equal((await status()).runtime.workspace.logicalRoot, switched.root)
    stage('T100-04 A/D1 restart', { workspace: (await status()).runtime.workspace })
    await quit()
    profile('evidence', 'A')
    profile('evidence', 'B')
    const receipts = JSON.parse(fs.readFileSync(path.join(state, 'run-evidence-A.json'), 'utf8'))
    for (const completed of result.stages.filter(stage => stage.runId)) {
      const run = receipts.find(row => row.runId === completed.runId)
      assert(run, 'missing public Run evidence')
      assert.equal(run.metadata.run_evidence.archive_status, 'archived')
      const archived = run.metadata.run_evidence.tool_receipts
      const local = archived.filter(row => row.local_execution_receipt?.task_id)
      const toolMessages = completed.messages.filter(message => message.role === 'tool')
      if (toolMessages.length && !toolMessages.some(message => /not a valid tool/.test(message.text))) {
        assert(local.length > 0, 'Dispatched operation has no archived Local Task receipt')
      }
      // Runtime's periodic status can lag a fast tool. Use durable public Run
      // receipts to enumerate every task before checking its public task API.
      completed.tasks = local.map(row => api('A', '/api/devices/tasks/' + row.local_execution_receipt.task_id))
      for (const task of completed.tasks) {
        assert.equal(task.status, 200)
        const linked = archived.find(row =>
          row.local_execution_receipt?.task_id === task.body.task_id)
        assert(linked, 'Local Task receipt was not archived in Run evidence')
        assert.equal(linked.tool_call_id, task.body.tool_call_id)
        assert.equal(linked.local_execution_receipt.run_id, completed.runId)
        assert.equal(linked.local_execution_receipt.payload_hash, task.body.receipt.payload_hash)
        assert(completed.messages.some(message => message.role === 'tool'), 'tool result absent from original Thread')
      }
    }
    assert.equal(fs.readFileSync(path.join(w1, 'marker.py'), 'utf8'), original)
    assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'T100_OUTSIDE_MUST_NOT_LEAK')
    assert.equal(fs.readFileSync(path.join(w1, '.git/config'), 'utf8'), 'T100_PROTECTED_MUST_NOT_LEAK')
    stage('T100-03 unchanged files', { marker: sha(fs.readFileSync(path.join(w1, 'marker.py'))),
      outside: sha(fs.readFileSync(path.join(outside, 'secret.txt'))),
      protected: sha(fs.readFileSync(path.join(w1, '.git/config'))) })
    result.status = result.stages.some(s => s.status === 'unexecuted') ? 'incomplete' : 'passed'
  } catch (error) {
    result.status = 'failed'
    result.error = error.stack
    throw error
  } finally {
    await quit().catch(() => {})
    result.finishedAt = new Date().toISOString()
    save()
    try { profile('cleanup') } catch (error) {
      result.status = 'failed'
      result.cleanupError = error.message
      save()
      throw error
    } finally { fs.writeFileSync(path.join(state, 'stop'), '') }
    // Remove link objects first, then only the uniquely created fixture root.
    for (const name of ['junction', 'symlink.txt']) {
      const link = path.join(w1, name)
      try { fs.unlinkSync(link) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(work, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
