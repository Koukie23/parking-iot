const $=id=>document.getElementById(id);
let authenticated=false,busy=false,last=null;
const modes=['自动','手动全亮','手动关闭'];
function add(parent,tag,text,cls=''){const e=document.createElement(tag);e.textContent=text;e.className=cls;parent.append(e);return e;}
function notice(text,error=false){$('message').textContent=text;$('message').className='notice'+(error?' error':'');}
async function api(url,body){
  const res=await fetch(url,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(7000)});
  const data=await res.json();if(!res.ok){if(res.status===401){authenticated=false;$('login').hidden=false;$('dashboard').hidden=true;}throw Error(data.error||'请求失败');}return data;
}
async function control(body){
  if(busy)return;
  const closing=body.target==='facility'&&body.action==='closed';
  const testing=body.target==='guide'&&body.action!=='auto';
  if(closing&&!confirm('确认停车场模型停业并关闭全部灯？司机页会立即暂停空位推荐。'))return;
  if(testing&&!confirm('进入空位指示维护测试？司机页将暂停空位推荐，直到恢复空位指示自动模式。'))return;
  busy=true;document.querySelectorAll('#dashboard button').forEach(b=>b.disabled=true);
  notice('正在提交指令…');
  try{const data=await api('/api/admin/control',body);notice(`指令 ${data.command.id} 已提交，等待 Nano 执行；尚未确认灯已变化。`);await refresh();}
  catch(e){notice(e.message+'；若请求超时，请查看当前指令状态再操作。',true);}
  finally{busy=false;if(last&&authenticated)render(last);else document.querySelectorAll('#dashboard button').forEach(b=>b.disabled=false);}
}
function addGuideStatus(parent,on){
  if(on===null){add(parent,'span','未知');return;}
  const dot=add(parent,'span','','status-dot '+(on?'is-on':'is-off'));
  dot.role='img';dot.ariaLabel=on?'空位指示亮起':'空位指示熄灭';dot.title=dot.ariaLabel;
}
function render(data){
  last=data;const c=data.command;
  const status={confirmed:'设备已确认执行',pending:'待执行',delayed:'确认超时，仍未证实执行；设备会继续同步最新要求',waiting_device:'设备离线或尚未上报，等待执行'}[c.status];
  $('command').textContent=`指令 ${c.id} · ${status}`;
  $('actual').textContent=`设备${data.online?'在线':'离线'}${data.fresh?'':' · 数据更新延迟'} · 最近上报：${data.last_seen?new Date(data.last_seen).toLocaleString():'无'} · 实际全场模式：${data.applied_facility===null?'未知':['营业自动','照明全亮','停业关闭'][data.applied_facility]}`;
  document.querySelectorAll('#facility button').forEach(b=>{b.disabled=busy;b.setAttribute('aria-pressed',String({auto:0,on:1,closed:2}[b.dataset.action]===c.facility));});
  $('logout').disabled=busy;$('bays').replaceChildren();
  for(let i=0;i<2;i++){
    const b=data.bays[i],card=add($('bays'),'article','','card '+b.occupancy);
    add(card,'h2',b.bay_id);add(card,'p',`车位：${{free:'空闲',occupied:'占用',unknown:'未知'}[b.occupancy]}`);
    const outputs=add(card,'p',`已上报照明：${b.brightness_pct===null?'未知':b.brightness_pct+'%'} · 空位指示：`);
    addGuideStatus(outputs,b.guide_on);
    for(const target of ['light','guide']){
      const box=add(card,'div','','control-group');add(box,'strong',target==='light'?'照明灯':'空位指示 · 维护测试');
      const desired=(target==='light'?c.light_modes:c.guide_modes)[i];
      const actual=target==='light'?b.light_mode:b.guide_mode;
      add(box,'p',`要求：${modes[desired]}；设备上报：${actual===null?'未知':modes[actual]}`);
      const row=add(box,'div','','row');
      for(const [action,label]of [['on',target==='light'?'全亮':'点亮'],['off','关闭'],['auto','恢复自动']]){
        const button=add(row,'button',label);button.disabled=busy||c.facility!==0;
        button.setAttribute('aria-pressed',String({auto:0,on:1,off:2}[action]===desired));
        button.onclick=()=>control({target,bay_id:b.bay_id,action});
      }
    }
  }
}
async function refresh(){
  if(!authenticated)return;
  try{const data=await api('/api/admin/status');if(authenticated)render(data);}
  catch(e){notice(e.message+'；当前状态未更新。',true);last=null;document.querySelectorAll('#dashboard button:not(#logout)').forEach(b=>b.disabled=true);}
}
$('login').onsubmit=async event=>{
  event.preventDefault();const button=$('login').querySelector('button');button.disabled=true;
  try{await api('/api/admin/login',{password:$('password').value});$('password').value='';authenticated=true;$('login').hidden=true;$('dashboard').hidden=false;notice('管理员已登录。');await refresh();}
  catch(e){notice(e.message,true);}finally{button.disabled=false;}
};
$('logout').onclick=async()=>{try{await api('/api/admin/logout',{});authenticated=false;last=null;$('login').hidden=false;$('dashboard').hidden=true;notice('已退出登录。');}catch(e){notice(e.message,true);}};
$('facility').onclick=e=>{if(e.target.dataset.action)control({target:'facility',action:e.target.dataset.action});};
async function poll(){await refresh();setTimeout(poll,2000);}
(async()=>{try{const data=await api('/api/admin/status');authenticated=true;$('login').hidden=true;$('dashboard').hidden=false;notice('管理员已登录。');render(data);}catch{}poll();})();
