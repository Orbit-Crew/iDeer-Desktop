// Sign exact tested combinations. The private key is supplied by the publisher.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, createPrivateKey, createPublicKey, sign } = require('node:crypto')

function main() {
  const options = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]
    if (!['--spec', '--key', '--output'].includes(name) || !process.argv[i + 1] || options[name]) throw new Error('COMPAT_ARGUMENT_INVALID')
    options[name] = process.argv[i + 1]
  }
  if (Object.keys(options).length !== 3) throw new Error('Usage: node make-compatibility.cjs --spec spec.json --key private.pem --output directory')
  const declaration = JSON.parse(fs.readFileSync(options['--spec'], 'utf8'))
  const known = new Set(['echo', 'local.files.list', 'local.files.read', 'local.files.search', 'local.files.write', 'local.python', 'local.artifacts.upload'])
  function policy(row, fallback = {}) {
    const level = row.level ?? fallback.level
    const disabled = row.disabledCapabilities ?? fallback.disabledCapabilities
    if (!['compatible', 'capability', 'core'].includes(level) || !Array.isArray(disabled) || disabled.length > 128 ||
        disabled.some(value => typeof value !== 'string' || (!known.has(value) && !/^local\.mcp\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value))) ||
        new Set(disabled).size !== disabled.length || (level !== 'capability' && disabled.length)) throw new Error('COMPAT_POLICY_INVALID')
    return { level, disabledCapabilities: disabled }
  }
  function combo(row) {
    if (!row || typeof row !== 'object' || ['desktop', 'runtime', 'server'].some(key => typeof row[key] !== 'string' || !row[key] || row[key].length > 128)) throw new Error('COMPAT_COMBINATION_INVALID')
    const result = { desktop: row.desktop, runtime: row.runtime, server: row.server }
    if (row.legacyHello !== undefined) {
      const hint = row.legacyHello
      if (!hint || typeof hint.runtimeVersion !== 'string' || !hint.runtimeVersion || hint.runtimeVersion.length > 128 ||
          hint.protocolVersion !== '1' || Object.keys(hint).some(key => !['runtimeVersion', 'protocolVersion'].includes(key))) throw new Error('COMPAT_LEGACY_HELLO_INVALID')
      result.legacyHello = { runtimeVersion: hint.runtimeVersion, protocolVersion: hint.protocolVersion }
    }
    return result
  }
  if (!declaration || declaration.version !== 1 || !Number.isInteger(declaration.minProtocol) || declaration.minProtocol < 1 ||
      typeof declaration.notes !== 'string' || declaration.notes.length > 2000) throw new Error('COMPAT_SPEC_INVALID')
  const top = policy(declaration)
  const candidate = combo(declaration.candidateCombo)
  if (declaration.supportedCombos !== undefined && (!Array.isArray(declaration.supportedCombos) || declaration.supportedCombos.length > 128)) throw new Error('COMPAT_COMBINATION_INVALID')
  const rows = [{ ...candidate, ...top }]
  for (const value of declaration.supportedCombos || []) {
    const current = { ...combo(value), ...policy(value, top) }
    if (rows.some(row => row.desktop === current.desktop && row.runtime === current.runtime && row.server === current.server)) throw new Error('COMPAT_COMBINATION_DUPLICATE')
    if (current.desktop === '0.1.0' && (current.level !== top.level ||
        JSON.stringify([...current.disabledCapabilities].sort()) !== JSON.stringify([...top.disabledCapabilities].sort()))) {
      throw new Error('COMPAT_LEGACY_PARSER_CONFLICT')
    }
    rows.push(current)
  }
  const key = createPrivateKey(fs.readFileSync(options['--key']))
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('COMPAT_SIGNING_KEY_INVALID')
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' })
  const text = JSON.stringify(declaration, null, 2) + '\n'
  const signature = sign(null, Buffer.from(text), key).toString('hex')
  const output = path.resolve(options['--output'])
  fs.mkdirSync(output, { recursive: true })
  fs.writeFileSync(path.join(output, 'compatibility.json'), text)
  fs.writeFileSync(path.join(output, 'compatibility.sig'), signature + '\n')
  const record = { version: 1, generatedAt: new Date().toISOString(),
    declarationSHA256: createHash('sha256').update(text).digest('hex'),
    publicKeySHA256: createHash('sha256').update(publicKey).digest('hex'), combinations: rows,
    deploymentOrder: ['Deploy Server with these explicitly supported combinations.', 'Verify the unchanged old client.',
      'Introduce the tested new client and verify its exact combination.'],
    legacyParser: { desktop: '0.1.0', readsTopLevelOnly: true, level: top.level, disabledCapabilities: top.disabledCapabilities },
    rollingUpgrade: 'Only the combinations and deployment order actually verified in acceptance are supported.' }
  fs.writeFileSync(path.join(output, 'release-combinations.json'), JSON.stringify(record, null, 2) + '\n')
  process.stdout.write(JSON.stringify({ declarationSHA256: record.declarationSHA256, combinations: rows.length }) + '\n')
}
try { main() } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 1 }
