const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {spawnSync} = require('node:child_process');
const {nsisInvocation} = require(process.cwd() + '/resources/nsis/command.cjs');
const installer = 'C:/Users/Neo/.codex/worktrees/15aa/iDeer-Desktop/dist/ideer-desktop-0.2.0-windows-x64-setup.exe';
const program = fs.mkdtempSync(path.join(os.tmpdir(),'ideer108-'));
const invocation = nsisInvocation(installer,program);
const result = spawnSync(invocation.file,invocation.args,{...invocation.options,encoding:'utf8',timeout:120000});
const evidence = {installer,program,status:result.status,error:result.error?.message,executable:path.join(program,'ideer-desktop.exe')};
fs.writeFileSync(process.argv[2],JSON.stringify(evidence,null,2));
console.log(JSON.stringify(evidence));
if(result.status!==0 || !fs.existsSync(evidence.executable)) process.exitCode=1;

