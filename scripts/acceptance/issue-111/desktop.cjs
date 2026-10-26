// Real Desktop/Runtime against an isolated, restartable Server; issue 111 matrix.
// Installed mode uses the standard --user-data-dir isolation below the state
// directory; the real user profile is never read, moved or replaced.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed: ' + old)
  source = source.replace(old, next)
}
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T111-01', 'T111-02', 'T111-03', 'T111-04']")
replace("installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')")
replace("if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')")
replace("executablePath: installed, args: []", "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
replace("args: [entry]", "args: [root, '--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
replace("...(operationName === 'write' ? { content } : {})", "...(operationName === 'write' ? { content } : operationName === 'search' ? { query: content } : {})")
source += "\nevidence.candidate.acceptanceFiles.push(...['desktop.cjs','flow.cjs'].map(name => ({path:'scripts/acceptance/issue-111/'+name,sha256:sha(fs.readFileSync(path.join(__dirname,'../issue-111',name)))})))\n"
source += fs.readFileSync(path.join(__dirname, 'flow.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
