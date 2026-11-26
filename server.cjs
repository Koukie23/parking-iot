const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');
const FRESH_MS = 5000, OFFLINE_MS = 30000;
const equal = (a,b) => typeof a==='string' && typeof b==='string' &&
  Buffer.byteLength(a)===Buffer.byteLength(b) && crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
const integer = (n,max) => Number.isInteger(n)&&n>=0&&n<=max;
function createApp(options={}) {
  const clock=options.now??Date.now;
  const deviceKey=options.deviceKey??process.env.DEVICE_API_KEY;
  const password=options.password??process.env.ADMIN_PASSWORD;
  const dataDir=options.dataDir??process.env.DATA_DIR??path.join(__dirname,'data');
  const secure=options.secure??process.env.COOKIE_SECURE==='1';
  if(!deviceKey||!password||equal(deviceKey,password))throw new Error('Set separate DEVICE_API_KEY and ADMIN_PASSWORD');
  fs.mkdirSync(dataDir,{recursive:true});
  const storeFile=path.join(dataDir,'control.json');
  let control={id:1,facility:0,light_modes:[0,0],guide_modes:[0,0],created_at:new Date().toISOString()};
  if(fs.existsSync(storeFile)) {
    control=JSON.parse(fs.readFileSync(storeFile,'utf8'));
    if(!integer(control.id,0xffffffff)||control.id===0||!integer(control.facility,2)||
      !['light_modes','guide_modes'].every(k=>Array.isArray(control[k])&&control[k].length===2&&control[k].every(x=>integer(x,2))))
      throw new Error('Invalid persisted controls; restore the control file before starting');
  } else save(control);
  function save(value){const temp=storeFile+'.tmp';fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,storeFile);}
  let telemetry=null,seen=0;
  const sessions=new Map(),attempts=new Map();
  const commandText=()=>[3,control.id,control.facility,control.light_modes[0],control.guide_modes[0],control.light_modes[1],control.guide_modes[1]].join(',');
  function confirmed(){return telemetry&&telemetry.ack_id===control.id&&telemetry.facility===control.facility&&
    telemetry.bays.every((b,i)=>b.light_mode===control.light_modes[i]&&b.guide_mode===control.guide_modes[i]);}
  function status(){
    const age=seen?clock()-seen:null,online=age!==null&&age<OFFLINE_MS,fresh=online&&age<FRESH_MS;
    const applied=Boolean(confirmed());
    const closed=control.facility===2||(online&&telemetry.facility===2);
    const maintenance=control.guide_modes.some(x=>x!==0)||(online&&telemetry.bays.some(b=>b.guide_mode!==0));
    const usable=fresh&&applied&&!closed&&!maintenance;
    const bays=['P1','P2'].map((id,i)=>{
      const b=telemetry?.bays[i];return {bay_id:id,online,fresh,age_ms:age,
        occupancy:fresh?b.occupancy:'unknown',distance_cm:fresh?b.distance_cm:null,
        brightness_pct:online?b.brightness_pct:null,guide_on:online?b.guide_on:null,
        light_mode:online?b.light_mode:null,guide_mode:online?b.guide_mode:null,
        recommended:usable&&b.occupancy==='free'};
    });
    return {total:2,available:usable?bays.filter(b=>b.recommended).length:null,
      operating:closed?'closed':maintenance?'maintenance':!usable?'unconfirmed':'open',
      online,fresh,age_ms:age,last_seen:seen?new Date(seen).toISOString():null,
      command:{id:control.id,status:applied&&online?'confirmed':!online?'waiting_device':clock()-Date.parse(control.created_at)>15000?'delayed':'pending',...control},
      applied_facility:online?telemetry.facility:null,bays};
  }
  function auth(req){
    const token=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('parking_session='))?.slice(16);
    const expires=sessions.get(token);if(!expires||expires<clock()){sessions.delete(token);return false;}return true;
  }
  function validTelemetry(body){
    if(!body||body.protocol!==3||!integer(body.ack_id,0xffffffff)||!integer(body.facility,2)||!Array.isArray(body.bays)||body.bays.length!==2)return false;
    const ids=new Set();
    for(const b of body.bays){
      if(!b||!['P1','P2'].includes(b.bay_id)||ids.has(b.bay_id)||!['unknown','free','occupied'].includes(b.occupancy)||
        !(b.distance_cm===null||(Number.isFinite(b.distance_cm)&&b.distance_cm>=2&&b.distance_cm<=200))||
        !integer(b.brightness_pct,100)||typeof b.guide_on!=='boolean'||!integer(b.light_mode,2)||!integer(b.guide_mode,2))return false;
      ids.add(b.bay_id);
    }return true;
  }
  async function body(req){
    if(!(req.headers['content-type']||'').startsWith('application/json'))throw new Error('JSON_REQUIRED');
    let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>10000)throw new Error('BODY_TOO_LARGE');}
    return JSON.parse(data);
  }
  const handler=async(req,res)=>{
    const send=(code,value,headers={})=>{
      res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(value));
    };
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try{
      const url=new URL(req.url,'http://localhost'),p=url.pathname;
      if(req.method==='GET'&&p==='/healthz')return send(200,{ok:true,protocol:3});
      if(req.method==='GET'&&p==='/api/parking'){
        const s=status();delete s.command;return send(200,s);
      }
      if(req.method==='POST'&&p==='/api/device/state'){
        if(!equal(req.headers['x-device-key'],deviceKey))return send(401,{error:'Invalid device key'});
        const b=await body(req);if(!validTelemetry(b))return send(400,{error:'Expected complete protocol v3 telemetry'});
        telemetry={protocol:3,ack_id:b.ack_id,facility:b.facility,bays:b.bays.slice().sort((a,b)=>a.bay_id.localeCompare(b.bay_id))};
        seen=clock();return send(200,{ok:true,command_id:control.id},{'X-Parking-Command':commandText()});
      }
      // Browser writes require same-origin requests; device authentication is separate.
      if(req.method==='POST'&&p.startsWith('/api/admin/')){
        const origin=req.headers.origin;
        if(origin){let host;try{host=new URL(origin).host;}catch{return send(403,{error:'Invalid origin'});}
          if(host!==req.headers.host)return send(403,{error:'Cross-origin request denied'});}
        if(req.headers['sec-fetch-site']==='cross-site')return send(403,{error:'Cross-origin request denied'});
      }
      if(req.method==='POST'&&p==='/api/admin/login'){
        const ip=req.socket.remoteAddress,now=clock();
        if(attempts.size>1000)for(const [k,v]of attempts)if(v.until<now)attempts.delete(k);
        let entry=attempts.get(ip);if(!entry||entry.until<now)entry={count:0,until:now+60000};
        if(entry.count>=10)return send(429,{error:'尝试过多，请一分钟后重试'});
        const b=await body(req);
        if(!equal(b.password,password)){entry.count++;attempts.set(ip,entry);return send(401,{error:'管理密码错误'});}
        attempts.delete(ip);for(const [t,expiry]of sessions)if(expiry<now)sessions.delete(t);
        if(sessions.size>=1000)return send(503,{error:'会话已满，请稍后重试'});
        const token=crypto.randomBytes(32).toString('hex');sessions.set(token,now+8*3600000);
        return send(200,{ok:true},{'Set-Cookie':`parking_session=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800${secure?'; Secure':''}`});
      }
      if(p.startsWith('/api/admin/')){
        if(!auth(req))return send(401,{error:'请先登录管理员'});
        if(req.method==='POST'&&p==='/api/admin/logout'){
          const token=(req.headers.cookie||'').match(/parking_session=([^;]+)/)?.[1];sessions.delete(token);
          return send(200,{ok:true},{'Set-Cookie':`parking_session=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0${secure?'; Secure':''}`});
        }
        if(req.method==='GET'&&p==='/api/admin/status')return send(200,status());
        if(req.method==='POST'&&p==='/api/admin/control'){
          const b=await body(req);const next=structuredClone(control);
          if(b.target==='facility'&&['auto','on','closed'].includes(b.action)){
            next.facility={auto:0,on:1,closed:2}[b.action];next.light_modes=[0,0];next.guide_modes=[0,0];
          }else if(['P1','P2'].includes(b.bay_id)&&['light','guide'].includes(b.target)&&['auto','on','off'].includes(b.action)){
            if(control.facility!==0)return send(409,{error:'先恢复营业自动，才能单独控制灯'});
            next[b.target==='light'?'light_modes':'guide_modes'][b.bay_id==='P1'?0:1]={auto:0,on:1,off:2}[b.action];
          }else return send(400,{error:'无效控制参数'});
          if(control.id===0xffffffff)return send(503,{error:'指令编号已满，需要维护'});
          next.id++;next.created_at=new Date().toISOString();save(next);control=next;
          return send(202,{ok:true,command:control,status:'pending'});
        }
      }
      if(req.method==='GET'){
        const files={'/':'index.html','/admin':'admin.html','/admin/':'admin.html','/style.css':'style.css','/driver.js':'driver.js','/admin.js':'admin.js'};
        if(files[p]){
          const name=files[p],type=name.endsWith('.html')?'text/html':name.endsWith('.css')?'text/css':'text/javascript';
          res.writeHead(200,{'Content-Type':type+'; charset=utf-8','Cache-Control':'no-store'});
          return res.end(fs.readFileSync(path.join(__dirname,'public',name)));
        }
      }
      send(404,{error:'Not found'});
    }catch(error){
      if(error.code){console.error('Request failed:',error.code);return send(500,{error:'服务器保存或读取失败，请重试'});}
      send(error.message==='BODY_TOO_LARGE'?413:400,{error:'请求格式错误'});
    }
  };
  return {handler,status,server:http.createServer(handler)};
}
if(require.main===module){const {server}=createApp();server.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`Parking v3 listening on ${server.address().port}`));}
module.exports={createApp};
