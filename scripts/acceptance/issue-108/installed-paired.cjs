// Paired installed update/recovery acceptance (#108 T108-04, #109 T109-04).
// Reuses the issue-102 preamble with standard --user-data-dir isolation.
//   IDEER_ACCEPTANCE_UPDATE_RELEASE  absolute path to the signed manifest.json
//   IDEER_ACCEPTANCE_UPDATE_EXPECTED updated | rolled-back
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed: ' + old)
  source = source.replace(old, next)
}
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T108-04', 'T109-04']")
replace("installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')")
replace("if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')")
replace("executablePath: installed, args: []", "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
source += fs.readFileSync(path.join(__dirname, 'flow-paired.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
