// Real Electron, signed Server broker and bundled Windows Runtime; synthetic data.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { randomUUID, createHash } = require('node:crypto')
const { _electron: electron } = require('playwright-core')

const sourceRoot = path.resolve(__dirname, '../../..')
const state = path.resolve(process.argv[2])
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json'), 'utf8'))
const installed = process.env.DESKTOP_EXECUTABLE
// This trusted process environment chooses a prepared build, never renderer input.
const root = !installed && process.env.DESKTOP_CANDIDATE_ROOT ? path.resolve(process.env.DESKTOP_CANDIDATE_ROOT) : sourceRoot
const runtimeDirectory = installed ? path.join(path.dirname(installed), 'resources/runtime') : path.join(root, '.runtime')
const appData = installed ? process.env.APPDATA : path.join(state, 'appdata')
const config = path.join(appData, 'iDeer Desktop/Runtime/settings.json')
const owner = path.join(path.dirname(config), '.issue102-owner')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ideer-t102-'))
const workspace = path.join(work, 'W'), outside = path.join(work, 'outside')
fs.mkdirSync(workspace); fs.mkdirSync(outside)
const BEFORE = 'BEFORE', AFTER = 'AFTER', NEWLINES = 'AFTER\r\n第二行\n'
const sha = value => createHash('sha256').update(value).digest('hex')
const constant = text => ({ text, bytes: Buffer.byteLength(text, 'utf8'), sha256: sha(text) })
const acceptanceFiles = ['issue-102/desktop.cjs', 'issue-102/profiles.py', 'issue-102/profile_controls.py',
  'issue-102/server_fixture.py', 'issue-102/fixture_hooks.py', 'issue-100/profiles.py',
  'issue-100/server_fixture.py', 'issue-101/source_binding.py'].map(name => ({
    path: 'scripts/acceptance/' + name, sha256: sha(fs.readFileSync(path.join(__dirname, '..', name))) }))
