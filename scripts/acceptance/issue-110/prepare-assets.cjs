// Prepare synthetic signed cases using a private key that stays in TEMP.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const options = {}
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i]] = process.argv[i + 1]
if (!options['--release-state'] || !options['--server'] || !options['--output']) throw new Error('Usage: node prepare-assets.cjs --release-state state.json --server actual-version --output cases-directory')
const release = JSON.parse(fs.readFileSync(options['--release-state'], 'utf8'))
const root = path.resolve(__dirname, '../../..')
const desktop = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version
const runtime = JSON.parse(fs.readFileSync(path.join(root, 'local-runtime/distribution.lock.json'))).python
const output = path.resolve(options['--output'])
fs.mkdirSync(output, { recursive: true })
for (const level of ['compatible', 'capability', 'core']) {
  const directory = path.join(output, level)
  fs.mkdirSync(directory, { recursive: true })
  const spec = { version: 1, level: 'compatible', disabledCapabilities: [], minProtocol: 1,
    notes: 'Isolated acceptance. Old Desktop 0.1.0 retains its top-level compatible policy; the exact new combination selects its own row.',
    candidateCombo: { desktop: '0.1.0', runtime, server: options['--server'],
      legacyHello: { runtimeVersion: '0.1.0', protocolVersion: '1' } },
    supportedCombos: [{ desktop, runtime, server: options['--server'], level,
      disabledCapabilities: level === 'capability' ? ['local.files.write'] : [] }] }
  const specFile = path.join(directory, 'spec.json')
  fs.writeFileSync(specFile, JSON.stringify(spec, null, 2))
  execFileSync(process.execPath, [path.join(root, 'scripts/release/issue-110/make-compatibility.cjs'),
    '--spec', specFile, '--key', release.privateFile, '--output', directory], { windowsHide: true })
}
process.stdout.write(JSON.stringify({ prepared: ['compatible', 'capability', 'core'], desktop, runtime, server: options['--server'] }) + '\n')
