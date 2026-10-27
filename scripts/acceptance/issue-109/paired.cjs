// Compose the real issue-102 preamble; use standard isolated installed profile.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
function replace(old, next) { if (source.split(old).length !== 2) throw new Error('Base harness changed: ' + old); source = source.replace(old, next) }
replace("['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T109-01', 'T109-02', 'T109-03', 'T109-04']")
replace("installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')")
replace("if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')")
replace("executablePath: installed, args: []", "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
source += fs.readFileSync(path.join(__dirname, 'paired-flow.cjs'), 'utf8')
const candidate = new Module(filename, module); candidate.filename = filename; candidate.paths = Module._nodeModulePaths(path.dirname(filename)); candidate._compile(source, filename)
