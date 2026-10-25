import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { blocksLocalTask, checkCompatibility, evaluate, type CompatibilityDeclaration } from '../src/main/compat'

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function declaration(overrides: Partial<CompatibilityDeclaration> = {}): CompatibilityDeclaration {
  return { version: 1, level: 'compatible', disabledCapabilities: [], minProtocol: 1, notes: 'Server 3e728cd6a or newer',
    candidateCombo: { desktop: '0.2.0', runtime: '3.12.10', server: '3e728cd6a' }, ...overrides }
}

function signed(value: CompatibilityDeclaration): { text: string; signature: string } {
  const text = JSON.stringify(value)
  return { text, signature: sign(null, Buffer.from(text, 'utf8'), createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toString('hex') }
}

describe('compatibility gate (issue 110)', () => {
  it('accepts the three declared levels with their exact semantics', () => {
    for (const [level, disabled] of [['compatible', []], ['capability', ['local.python']], ['core', []]] as const) {
      const { text, signature } = signed(declaration({ level, disabledCapabilities: [...disabled] }))
      const result = evaluate(text, signature, publicKeyPem, { protocolVersion: 1 })
      expect(result.ok).toBe(true)
      expect(result.declaration?.level).toBe(level)
      expect(result.advice).toContain(level === 'core' ? '停' : '可用')
    }
  })
  it('rejects unsigned, tampered, malformed or protocol-incompatible declarations', () => {
    const genuine = signed(declaration())
    expect(evaluate(genuine.text, genuine.signature, publicKeyPem, { protocolVersion: 1 }).ok).toBe(true)
    const tamperedText = JSON.stringify({ ...declaration(), notes: 'Tampered notes' })
    expect(evaluate(tamperedText, genuine.signature, publicKeyPem, { protocolVersion: 1 }).error).toBe('COMPAT_SIGNATURE_INVALID')
    const foreign = generateKeyPairSync('ed25519')
    const forged = sign(null, Buffer.from(genuine.text, 'utf8'),
      createPrivateKey(foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).toString('hex')
    expect(evaluate(genuine.text, forged, publicKeyPem, { protocolVersion: 1 }).error).toBe('COMPAT_SIGNATURE_INVALID')
    const versionBumped = signed({ ...declaration(), version: 2 as unknown as 1 })
    expect(evaluate(versionBumped.text, versionBumped.signature, publicKeyPem, { protocolVersion: 1 }).error).toBe('COMPAT_MANIFEST_VERSION_UNSUPPORTED')
    const protocol = signed(declaration({ minProtocol: 2 }))
    expect(evaluate(protocol.text, protocol.signature, publicKeyPem, { protocolVersion: 1 }).error).toBe('COMPAT_PROTOCOL_INCOMPATIBLE')
    const unknown = signed(declaration({ level: 'capability', disabledCapabilities: ['local.files.execute'] }))
    expect(evaluate(unknown.text, unknown.signature, publicKeyPem, { protocolVersion: 1 }).error).toBe('COMPAT_MANIFEST_CAPABILITY_INVALID')
  })
  it('stops only the declared work and never grants anything', () => {
    const capability = declaration({ level: 'capability', disabledCapabilities: ['local.python'] })
    const core = declaration({ level: 'core' })
    expect(blocksLocalTask(null, { action: 'send' })).toBe(false)
    expect(blocksLocalTask(capability, { action: 'send', capability: 'local.python' })).toBe(true)
    expect(blocksLocalTask(capability, { action: 'send', capability: 'local.files.write' })).toBe(false)
    expect(blocksLocalTask(capability, { action: 'consent', capability: 'local.python' })).toBe(false)
    expect(blocksLocalTask(capability, { action: 'open' })).toBe(false)
    // Core incompatibility stops creating and dispatching, but reads, history,
    // consents, stops and receipts stay available.
    for (const action of ['create', 'send', 'upload']) expect(blocksLocalTask(core, { action })).toBe(true)
    for (const action of ['state', 'refresh', 'open', 'reconnect', 'stop', 'answer', 'consent']) {
      expect(blocksLocalTask(core, { action })).toBe(false)
    }
  })
  it('keeps protocol and combination refusals as effective core gates', () => {
    const current = { protocolVersion: 1, desktopVersion: '0.2.0', runtimePython: '3.12.10', serverVersion: '3e728cd6a' }
    const protocol = signed(declaration({ minProtocol: 2 }))
    const refused = evaluate(protocol.text, protocol.signature, publicKeyPem, current)
    expect(refused.error).toBe('COMPAT_PROTOCOL_INCOMPATIBLE')
    expect(refused.declaration?.level).toBe('core')
    const genuine = signed(declaration())
    const wrong = evaluate(genuine.text, genuine.signature, publicKeyPem, { ...current, desktopVersion: '9.9.9' })
    expect(wrong.error).toBe('COMPAT_COMBINATION_UNSUPPORTED')
    expect(wrong.declaration?.level).toBe('core')
  })
  it('reads the controlled address with honest failures', async () => {
    await expect(checkCompatibility('https://server.invalid/path?x=1', publicKeyPem, { protocolVersion: 1 })).rejects.toThrow('COMPAT_ORIGIN_INVALID')
    await expect(checkCompatibility('http://127.0.0.1:9', publicKeyPem, { protocolVersion: 1 })).rejects.toThrow()
    const server = createServer((request, response) => {
      const { text, signature } = signed(declaration({ level: 'capability', disabledCapabilities: ['local.python'] }))
      response.setHeader('Content-Type', 'application/json')
      response.end(request.url?.endsWith('.sig') ? signature : text)
    })
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No fixture listener')
    const result = await checkCompatibility(`http://127.0.0.1:${address.port}`, publicKeyPem, { protocolVersion: 1 })
    expect(result.ok).toBe(true)
    expect(result.declaration?.level).toBe('capability')
    server.close()
  })
})
