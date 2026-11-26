// Local UI preview only. No hardware, production credentials, or public binding.
const http=require('node:http');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const {createApp}=require('./server.cjs');
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'parking-ui-preview-'));
const password=process.env.PREVIEW_ADMIN_PASSWORD||'123456';
const deviceKey=crypto.randomBytes(32).toString('hex');
const {handler}=createApp({deviceKey,password,dataDir,secure:false});
const banner='<div class="notice warning" role="note"><strong>本机效果预览 · 模拟数据</strong><br>不连接真实硬件。控灯按钮仅改变模拟灯状态。</div>';
const server=http.createServer((req,res)=>{
 const route=req.url.split('?')[0];
 if(req.method==='GET'&&['/','/admin','/admin/'].includes(route)){
  const file=route==='/'?'index.html':'admin.html';
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  return res.end(fs.readFileSync(path.join(__dirname,'public',file),'utf8').replace('<main>','<main>'+banner));
 }
 return handler(req,res);
});
let control={id:0,facility:0,light:[0,0],guide:[0,0]},timer,base;
async function report(){
 const bays=['P1','P2'].map((bay_id,i)=>({bay_id,distance_cm:i===0?25:7,occupancy:i===0?'free':'occupied',
  brightness_pct:control.facility===2?0:control.facility===1||control.light[i]===1?100:control.light[i]===2?0:20,
  guide_on:control.facility===2?false:control.guide[i]===1?true:control.guide[i]===2?false:i===0,
  light_mode:control.light[i],guide_mode:control.guide[i]}));
 try{
  const res=await fetch(base+'/api/device/state',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':deviceKey},body:JSON.stringify({protocol:3,ack_id:control.id,facility:control.facility,bays}),signal:AbortSignal.timeout(2000)});
  const command=res.headers.get('x-parking-command');await res.text();
  if(res.ok&&command){const [v,id,facility,l0,g0,l1,g1]=command.split(',').map(Number);if(v===3)control={id,facility,light:[l0,l1],guide:[g0,g1]};}
 }catch{console.error('Preview update failed');}
 timer=setTimeout(report,800);
}
server.listen(Number(process.env.PREVIEW_PORT||3037),'127.0.0.1',async()=>{
 base=`http://127.0.0.1:${server.address().port}`;await report();
 console.log(`Local simulated preview: ${base}`);console.log(`Admin page: ${base}/admin`);
});
function stop(){clearTimeout(timer);server.close(()=>{fs.rmSync(dataDir,{recursive:true,force:true});process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
