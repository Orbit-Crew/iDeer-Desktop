// Real NSIS install/uninstall/reinstall, actual isolated Desktop and Runtime.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {spawnSync}=require('node:child_process'),{_electron}=require('playwright-core')
const {nsisInvocation}=require('../../../resources/nsis/command.cjs')
const [installer,output]=process.argv.slice(2)
assert(path.isAbsolute(installer)&&path.isAbsolute(output))
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'ideer111-lifecycle-')),program=path.join(fixture,'installed'),profile=path.join(fixture,'profile')
const executable=path.join(program,'ideer-desktop.exe'),uninstaller=path.join(program,'Uninstall ideer-desktop.exe')
fs.mkdirSync(profile);fs.mkdirSync(path.dirname(output),{recursive:true})
const sha=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const canary=path.join(profile,'current-user-data.txt');fs.writeFileSync(canary,'T111-CURRENT-DATA-RETAINED')
const expected=sha(canary),evidence={startedAt:new Date().toISOString(),fixture,installerSHA256:sha(installer),driverSHA256:sha(__filename),canarySHA256:expected,steps:[]}
const save=()=>fs.writeFileSync(output,JSON.stringify(evidence,null,2))
const pause=ms=>new Promise(r=>setTimeout(r,ms)),alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
async function wait(fn,label){const deadline=Date.now()+90000;while(Date.now()<deadline){if(await fn())return;await pause(100)}throw Error('Timeout: '+label)}
let app
function install(){const call=nsisInvocation(installer,program),r=spawnSync(call.file,call.args,{...call.options,timeout:120000});assert.equal(r.status,0);assert(fs.existsSync(executable));evidence.steps.push({step:'install',exitCode:r.status,executableSHA256:sha(executable),asarSHA256:sha(path.join(program,'resources/app.asar'))});save()}
async function uninstall(){const r=spawnSync(uninstaller,['/S'],{windowsHide:true,timeout:120000});assert.equal(r.status,0);await wait(()=>!fs.existsSync(executable),'uninstall removes actual executable');assert.equal(sha(canary),expected);evidence.steps.push({step:'uninstall',exitCode:r.status,dataRetained:true});save()}
async function launch(closeViaWindow){
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 app=await _electron.launch({executablePath:executable,args:['--user-data-dir='+profile],env,timeout:45000})
 const page=await app.firstWindow();await page.waitForFunction(()=>!!window.ideer)
 let status;await wait(async()=>{status=await page.evaluate(()=>window.ideer.getStatus());return status.runtime.process==='running'},'actual bundled Runtime starts')
 const meta=await app.evaluate(({app,BrowserWindow})=>({packaged:app.isPackaged,version:app.getVersion(),electron:process.versions.electron,node:process.versions.node,disableGpu:app.commandLine.hasSwitch('disable-gpu'),gpu:app.getGPUFeatureStatus(),preferences:BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()}))
 assert(meta.packaged);assert.equal(meta.version,'0.2.0');assert.equal(meta.electron,'22.3.27');assert(meta.disableGpu)
 assert.equal(meta.preferences.sandbox,true);assert.equal(meta.preferences.contextIsolation,true);assert.equal(meta.preferences.nodeIntegration,false)
 const renderer=await page.evaluate(()=>({require:typeof require,process:typeof process,bridge:typeof window.ideer.getStatus}));assert.equal(renderer.require,'undefined');assert.equal(renderer.process,'undefined');assert.equal(renderer.bridge,'function')
 await page.screenshot({path:output.replace(/\.json$/,closeViaWindow?'-reinstalled.png':'-installed.png'),fullPage:true})
 const pid=status.runtime.pid,closed=app.waitForEvent('close',{timeout:30000})
 if(closeViaWindow)await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
 else await page.evaluate(()=>window.ideer.quit())
 await closed;app=null;if(pid)await wait(()=>!alive(pid),'owned Runtime exits with actual Desktop')
 assert.equal(sha(canary),expected);evidence.steps.push({step:closeViaWindow?'reinstalled-native-close':'installed-ui-quit',metadata:meta,renderer,runtimePID:pid||null,runtimeExited:true,dataRetained:true});save()
}
async function main(){install();await launch(false);await uninstall();install();assert.equal(sha(canary),expected);await launch(true);await uninstall();evidence.status='passed'}
main().catch(error=>{evidence.status='failed';evidence.error=String(error);evidence.stack=error.stack;process.exitCode=1}).finally(async()=>{if(app){try{await app.close()}catch{}}evidence.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:evidence.status,output}))})
