const $=id=>document.getElementById(id);
const labels={free:'最近检测为空闲',occupied:'已占用',unknown:'状态待确认'};
function add(parent,tag,text,cls=''){const e=document.createElement(tag);e.textContent=text;e.className=cls;parent.append(e);return e;}
function addGuideStatus(parent,on){
  if(on===null){add(parent,'span','未知');return;}
  const dot=add(parent,'span','','status-dot '+(on?'is-on':'is-off'));
  dot.role='img';dot.ariaLabel=on?'空位指示亮起':'空位指示熄灭';dot.title=dot.ariaLabel;
}
function render(data){
  const operating={open:'营业中',closed:'停车场已关闭',maintenance:'引导灯维护中',unconfirmed:'暂无法确认可用车位'};
  $('operating').textContent=operating[data.operating]||'状态待确认';
  $('count').textContent=data.available===null?'—':`${data.available} / ${data.total}`;
  $('hint').textContent=data.operating==='open'?'最近确认可用车位':data.operating==='closed'?'暂停停车与空位推荐':data.operating==='maintenance'?'人工测试期间暂停空位推荐':'等待最新硬件状态或控制确认';
  $('connection').className='notice'+(!data.fresh?' warning':'');
  $('connection').textContent=data.age_ms===null?'尚未收到设备上报':!data.online?'设备离线，暂停空位推荐':`最近上报：${Math.floor(data.age_ms/1000)} 秒前${data.fresh?'':' · 数据更新延迟，暂停推荐'}`;
  $('bays').replaceChildren();
  for(const b of data.bays){
    const card=add($('bays'),'article','','card '+(data.operating==='open'&&b.fresh?b.occupancy:'unknown'));
    const head=add(card,'div','','bay-header');add(head,'span',b.bay_id,'bay-id');add(head,'span',b.online?'设备在线':'设备离线','badge');
    let text=data.operating==='closed'?'暂停开放':data.operating==='maintenance'?'维护测试':data.operating!=='open'?'暂不推荐':labels[b.occupancy];
    add(card,'div',text,'space');
    const dl=add(card,'dl','');
    add(dl,'dt','照明设定');add(dl,'dd',b.brightness_pct===null?'未知':`${b.brightness_pct}%`);
    add(dl,'dt','空位指示');addGuideStatus(add(dl,'dd',''),b.guide_on);
    add(card,'small',b.recommended?'到达后请再次确认空位':'车位信息随现场情况变化');
  }
}
async function refresh(){
  try{
    const res=await fetch('/api/parking',{cache:'no-store',signal:AbortSignal.timeout(5000)});if(!res.ok)throw Error();render(await res.json());
  }catch{
    $('operating').textContent='连接暂时中断';$('count').textContent='—';$('hint').textContent='暂停空位推荐，正在重新连接';
    $('connection').textContent='无法获取最新状态，请勿依赖此前的空位信息';$('connection').className='notice error';$('bays').replaceChildren();
  }finally{setTimeout(refresh,2000);}
}
refresh();
