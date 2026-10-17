const { readFileSync } = require('node:fs')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')

const source = JSON.parse(readFileSync('resources/provenance/linz-source.json', 'utf8'))
const snapshot = process.argv[2] === '--snapshot' ? process.argv[3] : null
if (process.argv[2] === '--snapshot' && !snapshot) throw new Error('--snapshot requires a directory')
for (const name of ['package.json', 'package-lock.json']) {
  const bytes = readFileSync(`resources/provenance/linz-${name}`)
  if (createHash('sha256').update(bytes).digest('hex') !== source.files[name]) {
    throw new Error(`Archived source changed: ${name}`)
  }
}
// Optional source checkout is read only. Never import untracked working-tree files.
if (process.argv[2]) {
  for (const [path, expected] of Object.entries(source.files)) {
    const bytes = snapshot
      ? readFileSync(require('node:path').join(snapshot, path))
      : execFileSync('git', ['-C', process.argv[2], 'show', `${source.commit}:${path}`])
    if (createHash('sha256').update(bytes).digest('hex') !== expected) {
      throw new Error(`Source mismatch: ${path}`)
    }
    console.log(`Matched ${path}: ${expected}`)
  }
}
console.log(`Verified linz provenance: ${source.commit}`)
