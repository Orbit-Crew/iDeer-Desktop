// Run from the checkout. --archive-only does not verify its original installer.
// --allow-pending permits inspection of a draft, never a phase-pass verdict.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),assert=require('node:assert/strict')
const read=name=>JSON.parse(name.endsWith('.gz')?zlib.gunzipSync(fs.readFileSync(path.join(__dirname,name))).toString('utf8'):fs.readFileSync(path.join(__dirname,name),'utf8'))
const sha=data=>crypto.createHash('sha256').update(data).digest('hex'),fileSha=file=>sha(fs.readFileSync(file))
const binding=read('candidate-binding.json'),archiveOnly=process.argv.includes('--archive-only'),allowPending=process.argv.includes('--allow-pending')
if(!archiveOnly){
 const installer=path.join(process.cwd(),'dist',binding.installer.name);assert.equal(fileSha(installer),binding.installer.sha256);assert.equal(fs.statSync(installer).size,binding.installer.bytes)
 for(const row of read('desktop-source-binding.json').files)assert.equal(fileSha(row.path),row.sha256,row.path)
 for(const row of binding.drivers)assert.equal(fileSha(row.path),row.sha256,row.path)
}
for(const row of read('archive-map.json').files){
 const stored=fs.readFileSync(path.join(__dirname,row.archive)),data=row.gzip?zlib.gunzipSync(stored):stored
 assert.equal(data.length,row.bytes,row.archive);assert.equal(sha(data),row.originalSHA256,row.archive)
 if(!archiveOnly)assert.equal(fileSha(row.original),row.originalSHA256,row.original)
}
const counts={matrix:15,writes:22,identity:15,artifacts:8,online:8,offline:8,recovery:6}
let cases=0
for(const [mode,expected] of Object.entries(counts)){
 const result=read(mode+'-result.json.gz');assert.equal(result.status,'passed',mode);assert.equal(read(mode+'-command.json').exitCode,0,mode)
 assert.equal(result.candidate.serverSourceSHA256,binding.server.sourceSHA256);assert(binding.server.commits.includes(result.candidate.serverHead))
 if(!archiveOnly)for(const row of result.candidate.acceptanceFiles||[])assert.equal(fileSha(row.path),row.sha256,mode+': '+row.path)
 let count=0
 for(const [id,scenario] of Object.entries(result.scenarios)){
  if(id==='T111-04'){assert.equal(scenario.status,'unexecuted');continue}
  assert.equal(scenario.status,'passed',id);count+=scenario.cases.length
 }
 assert.equal(count,expected,mode);cases+=count
 const cleanup=read(mode+'-credential-cleanup.json');assert(cleanup.removed>0);assert.equal((cleanup.failures||[]).length,0)
 assert.equal(read(mode+'-gateway-cleanup.json').exited,true)
 assert.equal(read(mode+'-server-process-cleanup.json').exitCode,0)
 assert.equal(read(mode+'-proxy-process-cleanup.json').exitCode,0)
 assert.deepEqual(read(mode+'-proxy-cleanup.json'),{closed:true,remainingSockets:0})
}
const recovery=read('recovery-result.json.gz');assert.equal(recovery.recovery.state,'rolled-back');assert.deepEqual(recovery.programAfter,recovery.programBefore)
assert.deepEqual(recovery.currentIdentityAfter,recovery.currentIdentityBefore);assert.equal(recovery.confirmedOriginal.delivery_state,'confirmed');assert(recovery.confirmedOriginal.acknowledgment)
for(const mode of ['online','offline']){
 const result=read(mode+'-result.json.gz');assert.equal(result.recovery.state,'updated');assert(result.usable.windowLoaded&&result.usable.rendererReady&&result.usable.ipcReady&&result.usable.runtimeUnfenced)
 const manifest=fs.readFileSync(path.join(__dirname,mode+'-release-manifest.json')),signature=fs.readFileSync(path.join(__dirname,mode+'-release-manifest.sig'),'utf8').trim()
 assert(crypto.verify(null,manifest,fs.readFileSync(path.join(__dirname,'release-public-key.pem')),Buffer.from(signature,'hex')))
}
const lifecycle=read('lifecycle-result.json');assert.equal(lifecycle.status,'passed');assert.equal(lifecycle.installerSHA256,binding.installer.sha256);assert.equal(lifecycle.steps.length,6);assert.equal(read('lifecycle-command.json').exitCode,0)
for(const step of lifecycle.steps){if(step.metadata){assert(step.metadata.packaged&&step.metadata.disableGpu);assert.equal(step.metadata.version,'0.2.0');assert.equal(step.metadata.electron,'22.3.27');assert(step.metadata.preferences.sandbox&&step.metadata.preferences.contextIsolation);assert.equal(step.metadata.preferences.nodeIntegration,false);assert(step.runtimeExited&&step.dataRetained)}}
const provider=read('provider-provider-result.json.gz');assert.equal(provider.status,'passed');assert(provider.realProvider&&provider.streamingObserved);assert.equal(provider.restored.threadID,provider.threadID);assert.equal(provider.restored.runID,provider.runID);assert.equal(provider.credentialCleanup.failures.length,0);assert.equal(read('provider-command.json').exitCode,0)
const pending=[]
if(fs.existsSync(path.join(__dirname,'server-core-full-final.json'))){assert.equal(read('server-core-full-final.json').exitCode,0);for(const lane of ['core-full','backend-full','frontend-core','frontend-mock-e2e']){const result=read('lane-'+lane+'.json');assert.equal(result.status,0,lane);assert.equal(result.outcome,'passed',lane);assert.equal(result.candidate_commit,binding.server.commits[1])}}
else pending.push('Server full gate')
if(fs.existsSync(path.join(__dirname,'human-command.json'))){const human=read('human-provider-result.json.gz');assert.equal(read('human-command.json').exitCode,0);assert.equal(human.status,'passed');assert(human.humanAuthenticatedAt);assert(human.loginObservations.some(row=>row.login?.state==='awaiting-confirmation'));assert.equal(human.credentialCleanup.removed,3);assert.equal(human.credentialCleanup.failures.length,0);assert.equal(read('human-login-attestation.json').status,'passed');const cleanup=read('human-final-cleanup-check.json');assert.equal(cleanup.installedProcessCount,0);assert.equal(cleanup.activeTcpConnectionCount,0);assert.equal(read('human-server-cleanup.json').gatewayExited,true);assert.equal(read('human-frontend-cleanup.json').exited,true);assert.equal(read('gateway-supervisor-cleanup.json').closed,true)}
else pending.push('human browser login and subsequent model/history')
const signoff=path.join(__dirname,'human-signoff.json');if(fs.existsSync(signoff)){const approval=read('human-signoff.json');assert.equal(approval.status,'passed');assert(approval.reviewer&&approval.recordedAt&&approval.reviewedReportSHA256);assert.equal(approval.reviewedReport,'reviewed-report.txt');assert.equal(fileSha(path.join(__dirname,approval.reviewedReport)),approval.reviewedReportSHA256)}else pending.push('human report signoff')
if(pending.length&&!allowPending)throw Error('Required evidence incomplete: '+pending.join(', '))
console.log(JSON.stringify({status:pending.length?'incomplete':'passed',automaticCaseCount:cases,installerVerified:!archiveOnly,sourceVerified:!archiveOnly,pending}))
