// Real Electron/main/preload/Runtime/Gateway; manifest declares the Server model.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const root = path.resolve(__dirname, '../../..')
const state = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json'), 'utf8'))
const real = manifest.realProvider === true
const installed = process.env.DESKTOP_EXECUTABLE
const ordinary = real ? 'IDEER_T99_ORDINARY' : 'T99 Server response'
const clarified = real ? 'IDEER_T99_CLARIFIED' : 'T99 clarification accepted'
const appData = installed ? process.env.APPDATA : path.join(state, 'desktop-appdata')
const config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
let ownsConfig = false
const entry = path.join(state, 'electron-entry.cjs')
if (!installed) fs.writeFileSync(entry, `const {app}=require('electron'); app.setPath('appData',${JSON.stringify(appData)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
fs.mkdirSync(path.dirname(config), { recursive: true })
let app, page
let proxy, proxyPort
const sockets = new Set()
const stages = []
const started = Date.now()
async function wait(predicate, label) {
  const until = Date.now() + 60000
  while (Date.now() < until) {
    if (await predicate()) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('Timeout: ' + label)
}
async function snapshot() { return page.evaluate(() => window.ideer.chat({ action: 'state' })) }
function profileAction(action) {
  const result = spawnSync(path.join(root, '.runtime/python.exe'), ['-I', path.join(__dirname, 'provider_profiles.py'), action, state], { encoding: 'utf8', timeout: 45000 })
  assert.equal(result.status, 0, 'Fixture profile action failed: ' + action)
}
function hasAnswer(value, marker) { return value.messages.some(m => m.role === 'ai' && m.text.includes(marker)) }
async function complete(label, expectedError = '') {
  await wait(async () => (await snapshot()).stream !== 'streaming', label)
  const current = await snapshot()
  assert.equal(current.error, expectedError, label + ': ' + current.error)
  assert.equal(current.run.status, 'success', label + ': ' + JSON.stringify(current.run))
  return current
}
async function startProxy() {
  const upstream = new URL(manifest.origin)
  proxy = net.createServer(socket => {
    const remote = net.connect(Number(upstream.port), '127.0.0.1')
    sockets.add(socket); sockets.add(remote)
    socket.on('error', () => remote.destroy())
    remote.on('error', () => socket.destroy())
    socket.on('close', () => { sockets.delete(socket); remote.destroy() })
    remote.on('close', () => { sockets.delete(remote); socket.destroy() })
    socket.pipe(remote); remote.pipe(socket)
  })
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(proxyPort || 0, '127.0.0.1', resolve) })
  proxyPort = proxy.address().port
}
async function stopProxy() {
  if (!proxy) return
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => proxy.close(resolve))
  proxy = null
}
async function launch(identity) {
  const settings = JSON.parse(fs.readFileSync(manifest.identities[identity].profile, 'utf8'))
  settings.server_url = `http://127.0.0.1:${proxyPort}`
  if (installed && ownsConfig) {
    const references = JSON.parse(fs.readFileSync(path.join(state, 'credential-references.json'), 'utf8'))
    assert(references.includes(JSON.parse(fs.readFileSync(config, 'utf8')).business_token_ref), 'Runtime settings ownership changed')
  }
  // Exclusive creation protects an existing session even if the preflight races.
  fs.writeFileSync(config, JSON.stringify(settings), { flag: installed && !ownsConfig ? 'wx' : 'w' })
  ownsConfig = true
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [entry] }), env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !!installed)
  page = await app.firstWindow()
  page.setDefaultTimeout(30000)
  await wait(async () => (await page.evaluate(() => window.ideer.getStatus())).runtime.login?.state === 'authenticated', 'restore OS session')
  await wait(async () => !!(await snapshot()).scope, 'scope ready')
  const result = await page.evaluate(() => window.ideer.chat({ action: 'refresh' }))
  assert.equal(result.error, '', 'catalog refresh failed: ' + result.error)
  return result
}
async function quit() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 25000 })
  await page.evaluate(() => window.ideer.quit())
  await closed
  app = null
}
async function main() {
  await startProxy()
  const a = await launch('A')
  assert(a.resources.some(r => r.id === manifest.agentId && r.available))
  if (real) {
    profileAction('negative')
    assert(a.resources.some(r => r.id === manifest.skillId && r.available && r.version === 1))
    for (const id of [manifest.unpublishedId, manifest.unavailableId]) {
      assert(a.resources.some(r => r.id === id && !r.available))
      const rejected = await page.evaluate(command => window.ideer.chat(command), { action: 'create', scope: a.scope, agentId: id })
      assert(['CHAT_NOT_FOUND', 'CHAT_CONFLICT', 'CHAT_RESOURCE_UNAVAILABLE'].includes(rejected.error), rejected.error)
      assert.equal(rejected.thread, null)
    }
    const serverRejections = JSON.parse(fs.readFileSync(path.join(state, 'negative-api.json'), 'utf8'))
    stages.push({ scenario: 'T99-01', resources: a.resources, forcedUnavailable: 'rejected', serverRejections })
  }
  await page.locator('.ant-select[aria-label="选择 Agent"]').click()
  await page.locator('.ant-select-item-option').filter({ hasText: real ? 't99-real-expert' : 'T99 private expert' }).click()
  if (real) {
    await page.locator('.ant-select[aria-label="选择 Skill"]').click()
    await page.locator('.ant-select-item-option').filter({ hasText: 't99-real-skill' }).click()
  }
  await page.getByRole('button', { name: '新建平台聊天', exact: true }).click()
  await wait(async () => !!(await snapshot()).thread, 'create Thread through UI')
  const created = await snapshot()
  assert.equal(created.error, '', 'thread create failed: ' + created.error)
  const threadId = created.thread.id
  const turnId = randomUUID()
  const [sent, duplicate] = await page.evaluate(command => Promise.all([window.ideer.chat(command), window.ideer.chat(command)]), { action: 'send', scope: a.scope, threadId, turnId,
    text: real ? 'Reply briefly with IDEER_T99_ORDINARY and the selected Skill marker. This is ordinary chat; do not call tools.' : 'T99 unique ordinary chat' })
  assert.equal(sent.error, '', 'send failed: ' + sent.error)
  assert(sent.run?.id)
  assert.equal(duplicate.error, 'CHAT_TURN_ALREADY_SUBMITTED')
  let current = await complete('first run completion', 'CHAT_TURN_ALREADY_SUBMITTED')
  assert(hasAnswer(current, ordinary), JSON.stringify(current.messages))
  if (real) {
    assert(hasAnswer(current, 'IDEER_T99_SKILL_V1'))
    assert.equal(current.run.selection.agent.resource_id, manifest.agentId)
    assert.equal(current.run.selection.preferred_skill.resource_id, manifest.skillId)
  }
  stages.push({ scenario: 'T99-02', threadId, runId: current.run.id, eventIds: current.events.map(e => e.id), selection: current.run.selection })
  const question = await page.evaluate(command => window.ideer.chat(command), { action: 'send', scope: a.scope, threadId, turnId: randomUUID(), text: 'T99 ask for clarification' })
  assert.equal(question.error, '')
  current = await complete('human-input wait')
  const request = current.messages.find(m => m.request)?.request
  assert(request, 'Server clarification artifact missing')
  await page.getByText('T99 choose a target', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Target A', exact: true }).click()
  await wait(async () => hasAnswer(await snapshot(), clarified), 'clarification response')
  current = await complete('clarification completion')
  await wait(async () => !(await page.getByRole('textbox', { name: '聊天消息' }).isDisabled()), 'composer enabled after clarification')
  await page.getByRole('log', { name: '平台聊天消息' }).scrollIntoViewIfNeeded()
  await page.getByText(`Run：${current.run.id} · success · idle`, { exact: true }).waitFor()
  await page.getByRole('log').evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: path.join(state, 'desktop-chat.png') })
  stages.push({ scenario: 'T99-02-human-input', requestId: request.request_id, eventIds: current.events.map(e => e.id), result: 'passed' })
  if (real) {
    // Existing Server/Web runs can enable delegation through their public context.
    // Desktop restores and observes that same Run without replacing its policy.
    profileAction('delegate')
    const delegated = JSON.parse(fs.readFileSync(path.join(state, 'delegation.json'), 'utf8'))
    const opened = await page.evaluate(command => window.ideer.chat(command), { action: 'open', scope: a.scope, threadId: delegated.threadId })
    assert.equal(opened.error, '')
    assert.equal(opened.run.id, delegated.runId)
    await page.getByText('服务端工具与子代理进度', { exact: true }).click()
    const progress = new Map()
    let progressScreenshot = false
    await wait(async () => {
      const value = await snapshot()
      for (const event of value.events) if (event.event === 'custom' || event.event.includes('|')) progress.set(event.id, event)
      const liveProgress = page.locator('pre').filter({ hasText: 'task_running' }).first()
      if (!progressScreenshot && await liveProgress.isVisible()) {
        await liveProgress.scrollIntoViewIfNeeded()
        await page.screenshot({ path: path.join(state, 'desktop-delegation-progress.png') })
        progressScreenshot = true
      }
      return value.stream !== 'streaming'
    }, 'delegated Run completion')
    const finished = await complete('delegated Run status')
    assert(hasAnswer(finished, 'IDEER_T99_DELEGATED'))
    assert.equal(finished.messages.filter(m => m.role === 'human' && m.text.startsWith('Delegation test:')).length, 1,
      'Server journal/checkpoint aliases displayed the same user Turn twice')
    assert(finished.messages.some(m => m.name === 'task'), 'Actual task tool result missing')
    assert([...progress.values()].some(e => /task_(started|running|completed)|subagent/.test(e.detail)), 'Subagent progression missing')
    await page.getByText(`Run：${delegated.runId} · success · idle`, { exact: true }).waitFor()
    await page.getByRole('log').scrollIntoViewIfNeeded()
    await page.getByRole('log').evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.screenshot({ path: path.join(state, 'desktop-delegation.png') })
    stages.push({ scenario: 'T99-02-delegation', ...delegated, userTurnsDisplayed: 1, progressScreenshot,
      events: [...progress.values()], result: 'passed' })
  }
  await quit()
  const reopened = await launch('A')
  const restored = await page.evaluate(command => window.ideer.chat(command), { action: 'open', scope: reopened.scope, threadId })
  assert.equal(restored.error, '')
  assert(hasAnswer(restored, ordinary))
  assert(hasAnswer(restored, clarified))
  stages.push({ scenario: 'T99-03', threadId, restoredMessages: restored.messages.map(m => m.id), result: 'passed' })
  const interrupted = await page.evaluate(command => window.ideer.chat(command), { action: 'send', scope: reopened.scope, threadId, turnId: randomUUID(), text: real ? 'Reply briefly with IDEER_T99_RECOVERED. Do not call tools.' : 'T99 controlled transport loss' })
  assert.equal(interrupted.error, '')
  await wait(async () => (await snapshot()).events.length > 0, 'live stream established before fault')
  await stopProxy()
  await wait(async () => (await snapshot()).stream === 'disconnected', 'visible disconnect')
  const offline = await page.evaluate(command => window.ideer.chat(command), { action: 'reconnect', scope: reopened.scope, threadId })
  assert.equal(offline.error, 'CHAT_SERVER_UNAVAILABLE')
  assert.equal(offline.run.id, interrupted.run.id)
  const offlineSend = await page.evaluate(command => window.ideer.chat(command), { action: 'send', scope: reopened.scope, threadId, turnId: randomUUID(), text: 'T99 unavailable Server must reject this submission' })
  assert.equal(offlineSend.error, 'CHAT_SERVER_UNAVAILABLE')
  assert.equal(offlineSend.run.id, interrupted.run.id)
  await startProxy()
  let recovered = await page.evaluate(command => window.ideer.chat(command), { action: 'reconnect', scope: reopened.scope, threadId })
  assert.equal(recovered.error, '')
  if (recovered.stream === 'streaming') {
    recovered = await complete('recovered run completion')
  }
  assert.equal(recovered.run.id, interrupted.run.id)
  assert.equal(recovered.run.status, 'success')
  stages.push({ scenario: 'T99-03-transport', runId: recovered.run.id, offlineError: offline.error, offlineSendError: offlineSend.error, autoResubmit: false, result: 'passed' })
  await quit()
  const b = await launch('B')
  assert.notEqual(a.scope, b.scope)
  assert(!b.resources.some(r => r.id === manifest.agentId))
  assert(!b.threads.some(t => t.id === threadId))
  const privateAgent = await page.evaluate(command => window.ideer.chat(command), { action: 'create', scope: b.scope, agentId: manifest.agentId })
  assert.equal(privateAgent.error, 'CHAT_NOT_FOUND')
  const forced = await page.evaluate(command => window.ideer.chat(command), { action: 'open', scope: b.scope, threadId })
  assert.equal(forced.error, 'CHAT_NOT_FOUND')
  assert.equal(forced.messages.length, 0)
  await quit()
  const back = await launch('A')
  assert(back.threads.some(t => t.id === threadId))
  stages.push({ scenario: 'T99-04', privateAgentId: manifest.agentId, identityIsolation: true, result: 'passed' })
  if (real) {
    profileAction('evidence')
    const runs = JSON.parse(fs.readFileSync(path.join(state, 'run-evidence.json'), 'utf8'))
    assert.equal(runs.filter(run => run.threadId === threadId).length, 4, 'Duplicate or offline Turn created an extra Run')
    assert.equal(runs.filter(run => run.turnId === turnId).length, 1, 'Same Turn accepted more than once')
  }
  await quit()
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ result: 'passed', model: manifest.model, realProvider: real, installedExecutable: installed || null, elapsedMs: Date.now() - started, stages }, null, 2))
}
main().catch(error => {
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ result: 'failed', message: error.message, elapsedMs: Date.now() - started, stages }, null, 2))
  process.exitCode = 1
}).finally(async () => {
  try {
    await quit()
  } catch (error) {
    process.exitCode = 1
    const file = path.join(state, 'result.json')
    const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { stages }
    fs.writeFileSync(file, JSON.stringify({ ...result, result: 'failed', cleanupError: error.message }, null, 2))
    // This handle belongs only to the Electron instance launched by this fixture.
    app?.process()?.kill()
  } finally {
    try { await stopProxy() }
    finally {
      try {
        if (real) profileAction('cleanup')
      }
      catch (error) {
        process.exitCode = 1
        const file = path.join(state, 'result.json')
        const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { stages }
        fs.writeFileSync(file, JSON.stringify({ ...result, result: 'failed', credentialCleanupError: error.message }, null, 2))
      }
      finally {
        try {
          if (installed && ownsConfig) {
            const references = JSON.parse(fs.readFileSync(path.join(state, 'credential-references.json'), 'utf8'))
            assert(references.includes(JSON.parse(fs.readFileSync(config, 'utf8')).business_token_ref), 'Runtime settings ownership changed')
            fs.unlinkSync(config)
            fs.writeFileSync(path.join(state, 'profile-cleanup.json'), JSON.stringify({ originalSettings: 'absent', restoredSettings: 'absent' }))
          }
        } catch (error) {
          process.exitCode = 1
          const file = path.join(state, 'result.json')
          const result = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { stages }
          fs.writeFileSync(file, JSON.stringify({ ...result, result: 'failed', profileCleanupError: error.message }, null, 2))
        } finally { fs.writeFileSync(path.join(state, 'stop'), '') }
      }
    }
  }
})
