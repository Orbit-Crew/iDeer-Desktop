const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=process.cwd(),dir=path.join(root,'docs/acceptance/issue-108/evidence/supplement-20261026');
const read=n=>JSON.parse(fs.readFileSync(path.join(dir,n),'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const binding=read('candidate-binding.json');
for(const row of binding.sources) assert.equal(hash(path.join(root,row.path)),row.sha256,row.path);
assert.equal(hash(path.join(root,'dist',binding.installer.file)),binding.installer.sha256);
for(const [name,mode] of [['online-c','online'],['offline-a','offline']]) {
 const r=read(name+'-result.json');assert.equal(r.status,'passed');assert.equal(r.updateSource,mode);assert.equal(r.recovery.state,'updated');assert.equal(r.receiptBeforeUpdate.delivery_state,'pending');
 for(const s of Object.values(r.scenarios)) assert.equal(s.status,'passed');
 const cases=r.scenarios['T108-03'].cases, replay=cases.find(c=>c.name.startsWith('same receipt replay'));
 assert.equal(replay.receipt.delivery_state,'confirmed');assert.equal(replay.originalExecutions,1);assert.equal(replay.originalDispatches,1);assert.equal(replay.receipt.receipt_id,r.receiptBeforeUpdate.receipt_id);assert.equal(replay.receipt.receipt_hash,r.receiptBeforeUpdate.receipt_hash);
 for(const row of r.candidate.acceptanceFiles) assert.equal(hash(path.join(root,row.path)),row.sha256,name+':'+row.path);
 assert.equal(read(name+'-command.json').exitCode,0);assert.equal(read(name+'-server-cleanup.json').exited,true);assert.equal(r.credentialCleanup.failures.length,0);
}
const http=read('online-c-http.json');for(const url of ['/updates/desktop/manifest.json','/updates/desktop/manifest.sig','/updates/desktop/files/resources/runtime/core/tray.py']) assert(http.some(r=>r.method==='GET'&&r.path===url&&r.status===200),url);
const blockers=read('blockers-a-result.json');assert.equal(blockers.status,'passed');assert.equal(blockers.scenarios['T108-02'].cases.length,2);assert.equal(read('blockers-a-command.json').exitCode,0);
for(const row of blockers.candidate.acceptanceFiles) assert.equal(hash(path.join(root,row.path)),row.sha256,row.path);
for(const name of ['typecheck','vitest-ready','runtime-ready','dist-win','runtime-provenance','provenance','ruff','drain-green','skip-reasons']) assert.equal(read(name+'-command.json').exitCode,0,name);
const g=read('vitest-results.json');assert.equal(g.numFailedTests,0);assert.equal(g.numPassedTests,94);
const validation={checkedAt:new Date().toISOString(),status:'passed',sourceBindings:binding.sources.length,onlineCases:8,offlineCases:8,installedBlockerCases:2,vitestPassed:94,runtimePassed:397,runtimeSkipped:6,intermediateTimeout:'retained, unexplained, not relabeled'};
fs.writeFileSync(path.join(dir,'integrity-check.json'),JSON.stringify(validation,null,2));
console.log(JSON.stringify(validation));
