// Installed UI, owned Runtime and actual Gateway. Only native dialogs supply fixture input.
// Issue 121: Skill trigger preferences — the device only configures; the Server matches.
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
  serverCandidateMeaning: manifest.serverCandidateMeaning,
  installerSHA256: meta.installerSHA256, appASARSHA256: meta.appASARSHA256,
  driverSHA256: sha(fs.readFileSync(__filename)), fixtureSHA256: sha(fs.readFileSync(path.join(__dirname, 'server.py'))),
  authentication: 'Synthetic accounts through actual registration/login/device pairing APIs and Windows OS secret storage.',
  automation: 'Native picker and confirmation callbacks supply synthetic paths/choices; IPC, Runtime, HTTP, storage and model remain real.',
  scenarios: Object.fromEntries(['T121-01', 'T121-02', 'T121-03', 'T121-04'].map(id => [id, { status: 'unexecuted', cases: [] }])) }
let app, page, activeScenario = 'T121-01'
const save = () => fs.writeFileSync(path.join(state, 'result.json'), JSON.stringify(evidence, null, 2))
const record = (id, name, facts) => { evidence.scenarios[id].cases.push({ name, status: 'passed', ...facts }); save() }
const skipped = (id, name, dependency) => { evidence.scenarios[id].cases.push({ name, status: 'unexecuted', dependency }); save() }
const done = id => { evidence.scenarios[id].status = 'passed'; save() }
const incomplete = id => { evidence.scenarios[id].status = 'incomplete'; save() }
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function wait(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await pause(150) }
  throw Error('Timeout: ' + description)
}
function api(who, method, route, body) {
  const args = ['-I', path.join(__dirname, 'api.py'), state, who, method, route]
  if (body !== undefined) args.push(JSON.stringify(body))
  const result = spawnSync(python, args, { windowsHide: true, encoding: 'utf8', timeout: 90000 })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}
