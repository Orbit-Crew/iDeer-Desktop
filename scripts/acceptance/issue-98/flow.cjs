const {spawn, spawnSync} = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const net = require('node:net')
const desktop = path.resolve(__dirname, '../../..')
const root = path.resolve(process.env.IDEER_T98_SERVER_ROOT || path.join(desktop,'artifacts/issue-98/server'))
const {chromium} = require(path.join(root, 'frontend/node_modules/@playwright/test'))
const state = path.resolve(process.env.IDEER_T98_EVIDENCE_DIR || path.join(root,'dev-log/live-98'))
const profile = path.join(state, 'runtime-profile-' + Date.now())
fs.mkdirSync(profile, {recursive:true})
const origin = 'http://127.0.0.1:21980'
const statuses = []
let runtime, browser, snapshot, browserUrl, stdout = '', proxy
const nginx=path.join(desktop,'.cache/nginx-1.31.7/nginx.exe')
const conf=path.join(state,'nginx.conf').replaceAll('\\','/')
const normalized = value => value.replaceAll('\\','/').toLowerCase()
const systemConhost=path.join(process.env.SystemRoot || 'C:\\Windows','System32','conhost.exe')
const records = {startedAt:new Date().toISOString(), origin, scenarios:[], profile}
function proxySnapshot(masterPid) {
  assert(Number.isSafeInteger(masterPid) && masterPid > 0)
  const read = spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command',
    `$ErrorActionPreference='Stop'; $owned = @(Get-CimInstance Win32_Process -Filter "ProcessId = ${masterPid} OR ParentProcessId = ${masterPid}" | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine,CreationDate); ConvertTo-Json -Compress -InputObject $owned`],
    {windowsHide:true,encoding:'utf8'})
  assert.equal(read.status,0,'Cannot inspect acceptance proxy ownership: '+read.stderr)
  const tree=JSON.parse(read.stdout.trim().replace(/^\uFEFF/,''))
  for(const process of tree) {
    assert(process.ProcessId===masterPid || process.ParentProcessId===masterPid,'Unexpected proxy tree')
    const image=normalized(process.ExecutablePath || '')
    const ownedConhost=process.ProcessId!==masterPid && process.ParentProcessId===masterPid && image===normalized(systemConhost)
    if(ownedConhost) {
      // Windows may attach its console host directly to this exact master.
      // Keep it in the recorded tree; no other conhost or image is allowed.
      process.acceptanceRole='owned-system-console-host'
      continue
    }
    assert.equal(image,normalized(nginx),'Unexpected proxy executable')
    assert(normalized(process.CommandLine || '').includes(normalized(conf)),'Unexpected proxy configuration')
    process.acceptanceRole=process.ProcessId===masterPid?'nginx-master':'nginx-worker'
  }
  return tree
}
function stopOwnedProxy(masterPid, requireMaster=true) {
  const tree=proxySnapshot(masterPid)
  const master=tree.find(process=>process.ProcessId===masterPid)
  if(requireMaster) assert(master,'Recorded acceptance proxy master is no longer alive')
  // Windows nginx signals may leave an older worker serving upgraded sockets.
  // Kill only the verified fixture tree, and fail if the port still responds.
  const targets=master ? [masterPid] : tree.map(process=>process.ProcessId)
  for(const pid of targets) {
    const killed=spawnSync('taskkill',['/PID',String(pid),'/T','/F'],{windowsHide:true,encoding:'utf8'})
    assert.equal(killed.status,0,'Cannot terminate owned acceptance proxy tree: '+killed.stderr)
  }
  return tree
}
function publicPortConnects() {
  return new Promise(resolve=>{
    const socket=net.createConnection({host:'127.0.0.1',port:21980})
    const finish=value=>{socket.destroy();resolve(value)}
    socket.once('connect',()=>finish(true))
    socket.once('error',()=>finish(false))
    socket.setTimeout(1000,()=>finish(false))
  })
}
function launchRuntime() {
  snapshot = undefined
  const entry=process.env.IDEER_T98_NETWORK_GUARD==='1' ? [path.join(__dirname,'network_guard.py')] : ['-m','core.desktop']
  runtime = spawn(path.join(desktop,'.runtime/python.exe'), ['-I','-u',...entry,'--config',path.join(profile,'settings.json')],
    {cwd:path.join(desktop,'.runtime'), windowsHide:true, stdio:'pipe'})
  runtime.stdout.on('data', data => {
    stdout += data.toString()
    let index
    while((index=stdout.indexOf('\n'))>=0) {
      const value=JSON.parse(stdout.slice(0,index));stdout=stdout.slice(index+1)
      assert(!/session_token|business_token|PRIVATE KEY/.test(JSON.stringify(value)))
      snapshot=value
      if(value.browserUrl) browserUrl=value.browserUrl
      const last=statuses.at(-1)
      if(!last || last.connection!==value.connection || last.login?.state!==value.login?.state)
        statuses.push({connection:value.connection,login:value.login})
    }
  })
  runtime.stderr.on('data',()=>{})
  runtime.on('error',()=>{})
}
async function wait(predicate, timeout=30000) {
  const deadline=Date.now()+timeout
  while(Date.now()<deadline) {if(await predicate())return;await new Promise(r=>setTimeout(r,100))}
  throw new Error('Acceptance timeout; last redacted status '+JSON.stringify(snapshot))
}
async function stopRuntime() {
  if(!runtime || runtime.exitCode!==null)return
  const child=runtime
  const closed=new Promise(r=>child.once('close',r))
  child.stdin.end('{"type":"shutdown"}\n')
  await Promise.race([closed,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Runtime exit timeout')),15000))])
}
async function run() {
  launchRuntime()
  await wait(()=>snapshot?.login?.state==='unauthenticated')
  const name='T98-D1-'+Date.now()
  runtime.stdin.write(JSON.stringify({type:'login',serverUrl:origin,deviceName:name})+'\n')
  await wait(()=>browserUrl)
  assert.equal(snapshot.login.state,'awaiting-confirmation')
  assert.notEqual(snapshot.connection,'connected')
  const url=new URL(browserUrl)
  assert.equal(url.origin,origin)
  assert.deepEqual([...url.searchParams.keys()],['login_id'])
  browser=await chromium.launch({headless:true})
  const page=await browser.newPage({viewport:{width:1100,height:850}})
  page.on('pageerror',()=>{})
  await page.goto(browserUrl,{timeout:120000})
  await page.locator('input[type=email]').waitFor({timeout:120000})
  await page.locator('input[type=email]').fill('user98a@test.com')
  await page.locator('input[type=password]').fill('user98a@test.com')
  await page.locator('button[type=submit]').click()
  await page.getByRole('heading',{name:'绑定 iDeer Desktop'}).waitFor({timeout:120000})
  await page.getByText('设备：'+name,{exact:true}).waitFor({timeout:30000})
  assert.equal(snapshot.login.state,'awaiting-confirmation')
  assert.notEqual(snapshot.connection,'connected')
  const verification=snapshot.login.verification
  assert.match(verification,/^[a-f0-9]{12}$/)
  assert.equal(await page.locator('code').textContent(),verification)
  await page.screenshot({path:path.join(state,'browser-confirmation.png')})
  await page.getByRole('checkbox').check()
  await page.getByRole('button',{name:'确认绑定本人设备'}).click()
  await page.getByRole('status').filter({hasText:'本人设备已确认'}).waitFor({timeout:30000})
  await wait(()=>snapshot?.login?.state==='authenticated' && snapshot.connection==='connected',45000)
  await page.screenshot({path:path.join(state,'browser-completed.png')})
  const account=await (await page.request.get(origin+'/api/v1/auth/me')).json()
  const settings=JSON.parse(fs.readFileSync(path.join(profile,'settings.json'),'utf8'))
  assert.equal(settings.user_id,account.id)
  assert.equal(settings.device_name,name)
  assert.equal(settings.server_url,origin)
  assert.equal(settings.session_token,'')
  assert(settings.session_token_ref && settings.business_token_ref && settings.device_key_ref)
  assert.notEqual(settings.session_token_ref,settings.business_token_ref)
  const devices=await(await page.request.get(origin+'/api/devices')).json()
  assert(devices.some(d=>d.id===settings.device_id && d.owner_id===account.id && d.status==='online'))
  records.scenarios.push({id:'T98-01',result:'passed',checks:['real-browser-account-login','explicit-owner-confirmation','fingerprint-match','no-session-before-completion','OS-credential-refs','signed-WS-online']})
  await stopRuntime()
  launchRuntime()
  await wait(()=>snapshot?.login?.state==='authenticated' && snapshot.connection==='connected',45000)
  records.scenarios.push({id:'T98-03',result:'passed',checks:['no-credential-in-browser-url-or-stdio','no-plaintext-token-in-settings','business-device-refs-separate','real-OS-storage-restart']})
  const rejected=await new Promise((resolve,reject)=>{
    const socket=new WebSocket(origin.replace('http:','ws:')+'/api/devices/ws')
    socket.onopen=()=>socket.send('{}')
    socket.onclose=event=>resolve(event.code)
    socket.onerror=()=>{}
    setTimeout(()=>reject(new Error('Unauthenticated WS rejection timeout')),10000).unref()
  })
  assert.equal(rejected,4003)
  records.scenarios.push({id:'T98-02',result:'incomplete',checks:['unauthenticated-real-WebSocket-rejected-4003']})
  const prefix=path.dirname(nginx).replaceAll('\\','/')+'/'
  const manifest=JSON.parse(fs.readFileSync(path.join(state,'manifest.json'),'utf8'))
  assert.equal(manifest.public,origin)
  const masterPid=manifest.pids.at(-1)
  assert(await publicPortConnects(),'Public entry must be available before the injected cut')
  records.proxyCut={masterPid,tree:stopOwnedProxy(masterPid)}
  await wait(async()=>!(await publicPortConnects()),10000)
  records.proxyCut.publicPortClosed=true
  await wait(()=>snapshot.connection!=='connected',30000)
  records.disconnected=snapshot.connection
  proxy=spawn(nginx,['-p',prefix,'-c',conf,'-g','daemon off;'],{cwd:path.dirname(nginx),windowsHide:true,stdio:'ignore'})
  await wait(()=>snapshot.connection==='connected',45000)
  records.proxyRestored={masterPid:proxy.pid,tree:proxySnapshot(proxy.pid)}
  records.scenarios.push({id:'T98-04',result:process.env.IDEER_T98_NETWORK_GUARD==='1'?'passed':'incomplete',checks:['canonical-nginx-WS-location','real-proxy-stop-drops-connection','real-proxy-restart-reconnects'],directGatewayIsolation:process.env.IDEER_T98_NETWORK_GUARD==='1'?'socket-boundary-fault-injection-blocks-all-other-ports':'unexecuted'})
  records.statuses=statuses
  records.finishedAt=new Date().toISOString()
  fs.writeFileSync(path.join(state,'cross-repo-result.json'),JSON.stringify(records,null,2))
  console.log(JSON.stringify({scenarios:records.scenarios,statuses,output:path.join(state,'cross-repo-result.json')},null,2))
}
run().catch(error=>{console.error(error.message);process.exitCode=1}).finally(async()=>{
  await browser?.close()
  await stopRuntime().catch(()=>runtime?.kill())
  if(proxy?.pid) {
    try {
      stopOwnedProxy(proxy.pid,false)
      await wait(async()=>!(await publicPortConnects()),10000)
      records.cleanup={proxyTreeExited:true,publicPortClosed:true}
      fs.writeFileSync(path.join(state,'cross-repo-result.json'),JSON.stringify(records,null,2))
    }
    catch(error) { console.error('Owned proxy cleanup failed: '+error.message);process.exitCode=1 }
  }
  // OS secrets remain until the root performs the scoped cleanup/restart check.
})
