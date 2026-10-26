const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPublicKey } = require('node:crypto')
const packagedTrust = new Map()

// This input exists only in the build process. The running app always reads
// its packaged pin and never accepts an environment-provided trust anchor.
module.exports = async function afterPack(context) {
  const resources = path.join(context.appOutDir, 'resources', 'updates')
  const configured = process.env.IDEER_UPDATES_PUBLIC_KEY_FILE
  if (configured && !path.isAbsolute(configured)) throw new Error('UPDATE_BUILD_PUBLIC_KEY_ABSOLUTE_PATH_REQUIRED')
  const input = configured || path.join(resources, 'updates-public-key.pem')
  const pem = fs.readFileSync(input, 'utf8')
  if (!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----') || pem.includes('PRIVATE KEY')) throw new Error('UPDATE_BUILD_PUBLIC_KEY_REQUIRED')
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('UPDATE_BUILD_ED25519_REQUIRED')
  const publicKey = key.export({ type: 'spki', format: 'pem' })
  const sha256 = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex')
  fs.mkdirSync(resources, { recursive: true })
  fs.writeFileSync(path.join(resources, 'updates-public-key.pem'), publicKey)
  fs.writeFileSync(path.join(resources, 'trust-anchor.json'), JSON.stringify({ algorithm: 'ed25519', sha256 }, null, 2) + '\n')
  packagedTrust.set(context.packager, { algorithm: 'ed25519', sha256 })
}
module.exports.trustFor = packager => {
  const trust = packagedTrust.get(packager)
  if (!trust) throw new Error('UPDATE_BUILD_TRUST_NOT_RECORDED')
  return trust
}
