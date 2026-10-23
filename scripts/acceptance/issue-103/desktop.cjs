// Reuse the signed write acceptance harness, with independent Issue 103 flows.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed; inspect adaptation: ' + old)
  source = source.replace(old, next)
}
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T103-01', 'T103-02', 'T103-03', 'T103-04']")
replace("const controls = (action, ...args) => python(path.join(__dirname, 'profile_controls.py'), action, config, ...args)",
  "const controls = (action, ...args) => python(path.join(__dirname, '../issue-103/profile_controls.py'), action, config, state, ...args)")
replace("const api = (route, body, post = false) => profile(post ? 'api-post' : 'api', 'A', route, ...(body === undefined ? [] : [JSON.stringify(body)]))",
  "const lifecycle = (action, ...args) => python(path.join(__dirname, '../issue-103/lifecycle.py'), action, state, config, evidence.activeIdentity || 'A', ...args)\nconst api = (route, body, post = false) => lifecycle(post ? 'api-post' : 'api', route, ...(body === undefined ? [] : [JSON.stringify(body)]))")
replace('async function launch() {', 'async function launch(authenticated = true) {')
replace("  await wait(async () => (await status()).runtime.login?.state === 'authenticated', 'business identity')\n  await wait(async () => (await status()).server === 'connected', 'signed device connection')",
  "  await wait(async () => authenticated ? (await status()).runtime.login?.state === 'authenticated' : ['unauthenticated','error'].includes((await status()).runtime.login?.state), 'business identity')\n  if (authenticated) await wait(async () => (await status()).server === 'connected', 'signed device connection')")
replace('agentId: manifest.identities.A.agentId', "agentId: manifest.identities[evidence.activeIdentity || 'A'].agentId")
source += "\nevidence.candidate.acceptanceFiles.push(...['desktop.cjs','flow.cjs','lifecycle.py','profile_controls.py'].map(name => ({path:'scripts/acceptance/issue-103/'+name,sha256:sha(fs.readFileSync(path.join(__dirname,'../issue-103',name)))})))\n"
source += fs.readFileSync(path.join(__dirname, 'flow.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
