// Default: run from the bound Windows checkout with its local installer.
// --archive-only checks archived assertions/signatures without claiming that
// this machine has checked the original installer or execution-tree bytes.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const assert = require('node:assert/strict')
const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'))
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const binding = read('candidate-binding.json'), archiveOnly = process.argv.includes('--archive-only')
const publicKey = fs.readFileSync(path.join(__dirname, 'release-public-key.pem'))
const fingerprint = crypto.createHash('sha256').update(crypto.createPublicKey(publicKey).export({type:'spki',format:'der'})).digest('hex')
assert.equal(fingerprint, '2836a6c72360fca73c8bbf737a2d789224fdaa4ebf964ec6f53e5676ea7f49db')
if (!archiveOnly) {
  assert.equal(hash(path.join(process.cwd(), 'dist', binding.installer.name)), binding.installer.sha256)
  for (const row of read('desktop-source-binding.json').files) assert.equal(hash(row.path), row.sha256, row.path)
  for (const row of binding.drivers) assert.equal(hash(row.path), row.sha256, row.path)
}
const modes = ['copy-failure','interruption','startup-failure','combination-mismatch','unreadable-format','recovery-failure']
for (const mode of modes) {
  const r = read('final-' + mode + '.json'), command = read('final-' + mode + '-command.json')
  assert.equal(command.exitCode, 0); assert.equal(r.status, 'passed'); assert(!r.cleanupError)
  assert.equal(r.driverSHA256, binding.drivers.find(row => row.path.endsWith('/native.cjs')).sha256)
  assert.equal(r.installerSHA256, binding.installer.sha256)
  assert.deepEqual(r.protectedAfter, r.protectedBefore)
  assert(crypto.verify(null, Buffer.from(JSON.stringify(r.release.manifest)), publicKey, Buffer.from(r.release.signature, 'hex')))
  assert.equal(crypto.createHash('sha256').update(JSON.stringify(r.release.manifest)).digest('hex'), r.release.sha256)
  if (['unreadable-format','recovery-failure'].includes(mode)) {
    assert.equal(r.recovery.state, 'recovery-failed'); assert(r.repeatedHelperStart.journalUnchanged)
    assert(r.recovery.detail.includes('manual repair'))
  } else {
    assert.equal(r.recovery.state, 'rolled-back'); assert.deepEqual(r.programAfter, r.programBefore)
    assert.equal(r.health.echo, 'ideer-update-health-v1')
    assert(r.usable.windowLoaded && r.usable.rendererReady && r.usable.ipcReady && r.usable.runtimeUnfenced)
  }
}
assert.equal(read('unreadable-health-request.json').rollback, false)
const paired = read('paired-result.json'); assert.equal(paired.status, 'passed')
for (const scenario of Object.values(paired.scenarios)) assert.equal(scenario.status, 'passed')
assert.equal(paired.recovery.state, 'rolled-back'); assert.deepEqual(paired.programAfter, paired.programBefore)
assert.deepEqual(paired.currentIdentityAfter, paired.currentIdentityBefore)
const immutable = row => {const {delivery_state, acknowledgment, ...fixed} = row; return fixed}
assert.equal(paired.pendingBefore.delivery_state, 'pending'); assert.equal(paired.pendingAfter.delivery_state, 'pending')
assert.deepEqual(immutable(paired.pendingAfter), immutable(paired.pendingBefore))
assert.equal(paired.confirmedOriginal.delivery_state, 'confirmed'); assert(paired.confirmedOriginal.acknowledgment)
assert.deepEqual(immutable(paired.confirmedOriginal), immutable(paired.pendingBefore))
assert.deepEqual(paired.kb.after, paired.kb.before)
assert([403,404].includes(paired.kb.otherUserBefore.status))
assert.equal(paired.kb.otherUserAfter.status, paired.kb.otherUserBefore.status)
assert.equal(paired.credentialCleanup.removed, 6); assert.equal(paired.credentialCleanup.failures.length, 0)
assert.equal(read('paired-command.json').exitCode, 0)
assert.equal(read('paired-server-process-cleanup.json').exited, true)
assert.equal(read('paired-proxy-process-cleanup.json').exited, true)
assert.equal(read('paired-proxy-cleanup.json').closed, true)
assert.equal(read('paired-proxy-cleanup.json').remainingSockets, 0)
assert.equal(read('server-109-contract.json').exitCode, 0)
assert.equal(read('recovery-contract-command.json').exitCode, 0)
assert.equal(read('recovery-contract-results.json').numPassedTests, 18)
console.log(JSON.stringify({status:'passed',scope:archiveOnly?'archived assertions and signatures':'bound sources, installer, archived assertions and signatures',
  nativeFaults:modes.length,pairedScenarios:4,recoveryTests:18,serverTests:165,installerVerified:!archiveOnly,sourceVerified:!archiveOnly}))
