// Real Electron/main/preload/Runtime/Gateway; Server uses an explicit model fixture.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const net = require('node:net')
const { randomUUID } = require('node:crypto')
const { _electron: electron } = require('playwright-core')
const root = path.resolve(__dirname, '../../..')
const state = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json'), 'utf8'))
const appData = path.join(state, 'desktop-appdata')
const config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
const entry = path.join(state, 'electron-entry.cjs')
fs.writeFileSync(entry, `const {app}=require('electron'); app.setPath('appData',${JSON.stringify(appData)}); app.setAppPath(${JSON.stringify(root)}); require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
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
  fs.writeFileSync(config, JSON.stringify(settings))
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ args: [entry], env, timeout: 45000 })
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
  const created = await page.evaluate(command => window.ideer.chat(command), { action: 'create', scope: a.scope, agentId: manifest.agentId })
  assert.equal(created.error, '', 'thread create failed: ' + created.error)
  const threadId = created.thread.id
  const turnId = randomUUID()
  const [sent, duplicate] = await page.evaluate(command => Promise.all([window.ideer.chat(command), window.ideer.chat(command)]), { action: 'send', scope: a.scope, threadId, turnId, text: 'T99 unique ordinary chat' })
  assert.equal(sent.error, '', 'send failed: ' + sent.error)
  assert(sent.run?.id)
  assert.equal(duplicate.error, 'CHAT_TURN_ALREADY_SUBMITTED')
  await wait(async () => (await snapshot()).stream === 'idle', 'first run completion')
  let current = await snapshot()
  assert.equal(current.run.status, 'success', JSON.stringify(current.run))
  assert(current.messages.some(m => m.text === 'T99 Server response'))
  stages.push({ scenario: 'T99-02', threadId, runId: current.run.id, eventIds: current.events.map(e => e.id), selection: current.run.selection })
  const question = await page.evaluate(command => window.ideer.chat(command), { action: 'send', scope: a.scope, threadId, turnId: randomUUID(), text: 'T99 ask for clarification' })
  assert.equal(question.error, '')
  await wait(async () => (await snapshot()).stream === 'idle', 'human-input wait')
  current = await snapshot()
  const request = current.messages.find(m => m.request)?.request
  assert(request, 'Server clarification artifact missing')
  await page.getByText('T99 choose a target', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Target A', exact: true }).click()
  await wait(async () => (await snapshot()).messages.some(m => m.text === 'T99 clarification accepted'), 'clarification response')
  await wait(async () => (await snapshot()).stream === 'idle', 'clarification completion')
  await wait(async () => !(await page.getByRole('textbox', { name: '聊天消息' }).isDisabled()), 'composer enabled after clarification')
  await page.getByRole('log', { name: '平台聊天消息' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: path.join(state, 'desktop-chat.png') })
  stages.push({ scenario: 'T99-02-human-input', requestId: request.request_id, result: 'passed' })
  await quit()
  const reopened = await launch('A')
  const restored = await page.evaluate(command => window.ideer.chat(command), { action: 'open', scope: reopened.scope, threadId })
  assert.equal(restored.error, '')
  assert(restored.messages.some(m => m.text === 'T99 Server response'))
  assert(restored.messages.some(m => m.text === 'T99 clarification accepted'))
  stages.push({ scenario: 'T99-03', threadId, restoredMessages: restored.messages.map(m => m.id), result: 'passed' })
  const interrupted = await page.evaluate(command => window.ideer.chat(command), { action: 'send', scope: reopened.scope, threadId, turnId: randomUUID(), text: 'T99 controlled transport loss' })
  assert.equal(interrupted.error, '')
  await wait(async () => (await snapshot()).events.length > 0, 'live stream established before fault')
  await stopProxy()
  await wait(async () => (await snapshot()).stream === 'disconnected', 'visible disconnect')
  const offline = await page.evaluate(command => window.ideer.chat(command), { action: 'reconnect', scope: reopened.scope, threadId })
  assert.equal(offline.error, 'CHAT_SERVER_UNAVAILABLE')
  assert.equal(offline.run.id, interrupted.run.id)
  await startProxy()
  await new Promise(resolve => setTimeout(resolve, 1500))
  const recovered = await page.evaluate(command => window.ideer.chat(command), { action: 'reconnect', scope: reopened.scope, threadId })
  assert.equal(recovered.error, '')
  assert.equal(recovered.run.id, interrupted.run.id)
  assert.equal(recovered.run.status, 'success')
  stages.push({ scenario: 'T99-03-transport', runId: recovered.run.id, offlineError: offline.error, autoResubmit: false, result: 'passed' })
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
  await quit()
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ result: 'passed', model: manifest.model, elapsedMs: Date.now() - started, stages }, null, 2))
}
main().catch(error => {
  fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify({ result: 'failed', message: error.message, elapsedMs: Date.now() - started, stages }, null, 2))
  process.exitCode = 1
}).finally(async () => { await quit(); await stopProxy(); fs.writeFileSync(path.join(state, 'stop'), '') })
