// T108-02: real installed Runtime, SQLite completion fault and unknown effect.
// Uses the same isolated inputs as acceptance.cjs; never installs the patch.
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const filename = path.resolve(__dirname, '../issue-102/desktop.cjs')
let source = fs.readFileSync(filename, 'utf8').replace(/\r\n/g, '\n').split('async function main() {')[0]
for (const [old, next] of [
  ["['T102-01', 'T102-02', 'T102-03', 'T102-04']", "['T108-02']"],
  ["installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')"],
  ["if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')"],
  ["executablePath: installed, args: []", "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]"]
]) {
  if (source.split(old).length !== 2) throw new Error('Write harness changed: ' + old)
  source = source.replace(old, next)
}
source += fs.readFileSync(path.join(__dirname, 'flow-blockers.cjs'), 'utf8')
const candidate = new Module(filename, module)
candidate.filename = filename
candidate.paths = Module._nodeModulePaths(path.dirname(filename))
candidate._compile(source, filename)