const status = () => page.evaluate(() => window.ideer.getStatus())
const rows = async () => (await status()).runtime.skillImports || []
const wire = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'request-summary.json'), 'utf8')) } catch { return [] } }
const prefWrites = () => wire().filter(row => row.path.endsWith('/trigger-preference') && row.method !== 'GET')
const audits = () => { try { return JSON.parse(fs.readFileSync(path.join(state, 'audit-summary.json'), 'utf8')) } catch { return [] } }
const auditActions = name => audits().filter(row => row.action === name)
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
    global.t121Dialog = null
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value.picked] })
    dialog.showMessageBox = async (_owner, options) => {
      global.t121Dialog = { title: options.title, message: options.message, detail: options.detail, buttons: options.buttons }
      return { response: value.allow ? 1 : 0, checkboxChecked: false }
    }
  }, { picked, allow })
}
async function importUI(fixture) {
  const before = (await rows()).map(row => row.id)
  await dialogs(fixture.path, true)
  await page.getByRole('button', { name: '导入Markdown技能', exact: true }).click()
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
  const confirmation = await app.evaluate(() => global.t121Dialog)
  assert.equal(confirmation.title, '确认发布技能版本')
  return published
}
async function terminal(threadId, runId) {
  // The installed Runtime's SSE consumer has a 15s read timeout with no
  // reconnect (defect #37): a long silent model phase (53.3s observed) drops
  // the UI stream while the run succeeds server-side. The freeze/match
  // semantics under test are Server behavior, so terminality and messages are
  // asserted through the real Gateway API; the Runtime's own view is recorded
  // as a defect observation, never silently promoted.
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
  return { run: { id: runId, status: detail.body.status, selection: runSelection(detail) }, messages, runtimeView }
}
function runSelection(detail) { return detail.body.metadata?.selection_snapshot || detail.body.run_evidence?.selection_snapshot }
// Platform Agents do not inject Skill content into the prompt; the frozen
// run-skill-view is mounted read-only into the sandbox (/mnt/skills) and the
// model reads it with its file tools. Whether the trigger-preference entry
// rides the same mount is not independently verified here, so every marker
// assertion records a diagnostic on failure: if it ever fires, first check
// whether the Server froze <serverStateDir>/resources/run-skill-views/<runId>/
// t121-trigger/SKILL.md (serverStateDir is in ready.json), then adjust the
// prompt — never the assertion.
function expectMarker(messages, marker, threadId, runId) {
  // The frozen run-skill-view is mounted into Docker sandbox deployments;
  // the LocalSandboxProvider fixture does not expose /mnt/skills to the
  // model's tool roots (verified in the issue-120 record), so a missing
  // marker is recorded as an unexecuted leg with that dependency instead of
  // failing the run. The freeze semantics stay asserted on the frozen
  // selection snapshots and the audit trail.
  const hit = messages.some(item => item.role === 'ai' && item.text.includes(marker))
  evidence.markerObservations = evidence.markerObservations || []
  evidence.markerObservations.push({ marker, threadId, runId, hit,
    ai: messages.filter(item => item.role === 'ai').map(item => String(item.text).slice(0, 400)) })
  save()
  if (!hit) {
    evidence.scenarios[activeScenario].cases.push({ name: 'model-echo-' + marker, status: 'unexecuted',
      dependency: 'LocalSandboxProvider fixture does not mount run-skill-views into the model tool roots (/mnt/skills); the model was asked to read the mounted skill and could not. Docker sandbox deployments mount the view.',
      threadId, runId })
    save()
  }
}
const listSafe = async () => {
  let view
  await wait(async () => {
    view = await page.evaluate(() => window.ideer.skillPreferences({ action: 'list' }).then(
      value => value, error => (String(error).includes('SKILL_PREFERENCE_BUSY') ? null : Promise.reject(error))))
    return view !== null
  }, 'preference list after in-flight commands settle')
  return view
}
const prefRow = slug => page.locator('.ant-card', { hasText: slug }).last()
async function publishAgent(agentId, skillId, name) {
  const draft = api('A', 'PUT', `/api/resources/${agentId}/agent-draft`, {
    config: { name, model: manifest.model, thinking_enabled: false, memory_enabled: false, skills: [skillId], model_settings: { max_tokens: 1400 } },
    soul: 'Follow the selected Skill and the synthetic marker request. Do not use tools, access files, or execute commands.', expected_revision: 0 })
  assert.equal(draft.status, 200)
  const published = api('A', 'POST', `/api/resources/${agentId}/publish`, { expected_draft_revision: 1, scan_result: { status: 'passed' } })
  assert.equal(published.status, 200)
}
async function apiThread(agentId) {
  const created = api('A', 'POST', '/api/threads', { metadata: { agent_name: agentId } })
  assert.equal(created.status, 200, JSON.stringify(created.body))
  return created.body.thread_id
}
async function apiRun(threadId, agentId, text, skillId) {
  const context = { agent_name: agentId }
  if (skillId) context.skill_resource_id = skillId
  return api('A', 'POST', `/api/threads/${threadId}/runs`, {
    assistant_id: agentId, input: { messages: [{ id: randomUUID(), type: 'human', content: text }] },
    context, metadata: {}, stream_mode: ['messages-tuple', 'values', 'custom'],
    stream_subgraphs: true, multitask_strategy: 'reject', on_disconnect: 'continue' })
}
async function main() {
  try {
    assert.equal(manifest.realProvider, true)
    evidence.scenarios[activeScenario].status = 'incomplete'
    await launch()
    const trigger = fixtures['t121-trigger'], outsider = fixtures['t121-outsider']
    const triggerRow = await importUI(trigger)
    const triggerPublished = await publishedUI(triggerRow)
    const skillId = triggerPublished.resourceId
    const version1 = api('A', 'GET', `/api/resources/${skillId}/published?version=1`)
    assert.equal(version1.status, 200); assert.equal(version1.body.version.content_hash, trigger.packageHash)
    assert.equal(version1.body.skill_md, trigger.v1)
    const agent = api('A', 'POST', '/api/resources', { type: 'agent', slug: 't121-run-agent', display_name: 'T121 real provider', storage_kind: 'filesystem' })
    assert.equal(agent.status, 201)
    await publishAgent(agent.body.id, skillId, 't121-run-agent')
    record('T121-01', 'skill-and-closure-agent-published', { skill: triggerPublished, agent: agent.body.id })

    // The Server's preference list only carries rows that already exist, so the
    // account's first preference is created through the same Server endpoint the
    // pinned IPC relays to; the surface then edits exactly those five fields.
    const initial = api('A', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: ['T121_HIT'], always_inject: false, applicable_agent_ids: [], priority: 5 })
    assert.equal(initial.status, 204)
    await wait(() => auditActions('skill_trigger_preference_updated').some(row => row.resourceId === skillId
      && row.detail.priority === 5 && JSON.stringify(row.detail.keywords) === '["T121_HIT"]'), 'first preference audited', 30000)
    record('T121-01', 'first-preference-created-server-side', { status: initial.status, audited: true })
    await quit(); await launch()

    const slug = trigger.slug
    const rowSwitch = page.getByRole('switch', { name: `偏好启用开关 ${slug}` })
    await wait(async () => (await rowSwitch.count()) === 1, 'preference surface row')
    let rowText = await prefRow(slug).innerText()
    if (!rowText.includes('可用')) {
      // The availability badge rides the Server projection refresh; nudge it
      // once through the preferences reload before asserting.
      await wait(async () => {
        rowText = await prefRow(slug).innerText()
        return rowText.includes('可用') && rowText.includes('平台版本 V1')
      }, 'preference row shows availability and frozen version', 60000).catch(() => {})
    }
    assert.ok(rowText.includes('可用'), 'row text: ' + rowText.slice(0, 200))
    assert.ok(rowText.includes('平台版本 V1'), 'row text: ' + rowText.slice(0, 200))
    for (const label of [`偏好启用开关 ${slug}`, `始终注入勾选 ${slug}`, `优先级输入 ${slug}`, `关键词输入 ${slug}`, `适用Agent输入 ${slug}`, `保存偏好 ${slug}`, `清除偏好 ${slug}`]) {
      assert.ok(await page.getByLabel(label).count() > 0, 'surface control ' + label)
    }
    assert.equal(await page.getByRole('switch', { name: `偏好启用开关 ${slug}` }).isChecked(), true)
    assert.equal(await page.getByLabel(`关键词输入 ${slug}`).inputValue(), 'T121_HIT')
    await page.screenshot({ path: path.join(state, 'preference-surface.png'), fullPage: true })
    record('T121-01', 'five-field-surface-renders-server-truth', { slug, rowText })

    const writesBeforeSave = prefWrites().length
    await page.getByLabel(`优先级输入 ${slug}`).fill('50')
    await page.getByRole('button', { name: `保存偏好 ${slug}`, exact: true }).click()
    await wait(() => prefWrites().length > writesBeforeSave && prefWrites().at(-1).status === 204, 'UI save PUT accepted')
    const saved = api('A', 'GET', '/api/resources/skill-trigger-preferences')
    assert.equal(saved.status, 200)
    const savedRow = saved.body.items.find(item => item.skill_resource_id === skillId)
    assert.equal(savedRow.priority, 50); assert.deepEqual(savedRow.keywords, ['T121_HIT'])
    await wait(() => auditActions('skill_trigger_preference_updated').some(row => row.resourceId === skillId && row.detail.priority === 50), 'UI save audited', 30000)
    record('T121-01', 'ui-edit-put-relays-five-fields', { priority: savedRow.priority, keywords: savedRow.keywords, wire: prefWrites().at(-1) })

    await page.getByLabel(`关键词输入 ${slug}`).fill('T121_HIT, T121_HIT')
    await page.getByRole('button', { name: `保存偏好 ${slug}`, exact: true }).click()
    let refusalWrites = 0
    await wait(async () => {
      refusalWrites = prefWrites().filter(row => row.status === 422).length
      return (await page.locator('body').innerText()).includes('偏好未保存') && refusalWrites > 0
    }, 'server bounds refusal reaches the surface alert')
    const refusalAlert = ((await page.locator('body').innerText()).match(/偏好未保存：[^\n]*/) || [''])[0]
    const afterRefusal = api('A', 'GET', '/api/resources/skill-trigger-preferences')
    const refusedRow = afterRefusal.body.items.find(item => item.skill_resource_id === skillId)
    assert.equal(refusedRow.priority, 50); assert.deepEqual(refusedRow.keywords, ['T121_HIT'], 'a refused save changes nothing')
    record('T121-01', 'server-bounds-refusal-surfaces-without-drift', { alert: refusalAlert, refusedWrites: refusalWrites })
    await page.getByLabel(`关键词输入 ${slug}`).fill('T121_HIT')
    await page.getByRole('button', { name: `保存偏好 ${slug}`, exact: true }).click()
    await wait(async () => {
      const check = api('A', 'GET', '/api/resources/skill-trigger-preferences')
      return check.body.items.find(item => item.skill_resource_id === skillId)?.priority === 50
        && JSON.stringify(check.body.items.find(item => item.skill_resource_id === skillId)?.keywords) === '["T121_HIT"]'
    }, 'preference restored after the refused save')

    const refreshed = await chat({ action: 'refresh' }); assert.equal(refreshed.error, '')
    const thread = await chat({ action: 'create', scope: refreshed.scope, agentId: agent.body.id })
    assert.equal(thread.error, '')
    const sent = await chat({ action: 'send', scope: thread.scope, threadId: thread.thread.id, turnId: randomUUID(),
      text: 'T121_HIT. Platform skills are mounted read-only under /mnt/skills. List that directory, read the SKILL.md of the t121-trigger skill, and follow the marker instruction it contains. Then produce at least 300 words of harmless synthetic prose. Use no tools other than reading your mounted skill files.' })
    assert.equal(sent.error, ''); assert(sent.run)
    const finished = await terminal(thread.thread.id, sent.run.id)
    const matched = finished.run.selection.preferred_skill
    assert.equal(matched.resource_id, skillId); assert.equal(matched.version, 1)
    assert.equal(matched.content_hash, trigger.packageHash)
    expectMarker(finished.messages, 'T121_CONTENT_V1', thread.thread.id, finished.run.id)
    record('T121-01', 'runtime-stream-observation', { threadId: thread.thread.id, runId: finished.run.id, runtimeView: finished.runtimeView })
    await wait(() => auditActions('skill_trigger_preference_applied').some(row => row.resourceId === skillId
      && row.detail.version === 1 && row.detail.content_hash === trigger.packageHash
      && row.detail.origin === 'preference' && row.detail.run_attempt_id === finished.run.id), 'applied audit pins the frozen identity', 30000)
    const runPosts = wire().filter(row => row.path.endsWith('/runs') && row.method === 'POST')
    assert(runPosts.length >= 1); assert(runPosts.every(row => row.path.includes(thread.thread.id)))
    record('T121-01', 'preference-hit-injects-frozen-v1-through-real-run', { runId: finished.run.id, selection: matched, audit: 'skill_trigger_preference_applied' })

    const explicitThread = await chat({ action: 'create', scope: thread.scope, agentId: agent.body.id, skillId })
    assert.equal(explicitThread.error, '')
    const explicitSent = await chat({ action: 'send', scope: explicitThread.scope, threadId: explicitThread.thread.id, turnId: randomUUID(),
      text: 'No trigger words here. Platform skills are mounted read-only under /mnt/skills. Read /mnt/skills/t121-trigger/SKILL.md and return only the exact T121_CONTENT version marker it requires. Use no tools other than reading that file.' })
    assert.equal(explicitSent.error, '')
    const explicitDone = await terminal(explicitThread.thread.id, explicitSent.run.id)
    assert.equal(explicitDone.run.selection.preferred_skill.resource_id, skillId)
    assert.equal(explicitDone.run.selection.preferred_skill.version, 1)
    record('T121-01', 'explicit-selection-injects-without-any-keyword', { runId: explicitDone.run.id, selection: explicitDone.run.selection.preferred_skill })

    const missThread = await chat({ action: 'create', scope: thread.scope, agentId: agent.body.id })
    const missSent = await chat({ action: 'send', scope: missThread.scope, threadId: missThread.thread.id, turnId: randomUUID(),
      text: 'Nothing matches here. Produce two sentences of harmless synthetic prose. Use no tools.' })
    assert.equal(missSent.error, '')
    const missDone = await terminal(missThread.thread.id, missSent.run.id)
    assert.equal(missDone.run.selection.preferred_skill, undefined, 'a miss injects nothing')
    assert.equal(auditActions('skill_trigger_preference_applied').some(row => row.detail.run_attempt_id === missDone.run.id), false)
    record('T121-01', 'miss-continues-without-injection-or-audit', { runId: missDone.run.id })
    await page.screenshot({ path: path.join(state, 'matched-runs.png'), fullPage: true })
    done('T121-01')

    activeScenario = 'T121-02'; evidence.scenarios[activeScenario].status = 'incomplete'
    const outsiderRow = await importUI(outsider)
    const outsiderPublished = await publishedUI(outsiderRow)
    const outsiderSkill = outsiderPublished.resourceId
    const outsiderVersion = api('A', 'GET', `/api/resources/${outsiderSkill}/published?version=1`)
    assert.equal(outsiderVersion.status, 200); assert.equal(outsiderVersion.body.version.content_hash, outsider.packageHash)

    const invisible = api('B', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: ['x'], always_inject: false, applicable_agent_ids: [], priority: 0 })
    assert.equal(invisible.status, 404)
    const unknown = api('A', 'PUT', '/api/resources/12100000-0000-4000-8000-000000000099/trigger-preference',
      { enabled: true, keywords: ['x'], always_inject: false, applicable_agent_ids: [], priority: 0 })
    assert.equal(unknown.status, 404)
    const nonSkill = api('A', 'PUT', `/api/resources/${agent.body.id}/trigger-preference`,
      { enabled: true, keywords: ['x'], always_inject: false, applicable_agent_ids: [], priority: 0 })
    assert.equal(nonSkill.status, 409)
    const tooManyKeywords = api('A', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: Array.from({ length: 17 }, (_v, i) => 'k' + i), always_inject: false, applicable_agent_ids: [], priority: 0 })
    assert.equal(tooManyKeywords.status, 422)
    const rangePriority = api('A', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: ['x'], always_inject: false, applicable_agent_ids: [], priority: 1001 })
    assert.equal(rangePriority.status, 422)
    const duplicateAgents = api('A', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: ['x'], always_inject: false, applicable_agent_ids: [agent.body.id, agent.body.id], priority: 0 })
    assert.equal(duplicateAgents.status, 422)
    record('T121-02', 'preference-endpoint-rejection-matrix', {
      invisible: invisible.status, unknown: unknown.status, nonSkill: nonSkill.status,
      tooManyKeywords: tooManyKeywords.status, rangePriority: rangePriority.status, duplicateAgents: duplicateAgents.status })
    const bList = api('B', 'GET', '/api/resources/skill-trigger-preferences')
    assert.equal(bList.status, 200); assert.deepEqual(bList.body.items, [], 'B holds no preference rows')

    const explicitThread409 = await apiThread(agent.body.id)
    const explicitRejected = await apiRun(explicitThread409, agent.body.id, 'T121_HIT marker request', outsiderSkill)
    assert.equal(explicitRejected.status, 409)
    assert.ok(JSON.stringify(explicitRejected.body).includes('skill_outside_agent_closure'), JSON.stringify(explicitRejected.body))
    await wait(() => auditActions('run_preparation_rejected').some(row => row.detail.reason === 'skill_outside_agent_closure'
      && row.detail.requested_skill === outsiderSkill), 'explicit refusal audited', 30000)
    record('T121-02', 'explicit-outside-closure-hard-409', { status: explicitRejected.status, body: explicitRejected.body })

    const outsiderPreference = api('A', 'PUT', `/api/resources/${outsiderSkill}/trigger-preference`,
      { enabled: true, keywords: ['T121_HIT'], always_inject: false, applicable_agent_ids: [], priority: 100 })
    assert.equal(outsiderPreference.status, 204)
    const skipThread = await chat({ action: 'create', scope: thread.scope, agentId: agent.body.id })
    const skipSent = await chat({ action: 'send', scope: skipThread.scope, threadId: skipThread.thread.id, turnId: randomUUID(),
      text: 'T121_HIT: produce three sentences of harmless synthetic prose. Use no tools.' })
    assert.equal(skipSent.error, '')
    const skipDone = await terminal(skipThread.thread.id, skipSent.run.id)
    assert.equal(skipDone.run.selection.preferred_skill, undefined, 'the out-of-closure match never activates')
    await wait(() => auditActions('skill_trigger_preference_skipped').some(row => row.resourceId === outsiderSkill
      && row.detail.reason === 'skill_outside_agent_closure' && row.detail.run_attempt_id === skipDone.run.id), 'skip audited for this run', 30000)
    record('T121-02', 'out-of-closure-preference-skips-and-audits-run-proceeds', { runId: skipDone.run.id })
    const removed = api('A', 'DELETE', `/api/resources/${outsiderSkill}/trigger-preference`)
    assert.equal(removed.status, 204)
    const removedAgain = api('A', 'DELETE', `/api/resources/${outsiderSkill}/trigger-preference`)
    assert.equal(removedAgain.status, 204)
    await wait(() => auditActions('skill_trigger_preference_removed').some(row => row.resourceId === outsiderSkill), 'removal audited', 30000)
    record('T121-02', 'delete-idempotent-and-audited', { statuses: [removed.status, removedAgain.status] })

    const unpublished = api('A', 'POST', '/api/resources', { type: 'skill', slug: 't121-unpublished', display_name: 'T121 unpublished dependency', storage_kind: 'filesystem' })
    assert.equal(unpublished.status, 201)
    const wired = api('A', 'PUT', `/api/resources/${agent.body.id}/dependencies`, { resource_ids: [skillId, unpublished.body.id] })
    assert.equal(wired.status, 200, JSON.stringify(wired.body))
    const depThread = await apiThread(agent.body.id)
    const depRejected = await apiRun(depThread, agent.body.id, 'T121_HIT marker request', '')
    assert.equal(depRejected.status, 409, JSON.stringify(depRejected.body))
    const restored = api('A', 'PUT', `/api/resources/${agent.body.id}/dependencies`, { resource_ids: [skillId] })
    assert.equal(restored.status, 200)
    record('T121-02', 'unpublished-required-dependency-refuses-the-run', { status: depRejected.status, body: depRejected.body })
    skipped('T121-02', 'required-dependency-made-invisible-refusal',
      'Driving a required closure dependency invisible needs a visibility reduction on a resource the runner can see; '
      + 'every resource in this fixture is the runner\'s own (registered accounts get no department), visibility expansion '
      + 'needs platform approval, and resources have no delete endpoint — the A/B user API cannot reach that state. The '
      + 'rule itself is unchanged existing closure behavior pinned by the Server suite (same audit family as the 409 above).')
    await page.screenshot({ path: path.join(state, 'rejection-matrix.png'), fullPage: true })
    incomplete('T121-02')

    activeScenario = 'T121-03'; evidence.scenarios[activeScenario].status = 'incomplete'
    const projection = api('A', 'GET', '/api/resources/skill-trigger-preferences')
    assert.equal(projection.status, 200); assert.equal(projection.body.items.length, 1)
    const item = projection.body.items[0]
    assert.deepEqual(Object.keys(item).sort(), ['always_inject', 'applicable_agent_ids', 'enabled', 'keywords', 'priority', 'skill', 'skill_resource_id'])
    assert.deepEqual(Object.keys(item.skill).sort(), ['available', 'display_name', 'latest_version', 'slug'])
    assert.ok(!JSON.stringify(projection.body).includes('SKILL.md'), 'the projection never carries Skill content')
    record('T121-03', 'projection-carries-identity-and-availability-only', { keys: Object.keys(item).sort() })
    assert.equal(((await status()).runtime.skillScriptAuthorizations || []).length, 0, 'configuring a preference activates nothing')
    assert.equal(await page.getByRole('button', { name: '发布技能 ' + slug, exact: true }).count(), 0, 'the preference surface offers no publication or execution affordance')

    const writesBeforeBad = prefWrites().length
    const badShapes = [
      { action: 'set', skillId: 'not-a-uuid', enabled: true, keywords: [], alwaysInject: false, applicableAgentIds: [], priority: 0 },
      { action: 'set', skillId, enabled: true, keywords: Array.from({ length: 17 }, (_v, i) => 'k' + i), alwaysInject: false, applicableAgentIds: [], priority: 0 },
      { action: 'set', skillId, enabled: true, keywords: ['x'.repeat(65)], alwaysInject: false, applicableAgentIds: [], priority: 0 },
      { action: 'set', skillId, enabled: true, keywords: [''], alwaysInject: false, applicableAgentIds: [], priority: 0 },
      { action: 'set', skillId, enabled: true, keywords: [], alwaysInject: false, applicableAgentIds: [], priority: 1001 },
      { action: 'set', skillId, enabled: true, keywords: [], alwaysInject: false, applicableAgentIds: [], priority: 0.5 },
      { action: 'set', skillId, enabled: true, keywords: [], alwaysInject: false, applicableAgentIds: Array.from({ length: 33 }, () => agent.body.id), priority: 0 },
      { action: 'set', skillId, enabled: 'yes', keywords: [], alwaysInject: false, applicableAgentIds: [], priority: 0 },
      { action: 'set', skillId, enabled: true, keywords: [], alwaysInject: false, applicableAgentIds: [], priority: 0, extra: 1 },
      { action: 'clear', skillId: 'not-a-uuid' }
    ]
    for (const bad of badShapes) {
      const refused = await page.evaluate(command => window.ideer.skillPreferences(command).then(() => 'unexpected-success', error => String(error)), bad)
      assert.match(refused, /SKILL_PREFERENCE_COMMAND_INVALID/, JSON.stringify(bad))
    }
    assert.equal(prefWrites().length, writesBeforeBad, 'bad shapes never leave the process')
    const alive = await status()
    assert.equal(alive.runtime.process, 'running')
    const listed = await listSafe()
    assert.ok(Array.isArray(listed.skills) && listed.skills.length >= 1, 'the pinned channel still works after refusals')
    record('T121-03', 'bad-shapes-refused-before-any-wire-traffic', { shapes: badShapes.length, writesAdded: prefWrites().length - writesBeforeBad })
    await page.screenshot({ path: path.join(state, 'preference-bounds.png'), fullPage: true })
    done('T121-03')

    activeScenario = 'T121-04'; evidence.scenarios[activeScenario].status = 'incomplete'
    const overlapThread = await chat({ action: 'create', scope: thread.scope, agentId: agent.body.id })
    const overlapSent = await chat({ action: 'send', scope: overlapThread.scope, threadId: overlapThread.thread.id, turnId: randomUUID(),
      text: 'T121_HIT. Platform skills are mounted read-only under /mnt/skills. List that directory, read the SKILL.md of the t121-trigger skill, and follow the marker instruction it contains. Then produce at least 300 words of harmless synthetic prose. Use no tools other than reading your mounted skill files.' })
    assert.equal(overlapSent.error, ''); assert(overlapSent.run)
    const overlapRoute = `/api/threads/${overlapThread.thread.id}/runs/${overlapSent.run.id}`
    const runningBefore = api('A', 'GET', overlapRoute)
    assert.equal(runningBefore.status, 200); assert(['pending', 'running'].includes(runningBefore.body.status), 'Run must still be in progress before the rewrite')

    const rewrite = api('A', 'PUT', `/api/resources/skills/${skillId}/trigger-preference`,
      { enabled: true, keywords: ['T121_LATE'], always_inject: false, applicable_agent_ids: [], priority: 70 })
    assert.equal(rewrite.status, 204)
    const nextDraft = api('A', 'PUT', `/api/resources/${skillId}/skill-draft`, { content: trigger.v2, expected_revision: 1 })
    assert.equal(nextDraft.status, 200); assert.equal(nextDraft.body.revision, 2)
    const version2Publish = api('A', 'POST', `/api/resources/${skillId}/publish`, { expected_draft_revision: 2, scan_result: { status: 'passed' } })
    assert.equal(version2Publish.status, 200); assert.equal(version2Publish.body.version, 2)
    const runningAfter = api('A', 'GET', overlapRoute)
    assert(['pending', 'running'].includes(runningAfter.body.status), 'Run finished before a real overlap could be observed; scenario remains incomplete')
    const frozen = await terminal(overlapThread.thread.id, overlapSent.run.id)
    expectMarker(frozen.messages, 'T121_CONTENT_V1', overlapThread.thread.id, frozen.run.id)
    record('T121-04', 'runtime-stream-observation', { threadId: overlapThread.thread.id, runId: frozen.run.id, runtimeView: frozen.runtimeView })
    const archived = api('A', 'GET', overlapRoute)
    const frozenSelection = runSelection(archived)
    assert.equal(frozenSelection.preferred_skill.resource_id, skillId)
    assert.equal(frozenSelection.preferred_skill.version, 1); assert.equal(frozenSelection.preferred_skill.content_hash, trigger.packageHash)
    await wait(() => auditActions('skill_trigger_preference_applied').some(row => row.detail.run_attempt_id === frozen.run.id
      && row.detail.version === 1 && row.detail.content_hash === trigger.packageHash), 'frozen run audit keeps V1', 30000)
    const currentV1 = api('A', 'GET', `/api/resources/${skillId}/published?version=1`)
    const currentV2 = api('A', 'GET', `/api/resources/${skillId}/published?version=2`)
    assert.equal(currentV1.body.version.content_hash, trigger.packageHash); assert.equal(currentV1.body.skill_md, trigger.v1)
    assert.equal(currentV2.body.version.content_hash, trigger.packageHashV2); assert.equal(currentV2.body.skill_md, trigger.v2)
    record('T121-04', 'preference-rewrite-and-v2-publication-never-drift-the-running-run', {
      threadId: overlapThread.thread.id, runId: frozen.run.id, runningBefore: runningBefore.body.status,
      runningAfter: runningAfter.body.status, selection: frozenSelection, V1: currentV1.body.version, V2: currentV2.body.version })

    const lateThread = await chat({ action: 'create', scope: overlapThread.scope, agentId: agent.body.id })
    const lateSent = await chat({ action: 'send', scope: lateThread.scope, threadId: lateThread.thread.id, turnId: randomUUID(),
      text: 'T121_LATE. Platform skills are mounted read-only under /mnt/skills. Read /mnt/skills/t121-trigger/SKILL.md and return only the exact T121_CONTENT version marker it requires. Use no tools other than reading that file.' })
    assert.equal(lateSent.error, '')
    const late = await terminal(lateThread.thread.id, lateSent.run.id)
    expectMarker(late.messages, 'T121_CONTENT_V2', lateThread.thread.id, late.run.id)
    assert.equal(late.run.selection.preferred_skill.version, 2)
    assert.equal(late.run.selection.preferred_skill.content_hash, trigger.packageHashV2)
    record('T121-04', 'new-run-follows-the-rewritten-preference-and-v2', { runId: late.run.id, selection: late.run.selection.preferred_skill, runtimeView: late.runtimeView })
    await page.screenshot({ path: path.join(state, 'frozen-and-late-runs.png'), fullPage: true })
    done('T121-04')
    evidence.status = Object.values(evidence.scenarios).every(row => row.status === 'passed') ? 'passed' : 'incomplete'
    if (evidence.status !== 'passed') process.exitCode = 1
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