const evidence = {
  startedAt: new Date().toISOString(), installed: !!installed, model: manifest.model,
  constants: { BEFORE: constant(BEFORE), AFTER: constant(AFTER), NEWLINES: constant(NEWLINES) },
  candidate: { serverHead: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
    acceptanceFiles,
    buildMirror: root !== sourceRoot,
    ...(root !== sourceRoot ? { buildInputsSHA256: sha(fs.readFileSync(path.join(sourceRoot, 'artifacts/issue-102/build-inputs.json'))) } : {}),
    runtimePythonSHA256: sha(fs.readFileSync(path.join(runtimeDirectory, 'python.exe'))),
    runtimeCore: fs.readdirSync(path.join(runtimeDirectory, 'core')).filter(name => name.endsWith('.py')).sort().map(name => ({ path: 'local-runtime/core/' + name, sha256: sha(fs.readFileSync(path.join(runtimeDirectory, 'core', name))) })),
    ...(installed ? { executableSHA256: sha(fs.readFileSync(installed)), appASARSHA256: sha(fs.readFileSync(path.join(path.dirname(installed), 'resources/app.asar'))) } : {}) },
  scenarios: Object.fromEntries(['T102-01', 'T102-02', 'T102-03', 'T102-04'].map(id => [id, { status: 'unexecuted', cases: [] }])),
  operations: [], auxiliaryOperations: [], stages: [],
  picker: 'Actual Desktop selection button, synthetic path supplied through native dialog callback.'
}
let app, page, ownsSettings = false, logical
const entry = path.join(state, 'electron-entry.cjs')
fs.writeFileSync(entry, `const {app}=require('electron');app.setPath('appData',${JSON.stringify(appData)});app.setAppPath(${JSON.stringify(root)});require(${JSON.stringify(path.join(root, 'out/main/index.js'))});`)
function save() { fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2)) }
function stage(id, details) { evidence.stages.push({ id, at: new Date().toISOString(), ...details }); save() }
function pass(id, name, value) { evidence.scenarios[id].cases.push({ name, status: 'passed', ...value }); save() }
function flag(name, value = true) {
  const filename = path.join(state, name)
  if (value) fs.writeFileSync(filename, 'isolated issue102 fixture')
  else if (fs.existsSync(filename)) fs.unlinkSync(filename)
}
function python(file, ...args) {
  const invocation = spawnSync(path.join(runtimeDirectory, 'python.exe'), ['-I', file, ...args],
    { windowsHide: true, encoding: 'utf8', timeout: 60000 })
  assert.equal(invocation.status, 0, path.basename(file) + ': ' + invocation.stderr)
  return JSON.parse(invocation.stdout.trim())
}
function profile(action, ...args) { return python(path.join(__dirname, 'profiles.py'), action, state, ...args) }
const api = (route, body, post = false) => profile(post ? 'api-post' : 'api', 'A', route, ...(body === undefined ? [] : [JSON.stringify(body)]))
const controls = (action, ...args) => python(path.join(__dirname, 'profile_controls.py'), action, config, ...args)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(predicate, description, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await pause(150)
  }
  throw new Error('Timeout: ' + description)
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const command = value => page.evaluate(value => window.ideer.chat(value), value)
const snapshot = () => command({ action: 'state' })
function wireEvents() {
  const filename = path.join(state, 'wire-events.jsonl')
  return fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
}
function observed(filename) {
  const absolute = path.resolve(work, filename)
  assert(absolute.startsWith(work + path.sep), 'fixture path escaped its unique root')
  if (!fs.existsSync(absolute)) return { exists: false, bytes: 0, sha256: null }
  const value = fs.readFileSync(absolute)
  return { exists: true, bytes: value.length, sha256: sha(value), text: value.toString('utf8') }
}
function exact(filename, text) {
  assert.deepEqual(fs.readFileSync(path.join(work, filename)), Buffer.from(text, 'utf8'), filename + ' exact bytes')
  return observed(filename)
}
function fixture(filename, text = BEFORE) {
  const absolute = path.resolve(work, filename)
  assert(absolute.startsWith(work + path.sep))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, text, 'utf8')
}
async function launch() {
  fs.mkdirSync(path.dirname(config), { recursive: true })
  if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')
  fs.writeFileSync(config, fs.readFileSync(manifest.identities.A.profile), { flag: installed && !ownsSettings ? 'wx' : 'w' })
  ownsSettings = true
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ ...(installed ? { executablePath: installed, args: [] } : { args: [entry] }), env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), !!installed)
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  await wait(async () => (await status()).runtime.login?.state === 'authenticated', 'business identity')
  await wait(async () => (await status()).server === 'connected', 'signed device connection')
}
async function quit() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ideer.quit()); await closed; app = null
  fs.copyFileSync(config, manifest.identities.A.profile)
}
async function restartRuntime() {
  await page.evaluate(() => window.ideer.stopRuntime())
  await wait(async () => (await status()).runtime.process === 'stopped', 'Runtime stopped')
  await page.evaluate(() => window.ideer.startRuntime())
  await wait(async () => (await status()).server === 'connected', 'Runtime reconnected')
}
async function choose() {
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
    dialog.showMessageBox = async (_owner, options) => {
      global.t102PickerConfirmation = { title: options.title, detail: options.detail.replace(directory, '<synthetic directory>'), buttons: options.buttons }
      return { response: 1, checkboxChecked: false }
    }
  }, workspace)
  await page.getByRole('button', { name: '选择并授权目录', exact: true }).click()
  await wait(async () => (await status()).runtime.workspace?.state === 'ready' && (await status()).server === 'connected', 'workspace selection')
  logical = (await status()).runtime.workspace.logicalRoot
  stage('workspace-selected', { logical, pickerConfirmation: await app.evaluate(() => global.t102PickerConfirmation) })
}
async function submit(id, name, suffix, content = AFTER, options = {}) {
  const operationName = options.operation || 'write'
  const operation = { id: randomUUID(), scenario: id, name, capability: 'local.files.' + operationName,
    path: logical + '/' + suffix, requested: constant(content), startedAt: new Date().toISOString(), phase: 'read-only-refresh', refreshAttempts: [] }
  if (options.recoveryFor) operation.recoveryFor = options.recoveryFor
  ;(options.auxiliary ? evidence.auxiliaryOperations : evidence.operations).push(operation); save()
  let current
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = Date.now()
    current = await command({ action: 'refresh' })
    operation.refreshAttempts.push({ attempt, elapsedMs: Date.now() - started, error: current.error }); save()
    if (current.error !== 'CHAT_SERVER_UNAVAILABLE' || attempt === 3) break
    await pause(250 * attempt)
  }
  assert.equal(current.error, '', name + ' refresh')
  operation.phase = 'create-thread-once'; save()
  current = await command({ action: 'create', scope: current.scope, agentId: manifest.identities.A.agentId })
  assert.equal(current.error, '', name + ' Thread uncertain; never resubmit')
  operation.threadId = current.thread.id
  operation.turnId = options.ui ? null : randomUUID()
  operation.uiGeneratedTurnId = !!options.ui
  operation.phase = 'submit-run-once'; save()
  const request = { operation: operationName, arguments: { path: operation.path, ...(operationName === 'write' ? { content } : {}) }, ...(options.hold ? { hold: true } : {}) }
  const text = 'T100_REQUEST ' + JSON.stringify(request)
  if (options.ui) {
    await wait(async () => (await page.locator('body').innerText()).includes('Thread：' + operation.threadId), 'new Thread rendered before UI submission')
    await page.getByRole('textbox', { name: '聊天消息', exact: true }).fill(text)
    await page.getByRole('button', { name: /^发\s*送$/ }).click()
  } else {
    const sent = await command({ action: 'send', scope: current.scope, threadId: operation.threadId, turnId: operation.turnId, text })
    assert.equal(sent.error, '', name + ' Run uncertain; reconcile recorded turn instead of resubmitting')
  }
  operation.phase = 'observe-run'; save()
  await wait(async () => {
    current = await snapshot()
    if (!current.run) return false
    operation.runId = current.run.id; save(); return true
  }, name + ' Run identity')
  if (options.ui) {
    const submittedRun = api(`/api/threads/${operation.threadId}/runs/${operation.runId}`)
    assert.equal(submittedRun.status, 200)
    const actualTurnId = submittedRun.body.metadata?.desktop_turn_id
    assert.match(actualTurnId || '', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    operation.turnId = actualTurnId; save()
  }
  return operation
}
async function approval(operation) {
  let pending
  await wait(async () => {
    const current = await snapshot()
    pending = current.localConsents?.find(row => row.runId === operation.runId)
    return !!pending
  }, operation.name + ' local approval card')
  assert.equal(pending.threadId, operation.threadId)
  assert.equal(pending.path, operation.path)
  assert.equal(pending.content, operation.requested.text)
  assert.match(pending.requestHash, /^[0-9a-f]{64}$/)
  await wait(async () => await page.getByRole('textbox', { name: '审批写入内容', exact: true }).count() === 1, 'rendered local approval')
  // HTML textarea values normalize CRLF. The Runtime snapshot above must still
  // contain the original bytes; the resulting file below is compared as bytes.
  const renderedText = operation.requested.text.replace(/\r\n?/g, '\n')
  assert.equal(await page.getByRole('textbox', { name: '审批写入内容', exact: true }).inputValue(), renderedText)
  assert.equal(await page.getByRole('textbox', { name: '审批写入内容', exact: true }).getAttribute('readonly'), '')
  const body = await page.locator('body').innerText()
  assert(body.includes(pending.requestHash)); assert(body.includes(pending.taskId)); assert(body.includes(operation.runId))
  operation.approval = { ...pending, exactContentSHA256: sha(pending.content), renderedContentSHA256: sha(renderedText), observedAt: new Date().toISOString() }; save()
  return pending
}
async function click(operation, allow) {
  const pending = operation.approval || await approval(operation)
  operation.phase = allow ? 'click-ui-allow-once' : 'click-ui-deny-once'; save()
  await page.getByRole('button', { name: allow ? '仅允许这一次' : '拒绝写入', exact: true }).click()
  operation.decision = { origin: 'actual Desktop chat UI click', approved: allow, taskId: pending.taskId, requestHash: pending.requestHash, at: new Date().toISOString() }; save()
}
async function finish(operation, expected, timeout = 90000) {
  let current
  const observationDeadline = Date.now() + timeout
  operation.phase = 'observe-terminal'; save()
  await wait(async () => {
    current = await snapshot()
    if (current.run?.id === operation.runId && current.stream === 'disconnected' &&
        ['CHAT_STREAM_DISCONNECTED', 'CHAT_SERVER_UNAVAILABLE'].includes(current.error)) {
      const localTask = (await status()).runtime.tasks?.find(row => row.runId === operation.runId)
      const localTerminal = ['completed', 'denied', 'failed', 'cancelled', 'result_not_verified'].includes(localTask?.state)
      const attempts = operation.recoveryAttempts || (operation.recoveryAttempts = [])
      const lastAttempt = attempts[attempts.length - 1]
      if ((localTerminal || operation.cancel || observationDeadline - Date.now() <= 20000) &&
          attempts.length < 3 && (!lastAttempt || Date.now() - Date.parse(lastAttempt.at) >= 5000)) {
        assert.equal(current.thread?.id, operation.threadId, 'recovery must retain the original Thread')
        const button = page.getByRole('button', { name: '重新连接并恢复状态', exact: true })
        if (await button.isEnabled()) {
          attempts.push({ at: new Date().toISOString(), origin: 'actual Desktop reconnect UI click',
            threadId: operation.threadId, runId: operation.runId, previousStream: current.stream,
            previousError: current.error, localTaskState: localTask?.state || null,
            reason: localTerminal ? 'original local task reached a terminal state' : operation.cancel ? 'original Run cancellation requested' : 'bounded final observation recovery' })
          save()
          await button.click({ timeout: 2000 })
        }
      }
    }
    if (operation.expectNoApproval) {
      assert(!current.localConsents?.some(row => row.runId === operation.runId), operation.name + ' unexpectedly asked for local approval')
      operation.noApprovalSamples = (operation.noApprovalSamples || 0) + 1
    }
    return current.run?.id === operation.runId && !['pending', 'running'].includes(current.run.status) && current.stream !== 'streaming'
  }, operation.name + ' terminal Run', timeout)
  const transcript = current.messages.map(message => message.text).join('\n')
  if (expected) assert.match(transcript, expected, operation.name + ' result in original chat')
  operation.phase = 'completed'; operation.finishedAt = new Date().toISOString(); operation.runStatus = current.run.status
  operation.messages = current.messages; operation.events = current.events; operation.stream = current.stream
  operation.dispatches = wireEvents().filter(row => row.event === 'task-dispatched' && row.runId === operation.runId)
  operation.localRows = controls('history').rows.filter(row => row.run_id === operation.runId)
  operation.audit = controls('audit').rows.filter(row => row.run_id === operation.runId)
  operation.tasks = operation.dispatches.map(row => api('/api/devices/tasks/' + row.taskId))
  save(); return operation
}
function executionCount(operation) { return controls('audit').rows.filter(row => row.kind === 'execution' && row.action === 'completed' && row.run_id === operation.runId).length }
function noRedispatch(operation) {
  const count = wireEvents().filter(row => row.event === 'task-dispatched' && row.runId === operation.runId).length
  assert.equal(count, 1, operation.name + ' auto redispatched'); return count
}
function correlate(operation) {
  assert.equal(operation.dispatches.length, 1)
  const response = operation.tasks[0]; assert.equal(response.status, 200)
  const task = response.body
  assert.equal(task.run_id, operation.runId); assert(task.tool_call_id)
  assert.equal(task.task_id, operation.approval.taskId)
  assert.equal(task.receipt.task_id, task.task_id); assert.equal(task.receipt.run_id, operation.runId)
  assert.equal(task.receipt.request_hash, operation.approval.requestHash)
  assert.equal(task.result.sha256, operation.requested.sha256)
  assert.equal(task.result.bytes, operation.requested.bytes)
  assert.equal(task.receipt.consent_decision, 'approved')
  assert.equal(task.receipt.status, 'completed')
  assert.equal(executionCount(operation), 1)
  return { taskId: task.task_id, runId: task.run_id, toolCallId: task.tool_call_id, requestHash: task.receipt.request_hash, resultSHA256: task.result.sha256, executionCount: 1 }
}
async function successful(id, name, filename, suffix, text, ui = false) {
  const before = observed(filename)
  const operation = await submit(id, name, suffix, text, { ui })
  await approval(operation)
  await page.screenshot({ path: path.join(state, name + '-approval.png'), fullPage: true })
  await click(operation, true); await finish(operation, /"written"\s*:\s*true/)
  const after = exact(filename, text), correlation = correlate(operation)
  operation.before = before; operation.after = after; save()
  pass(id, name, { operationId: operation.id, before, after, ...correlation })
  return operation
}
async function recoverStorageWithRead(name) {
  const healthRead = await submit('T102-03', name, 'health.txt', BEFORE, { operation: 'read' })
  await finish(healthRead, /BEFORE/)
  assert.equal(healthRead.tasks.length, 1)
  assert.equal(healthRead.tasks[0].status, 200)
  const readTask = healthRead.tasks[0].body
  assert.equal(readTask.receipt.status, 'completed')
  assert.equal(readTask.result.content, BEFORE)
  assert.equal(readTask.result.sha256, sha(BEFORE))
  await wait(async () => (await status()).runtime.receiptStorageError === '', 'successful durable read clears ' + name)
  pass('T102-03', name, { operationId: healthRead.id, after: exact('W/health.txt', BEFORE), readSHA256: readTask.result.sha256, receiptStatus: readTask.receipt.status })
}
async function recoverStorageAfterRestart(original) {
  const uncertainRows = () => controls('history').rows.filter(row => row.delivery_state === 'uncertain').map(row => ({
    task_id: row.task_id, request_hash: row.request_hash, delivery_state: row.delivery_state,
    error_code: row.error_code, status: row.status
  })).sort((left, right) => left.task_id.localeCompare(right.task_id))
  const retainedBefore = uncertainRows()
  const check = await submit('T102-04', 'health-after-' + original.name, 'health.txt', BEFORE,
    { operation: 'read', auxiliary: true, recoveryFor: original.id })
  check.uncertainRowsBefore = retainedBefore; save()
  await finish(check, /BEFORE/)
  assert.equal(check.dispatches.length, 1); assert.equal(check.tasks.length, 1)
  assert.equal(check.tasks[0].status, 200)
  const task = check.tasks[0].body
  assert.equal(task.run_id, check.runId); assert(task.tool_call_id)
  assert.equal(task.task_id, check.dispatches[0].taskId)
  assert.equal(task.receipt.task_id, task.task_id); assert.equal(task.receipt.run_id, check.runId)
  assert.equal(task.receipt.capability, 'local.files.read'); assert.equal(task.receipt.status, 'completed')
  assert.equal(task.receipt.request_hash, check.dispatches[0].requestHash)
  assert.equal(task.result.content, BEFORE); assert.equal(task.result.bytes, Buffer.byteLength(BEFORE))
  assert.equal(task.result.sha256, sha(BEFORE)); assert.equal(executionCount(check), 1)
  await wait(async () => (await status()).runtime.receiptStorageError === '', 'durable auxiliary read clears current Runtime storage latch')
  await wait(() => controls('history').rows.some(row => row.task_id === task.task_id && row.delivery_state === 'confirmed'), 'auxiliary read receipt durably confirmed')
  check.proof = { after: exact('W/health.txt', BEFORE), dispatchCount: noRedispatch(check), executionCount: 1,
    storageError: (await status()).runtime.receiptStorageError, deliveryState: 'confirmed' }; save()
  check.uncertainRowsAfter = uncertainRows()
  assert.deepEqual(check.uncertainRowsAfter, check.uncertainRowsBefore, 'health proof cannot clear or alter the uncertain write')
  save()
}
async function cancel(operation, waitForCompletion = true) {
  const result = api(`/api/threads/${operation.threadId}/runs/${operation.runId}/cancel?wait=${waitForCompletion}&action=interrupt`, undefined, true)
  assert.equal(result.status, waitForCompletion ? 204 : 202, 'cancel original canonical Run')
  operation.cancel = { at: new Date().toISOString(), waitForCompletion, result }; save()
}
async function reconnectChat(operation) {
  await wait(async () => (await status()).server === 'connected', 'signed reconnect')
  const current = await command({ action: 'refresh' })
  assert.equal(current.error, '', 'refresh restored Runtime chat scope')
  const opened = await command({ action: 'open', scope: current.scope, threadId: operation.threadId })
  assert.equal(opened.error, '', 'reopen original durable chat after Runtime restart')
  const result = await command({ action: 'reconnect', scope: opened.scope, threadId: operation.threadId })
  assert.equal(result.error, '', 'original chat reconnect')
  assert.equal(result.thread.id, operation.threadId)
  assert.equal(result.run.id, operation.runId)
  operation.reconnected = { at: new Date().toISOString(), runStatus: result.run.status, messages: result.messages,
    stream: result.stream, localConsents: result.localConsents }; save()
}
async function disconnect() {
  const id = randomUUID()
  fs.writeFileSync(path.join(state, 'disconnect-request.json'), JSON.stringify({ id }))
  await wait(() => {
    const filename = path.join(state, 'disconnect-applied.json')
    return fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).id === id
  }, 'Server websocket disconnect applied')
  return id
}

