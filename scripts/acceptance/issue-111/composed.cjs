// Run existing full write/identity scenarios with isolated installed profiles.
const fs = require('node:fs'), path = require('node:path'), Module = require('node:module')
const mode = process.env.IDEER_T111_MODE
if (!['writes', 'identity'].includes(mode)) throw new Error('Explicit writes or identity mode required')
const base = path.resolve(__dirname, '../issue-102/desktop.cjs')
const entry = mode === 'writes' ? base : path.resolve(__dirname, '../issue-103/desktop.cjs')
let source = fs.readFileSync(entry, 'utf8').replace(/\r\n/g, '\n')
const edits = [
  ["installed ? process.env.APPDATA : path.join(state, 'appdata')", "path.join(state, 'appdata')"],
  ["if (!installed) fs.writeFileSync(owner, 'isolated issue102 fixture')", "fs.writeFileSync(owner, 'isolated issue102 fixture')"],
  ['executablePath: installed, args: []', "executablePath: installed, args: ['--user-data-dir=' + path.join(appData, 'iDeer Desktop')]"]
]
const provenance = "\nevidence.candidate.acceptanceFiles.push({path:'scripts/acceptance/issue-111/composed.cjs',sha256:sha(fs.readFileSync(" + JSON.stringify(__filename) + "))})\n"
if (mode === 'writes') {
  for (const [before, after] of edits) {
    if (source.split(before).length !== 2) throw new Error('Base write driver changed: ' + before)
    source = source.replace(before, after)
  }
  source = source.replace('function save()', provenance + 'function save()')
} else {
  const point = source.indexOf('source +=')
  if (point < 0) throw new Error('Identity composition changed')
  source = source.slice(0, point) + edits.map(([before, after]) => 'replace(' + JSON.stringify(before) + ',' + JSON.stringify(after) + ')\n').join('') +
    'source += ' + JSON.stringify(provenance) + '\n' + source.slice(point)
}
const candidate = new Module(entry, module)
candidate.filename = entry; candidate.paths = Module._nodeModulePaths(path.dirname(entry)); candidate._compile(source, entry)
