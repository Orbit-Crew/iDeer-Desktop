// Raw TCP forwarding only. Browser and Runtime use the same real Next origin.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net'),assert=require('node:assert/strict')
const state=path.resolve(process.argv[2]);assert(state.includes('artifacts'));fs.mkdirSync(state,{recursive:true})
const sockets=new Set(),server=net.createServer(local=>{
 const file=path.join(state,'desktop/frontend-target.json');if(!fs.existsSync(file)){local.destroy();return}
 const target=JSON.parse(fs.readFileSync(file));assert(/^172\./.test(target.host));assert.equal(target.port,13112)
 const remote=net.connect(target.port,target.host);sockets.add(local);sockets.add(remote)
 local.on('error',()=>remote.destroy());remote.on('error',()=>local.destroy())
 local.on('close',()=>{sockets.delete(local);remote.destroy()});remote.on('close',()=>{sockets.delete(remote);local.destroy()});local.pipe(remote);remote.pipe(local)
})
server.listen(Number(process.argv[3]||0),'127.0.0.1',()=>fs.writeFileSync(path.join(state,'public.json'),JSON.stringify({origin:'http://127.0.0.1:'+server.address().port})))
const timer=setInterval(()=>{if(!fs.existsSync(path.join(state,'stop')))return;clearInterval(timer);for(const socket of sockets)socket.destroy();server.close(()=>fs.writeFileSync(path.join(state,'proxy-cleanup.json'),JSON.stringify({closed:true,remainingSockets:sockets.size})))},200)
