// Compose the real signed-write UI fixture with the artifact contract checks.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed: ' + old)
  source = source.replace(old, next)
}
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T105-01', 'T105-02', 'T105-03', 'T105-04']")
replace('const appData =', 'let appData =')
replace("installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')")
replace('const config =', 'let config =')
replace('const owner =', 'let owner =')
replace('executablePath: installed, args: []', "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
replace('args: [entry]', "args: [root, '--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
source = 'let identityLabel = "A"\n' + source.replaceAll('manifest.identities.A.profile', 'manifest.identities[identityLabel].profile')
replace("  if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')\n  fs.writeFileSync(config, fs.readFileSync(manifest.identities[identityLabel].profile), { flag: installed && !ownsSettings ? 'wx' : 'w' })", `  if (fs.existsSync(config)) {
    assert(fs.existsSync(owner), 'existing fixture profile requires its synthetic ownership marker')
    const current = JSON.parse(fs.readFileSync(config, 'utf8'))
    const expected = JSON.parse(fs.readFileSync(manifest.identities[identityLabel].profile, 'utf8'))
    assert.equal(current.user_id, expected.user_id)
    assert.equal(current.device_id, expected.device_id)
  } else {
    fs.writeFileSync(owner, 'isolated issue102 fixture')
    fs.writeFileSync(config, fs.readFileSync(manifest.identities[identityLabel].profile), { flag: 'wx' })
  }`)
source += "\nevidence.candidate.acceptanceFiles.push(...['desktop.cjs','artifact-flow.cjs','artifact_profiles.py'].map(name => ({path:'scripts/acceptance/issue-105/'+name,sha256:sha(fs.readFileSync(path.join(__dirname,'../issue-105',name)))})))\n"
source += fs.readFileSync(path.join(__dirname, '../issue-106/flow.cjs'), 'utf8').split('async function main() {')[0]
source += fs.readFileSync(path.join(__dirname, 'artifact-flow.cjs'), 'utf8')
source += `
async function main() {
  try {
    fixture('W/target.txt')
    await launch(); await choose()
    const operation = await successful('T105-01', 'create-result', 'W/target.txt', 'target.txt', AFTER, true)
    await wait(() => controls('history').rows.some(row => row.task_id === operation.approval.taskId && row.delivery_state === 'confirmed'), 'real Server receipt confirmation')
    const local = await taskCard(operation)
    assert.equal(local.localResult.artifact_ref, '')
    assert(!(await snapshot()).artifacts.length)
    pass('T105-01', 'local-result-no-auto-upload', { operationId: operation.id, localResult: local.localResult })
    evidence.scenarios['T105-01'].status = 'passed'; save()
    await exerciseArtifacts(operation, 'T105-02')
    evidence.scenarios['T105-02'].status = 'passed'; save()
    // Account rejection and producer revocation are separately recorded, even
    // though the successful D2 flow above already exercises account B.
    await revokedArtifactProducer(operation, 'T105-03')
    evidence.scenarios['T105-03'].status = 'passed'; save()
    pass('T105-04', 'real-artifact-idempotency-and-visibility', { threadId: operation.threadId })
    evidence.scenarios['T105-04'].status = 'passed'
    await page.screenshot({ path: path.join(state, 'issue-105-matrix.png'), fullPage: true })
    await quit()
    evidence.status = 'passed'
  } catch (error) {
    evidence.status = 'failed'
    evidence.failure = String(error.stack || error)
    for (const row of Object.values(evidence.scenarios)) if (row.status === 'unexecuted' && row.cases.length) row.status = 'incomplete'
    try { if (page) { evidence.failureSnapshot = await snapshot(); evidence.failureUI = await page.locator('body').innerText() } } catch {}
    throw error
  } finally {
    if (app) { try { await quit() } catch (error) { evidence.shutdownError = String(error); evidence.status = 'failed' } }
    try { evidence.credentialCleanup = profile('cleanup') } catch (error) { evidence.cleanupError = String(error); evidence.status = 'failed' }
    flag('stop')
    assert(path.resolve(work).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(work, { recursive: true, force: true })
    evidence.finishedAt = new Date().toISOString(); save()
    if (evidence.status !== 'passed') process.exitCode = 1
  }
}
save()
main().catch(error => { console.error(String(error.stack)); process.exitCode = 1 })
`
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
