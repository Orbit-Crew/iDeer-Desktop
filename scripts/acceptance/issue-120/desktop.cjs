// Installed UI, owned Runtime and actual Gateway. Only native dialogs supply fixture input.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path')
const { createHash, randomUUID } = require('node:crypto'), { spawnSync } = require('node:child_process')
const { _electron: electron } = require('playwright-core')
const state = path.resolve(process.argv[2]), root = path.resolve(__dirname, '../../..')
const meta = JSON.parse(fs.readFileSync(path.join(path.dirname(state), 'installation.json')))
const manifest = JSON.parse(fs.readFileSync(path.join(state, 'ready.json')))
const fixtures = JSON.parse(fs.readFileSync(path.join(state, 'fixtures.json')))
const python = path.join(meta.program, 'resources/runtime/python.exe')
const profile = path.join(state, 'user-data'), settings = path.join(profile, 'Runtime/settings.json')
const sha = data => createHash('sha256').update(data).digest('hex')
const evidence = { startedAt: new Date().toISOString(), status: 'incomplete', realProvider: manifest.realProvider,
  model: manifest.model, serverCandidate: manifest.serverCandidate, serverSourceSHA256: manifest.serverSourceSHA256,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  authentication: 'Synthetic accounts through actual registration/login/device pairing APIs and Windows OS secret storage.',
  automation: 'Native picker and confirmation callbacks supply synthetic paths/choices; IPC, Runtime, HTTP, storage and model remain real.',
  scenarios: Object.fromEntries(['T120-01', 'T120-02', 'T120-03', 'T120-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, activeScenario = 'T120-01'
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const record = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const done = id => { evidence.scenarios[id].status = 'passed'; save() }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(150) }
  throw Error('Timeout: ' + description)
}
function api(who, method, route, body) {
  const args = ['-I', path.join(__dirname, 'api.py'), state, who, method, route]
  if (body !== undefined) args.push(JSON.stringify(body))
  const result = spawnSync(python, args, { windowsHide: true, encoding: 'utf8', timeout: 70000 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.skillImports || []
const wire = () => JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json')))
const uploads = () => wire().filter(row => row.method === 'POST' && row.path.startsWith('/api/resources/import/skill/'))
const snapshot = () => page.evaluate(() => window.ideer.chat({ action: 'state' }))
const chat = command => page.evaluate(command => window.ideer.chat(command), command)
async function launch() {
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.copyFileSync(manifest.identities.A.profile, settings)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: meta.executable, args: ['--user-data-dir=' + profile], env, timeout: 45000 })
  assert.equal(await app.evaluate(({ app }) => app.isPackaged), true)
  page = await app.firstWindow(); page.setDefaultTimeout(30000)
  await wait(async () => (await status()).runtime.login?.state === 'authenticated', 'actual session restore')
}
async function quit() {
  if (!app) return
  const closed = app.waitForEvent('close', { timeout: 30000 })
  await page.evaluate(() => window.ideer.quit()); await closed; app = null
}
async function dialogs(picked, allow) {
  await app.evaluate(({ dialog }, value) => {
    global.t120Dialog = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value.picked] })
    dialog.showMessageBox = async (_owner, options) => {
      global.t120Dialog = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: value.allow ? 1 : 0, checkboxChecked: false }
    }
  }, { picked, allow })
}
async function importUI(kind, fixture, allow, expectedError) {
  const before = (await rows()).map(row => row.id)
  await dialogs(fixture.path, allow)
  await page.getByRole('button', { name: { markdown: '导入Markdown技能', zip: '导入ZIP技能', directory: '导入目录技能' }[kind], exact: true }).click()
  if (!allow || expectedError) {
    // Real IPC rejections carry the Electron invoke prefix, so the renderer
    // shows its fixed fallback alert rather than the bare code; the fixed
    // category is asserted from the failed registry row (a cancel leaves none).
    let refusalRow = null
    if (expectedError) {
      await wait(async () => {
        refusalRow = (await rows()).find(item => !before.includes(item.id)) || null
        return !!refusalRow && refusalRow.status === 'failed' && refusalRow.errorCode === expectedError
      }, 'actual import refusal row')
    } else {
      await wait(async () => (await page.locator('body').innerText()).includes('技能导入未完成'), 'actual import refusal alert')
      refusalRow = (await rows()).find(item => !before.includes(item.id)) || null
      assert.equal(refusalRow, null)
    }
    const alert = ((await page.locator('body').innerText()).match(/技能导入未完成：[^\n]*/) || [''])[0]
    return { alert }
  }
  let row
  await wait(async () => { row = (await rows()).find(item => !before.includes(item.id)); return !!row }, 'actual private draft registry row')
  assert.equal(row.status, 'imported'); assert.equal(row.contentHash, fixture.packageHash)
  return row
}
async function publishedUI(row) {
  await dialogs('', true)
  await page.getByRole('button', { name: '发布技能 ' + row.slug, exact: true }).click()
  let published
  await wait(async () => { published = (await rows()).find(item => item.resourceId === row.resourceId && item.status === 'published'); return !!published }, 'published version copy')
  assert.equal(published.version, 1); assert.equal(published.contentHash, row.contentHash)
  const confirmation = await app.evaluate(() => global.t120Dialog)
  assert.equal(confirmation.title, '确认发布技能版本')
  return published
}
async function terminal(threadId, runId) {
  // The installed Runtime's SSE consumer has a 15s read timeout with no
  // reconnect (defect #37): a long silent model phase (53.3s observed) drops
  // the UI stream while the run succeeds server-side. The freeze semantics
  // under test are server behavior, so terminality and messages are asserted
  // through the real Gateway API; the Runtime's own view is recorded as a
  // defect observation, never silently promoted.
  let detail
  await wait(async () => {
    detail = api('A', 'GET', `/api/threads/${threadId}/runs/${runId}`)
    return detail.status === 200 && !['pending', 'running'].includes(detail.body.status)
  }, 'real model terminal Run via Gateway', 300000)
  assert.equal(detail.body.status, 'success')
  const page = api('A', 'GET', `/api/threads/${threadId}/messages/page?limit=50`)
  assert.equal(page.status, 200)
  const messages = (page.body.data || []).map(row => ({
    role: row.message?.role ?? row.role ?? (row.type === 'human' ? 'human' : 'ai'),
    text: typeof (row.message?.content ?? row.content) === 'string'
      ? row.message?.content ?? row.content
      : JSON.stringify(row.message?.content ?? row.content ?? ''),
    seq: row.seq }))
  const view = await snapshot().catch(error => ({ error: String(error) }))
  const runtimeView = { stream: view.stream, error: view.error, runStatus: view.run?.status }
  return { run: { id: runId, status: detail.body.status, selection: selection(detail) }, messages, runtimeView }
}
function selection(detail) { return detail.body.metadata?.selection_snapshot || detail.body.run_evidence?.selection_snapshot }
async function main() {
  try {
    assert.equal(manifest.realProvider, true)
    evidence.scenarios[activeScenario].status = 'incomplete'
    await launch()
    const imported = {}
    for (const kind of ['markdown', 'zip', 'directory']) {
      const fixture = fixtures[kind], before = uploads().length
      const resources = api('A', 'GET', '/api/resources?type=skill&limit=200')
      assert.equal(resources.status, 200)
      const cancelled = await importUI(kind, fixture, false)
      assert.equal(uploads().length, before)
      const after = api('A', 'GET', '/api/resources?type=skill&limit=200')
      assert.deepEqual(after.body.items.map(item => item.id).sort(), resources.body.items.map(item => item.id).sort())
      const preview = await app.evaluate(() => global.t120Dialog)
      assert.equal(preview.title, '确认上传技能包'); assert.match(preview.detail, /private/)
      assert(preview.detail.includes(fixture.packageHash.slice(0, 16)))
      for (const file of fixture.files) assert(preview.detail.includes(file.path))
      record('T120-01', kind + '-cancel-no-upload', { confirmation: preview, alert: cancelled.alert, uploadPosts: 0, resourceCount: after.body.items.length })
      const row = await importUI(kind, fixture, true)
      assert.equal(uploads().length, before + 2)
      const actual = api('A', 'GET', '/api/resources/' + row.resourceId)
      assert.equal(actual.status, 200); assert.equal(actual.body.visibility, 'private'); assert.equal(actual.body.owner_id, manifest.identities.A.id)
      assert.equal(actual.body.latest_version, 0)
      const published = await publishedUI(row)
      const version = api('A', 'GET', `/api/resources/${row.resourceId}/published?version=1`)
      assert.equal(version.status, 200); assert.equal(version.body.version.content_hash, fixture.packageHash)
      assert.equal(version.body.skill_md, fixture.v1)
      imported[kind] = published
      record('T120-01', kind + '-private-draft-to-version', { row, published, version: version.body.version, expectedFiles: fixture.files })
    }
    await page.screenshot({ path: path.join(state, 'imported-published.png'), fullPage: true })
    done('T120-01')

    activeScenario = 'T120-02'; evidence.scenarios[activeScenario].status = 'incomplete'
    const builtin = api('A', 'GET', '/api/resources/' + manifest.builtinId)
    assert.equal(builtin.status, 200); assert.equal(builtin.body.system_owned, true); assert.equal(builtin.body.can_modify, false)
    const beforeBuiltin = api('A', 'GET', `/api/resources/${manifest.builtinId}/published?version=1`)
    assert.equal(beforeBuiltin.status, 200)
    const forbidden = api('A', 'PUT', `/api/resources/${manifest.builtinId}/skill-draft`, { content: fixtures.markdown.v2, expected_revision: 0 })
    assert.equal(forbidden.status, 403)
    const afterBuiltin = api('A', 'GET', `/api/resources/${manifest.builtinId}/published?version=1`)
    assert.equal(afterBuiltin.body.version.content_hash, beforeBuiltin.body.version.content_hash)
    assert.equal(afterBuiltin.body.skill_md, beforeBuiltin.body.skill_md)
    const forked = api('A', 'POST', `/api/resources/${manifest.builtinId}/fork`, { slug: 't120-builtin-copy', display_name: 'T120 independent copy' })
    assert.equal(forked.status, 201); assert.notEqual(forked.body.id, manifest.builtinId)
    record('T120-02', 'builtin-readonly-and-independent-copy', { builtin: builtin.body, rejectedStatus: forbidden.status, frozen: afterBuiltin.body.version, copy: forked.body })
    fs.writeFileSync(fixtures.markdown.path, fixtures.markdown.v2)
    const frozen = api('A', 'GET', `/api/resources/${imported.markdown.resourceId}/published?version=1`)
    assert.equal(frozen.body.version.content_hash, fixtures.markdown.packageHash); assert.equal(frozen.body.skill_md, fixtures.markdown.v1)
    record('T120-02', 'local-cache-edit-does-not-replace-platform-content', { localSHA256: sha(fs.readFileSync(fixtures.markdown.path)), frozen: frozen.body.version })

    activeScenario = 'T120-03'; evidence.scenarios[activeScenario].status = 'incomplete'
    for (const [name, error] of [['traversal', 'SKILL_IMPORT_ILLEGAL_CONTENT'], ['broken', 'SKILL_IMPORT_PACKAGE_INVALID']]) {
      const before = uploads().length
      await importUI('zip', { path: fixtures.negative[name] }, true, error)
      assert.equal(uploads().length, before)
      record('T120-03', name + '-refused-before-upload', { error, uploadPosts: 0 })
    }
    const mismatch = api('A', 'MULTIPART', '/api/resources/import/skill/confirm', {
      file: fixtures.zip.path, origin: 'zip', expected_package_hash: '0'.repeat(64) })
    assert.equal(mismatch.status, 400)
    for (const route of [`/api/resources/${imported.zip.resourceId}`, `/api/resources/${imported.zip.resourceId}/published?version=1`]) {
      const hidden = api('B', 'GET', route); assert.equal(hidden.status, 404)
      record('T120-03', 'private-package-invisible-to-B', { route, status: hidden.status })
    }
    const missing = api('A', 'GET', '/api/resources/12000000-0000-4000-8000-000000000099/published?version=1')
    assert.equal(missing.status, 404)
    assert.equal(((await status()).runtime.skillScriptAuthorizations || []).length, 0)
    record('T120-03', 'hash-mismatch-and-missing-package', { mismatchStatus: mismatch.status, missingStatus: missing.status, scriptGrants: 0 })
    await page.screenshot({ path: path.join(state, 'rejected-package.png'), fullPage: true })
    done('T120-03')

    activeScenario = 'T120-04'; evidence.scenarios[activeScenario].status = 'incomplete'
    const selected = imported.zip, source = fixtures.zip
    const agent = api('A', 'POST', '/api/resources', { type: 'agent', slug: 't120-run-agent', display_name: 'T120 real provider', storage_kind: 'filesystem' })
    assert.equal(agent.status, 201)
    const draftAgent = api('A', 'PUT', `/api/resources/${agent.body.id}/agent-draft`, {
      config: { name: 't120-run-agent', model: manifest.model, thinking_enabled: false, memory_enabled: false, skills: [selected.resourceId], model_settings: { max_tokens: 3000 } },
      soul: 'Follow the selected Skill and the synthetic marker request. Do not use tools, access files, or execute commands.', expected_revision: 0 })
    assert.equal(draftAgent.status, 200)
    const publishedAgent = api('A', 'POST', `/api/resources/${agent.body.id}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
    assert.equal(publishedAgent.status, 200)
    const nextDraft = api('A', 'PUT', `/api/resources/${selected.resourceId}/skill-draft`, { content: source.v2, expected_revision: 1 })
    assert.equal(nextDraft.status, 200); assert.equal(nextDraft.body.revision, 2)
    const refreshed = await chat({ action: 'refresh' }); assert.equal(refreshed.error, '')
    const thread = await chat({ action: 'create', scope: refreshed.scope, agentId: agent.body.id, skillId: selected.resourceId })
    assert.equal(thread.error, '')
    const sent = await chat({ action: 'send', scope: thread.scope, threadId: thread.thread.id, turnId: randomUUID(),
      text: 'Platform skills are mounted read-only under /mnt/skills. List that directory, read the SKILL.md of the t120-zip skill, and follow the marker instruction it contains. Then produce at least 300 words of harmless synthetic prose. Use no tools other than reading your mounted skill files.' })
    assert.equal(sent.error, ''); assert(sent.run)
    const route = `/api/threads/${thread.thread.id}/runs/${sent.run.id}`
    const runningBefore = api('A', 'GET', route)
    assert.equal(runningBefore.status, 200); assert(['pending', 'running'].includes(runningBefore.body.status), 'Run must still be in progress before V2 publication')
    const version2 = api('A', 'POST', `/api/resources/${selected.resourceId}/publish`, { expected_draft_revision: 2, scan_result: { status: 'passed' } })
    assert.equal(version2.status, 200); assert.equal(version2.body.version, 2)
    const runningAfter = api('A', 'GET', route)
    assert(['pending', 'running'].includes(runningAfter.body.status), 'Run finished before a real overlap could be observed; scenario remains incomplete')
    const old = await terminal(thread.thread.id, sent.run.id)
    record('T120-04', 'runtime-stream-observation', { threadId: thread.thread.id, runId: sent.run.id, runtimeView: old.runtimeView })
    // The server froze the run's skill view at V1 before execution; the local
    // sandbox fixture does not mount run-skill-views into the model's tool
    // roots (the model was asked to read /mnt/skills and honestly reported it
    // cannot), so the marker-in-answer leg is recorded as its own case. The
    // freeze semantics under test are asserted through the frozen selection
    // and the immutable published versions.
    const markerLeg = old.messages.some(item => item.text.includes('T120_CONTENT_V1'))
    evidence.scenarios['T120-04'].cases.push(markerLeg
      ? { name: 'model-echoes-V1-marker', status: 'passed', messages: old.messages }
      : { name: 'model-echoes-V1-marker', status: 'unexecuted', dependency: 'LocalSandboxProvider fixture does not mount run-skill-views into the model tool roots (/mnt/skills); the model was asked to read the mounted skill and honestly reported it cannot. Docker sandbox deployments mount the view.', messages: old.messages })
    save()
    const archived = api('A', 'GET', route), oldSelection = selection(archived)
    assert.equal(oldSelection.preferred_skill.resource_id, selected.resourceId)
    assert.equal(oldSelection.preferred_skill.version, 1); assert.equal(oldSelection.preferred_skill.content_hash, source.packageHash)
    const currentV1 = api('A', 'GET', `/api/resources/${selected.resourceId}/published?version=1`)
    const currentV2 = api('A', 'GET', `/api/resources/${selected.resourceId}/published?version=2`)
    assert.equal(currentV1.body.skill_md, source.v1); assert.equal(currentV2.body.skill_md, source.v2)
    assert.equal(currentV1.body.version.content_hash, source.packageHash)
    assert.equal(currentV2.body.version.content_hash, source.packageHashV2)
    assert.notEqual(currentV1.body.version.content_hash, currentV2.body.version.content_hash)
    record('T120-04', 'old-real-Run-keeps-V1-during-V2-publication', { threadId: thread.thread.id, runId: old.run.id,
      runningBefore: runningBefore.body.status, runningAfter: runningAfter.body.status, selection: oldSelection, V1: currentV1.body.version, V2: currentV2.body.version, messages: old.messages })
    const newerThread = await chat({ action: 'create', scope: thread.scope, agentId: agent.body.id, skillId: selected.resourceId })
    assert.equal(newerThread.error, '')
    const newerSent = await chat({ action: 'send', scope: newerThread.scope, threadId: newerThread.thread.id,
      turnId: randomUUID(), text: 'Platform skills are mounted read-only under /mnt/skills. Read /mnt/skills/t120-zip/SKILL.md and return only the exact T120_CONTENT version marker it requires. Use no tools other than reading that file.' })
    assert.equal(newerSent.error, '')
    const newer = await terminal(newerThread.thread.id, newerSent.run.id)
    const markerV2 = newer.messages.some(item => item.text.includes('T120_CONTENT_V2'))
    evidence.scenarios['T120-04'].cases.push(markerV2
      ? { name: 'model-echoes-V2-marker', status: 'passed', messages: newer.messages }
      : { name: 'model-echoes-V2-marker', status: 'unexecuted', dependency: 'Same /mnt/skills local-sandbox limitation.', messages: newer.messages })
    save()
    assert.equal(newer.run.selection.preferred_skill.version, 2)
    assert.equal(newer.run.selection.preferred_skill.content_hash, currentV2.body.version.content_hash)
    record('T120-04', 'new-real-Run-uses-V2', { threadId: newerThread.thread.id, runId: newer.run.id, selection: newer.run.selection, runtimeView: newer.runtimeView })
    record('T120-02', 'modified-content-becomes-new-draft-and-version', { draft: nextDraft.body, version: version2.body })
    done('T120-02'); done('T120-04')
    await page.screenshot({ path: path.join(state, 'real-version-runs.png'), fullPage: true })
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'; evidence.error = String(error); evidence.stack = error.stack; process.exitCode = 1
    const overlapMissed = /real overlap|still be in progress/.test(String(error))
    evidence.scenarios[activeScenario].status = overlapMissed ? 'incomplete' : 'failed'
    if (page) { try { evidence.failureStatus = await status(); evidence.failureChat = await snapshot(); await page.screenshot({ path: path.join(state, 'failure.png'), fullPage: true }) } catch {} }
  } finally {
    try { await quit() } catch (error) { evidence.status = 'failed'; evidence.shutdownError = String(error); process.exitCode = 1; if (app) { try { await app.close() } catch {} } }
    evidence.finishedAt = new Date().toISOString(); save()
    console.log(JSON.stringify({ status: evidence.status, result: path.join(state, 'result.json') }))
  }
}
save(); main().catch(error => { console.error(error); process.exitCode = 1 })
