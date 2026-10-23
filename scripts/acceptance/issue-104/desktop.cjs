// Real Desktop/Runtime against an isolated, restartable Server.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed: ' + old)
  source = source.replace(old, next)
}
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T104-01', 'T104-02', 'T104-03', 'T104-04']")
replace("...(options.hold ? { hold: true } : {})", "...(options.hold ? { hold: true } : {}), ...(options.next ? {next: options.next} : {})")
source += "\nevidence.candidate.acceptanceFiles.push(...['desktop.cjs','flow.cjs','server_fixture.py','fixture_hooks.py'].map(name => ({path:'scripts/acceptance/issue-104/'+name,sha256:sha(fs.readFileSync(path.join(__dirname,'../issue-104',name)))})))\n"
source += fs.readFileSync(path.join(__dirname, 'flow.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
