// Installed Electron + bundled Runtime + real isolated Gateway, synthetic data only.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { _electron: electron } = require('playwright-core')
const root = path.resolve(__dirname, '../../..')
const state = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json'), 'utf8'))
const installed = process.env.DESKTOP_EXECUTABLE
const appData = installed ? process.env.APPDATA : path.join(state, 'appdata')
const config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
const owner = path.join(path.dirname(config), '.issue101-owner')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer-t101-'))
const marker = 'T101_UNIQUE_FIXED_MARKER_101\n'
fs.writeFileSync(path.join(work, 'marker.txt'), marker)
const sha = value => createHash('sha256').update(value).digest('hex')
const evidence = { startedAt: new Date().toISOString(), markerSHA256: sha(marker), stages: [], operations: [], installed: !!installed }
let app, page, label, ownsSettings = false
const entry = path.join(state, 'electron-entry.cjs')
fs.writeFileSync(entry, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});app.setAppPath(${JSON.stringify(root)});require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
function save() { fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2)) }
function stage(id, value) { evidence.stages.push({ id, ...value }); save() }
function python(file, ...args) {
  const run = spawnSync(path.join(root, '.runtime/python.exe'), ['-I', file, ...args], { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  assert.equal(run.status, 0, file + ': ' + run.stderr)
  return JSON.parse(run.stdout.trim())
}
function api(account, route, body) {
  return python(path.join(__dirname, '../issue-100/profiles.py'), 'api', state, account, route, ...(body === undefined ? [] : [JSON.stringify(body)]))
}
const controls = (action, ...args) => python(path.join(__dirname, 'profile_controls.py'), action, config, ...args)
async function wait(predicate, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  throw new Error('Timeout: ' + description)
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const chat = command => page.evaluate(command => window.ideer.chat(command), command)
// Status polling also reads history, so retry only the expected one-request busy condition.
async function history(action = 'history', offset = 0) {
  for (let i = 0; i < 40; i++) {
    try { return await page.evaluate(({ action, offset }) => window.ideer.receipts(action, offset), { action, offset }) }
    catch (error) { if (!String(error).includes('RECEIPT_BUSY')) throw error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  throw new Error('Receipt history remained busy')
}
async function screenshotWhenSettled(filename, expectedTaskId) {
  const started = Date.now()
  let consecutive = 0
  await wait(async () => {
    // Observe rendered state only: another receipt IPC here can contend with the UI poll.
    const text = await page.locator('body').innerText()
    const ready = text.includes('桌面业务会话：已认证') && text.includes('进程：运行中') &&
      /共 \d+ 条 · 待确认 \d+/.test(text) && !text.includes('读取中') &&
      !text.includes('无法读取回执历史') && !text.includes('无法读取 Runtime 状态') &&
      (!expectedTaskId || text.includes(expectedTaskId))
    consecutive = ready ? consecutive + 1 : 0
    return consecutive >= 3
  }, 'settled authenticated receipt history for ' + filename, 15000)
  await page.screenshot({ path: path.join(state, filename), fullPage: true })
  evidence.visuals ||= []
  evidence.visuals.push({ filename, settledAt: new Date().toISOString(), elapsedMs: Date.now() - started, consecutiveSamples: consecutive })
  save()
}
async function launch(account, authenticated = true) {
  label = account
  fs.mkdirSync(path.dirname(config), { recursive: true })
  if (!installed) fs.writeFileSync(owner, 'isolated issue101 fixture')
  fs.writeFileSync(config, fs.readFileSync(manifest.identities[account].profile), { flag: installed && !ownsSettings ? 'wx' : 'w' })
  ownsSettings = true
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [entry] }), env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !!installed)
  page = await app.firstWindow()
  await wait(async () => (await status()).runtime.process === 'running', 'Runtime process')
  if (authenticated) {
    await wait(async () => (await status()).runtime.login?.state === 'authenticated', 'business identity')
    // An ACK may intentionally close the first connection, but retry remains safe.
    await wait(async () => ['connected', 'offline'].includes((await status()).server), 'device connection attempt')
  }
  await app.evaluate(({ dialog }) => { dialog.showMessageBox = async (_owner, options) => { global.receiptConfirmation = options; return { response: 1 } } })
}
async function quit() {
  if (!app) return
  const closing = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ideer.quit())
  await closing
  app = null
  fs.copyFileSync(config, manifest.identities[label].profile)
}
async function read(logical, expected) {
  const operation = { id: randomUUID(), startedAt: new Date().toISOString(), phase: 'connection-readiness', refreshAttempts: [] }
  evidence.operations.push(operation); save()
  await wait(async () => (await status()).server === 'connected', 'task-ready connection')
  let snapshot
  operation.phase = 'read-only-refresh'; save()
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    snapshot = await chat({ action: 'refresh' })
    operation.refreshAttempts.push({ attempt, startedAt: new Date(started).toISOString(), elapsedMs: Date.now() - started, error: snapshot.error })
    save()
    if (snapshot.error !== 'CHAT_SERVER_UNAVAILABLE' || attempt === 3) break
    await new Promise(resolve => setTimeout(resolve, 250 * attempt))
  }
  assert.equal(snapshot.error, '', `read ${operation.id}: read-only refresh failed`)
  operation.phase = 'create-thread-once'; save()
  snapshot = await chat({ action: 'create', scope: snapshot.scope, agentId: manifest.identities[label].agentId })
  operation.createError = snapshot.error; save()
  assert.equal(snapshot.error, '', `read ${operation.id}: single Thread create is uncertain; do not resubmit`)
  const threadId = snapshot.thread.id
  const turnId = randomUUID()
  operation.threadId = threadId; operation.turnId = turnId; operation.phase = 'submit-run-once'; save()
  const sent = await chat({ action: 'send', scope: snapshot.scope, threadId, turnId,
    text: 'T100_REQUEST ' + JSON.stringify({ operation: 'read', arguments: { path: logical + '/marker.txt' } }) })
  operation.sendError = sent.error; save()
  assert.equal(sent.error, '', `read ${operation.id}: single Run submit is uncertain; reconcile turn ${turnId}, do not resubmit`)
  operation.phase = 'observe-terminal-run'; save()
  await wait(async () => {
    snapshot = await chat({ action: 'state' })
    return snapshot.run && !['pending', 'running'].includes(snapshot.run.status) && snapshot.stream !== 'streaming'
  }, 'terminal read Run')
  assert.match(snapshot.messages.map(message => message.text).join('\n'), expected)
  operation.phase = 'completed'; operation.finishedAt = new Date().toISOString(); operation.runId = snapshot.run.id; operation.runStatus = snapshot.run.status; save()
  return { runId: snapshot.run.id, threadId, runStatus: snapshot.run.status }
}
function flag(name, value) {
  const file = path.join(state, name)
  if (value) fs.writeFileSync(file, 'isolated issue101 fixture')
  else if (fs.existsSync(file)) fs.unlinkSync(file)
}