async function main() {
  try {
    for (const filename of ['target.txt', 'unicode.txt', 'reject.txt', 'timeout.txt', 'hash.txt', 'web.txt', 'deny.txt', 'admission.txt', 'completion.txt', 'completion-blocked.txt', 'health.txt', 'before-submit.txt', 'before-cancel.txt', 'before-disconnect.txt', 'after-cancel.txt', 'after-disconnect.txt']) fixture('W/' + filename)
    fixture('outside/secret.txt'); fixture('W/.git/config')
    fs.symlinkSync(outside, path.join(workspace, 'junction'), 'junction')
    await launch(); await choose()
    await successful('T102-01', 'create', 'W/new.txt', 'new.txt', AFTER, true)
    await successful('T102-01', 'overwrite', 'W/target.txt', 'target.txt', AFTER, true)
    await successful('T102-01', 'unicode-newlines', 'W/unicode.txt', 'unicode.txt', NEWLINES)
    evidence.scenarios['T102-01'].status = 'passed'; save()

    let operation = await submit('T102-02', 'reject', 'reject.txt')
    await approval(operation); await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T102-02', 'reject', { operationId: operation.id, after: exact('W/reject.txt', BEFORE) })

    operation = await submit('T102-02', 'timeout', 'timeout.txt')
    await approval(operation)
    operation.timeout = { configuredSeconds: 300, signedTaskDeadlineSeconds: 305, observationToleranceSeconds: 45, startedAt: new Date().toISOString() }; save()
    // Observe the actual fixed product timeout. No product clock or source patch.
    await finish(operation, /DENIED|expired|TIMEOUT|TIMED_OUT|timed.?out/i, 345000)
    await wait(async () => !(await snapshot()).localConsents?.some(row => row.runId === operation.runId), 'timeout removes the approval card', 20000)
    operation.audit = controls('audit').rows.filter(row => row.run_id === operation.runId)
    operation.timeout.finishedAt = new Date().toISOString(); save()
    const timeoutFacts = [...operation.audit, ...operation.tasks, ...operation.messages]
    assert(/timeout|timed out|timed_out|expired/i.test(JSON.stringify(timeoutFacts)), 'explicit local or signed Server timeout reason')
    pass('T102-02', 'timeout', { operationId: operation.id, after: exact('W/timeout.txt', BEFORE), timeout: operation.timeout })

    operation = await submit('T102-02', 'changed-request-hash', 'hash.txt')
    const pending = await approval(operation)
    const current = await snapshot()
    const wrongHash = pending.requestHash[0] === '0' ? '1' + pending.requestHash.slice(1) : '0' + pending.requestHash.slice(1)
    const refused = await command({ action: 'consent', scope: current.scope, threadId: pending.threadId, runId: pending.runId,
      taskId: pending.taskId, requestHash: wrongHash, decision: 'allow' })
    assert.equal(refused.error, 'CONSENT_MISMATCH')
    assert.equal(executionCount(operation), 0)
    exact('W/hash.txt', BEFORE)
    operation.changedApproval = { wrongHash, error: refused.error, expectedContentSHA256: operation.requested.sha256 }; save()
    await click(operation, false); await finish(operation, /DENIED|denied/)
    const stale = await command({ action: 'consent', scope: current.scope, threadId: pending.threadId, runId: pending.runId,
      taskId: pending.taskId, requestHash: pending.requestHash, decision: 'allow' })
    assert(['CONSENT_MISMATCH', 'CONSENT_UNAVAILABLE'].includes(stale.error))
    pass('T102-02', 'changed-request-hash', { operationId: operation.id, error: refused.error, staleApprovalError: stale.error, after: exact('W/hash.txt', BEFORE) })

    operation = await submit('T102-02', 'web-approval', 'web.txt')
    const webPending = await approval(operation)
    const web = api('/api/devices/tasks/' + webPending.taskId + '/consent', { approved: true, actor_id: manifest.identities.A.id })
    operation.webApproval = web; save()
    assert.equal(web.status, 403); assert.equal(web.body.detail.code, 'LOCAL_APPROVAL_REQUIRED')
    assert.equal(executionCount(operation), 0); exact('W/web.txt', BEFORE)
    await click(operation, false); await finish(operation, /DENIED|denied/)
    pass('T102-02', 'web-approval', { operationId: operation.id, response: web, after: exact('W/web.txt', BEFORE) })

    await page.evaluate(() => window.ideer.stopRuntime())
    controls('policy', 'deny')
    await page.evaluate(() => window.ideer.startRuntime())
    await wait(async () => (await status()).server === 'connected', 'local DENY connection')
    operation = await submit('T102-02', 'local-deny', 'deny.txt')
    await finish(operation, /POLICY_DENIED|LOCAL_POLICY_DENIED/)
    assert.equal(executionCount(operation), 0)
    pass('T102-02', 'local-deny', { operationId: operation.id, after: exact('W/deny.txt', BEFORE) })
    await page.evaluate(() => window.ideer.stopRuntime()); controls('policy', 'ask_first')
    await page.evaluate(() => window.ideer.startRuntime()); await wait(async () => (await status()).server === 'connected', 'restored local policy')

    for (const [name, suffix, filename, expected] of [
      ['outside-path', '../outside/secret.txt', 'outside/secret.txt', /INVALID_PATH/],
      ['protected-path', '.git/config', 'W/.git/config', /PROTECTED_PATH/],
      ['link-escape', 'junction/secret.txt', 'outside/secret.txt', /OUTSIDE_ALLOWED_ROOTS/]
    ]) {
      operation = await submit('T102-02', name, suffix)
      operation.expectNoApproval = true; save()
      await finish(operation, expected)
      assert.equal(executionCount(operation), 0)
      await wait(async () => await page.getByRole('textbox', { name: '审批写入内容', exact: true }).count() === 0, 'rejected unsafe path has no approval card')
      pass('T102-02', name, { operationId: operation.id, after: exact(filename, BEFORE), executionCount: 0,
        noApprovalCard: true, noApprovalSamples: operation.noApprovalSamples })
    }
    evidence.scenarios['T102-02'].status = 'passed'; save()

    const admissionBefore = controls('history').total
    controls('fault', 'admission'); evidence.activeStorageFault = 'admission'; save()
    operation = await submit('T102-03', 'admission-failure', 'admission.txt')
    await finish(operation, /RECEIPT_STORAGE_UNAVAILABLE/)
    assert.equal(controls('history').total, admissionBefore)
    assert.equal(executionCount(operation), 0)
    pass('T102-03', 'admission-failure', { operationId: operation.id, after: exact('W/admission.txt', BEFORE), addedRows: 0 })
    controls('fault', 'none'); evidence.activeStorageFault = 'none'; save()
    await recoverStorageWithRead('admission-recovery-read')
    controls('fault', 'completion'); evidence.activeStorageFault = 'completion'; save()
    operation = await submit('T102-03', 'completion-failure', 'completion.txt')
    await approval(operation); await click(operation, true); await finish(operation, /RESULT_UNCERTAIN/)
    const uncertain = controls('history').rows.find(row => row.run_id === operation.runId)
    assert.equal(uncertain.delivery_state, 'uncertain'); assert.equal(uncertain.error_code, 'RESULT_UNCERTAIN')
    pass('T102-03', 'completion-failure', { operationId: operation.id, after: exact('W/completion.txt', AFTER), uncertain })
    const uncertainOperation = operation
    const beforeBlocked = controls('history').total
    const blocked = await submit('T102-03', 'second-write-blocked', 'completion-blocked.txt')
    await finish(blocked, /RECEIPT_STORAGE_UNAVAILABLE|RESULT_UNCERTAIN/)
    assert.equal(executionCount(blocked), 0)
    assert.equal(controls('history').total, beforeBlocked, 'a latched completion fault must block another write admission')
    pass('T102-03', 'second-write-blocked', { operationId: blocked.id, after: exact('W/completion-blocked.txt', BEFORE), addedRows: 0, executionCount: 0 })
    controls('fault', 'none'); evidence.activeStorageFault = 'none'; save()
    await restartRuntime()
    assert.equal(controls('history').rows.find(row => row.task_id === uncertain.task_id).delivery_state, 'uncertain')
    assert.equal(noRedispatch(uncertainOperation), 1)
    pass('T102-03', 'uncertain-restart', { operationId: uncertainOperation.id, after: exact('W/completion.txt', AFTER), retainedTaskId: uncertain.task_id, dispatchCount: 1 })
    await recoverStorageWithRead('uncertain-recovery-read')
    evidence.scenarios['T102-03'].status = 'passed'; save()

    flag('hold'); flag('held', false)
    operation = await submit('T102-04', 'before-submit-cancel', 'before-submit.txt', AFTER, { hold: true })
    await wait(() => fs.existsSync(path.join(state, 'held')), 'model held before Local Task submission')
    await cancel(operation, false); flag('hold', false); await finish(operation)
    assert.equal(operation.runStatus, 'interrupted')
    assert.equal(operation.dispatches.length, 0); assert.equal(executionCount(operation), 0)
    pass('T102-04', 'before-submit-cancel', { operationId: operation.id, dispatchCount: 0, after: exact('W/before-submit.txt', BEFORE) })

    operation = await submit('T102-04', 'before-write-cancel', 'before-cancel.txt')
    await approval(operation); await cancel(operation); await finish(operation)
    assert.equal(operation.runStatus, 'interrupted')
    await wait(async () => !(await snapshot()).localConsents?.some(row => row.taskId === operation.approval.taskId), 'cancel removed pending approval')
    await restartRuntime(); await recoverStorageAfterRestart(operation); await reconnectChat(operation)
    assert.equal(executionCount(operation), 0)
    pass('T102-04', 'before-write-cancel', { operationId: operation.id, dispatchCount: noRedispatch(operation), after: exact('W/before-cancel.txt', BEFORE) })

    operation = await submit('T102-04', 'before-write-disconnect', 'before-disconnect.txt')
    await approval(operation); operation.disconnectRequestId = await disconnect(); save()
    await finish(operation)
    await restartRuntime(); await recoverStorageAfterRestart(operation); await reconnectChat(operation)
    assert.equal(executionCount(operation), 0)
    pass('T102-04', 'before-write-disconnect', { operationId: operation.id, dispatchCount: noRedispatch(operation), after: exact('W/before-disconnect.txt', BEFORE) })

    for (const [name, filename, withCancel] of [
      ['after-write-cancel', 'after-cancel.txt', true], ['after-write-disconnect', 'after-disconnect.txt', false]
    ]) {
      flag('hold-results'); flag('hold-uploads'); flag('disconnect-after-result', !withCancel)
      flag('result-held.json', false)
      operation = await submit('T102-04', name, filename)
      await approval(operation); await click(operation, true)
      await wait(() => {
        const filename = path.join(state, 'result-held.json')
        return fs.existsSync(filename) && JSON.parse(fs.readFileSync(filename, 'utf8')).taskId === operation.approval.taskId
      }, 'actual result sent after file effect')
      exact('W/' + filename, AFTER)
      operation.effectObservedAt = new Date().toISOString(); save()
      if (withCancel) await cancel(operation)
      await finish(operation)
      flag('hold-results', false); flag('hold-uploads', false); flag('disconnect-after-result', false)
      await restartRuntime(); await recoverStorageAfterRestart(operation); await reconnectChat(operation)
      await wait(() => {
        const row = controls('history').rows.find(row => row.task_id === operation.approval.taskId)
        return row?.delivery_state === 'confirmed'
      }, 'recovery upload of original write receipt')
      assert.equal(executionCount(operation), 1)
      const liveTask = api('/api/devices/tasks/' + operation.approval.taskId)
      operation.liveTask = { at: new Date().toISOString(), response: liveTask }; save()
      assert.equal(liveTask.status, 200)
      const durable = api('/api/devices/receipts/' + operation.approval.taskId)
      const body = durable.body || {}
      const pick = (value, fields) => Object.fromEntries(fields.map(field => [field, value?.[field] ?? null]))
      const archive = { httpStatus: durable.status,
        ...pick(body, ['task_id', 'receipt_id', 'receipt_hash', 'acknowledgment']),
        task: pick(body.task, ['task_id', 'run_id', 'tool_call_id', 'capability', 'request_hash', 'logical_target']),
        receipt: pick(body.receipt, ['task_id', 'run_id', 'capability', 'request_hash', 'payload_hash', 'result_hash', 'status', 'consent_decision', 'policy_decision']),
        evidence: pick(body.evidence, ['tool_call_id']) }
      operation.recoveredArchive = archive; save()
      assert.equal(archive.httpStatus, 200); assert.equal(archive.receipt.status, 'completed')
      assert.equal(archive.task_id, operation.approval.taskId)
      assert.equal(archive.task.task_id, archive.task_id); assert.equal(archive.receipt.task_id, archive.task_id)
      assert.equal(archive.task.run_id, operation.runId); assert.equal(archive.receipt.run_id, operation.runId)
      assert.equal(archive.task.request_hash, operation.approval.requestHash)
      assert.equal(archive.receipt.request_hash, operation.approval.requestHash)
      assert.equal(archive.receipt.capability, 'local.files.write'); assert.equal(archive.receipt.consent_decision, 'approved')
      assert.equal(archive.receipt.policy_decision, 'allow')
      assert.equal(archive.evidence.tool_call_id, archive.task.tool_call_id)
      const confirmed = controls('history').rows.find(row => row.task_id === archive.task_id)
      assert.equal(archive.receipt_id, confirmed.receipt_id); assert.equal(archive.receipt_hash, confirmed.receipt_hash)
      assert(archive.acknowledgment); assert.equal(archive.acknowledgment, confirmed.acknowledgment)
      const originalResult = wireEvents().find(row => row.event === 'task-result-received' && row.taskId === archive.task_id && row.receipt?.status === 'completed')
      assert(originalResult); assert.equal(originalResult.result.sha256, sha(AFTER)); assert.equal(originalResult.result.bytes, Buffer.byteLength(AFTER))
      assert.equal(archive.receipt.result_hash, originalResult.receipt.result_hash)
      const run = api(`/api/threads/${operation.threadId}/runs/${operation.runId}`)
      assert.equal(run.status, 200)
      assert(['interrupted', 'cancelled', 'failed', 'success', 'completed', 'error'].includes(run.body.status), 'terminal original Run after recovery')
      if (withCancel) assert.equal(run.body.status, 'interrupted', 'late write receipt cannot resume the cancelled Run')
      operation.recoveredRunStatus = run.body.status; save()
      pass('T102-04', name, { operationId: operation.id, after: exact('W/' + filename, AFTER), dispatchCount: noRedispatch(operation), executionCount: 1, liveTask: liveTask.body, recoveredArchive: archive, runStatus: run.body.status })
    }
    evidence.scenarios['T102-04'].status = 'passed'; save()
    // Recheck the complete observed interval, including all later reconnects.
    for (const item of evidence.operations.filter(row => row.scenario === 'T102-04')) {
      const count = wireEvents().filter(row => row.event === 'task-dispatched' && row.runId === item.runId).length
      assert.equal(count, item.name === 'before-submit-cancel' ? 0 : 1, 'late redispatch of ' + item.name)
      item.finalDispatchCount = count
    }
    for (const item of evidence.auxiliaryOperations) {
      const count = wireEvents().filter(row => row.event === 'task-dispatched' && row.runId === item.runId && row.taskId === item.tasks[0].body.task_id).length
      assert.equal(count, 1, 'auxiliary read was redispatched after later reconnects')
      item.finalDispatchCount = count
    }
    await page.screenshot({ path: path.join(state, 'write-recovery.png'), fullPage: true })
    evidence.finalLocalHistory = controls('history'); evidence.finalLocalAudit = controls('audit')
    assert(evidence.finalLocalAudit.integrity)
    await quit(); profile('evidence', 'A')
    const runs = JSON.parse(fs.readFileSync(path.join(state, 'run-evidence-A.json'), 'utf8'))
    for (const item of evidence.operations.filter(row => row.scenario === 'T102-01')) {
      const run = runs.find(row => row.runId === item.runId)
      assert(run && run.threadId === item.threadId)
      assert.equal(run.metadata.run_evidence.archive_status, 'archived')
      const archived = run.metadata.run_evidence.tool_receipts.find(row => row.local_execution_receipt?.task_id === item.approval.taskId)
      assert(archived, 'completed write has no archived original Run receipt')
      assert.equal(archived.tool_call_id, item.tasks[0].body.tool_call_id)
      assert.equal(archived.local_execution_receipt.request_hash, item.approval.requestHash)
      assert.equal(archived.local_execution_receipt.consent_decision, 'approved')
      item.archivedReceipt = archived; save()
    }
    evidence.status = 'passed'
  } catch (error) {
    try { if (page) evidence.failureChatSnapshot = await snapshot() } catch (observationError) { evidence.failureChatSnapshotError = String(observationError) }
    evidence.status = 'failed'
    evidence.error = String(error)
    evidence.errorStack = String(error.stack || error).replaceAll(state, '<acceptance-state>').replaceAll(root, '<desktop-candidate>').replaceAll(sourceRoot, '<desktop-source>').replaceAll(work, '<synthetic-directory>')
    for (const scenario of Object.values(evidence.scenarios)) if (scenario.status !== 'passed' && scenario.cases.length) scenario.status = 'incomplete'
    save(); throw error
  } finally {
    try {
      evidence.finalFixtureFiles = Object.fromEntries([
        'W/new.txt', 'W/target.txt', 'W/unicode.txt', 'W/reject.txt', 'W/timeout.txt', 'W/hash.txt', 'W/web.txt',
        'W/deny.txt', 'W/admission.txt', 'W/completion.txt', 'W/completion-blocked.txt', 'W/health.txt',
        'W/before-submit.txt', 'W/before-cancel.txt', 'W/before-disconnect.txt', 'W/after-cancel.txt',
        'W/after-disconnect.txt', 'W/.git/config', 'outside/secret.txt'
      ].map(filename => [filename, observed(filename)]))
    } catch (error) { evidence.finalFixtureObservationError = String(error) }
    if (app) {
      try { evidence.finalLocalHistory = controls('history'); evidence.finalLocalAudit = controls('audit'); evidence.finalRuntimeStatus = await status() } catch (error) { evidence.finalMetadataError = String(error) }
      try { controls('fault', 'none') } catch {}
      try { await quit() } catch (error) { evidence.shutdownError = String(error) }
    }
    for (const name of ['hold', 'hold-results', 'hold-uploads', 'drop-acks', 'disconnect-after-result']) flag(name, false)
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
    if (evidence.status === 'failed' && process.env.ISSUE102_KEEP_SERVER_ON_FAILURE === '1') {
      evidence.serverPreservedForDiagnosis = true
    } else flag('stop')
    try {
      if (fs.existsSync(path.join(workspace, 'junction'))) fs.unlinkSync(path.join(workspace, 'junction'))
      assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
      fs.rmSync(work, { recursive: true, force: true })
      evidence.fixtureCleanup = { removed: true, appClosed: app === null }
    } catch (error) { evidence.fixtureCleanup = { removed: false, error: String(error) }; evidence.status = 'failed' }
    evidence.finishedAt = new Date().toISOString(); save()
  }
}
save()
main().catch(error => { console.error(evidence.errorStack || String(error)); process.exitCode = 1 })
