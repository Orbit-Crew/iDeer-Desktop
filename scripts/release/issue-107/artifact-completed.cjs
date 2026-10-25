const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { trustFor } = require('./after-pack.cjs')

module.exports = async function artifactCompleted(event) {
  if (!event.file || !event.file.endsWith('.exe')) return
  const trust = trustFor(event.packager)
  const hash = createHash('sha256')
  const input = fs.createReadStream(event.file)
  for await (const chunk of input) hash.update(chunk)
  fs.writeFileSync(event.file + '.updates-trust.json', JSON.stringify({ artifact: path.basename(event.file),
    artifactSHA256: hash.digest('hex'), publicKeySHA256: trust.sha256, algorithm: trust.algorithm }, null, 2) + '\n')
}