async function main() {
  try {
    flag('drop-acks', true)
    flag('hold-uploads', true)
    await launch('A')
    await app.evaluate(({ dialog }, work) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [work] }) }, work)
    await page.getByRole('button', { name: '选择并授权只读目录' }).click()
    await wait(async () => (await status()).runtime.workspace?.state === 'ready', 'workspace grant')
    const logical = (await status()).runtime.workspace.logicalRoot
    const firstRun = await read(logical, /T101_UNIQUE_FIXED_MARKER_101/)
    await wait(() => controls('history').pending >= 1, 'durable pending receipt')
    const original = controls('history').rows.find(row => row.run_id === firstRun.runId)
    assert(original && original.tool_call_id && original.request_hash && original.task_signature)
    const firstServer = api('A', '/api/devices/receipts/' + original.task_id)
    assert.equal(firstServer.status, 200)
    assert.equal(firstServer.body.acknowledgment, null, 'first disconnect precedes Server receipt confirmation')
    await history('clear-confirmed')
    assert.equal(controls('history').rows.find(row => row.task_id === original.task_id).delivery_state, 'pending')
    stage('T101-01 before restart', { ...firstRun, original, serverReceipt: firstServer.body, markerSHA256: sha(fs.readFileSync(path.join(work, 'marker.txt'))) })
    await quit()
    await launch('B')
    assert.equal(api('B', '/api/devices/receipts/' + original.task_id).status, 404)
    assert(!controls('history').rows.some(row => row.task_id === original.task_id))
    assert(!(await history()).rows.some(row => row.task_id === original.task_id))
    assert(!(await status()).runtime.tasks.some(row => row.taskId === original.task_id))
    await history('clear-confirmed')
    stage('T101-03 account B', { forbiddenReceiptStatus: 404, history: await history(), taskSummary: (await status()).runtime.tasks })
    await quit()
    flag('disable-A', true)
    await wait(() => JSON.parse(fs.readFileSync(path.join(state, 'identity-state.json'))).disabledA === true, 'A identity disabled')
    await launch('A', false)
    await wait(async () => ['error', 'offline'].includes((await status()).server), 'disabled A receipt session rejected')
    assert.equal(controls('history').rows.find(row => row.task_id === original.task_id).delivery_state, 'pending')
    stage('T101-03 invalid A', { login: (await status()).runtime.login, pending: controls('history').pending })
    await quit()
    flag('disable-A', false)
    await wait(() => JSON.parse(fs.readFileSync(path.join(state, 'identity-state.json'))).disabledA === false, 'A identity restored')
    const generation = JSON.parse(fs.readFileSync(path.join(state, 'generation.json'))).generation
    flag('restart-request', true)
    await wait(() => JSON.parse(fs.readFileSync(path.join(state, 'generation.json'))).generation > generation, 'new Server process', 180000)
    flag('hold-uploads', false)
    await launch('A')
    await wait(() => !!api('A', '/api/devices/receipts/' + original.task_id).body.acknowledgment, 'first confirmation after original Server restart')
    const firstAcknowledgment = api('A', '/api/devices/receipts/' + original.task_id).body.acknowledgment
    assert.equal(controls('history').rows.find(row => row.task_id === original.task_id).delivery_state, 'pending')
    stage('T101-01 Server recovered with lost ACK', { acknowledgment: firstAcknowledgment, history: await history() })
    await quit()
    const secondGeneration = JSON.parse(fs.readFileSync(path.join(state, 'generation.json'))).generation
    flag('restart-request', true)
    await wait(() => JSON.parse(fs.readFileSync(path.join(state, 'generation.json'))).generation > secondGeneration, 'second Server process restart', 180000)
    flag('drop-acks', false)
    await launch('A')
    await wait(() => controls('history').rows.find(row => row.task_id === original.task_id)?.delivery_state === 'confirmed', 'same identity receipt acknowledged after Server restart')
    const recovered = controls('history').rows.find(row => row.task_id === original.task_id)
    assert.equal(recovered.receipt_id, original.receipt_id)
    assert.equal(recovered.receipt_hash, original.receipt_hash)
    const persisted = api('A', '/api/devices/receipts/' + original.task_id)
    assert.equal(persisted.body.acknowledgment, firstAcknowledgment)
    const run = api('A', `/api/threads/${firstRun.threadId}/runs/${firstRun.runId}`)
    assert.equal(run.status, 200)
    assert.equal(run.body.status, firstRun.runStatus)
    const executions = controls('audit').filter(row => row.task_id === original.task_id && row.kind === 'execution')
    assert.equal(executions.length, 1)
    stage('T101-01 T101-02 recovered', { recovered, acknowledgment: persisted.body.acknowledgment, runStatus: run.body.status, executionCount: executions.length })
    await page.getByRole('button', { name: '清理已确认回执', exact: true }).click()
    await wait(() => controls('history').rows.find(row => row.task_id === original.task_id).delivery_state === 'cleaned', 'confirmed cleanup tombstone')
    stage('T101-03 cleanup', { tombstone: controls('history').rows.find(row => row.task_id === original.task_id), confirmation: await app.evaluate(() => global.receiptConfirmation) })
    for (let i = 0; i < 22; i++) await read(logical, /T101_UNIQUE_FIXED_MARKER_101/)
    const all = controls('history')
    assert(all.total > 20)
    assert.equal((await history('history', 0)).rows.length, 20)
    assert((await history('history', 20)).rows.length > 0)
    await page.getByRole('button', { name: '较早回执', exact: true }).click()
    await wait(async () => (await page.locator('body').innerText()).includes(original.task_id), 'older receipt visible through UI pagination')
    stage('T101-04 storage versus display', { total: all.total, firstPage: 20, olderPage: (await history('history', 20)).rows, markerSHA256: sha(fs.readFileSync(path.join(work, 'marker.txt'))) })
    await screenshotWhenSettled('receipt-history-older.png', original.task_id)
    const before = controls('history').total
    evidence.activeStorageFault = 'admission'; save()
    controls('fault', 'admission')
    await read(logical, /RECEIPT_STORAGE_UNAVAILABLE/)
    assert.equal(controls('history').total, before)
    await wait(async () => (await status()).runtime.receiptStorageError === 'RECEIPT_STORAGE_UNAVAILABLE', 'admission storage error visible')
    evidence.activeStorageFault = 'completion'; save()
    controls('fault', 'completion')
    const uncertainRun = await read(logical, /RESULT_UNCERTAIN/)
    const uncertain = controls('history').rows.find(row => row.run_id === uncertainRun.runId)
    assert.equal(uncertain.delivery_state, 'uncertain')
    controls('fault', 'none')
    evidence.activeStorageFault = 'none'; save()
    flag('drop-acks', true)
    await read(logical, /T101_UNIQUE_FIXED_MARKER_101/)
    await read(logical, /T101_UNIQUE_FIXED_MARKER_101/)
    const pending = controls('history').pending
    assert(pending >= 2)
    await wait(async () => (await status()).runtime.receiptStorageError === '', 'reliable admission clears storage error')
    await history('clear-confirmed')
    const protectedView = controls('history')
    assert.equal(protectedView.pending, pending)
    assert.equal(protectedView.rows.find(row => row.receipt_id === uncertain.receipt_id).delivery_state, 'uncertain')
    stage('T101-05 faults', { admissionBlockedNewRow: true, uncertain, networkOnlyNewReads: 2, protectedPending: pending })
    flag('drop-acks', false)
    await screenshotWhenSettled('receipt-history.png')
    assert.equal(sha(fs.readFileSync(path.join(work, 'marker.txt'))), sha(marker))
    evidence.finishedAt = new Date().toISOString(); evidence.passed = true; save()
  } finally {
    if (app) {
      try { evidence.finalLocalHistory = controls('history'); evidence.finalLocalAudit = controls('audit'); evidence.finalRuntimeStatus = await status(); save() }
      catch (error) { evidence.finalMetadataError = String(error); save() }
      try { controls('fault', 'none') } catch {}
      await quit()
    }
    for (const name of ['drop-acks', 'hold-uploads', 'disable-A']) flag(name, false)
    fs.rmSync(work, { recursive: true, force: true })
  }
}
main().catch(error => {
  evidence.error = String(error)
  evidence.errorStack = String(error.stack || error).replaceAll(root, '<desktop-candidate>').replaceAll(state, '<acceptance-state>').replaceAll(work, '<synthetic-workdir>')
  save(); console.error(evidence.errorStack); process.exitCode = 1
})
