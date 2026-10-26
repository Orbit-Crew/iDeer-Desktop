// One actual external-model turn, published Agent/Skill selection and history.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto')
const {spawnSync}=require('node:child_process'),{_electron}=require('playwright-core')
const root=path.resolve(__dirname,'../../..'),state=path.resolve(process.argv[2]),installed=process.env.DESKTOP_EXECUTABLE
assert(installed&&path.isAbsolute(installed));const manifest=JSON.parse(fs.readFileSync(path.join(state,'ready.json'),'utf8'));assert.equal(manifest.realProvider,true)
const runtime=path.join(path.dirname(installed),'resources/runtime'),profile=path.join(state,'provider-user-data'),config=path.join(profile,'Runtime/settings.json')
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),marker='IDEER_T111_REAL_'+crypto.randomUUID().replaceAll('-','')
const evidence={startedAt:new Date().toISOString(),status:'incomplete',realProvider:true,model:manifest.model,marker,
 candidate:{serverHead:manifest.serverCandidate,serverSourceSHA256:manifest.serverSourceSHA256,executableSHA256:hash(installed),asarSHA256:hash(path.join(path.dirname(installed),'resources/app.asar')),runtimePythonSHA256:hash(path.join(runtime,'python.exe')),driverSHA256:hash(__filename)},
 authentication:'Synthetic account through actual public login/device pairing APIs and Windows credential store; automated restore, no human login or signoff claim.'}
const save=()=>fs.writeFileSync(path.join(state,'provider-result.json'),JSON.stringify(evidence,null,2))
const pause=ms=>new Promise(r=>setTimeout(r,ms));let app,page
async function wait(fn,label){const deadline=Date.now()+180000;while(Date.now()<deadline){if(await fn())return;await pause(100)}throw Error('Timeout: '+label)}
function helper(action){const file=action==='cleanup'?'issue-102/profiles.py':'issue-99/provider_profiles.py';const r=spawnSync(path.join(runtime,'python.exe'),['-I',path.join(root,'scripts/acceptance',file),action,state],{windowsHide:true,encoding:'utf8',timeout:60000});assert.equal(r.status,0,'profile helper '+action+': '+r.stderr)}
const snapshot=()=>page.evaluate(()=>window.ideer.chat({action:'state'}))
async function launch(){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 app=await _electron.launch({executablePath:installed,args:['--user-data-dir='+profile],env,timeout:45000});page=await app.firstWindow();await page.waitForFunction(()=>!!window.ideer)
 await wait(async()=>{
  const status=await page.evaluate(()=>window.ideer.getStatus()),login=status.runtime.login
  const observations=evidence.loginObservations||(evidence.loginObservations=[])
  const row={process:status.runtime.process,login:login||null}
  if(JSON.stringify(observations.at(-1))!==JSON.stringify(row)){observations.push(row);save()}
  if(login?.state==='error')throw Error('Actual login restore failed: '+login.error)
  return login?.state==='authenticated'
 },'actual OS-stored business session restored')
 await wait(async()=>!!(await snapshot()).scope,'business scope');const r=await page.evaluate(()=>window.ideer.chat({action:'refresh'}));assert.equal(r.error,'');return r
}
async function quit(){if(!app)return;const closed=app.waitForEvent('close',{timeout:30000});await page.evaluate(()=>window.ideer.quit());await closed;app=null}
async function main(){
 fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,fs.readFileSync(manifest.identities.A.profile),{flag:'wx'})
 const a=await launch();assert(a.resources.some(r=>r.id===manifest.agentId&&r.available));assert(a.resources.some(r=>r.id===manifest.skillId&&r.available))
 helper('negative');evidence.resourceRejections=JSON.parse(fs.readFileSync(path.join(state,'negative-api.json'),'utf8'))
 await page.locator('.ant-select[aria-label="选择 Agent"]').click();await page.locator('.ant-select-item-option').filter({hasText:'t99-real-expert'}).click()
 await page.locator('.ant-select[aria-label="选择 Skill"]').click();await page.locator('.ant-select-item-option').filter({hasText:'t99-real-skill'}).click()
 await page.getByRole('button',{name:'新建平台聊天',exact:true}).click();await wait(async()=>!!(await snapshot()).thread,'actual UI creates Thread')
 const created=await snapshot();assert.equal(created.error,'');const thread=created.thread.id
 await page.getByRole('textbox',{name:'聊天消息',exact:true}).fill('Reply with '+marker+' and the selected Skill marker IDEER_T99_SKILL_V1. Use no tools. This is a synthetic acceptance marker.')
 await page.getByRole('button',{name:/^发\s*送$/}).click()
 let final,sawStreaming=false
 await wait(async()=>{final=await snapshot();if(final.stream==='streaming')sawStreaming=true;return !!final.run&&!['pending','running'].includes(final.run.status)&&final.stream!=='streaming'},'actual external model terminal Run')
 assert.equal(final.error,'');assert.equal(final.run.status,'success');assert(final.messages.some(m=>m.role==='ai'&&m.text.includes(marker)&&m.text.includes('IDEER_T99_SKILL_V1')))
 assert.equal(final.run.selection.agent.resource_id,manifest.agentId);assert.equal(final.run.selection.preferred_skill.resource_id,manifest.skillId)
 assert(final.events.some(e=>/^messages/.test(e.event)),'actual streamed model message events')
 evidence.threadID=thread;evidence.runID=final.run.id;evidence.streamingObserved=sawStreaming;evidence.events=final.events;evidence.messages=final.messages;evidence.selection=final.run.selection
 evidence.application=await app.evaluate(({app})=>({packaged:app.isPackaged,version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,disableGpu:app.commandLine.hasSwitch('disable-gpu')}))
 await page.screenshot({path:path.join(state,'provider-streamed.png'),fullPage:true});await quit()
 const restored=await launch();const opened=await page.evaluate(c=>window.ideer.chat(c),{action:'open',scope:restored.scope,threadId:thread});assert.equal(opened.error,'');assert.equal(opened.run.id,evidence.runID);assert(opened.messages.some(m=>m.role==='ai'&&m.text.includes(marker)))
 evidence.restored={threadID:opened.thread.id,runID:opened.run.id,messageIDs:opened.messages.map(m=>m.id)}
 await page.screenshot({path:path.join(state,'provider-reopened.png'),fullPage:true});helper('evidence');await quit();evidence.status='passed'
}
save();main().catch(error=>{evidence.status='failed';evidence.error=String(error);evidence.stack=error.stack;process.exitCode=1}).finally(async()=>{try{await quit()}catch(e){evidence.status='failed';evidence.shutdownError=String(e);process.exitCode=1}try{helper('cleanup');evidence.credentialCleanup=JSON.parse(fs.readFileSync(path.join(state,'credential-cleanup.json')))}catch(e){evidence.status='failed';evidence.cleanupError=String(e);process.exitCode=1}fs.writeFileSync(path.join(state,'stop'),'task-owned provider fixture shutdown');evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:evidence.status,state}))})
