// Real UI + bundled Runtime + real signed Gateway. Reuse the existing write fixture.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
const previous = "['T102-01', 'T102-02', 'T102-03', 'T102-04']"
if (source.split(previous).length !== 2) throw new Error('Write fixture changed')
source = source.replace(previous, "['T110-01', 'T110-02', 'T110-03', 'T110-04']")
source = source.replace("installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')")
source = source.replace("if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')")
source = source.replace("{ buildInputsSHA256: sha(fs.readFileSync(path.join(sourceRoot, 'artifacts/issue-102/build-inputs.json'))) }", "{ buildPackageSHA256: sha(fs.readFileSync(path.join(root, 'package.json'))) }")
source = source.replace('executablePath: installed, args: []', "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
source = source.replace('args: [entry]', "args: process.env.IDEER_ACCEPTANCE_LEGACY_CLIENT === '1' ? [entry] : [root, '--user-data-dir=' + path.join(appData, 'iDeer Desktop')]")
source += fs.readFileSync(path.join(__dirname, 'flow.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
