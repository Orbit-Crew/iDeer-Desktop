// Human performs browser credentials and device confirmation; then real model/history.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module')
const entry=path.join(__dirname,'provider.cjs');let source=fs.readFileSync(entry,'utf8')
function replace(before,after){if(source.split(before).length!==2)throw Error('Manual composition seam changed');source=source.replace(before,after)}
replace("const deadline=Date.now()+180000", "const deadline=Date.now()+1800000")
replace("const status=await page.evaluate(()=>window.ideer.getStatus()),login=status.runtime.login", `
  const browserUrl=await app.evaluate(()=>globalThis.t111ExternalUrl||'');
  if(browserUrl&&evidence.openedBrowserUrl!==browserUrl){
   const origin=JSON.parse(fs.readFileSync(path.join(state,'../public.json'))).origin;
   assert.equal(new URL(browserUrl).origin,origin);assert.equal(new URL(browserUrl).pathname,'/desktop-login');
   require('node:child_process').spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ['--user-data-dir='+path.join(state,'isolated-browser'),'--no-first-run','--no-default-browser-check',browserUrl],{detached:true,stdio:'ignore'}).unref();
   evidence.openedBrowserUrl=browserUrl;evidence.browserIsolation='New Edge --user-data-dir; shell.openExternal launch adapter only, actual Next/Gateway authentication untouched';save();
  }
  const status=await page.evaluate(()=>window.ideer.getStatus()),login=status.runtime.login`)
replace("page=await app.firstWindow();", "await app.evaluate(({shell})=>{shell.openExternal=async url=>{globalThis.t111ExternalUrl=url}});page=await app.firstWindow();")
replace("authentication:'Synthetic account through actual public login/device pairing APIs and Windows credential store; automated restore, no human login or signoff claim.'", "authentication:'Human browser login and device confirmation requested by the user; no API-prepared sessions. Automatic model/history checks follow observed login; final report signoff remains separate.'")
replace("fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,fs.readFileSync(manifest.identities.A.profile),{flag:'wx'})", "fs.mkdirSync(path.dirname(config),{recursive:true});assert(!fs.existsSync(config),'Fresh unauthenticated profile required')")
replace("await page.waitForFunction(()=>!!window.ideer)", `await page.waitForFunction(()=>!!window.ideer)
 if(!evidence.humanAuthenticatedAt){
  const first=await page.evaluate(()=>window.ideer.getStatus());assert.notEqual(first.runtime.login?.state,'authenticated')
  await page.getByRole('textbox',{name:'平台统一入口',exact:true}).fill(JSON.parse(fs.readFileSync(path.join(state,'../public.json'))).origin)
  await page.getByRole('textbox',{name:'设备名称',exact:true}).fill('T111 Human 15aa')
  await page.screenshot({path:path.join(state,'human-ready.png'),fullPage:true})
  fs.writeFileSync(path.join(state,'human-ready.json'),JSON.stringify({ready:true,profile,initialLogin:first.runtime.login||null}))
 }`)
replace("const a=await launch();", `const a=await launch();
 evidence.humanAuthenticatedAt=new Date().toISOString();manifest.identities.A.profile=config;
 fs.writeFileSync(path.join(state,'ready.json'),JSON.stringify(manifest,null,2));
 await page.screenshot({path:path.join(state,'human-authenticated.png'),fullPage:true});save();`)
replace("helper('negative');evidence.resourceRejections=JSON.parse(fs.readFileSync(path.join(state,'negative-api.json'),'utf8'))", "evidence.resourceRejections='Covered independently by recheck-provider-paired and identity matrix; this run starts without any prepared business/device session.'")
replace("const file=action==='cleanup'?'issue-102/profiles.py':'issue-99/provider_profiles.py'", "const file=action==='cleanup'?'issue-111/manual-profile.py':'issue-99/provider_profiles.py'")
const composed=new Module(entry,module);composed.filename=entry;composed.paths=module.paths;composed._compile(source,entry)
