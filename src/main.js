import './style.css';
import './board.css';
import {createElement, Check, Plus, LayoutDashboard, Layers, ArrowUpRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Minus, Scan, Sprout, MessagesSquare, ArrowUp, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Link, Download, LogOut, CircleStop, Circle, X} from 'lucide';
const icons={Check, Plus, LayoutDashboard, Layers, ArrowUpRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Minus, Scan, Sprout, MessagesSquare, ArrowUp, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Link, Download, LogOut, CircleStop, Circle, X};
import {Board} from './board.js';
import {ScreenSharing} from './media.js';
import {SharedCanvas} from './shared-canvas.js';
import {PeerCanvas} from './peer-canvas.js';
import {ScreenSubscriptions} from './screen-subscriptions.js';
import {PollingSessionTransport} from './session-transport.js';
import {initGeometry, geometryBackend} from './geometry.js';

const $=s=>document.querySelector(s);
const icon=(name,size=18)=>{const node=createElement(icons[name]||icons.Circle,{width:size,height:size,'stroke-width':1.7});return node.outerHTML};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
let shared=null, peerCanvas=null, receivingCanvas=false;
let capture=null, walkthrough=null, agentTools=null, agentControlEnabled=false;
let board, socket, media, auth=null, participants=[], chat=[], connected=false, localStream=null, reconnectTimer, intentionalClose=false, roomSeeded=false;
let rightPanel='people', tool='select', roomName='Your canvas', sandbox=true, startedAt=Date.now(), activeColor='#305e48';
const screenSubscriptions=new ScreenSubscriptions();
let subscriptionTimer, disposed=false;
const savedRooms=()=>{try{return JSON.parse(localStorage.getItem('common.rooms')||'[]')}catch{return []}};
const ownParticipantId=()=>sandbox?'local':auth?.participantId;
const saveRoom=r=>{localStorage.setItem('common.rooms',JSON.stringify([r,...savedRooms().filter(x=>x.id!==r.id)].slice(0,8)));renderRecent()};
function toast(message){const el=document.createElement('div');el.className='toast';el.innerHTML=icon('Check',16);el.append(document.createTextNode(message));$('#toasts').append(el);setTimeout(()=>el.remove(),4500)}
function modal(html,onSubmit){const root=$('#modal-root');root.innerHTML=`<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="icon-button close-modal" aria-label="Close dialog">${icon('X')}</button>${html}</section></div>`;root.querySelector('.close-modal').onclick=closeModal;root.querySelector('.modal-overlay').onclick=e=>{if(e.target===e.currentTarget)closeModal()};root.querySelector('form')?.addEventListener('submit',onSubmit);setTimeout(()=>root.querySelector('input,textarea,button:not(.close-modal)')?.focus(),20)}
function closeModal(){$('#modal-root').replaceChildren()}
function formError(form,msg){let e=form.querySelector('.form-error');if(!e){e=document.createElement('p');e.className='form-error';e.setAttribute('role','alert');form.append(e)}e.textContent=msg}
async function api(path,body){const r=await fetch(path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});const data=await r.json();if(!r.ok)throw new Error(data.error||'Something went wrong. Please try again.');return data}
function send(message){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));else if(!sandbox&&message.type!=='cursor'&&message.type!=='signal')toast('Reconnect to edit the shared canvas.')}
const seed=()=>[
 {id:'welcome',type:'text',x:88,y:70,width:600,height:94,text:'A little room for your next idea.',fontSize:32,color:'#283f32',z:1},
 {id:'note',type:'sticky',x:91,y:220,width:258,height:190,text:'One small thought…\n\nShare a window.\nFollow a hunch.',color:'#344a30',fill:'#f0e4ad',fontSize:18,z:2},
 {id:'flow1',type:'rectangle',x:440,y:220,width:220,height:125,text:'What if?',color:'#78927b',fill:'#f3f4e9',z:2},
 {id:'flow-title',type:'text',x:440,y:365,width:320,height:70,text:'Drag objects to arrange them.\nDouble-click text to edit.',fontSize:15,color:'#697565',z:1}
];

$('#app').innerHTML=`
<aside class="sidebar">
 <a class="brand" href="/" aria-label="Common home"><span class="brand-mark">${icon('Sprout',22)}</span>common</a>
 <button class="new-session primary" id="new-session" title="New session">${icon('Plus',17)} New session</button>
 <nav aria-label="Workspace"><button class="nav-item active" id="sandbox-nav" title="Your canvas">${icon('LayoutDashboard')} Your canvas</button><button class="nav-item" id="sessions-nav" title="Sessions">${icon('Layers')} Sessions <span class="recent-count">0</span></button></nav>
 <div class="recent-block"><div class="nav-label">RECENT</div><div id="recent-rooms"></div></div>
 <div class="sidebar-bottom"><span class="sidebar-flower" aria-hidden="true">✳</span><button class="sidebar-help" id="how-it-works" title="How it works">${icon('CircleHelp',16)} How it works</button></div>
</aside>
<main class="main">
 <header class="topbar"><div class="session-heading"><span class="eyebrow" id="session-kind">PERSONAL</span><div class="title-row"><h1 id="room-title">Your canvas</h1><button class="icon-button" id="room-menu" aria-label="Canvas options">${icon('Ellipsis',21)}</button></div><p id="room-subtitle">Notes, diagrams, and shared windows.</p></div><div class="top-actions"><span class="privacy-label">${icon('LockKeyhole',13)} <span id="privacy-status">Only you</span></span><button class="button invite-button" id="invite" aria-label="Invite people">${icon('UserPlus',16)} Invite people</button><button class="primary share-button" id="share-screen" aria-label="Share a window" aria-pressed="false">${icon('MonitorUp',17)} Share a window</button></div></header>
 <div class="canvas-bar"><span class="canvas-label">Canvas</span><div class="canvas-status"><span id="connection-status">${icon('CloudUpload',15)} Saved on this device</span><div class="presence" id="header-presence"><span class="avatar avatar-small" aria-hidden="true">Y</span><span id="member-count">Only you</span></div><button class="button panel-toggle" id="toggle-panel" aria-label="People and chat" aria-expanded="false" aria-controls="right-panel">${icon('PanelRight',17)}<span>People &amp; chat</span></button></div></div>
 <section class="workspace-area">
 <div class="canvas-wrap"><div id="board-viewport" aria-label="Collaborative canvas"></div><div id="remote-cursors"></div>
 <div class="canvas-top-hint"><span class="hint-icon">${icon('MousePointer2',13)}</span><span id="canvas-hint">Drag to move · Double-click text to edit</span></div>
 <div class="canvas-toolbar" role="toolbar" aria-label="Canvas tools">${[['select','MousePointer2','Select (V)'],['hand','Hand','Pan (H)'],['draw','Pencil','Draw (P)'],['text','Type','Text (T)'],['sticky','StickyNote','Sticky note (N)'],['rectangle','Square','Rectangle (R)'],['arrow','MoveUpRight','Arrow (A)'],['image','ImagePlus','Upload image'],['diagram','Workflow','Add diagram']].map(([id,i,label],n)=>`${n===2||n===7?'<span class="tool-divider"></span>':''}<button class="tool ${id==='select'?'selected':''}" data-tool="${id}" aria-label="${label}" aria-pressed="${id==='select'}" title="${label}">${icon(i,20)}</button>`).join('')}<span class="tool-divider"></span><input type="color" value="#305e48" id="tool-color" title="Drawing color" aria-label="Drawing color"></div>
 <span id="engine-label" class="sr-only">Canvas ready</span><div class="canvas-bottom"><div class="zoom-controls"><button class="icon-button" id="zoom-out" aria-label="Zoom out">${icon('Minus',15)}</button><button id="zoom-label" title="Reset zoom" aria-label="Reset zoom">100%</button><button class="icon-button" id="zoom-in" aria-label="Zoom in">${icon('Plus',15)}</button><span></span><button class="icon-button" id="fit-canvas" aria-label="Fit canvas to view">${icon('Scan',16)}</button></div></div>
 <div class="drop-overlay" id="drop-overlay">${icon('ImagePlus',40)}<strong>Drop images onto the canvas</strong></div>
 </div>
 <aside class="right-panel collapsed" id="right-panel" aria-label="People and chat"><div class="panel-tabs"><button class="panel-tab active" data-panel="people">People <span id="people-number">1</span></button><button class="panel-tab" data-panel="chat">Chat <span id="chat-number" hidden>0</span></button></div><div id="panel-content"></div></aside>
 </section>
 <footer class="footer"><span id="footer-access">Saved on this device</span><span id="footer-tip">V Select · H Pan · P Draw</span></footer>
</main><input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden>`;

board=new Board({
  el:$('#board-viewport'),
  canEdit:entity=>entity.type!=='screen'||sandbox||entity.participantId===auth?.participantId,
  onChange:(entity,patch)=>{if(!shared?.setLocal(entity,patch))refreshCanvas()},
  onDelete:id=>{shared?.deleteLocal(id);stopDeletedLocalScreen()},
  onLayerAction:(id,action)=>shared?.reorder(id,action),
  onLockChange:(id,locked)=>shared?.patch(id,{locked}),
  onCursor:({x,y})=>{if(!sandbox&&connected)send({type:'cursor',x,y})},
  onSelect:()=>{agentTools?.refresh();scheduleScreenSubscriptions()},
  onWatchScreen:id=>{screenSubscriptions.toggle(id);syncScreenSubscriptions()},
  onStatus:toast,onToolChange:next=>chooseTool(next),
  onViewChange:view=>{$('#zoom-label').textContent=Math.round(view.zoom*100)+'%';scheduleScreenSubscriptions()}
});
function positionCanvasOverlays(){
  const toolbar=$('.canvas-toolbar').getBoundingClientRect();
  if(toolbar.height>0)document.documentElement.style.setProperty('--canvas-overlay-bottom',`${Math.max(0,window.innerHeight-toolbar.top)+14}px`);
}
const subscriptionResizeObserver=new ResizeObserver(()=>{scheduleScreenSubscriptions();positionCanvasOverlays()});
subscriptionResizeObserver.observe($('#board-viewport'));
function isPeerRoom(){return !sandbox&&auth?.room?.collaboration==='peer'}
function refreshCanvas(){if(shared){board.setEntities(shared.all());board.setLayerOrder(shared.getOrder());scheduleScreenSubscriptions()}}
function scheduleScreenSubscriptions(){clearTimeout(subscriptionTimer);if(!disposed)subscriptionTimer=setTimeout(syncScreenSubscriptions,150)}
function syncScreenSubscriptions(){
  clearTimeout(subscriptionTimer);
  if(disposed||!board||!media||!shared)return;
  const el=$('#board-viewport');
  const active=new Set(participants.map(person=>person.id));
  const screens=shared.all().filter(entity=>entity.type==='screen'&&(sandbox||active.has(entity.participantId)));
  const ids=screenSubscriptions.plan(screens,{participantId:ownParticipantId(),selectedId:board.selectedId,view:board.getView(),width:el.clientWidth,height:el.clientHeight,hidden:document.hidden||(!sandbox&&!connected)});
  board.setScreenSubscriptions(ids,ownParticipantId());
  media.setSubscriptions(ids);
}
document.addEventListener('visibilitychange',syncScreenSubscriptions);
window.addEventListener('resize',scheduleScreenSubscriptions);
function stopDeletedLocalScreen(){
  if(localStream&&!shared?.all().some(e=>e.type==='screen'&&e.participantId===ownParticipantId())){
    media?.stop();localStream=null;updateShareButton();
  }
}
function makeCanvasModel(){
  peerCanvas?.destroy();peerCanvas=null;shared?.destroy();
  shared=new SharedCanvas({
    onChange:entity=>{
      board.upsert(entity);board.setLayerOrder(shared.getOrder());
      if(entity.type==='screen')scheduleScreenSubscriptions();
      if(sandbox)saveSandbox();else if(!isPeerRoom()&&!receivingCanvas)send({type:'upsert',entity});
    },
    onDelete:id=>{
      board.remove(id);board.setLayerOrder(shared.getOrder());stopDeletedLocalScreen();
      scheduleScreenSubscriptions();
      if(sandbox)saveSandbox();else if(!isPeerRoom()&&!receivingCanvas)send({type:'delete',id});
    },
    onUpdate:(update,origin)=>{if(isPeerRoom())peerCanvas?.broadcast(update,origin)},
    onInvalid:error=>toast(error.message)
  });
  board.setEntities([]);board.setLayerOrder([]);
}
function receiveCanvas(action){receivingCanvas=true;try{return action()}finally{receivingCanvas=false}}

function saveSandbox(){try{localStorage.setItem('common.canvas',JSON.stringify([...board.entities.values()].filter(e=>e.type!=='screen')))}catch{toast('This device’s canvas storage is full. Export your canvas to keep these changes.')}}
function loadSandbox(){let data;try{data=JSON.parse(localStorage.getItem('common.canvas'))}catch{}makeCanvasModel();shared.replaceInitial(data||seed());renderPeople();renderRecent();setPanelOpen(false);if(!data)requestAnimationFrame(()=>board.fit())}
loadSandbox();
setupMedia();
initGeometry().then(()=>{$('#engine-label').textContent='Canvas ready';$('#engine-label').title=geometryBackend()});

function chooseTool(next){if(next==='image'){$('#image-input').click();return}if(next==='diagram'){diagramModal();return}tool=next;board.setTool(next);document.querySelectorAll('.canvas-toolbar [data-tool]').forEach(e=>{const selected=e.dataset.tool===next;e.classList.toggle('selected',selected);e.setAttribute('aria-pressed',String(selected))});$('#canvas-hint').textContent=({select:'Drag to move · Double-click text to edit',hand:'Drag to pan the canvas',draw:'Click and drag to draw',text:'Click to add text',sticky:'Click to add a note',rectangle:'Click and drag to draw a box',arrow:'Click and drag to draw an arrow'})[next]||''}
document.querySelectorAll('.canvas-toolbar [data-tool]').forEach(e=>e.onclick=()=>chooseTool(e.dataset.tool));
$('#tool-color').oninput=e=>{activeColor=e.target.value;board.setColor(activeColor)};
$('#zoom-in').onclick=()=>board.setZoom(Math.min(2,board.getView().zoom+.1));$('#zoom-out').onclick=()=>board.setZoom(Math.max(.25,board.getView().zoom-.1));$('#zoom-label').onclick=()=>board.setZoom(1);$('#fit-canvas').onclick=()=>board.fit();
function setPanelOpen(open){$('#right-panel').classList.toggle('collapsed',!open);$('#toggle-panel').setAttribute('aria-expanded',String(open))}
$('#toggle-panel').onclick=()=>setPanelOpen($('#right-panel').classList.contains('collapsed'));
$('#new-session').onclick=()=>createModal();$('#invite').onclick=()=>sandbox?createModal():inviteModal();$('#how-it-works').onclick=tour;$('#sessions-nav').onclick=showSessions;$('#sandbox-nav').onclick=()=>{if(sandbox)board.fit();else location.href='/'};
$('#room-menu').onclick=roomMenu;
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>{rightPanel=b.dataset.panel;document.querySelectorAll('[data-panel]').forEach(e=>e.classList.toggle('active',e===b));renderPanel()});
function renderPanel(){rightPanel==='people'?renderPeople():renderChat()}
function renderPeople(){if(rightPanel!=='people')return;const list=sandbox?[{id:'local',name:'You',color:'#365f4a'}]:participants;$('#panel-content').innerHTML=`<div class="people-list" role="list" aria-label="${sandbox?'On this canvas':'Session participants'}">${list.map(p=>`<div class="person" role="listitem"><span class="avatar" aria-hidden="true" style="--avatar-color:${esc(p.color)}">${esc(p.name.slice(0,1).toUpperCase())}</span><div><strong>${esc(p.name)} ${!sandbox&&p.id===auth?.participantId?'<span class="you-tag">(you)</span>':''}</strong><small>${sandbox?'This device':p.isAdmin?'Host':'Participant'}</small></div><span class="person-online" title="Online"></span></div>`).join('')}</div><button class="invite-dashed" id="panel-invite">${icon('UserPlus',15)} Invite people</button><p class="panel-invite-hint">${sandbox?'Create a session to invite your team.':'Share the session link and password to invite your team.'}</p>`;$('#panel-invite').onclick=()=>sandbox?createModal():inviteModal()}
function renderChat(){if(rightPanel!=='chat')return;$('#panel-content').innerHTML=`<div class="chat-messages" id="chat-messages">${chat.length?chat.map(m=>`<div class="chat-message"><div><strong>${esc(m.name)}</strong><time>${new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>${esc(m.text)}</p></div>`).join(''):`<div class="chat-empty">${icon('MessagesSquare',26)}<strong>No messages yet</strong><p>${sandbox?'Create a session to chat with your team.':'Send a message or share a useful link.'}</p></div>`}</div><form id="chat-form"><label class="sr-only" for="chat-text">Message your team</label><input id="chat-text" maxlength="2000" placeholder="Message the team" autocomplete="off" ${sandbox?'disabled':''}><button aria-label="Send message" ${sandbox?'disabled':''}>${icon('ArrowUp',17)}</button></form>`;$('#chat-form').onsubmit=e=>{e.preventDefault();const input=$('#chat-text');if(input.value.trim()){if(!connected){toast('Reconnect to send your message.');return}send({type:'chat',text:input.value.trim()});input.value=''}};const m=$('#chat-messages');m.scrollTop=m.scrollHeight}
function updatePresence(){const count=sandbox?1:participants.length;$('#member-count').textContent=sandbox?'Only you':`${count} ${count===1?'person':'people'}`;$('#people-number').textContent=count;const avatar=$('#header-presence .avatar');avatar.textContent=auth?.displayName?.slice(0,1)||'Y';renderPanel()}
function renderRecent(){$('.recent-count').textContent=savedRooms().length;$('#recent-rooms').innerHTML=savedRooms().length?savedRooms().slice(0,4).map(r=>`<a class="recent-room" href="/room/${encodeURIComponent(r.id)}"><span class="room-dot"></span><span>${esc(r.name)}</span>${icon('ArrowUpRight',12)}</a>`).join(''):'<p class="no-recent">No recent sessions</p>'}
function createModal(){modal(`<span class="modal-symbol">${icon('Plus',25)}</span><h2 id="modal-title">Create a session</h2><p>Start a private session and invite your teammates.</p><form id="create-form"><label>Session name<input name="name" placeholder="e.g. Weekly product review" maxlength="60" required value="Team workspace"></label><label>Your name<input name="displayName" placeholder="Your name" maxlength="60" required autocomplete="given-name"></label><label>Room password<span class="field-help">Share this with your team separately.</span><input name="password" type="password" minlength="8" maxlength="128" placeholder="At least 8 characters" required autocomplete="new-password"></label><button class="primary modal-submit">Create session ${icon('ArrowRight',17)}</button><small class="form-footnote">${icon('LockKeyhole',12)} Link and password required to join.</small></form>`,async e=>{e.preventDefault();const form=e.target;const b=form.querySelector('button');b.disabled=true;b.textContent='Creating…';try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms',{...vals,collaboration:'peer'});result.displayName=vals.displayName;sessionStorage.setItem('common.auth.'+result.room.id,JSON.stringify(result));saveRoom(result.room);closeModal();await enterRoom(result,true);inviteModal()}catch(err){formError(form,err.message);b.disabled=false;b.innerHTML='Create session '+icon('ArrowRight',17)}})}
function inviteModal(){const url=location.origin+'/room/'+auth.room.id;modal(`<span class="modal-symbol">${icon('UserPlus',25)}</span><h2 id="modal-title">Invite your team</h2><p>Anyone with this link and the session password can join. Windows load when you watch them.</p><label class="link-label">SESSION LINK<div class="copy-field"><input id="invite-link" readonly value="${esc(url)}"><button class="button" id="copy-link">${icon('Copy',16)} Copy</button></div></label><div class="invite-password">${icon('LockKeyhole',17)}<div><strong>Share the password separately.</strong><span>Your password is never included in the link.</span></div></div><button class="primary modal-submit" id="done-invite">Done ${icon('ArrowRight',16)}</button>`);$('#copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(url);$('#copy-link').innerHTML=icon('Check',16)+' Copied';toast('Session link copied')}catch{$('#invite-link').select();toast('Select and copy the session link')}};$('#done-invite').onclick=closeModal}
async function joinFromPath(id){let saved;try{saved=JSON.parse(sessionStorage.getItem('common.auth.'+id))}catch{}if(saved){await enterRoom(saved);return}let room;try{({room}=await api('/api/rooms/'+encodeURIComponent(id)))}catch(err){toast(err.message);if(!sandbox){location.replace('/');return}history.replaceState(null,'','/');return}modal(`<span class="modal-symbol">${icon('DoorOpen',26)}</span><h2 id="modal-title">${esc(room.name)}</h2><p>Enter your name and the session password.</p><form><label>Your name<input name="displayName" placeholder="Your name" maxlength="60" autocomplete="given-name" required></label><label>Room password<input name="password" type="password" required autocomplete="current-password" placeholder="The password from your host"></label><button class="primary modal-submit">Join session ${icon('ArrowRight',17)}</button></form>`,async e=>{e.preventDefault();const form=e.target,b=form.querySelector('button');b.disabled=true;try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms/'+encodeURIComponent(id)+'/join',vals);result.displayName=vals.displayName;sessionStorage.setItem('common.auth.'+id,JSON.stringify(result));saveRoom(result.room);closeModal();await enterRoom(result)}catch(err){formError(form,err.message);b.disabled=false}})}
async function enterRoom(result,isNew=false){
  capture?.stop().catch(()=>{});walkthrough?.stop();
  intentionalClose=true;clearTimeout(reconnectTimer);socket?.close();media?.destroy();
  auth=result;sandbox=false;intentionalClose=false;localStream=null;roomSeeded=!isNew;
  participants=[];screenSubscriptions.reset();board.setScreenSubscriptions([],result.participantId);
  makeCanvasModel();roomName=result.room.name;startedAt=Date.now();
  history.pushState(null,'','/room/'+result.room.id);
  $('#room-title').textContent=roomName;
  $('#session-kind').textContent='LIVE SESSION';$('#privacy-status').textContent='Password protected';
  $('#room-subtitle').textContent='Share windows and work on the canvas together.';
  $('#footer-access').textContent=isPeerRoom()?'Shared directly between browsers':'Password-protected room';
  document.title=roomName+' — Common';$('#sandbox-nav').classList.remove('active');$('#sessions-nav').classList.add('active');
  setPanelOpen(innerWidth>=1100);
  if(isPeerRoom())peerCanvas=new PeerCanvas({model:shared,send:(id,bytes)=>media?.sendData(id,bytes)||false,onStatus:toast});
  setupMedia();
  updateShareButton();
  connect();
}
function setupMedia(){
  media=new ScreenSharing({
    send,
    onStream:(id,stream)=>board.setStream(id==='local'?ownParticipantId():id,stream),
    onData:(id,bytes)=>peerCanvas?.receive(id,bytes),
    onPeerOpen:id=>{peerCanvas?.open(id);updateCanvasStatus()},
    onPeerClose:id=>{peerCanvas?.close(id);updateCanvasStatus()},
    onStatus:toast,
    onStopped:()=>{
      localStream=null;updateShareButton();
      const entity=shared.all().find(e=>e.type==='screen'&&e.participantId===ownParticipantId());
      if(entity)shared.deleteLocal(entity.id);
    },
    getIceConfig:async()=>{
      if(sandbox){const r=await fetch('/api/ice');if(!r.ok)throw new Error('ICE configuration unavailable');return r.json()}
      const r=await fetch('/api/ice?room='+encodeURIComponent(auth.room.id),{headers:{Authorization:'Bearer '+auth.token}});
      if(!r.ok)throw new Error('ICE configuration unavailable');return r.json();
    }
  });
}
function updateCanvasStatus(){
  if(sandbox)return;
  const count=peerCanvas?.peers.size||0;
  // Canvas gossip needs only the sparse overlay, independent of video viewers.
  const ready=Boolean(media)&&[...media.desiredCanvasPeers].every(id=>peerCanvas?.peers.has(id));
  socket?.setIdle?.(isPeerRoom()&&ready);
  const text=!connected?'Reconnecting…':isPeerRoom()?(participants.length<=1?'Live · Connected':count?`Live · Connected · ${count} ${count===1?'peer':'peers'}`:'Live · Connected · finding peers…'):'Live · Connected';
  $('#connection-status').innerHTML=icon(connected?'CloudUpload':'CloudOff',15)+' '+text;
}
function setConnection(status){
  connected=status==='connected';board.setReadOnly(!sandbox&&!connected);
  $('#connection-status').classList.toggle('disconnected',!connected);updateCanvasStatus();
  scheduleScreenSubscriptions();
  agentTools?.refresh();
}
function syncPeople(){
  media.syncParticipants(participants,auth.participantId).then(updateCanvasStatus);updatePresence();updateCanvasStatus();
  scheduleScreenSubscriptions();
  const active=new Set(participants.map(p=>p.id));
  document.querySelectorAll('.remote-cursor').forEach(el=>{if(!active.has(el.dataset.person))el.remove()});
  if(isPeerRoom())for(const entity of shared.all())if(entity.type==='screen'&&!active.has(entity.participantId))shared.deleteLocal(entity.id);
}
async function connect(){
  setConnection('connecting');
  try{
    const response=await fetch('/api/rooms/'+encodeURIComponent(auth.room.id)+'/session',{headers:{Authorization:'Bearer '+auth.token}});
    if(response.status===401||response.status===404){
      sessionStorage.removeItem('common.auth.'+auth.room.id);localStream=null;media?.destroy();updateShareButton();intentionalClose=true;
      toast(response.status===404?'This room has ended.':'Please enter the password to rejoin.');await joinFromPath(auth.room.id);return;
    }
    if(!response.ok)throw new Error('unavailable');
  }catch{reconnectTimer=setTimeout(connect,2500);return}
  if(intentionalClose)return;
  const ws=import.meta.env.VITE_SESSION_TRANSPORT==='polling'
    ?new PollingSessionTransport({room:auth.room.id,token:auth.token})
    :new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws?room=${encodeURIComponent(auth.room.id)}&token=${encodeURIComponent(auth.token)}`);socket=ws;
  ws.onmessage=e=>{
    let m;try{m=JSON.parse(e.data)}catch{return}
    switch(m.type){
      case 'init':{
        auth.room=m.room;sessionStorage.setItem('common.auth.'+auth.room.id,JSON.stringify(auth));
        setConnection('connected');participants=m.participants;chat=m.chat||[];
        if(!isPeerRoom())receiveCanvas(()=>{if(!shared.entities.size&&!shared.tombstones.size)shared.replaceInitial(m.entities);else{const incoming=new Set(m.entities.map(e=>e.id));for(const entity of shared.all())if(!incoming.has(entity.id))shared.deleteLocal(entity.id);for(const entity of m.entities)shared.setLocal(entity)}});
        if(!roomSeeded){
          roomSeeded=true;
          shared.replaceInitial([{id:uid(),type:'text',x:120,y:85,width:600,height:110,text:'Team workspace',fontSize:34,color:'#2b4936',z:1},{id:uid(),type:'sticky',x:125,y:252,width:270,height:210,text:'Add a note, share a window,\nor sketch an idea.\n\nChanges appear for everyone\nin this session.',fontSize:18,color:'#364c31',fill:'#edf1cb',z:2}]);
        }
        refreshCanvas();syncPeople();break;
      }
      case 'participants':participants=m.participants;syncPeople();break;
      case 'upsert':if(!isPeerRoom())receiveCanvas(()=>shared.setLocal(m.entity));break;
      case 'delete':if(!isPeerRoom())receiveCanvas(()=>shared.deleteLocal(m.id));break;
      case 'cursor':renderCursor(m);break;
      case 'chat':chat.push(m.message);$('#chat-number').hidden=false;$('#chat-number').textContent=chat.length;renderChat();break;
      case 'signal':media.handleSignal(m.from,m.data);break;
      case 'ended':
        intentionalClose=true;connected=false;capture?.stop().catch(()=>{});walkthrough?.stop();board.setReadOnly(true);localStream=null;updateShareButton();sessionStorage.removeItem('common.auth.'+auth.room.id);media.destroy();peerCanvas?.destroy();$('#connection-status').textContent='Session ended';closeModal();
        toast('This session has ended. Your host closed the room.');
        modal(`<span class="modal-symbol">${icon('Sunset',25)}</span><h2 id="modal-title">Session ended</h2><p>The host has ended this session.</p><button class="primary modal-submit" id="back-home">Back to your canvas ${icon('ArrowRight',16)}</button>`);
        $('#back-home').onclick=()=>location.href='/';break;
      case 'error':toast(m.error);break;
    }
  };
  ws.onclose=e=>{
    if(ws!==socket||intentionalClose)return;
    setConnection('disconnected');
    if(localStream){media.stop();localStream=null;const ownScreen=shared.all().find(e=>e.type==='screen'&&e.participantId===auth.participantId);if(ownScreen)shared.deleteLocal(ownScreen.id);updateShareButton();toast('Sharing stopped when the connection dropped. Share again after reconnecting.')}
    media.syncParticipants([],auth.participantId);
    if([4001,4003,4004,1008].includes(e.code)){
      sessionStorage.removeItem('common.auth.'+auth.room.id);toast('Your room access has expired. Please join again.');intentionalClose=true;joinFromPath(auth.room.id);return;
    }
    reconnectTimer=setTimeout(connect,2000);
  };
  ws.onerror=()=>{};
}

function renderCursor(m){const p=participants.find(x=>x.id===m.participantId);if(!p)return;let el=document.querySelector(`[data-person="${CSS.escape(p.id)}"]`);if(!el){el=document.createElement('div');el.className='remote-cursor';el.dataset.person=p.id;el.innerHTML=icon('MousePointer2',17)+`<span>${esc(p.name)}</span>`;el.style.color=p.color;$('#remote-cursors').append(el)}const v=board.getView();el.style.transform=`translate(${m.x*v.zoom+v.x}px,${m.y*v.zoom+v.y}px)`;el.style.opacity='1';clearTimeout(el.fade);el.fade=setTimeout(()=>el.style.opacity='0',5000)}
$('#share-screen').onclick=async()=>{
  if(!sandbox&&!connected){toast('Wait for your room to reconnect before sharing.');return}
  if(localStream){
    await media.stop();localStream=null;
    const entity=shared.all().find(e=>e.type==='screen'&&e.participantId===ownParticipantId());
    if(entity)shared.deleteLocal(entity.id);updateShareButton();return;
  }
  const b=$('#share-screen');b.disabled=true;
  try{
    const stream=await media.start();
    if(stream){
      localStream=stream;
      const entity={id:uid(),type:'screen',participantId:ownParticipantId(),streamId:stream.id,x:130+Math.random()*100,y:150+Math.random()*100,width:620,height:390,title:sandbox?'Your window':auth.displayName+"’s window",z:20};
      if(!shared.setLocal(entity)){await media.stop();localStream=null;toast('There is no room for this shared window on the canvas.');return}
      board.setStream(ownParticipantId(),stream);
      toast(sandbox?'Window added to your canvas.':'Window shared with the session.');
    }
  }catch(err){toast(err.message||'Unable to share this window.')}
  finally{b.disabled=false;updateShareButton()}
};
function updateShareButton(){
  $('#share-screen').innerHTML=icon(localStream?'MonitorX':'MonitorUp',17)+(localStream?' Stop sharing':' Share a window');
  $('#share-screen').classList.toggle('is-sharing',!!localStream);
  $('#share-screen').setAttribute('aria-label',localStream?'Stop sharing':'Share a window');
  $('#share-screen').setAttribute('aria-pressed',String(!!localStream));
  capture?.syncSource();agentTools?.refresh();
}
function diagramModal(){modal(`<span class="modal-symbol">${icon('Workflow',25)}</span><h2 id="modal-title">Add a diagram</h2><p>Use Mermaid or PlantUML syntax.</p><form><label>Diagram language<select name="language" id="diagram-language"><option value="mermaid">Mermaid · renders in your browser</option><option value="plantuml">PlantUML · external renderer</option></select></label><label>Diagram source<textarea name="source" rows="8" spellcheck="false" required>flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]</textarea></label><label class="consent-label" id="plant-consent" hidden><input type="checkbox" name="consent">Allow sending this diagram to plantuml.com for rendering. Everyone in this room can see the result.</label><button class="primary modal-submit">Add to canvas ${icon('Plus',17)}</button></form>`,e=>{e.preventDefault();const vals=Object.fromEntries(new FormData(e.target));if(vals.language==='plantuml'&&!vals.consent){formError(e.target,'Allow external rendering to use PlantUML.');return}board.add('diagram',{source:vals.source,language:vals.language,externalConsent:vals.language==='plantuml',title:vals.language==='mermaid'?'Mermaid diagram':'PlantUML diagram',width:500,height:300});closeModal();chooseTool('select')});$('#diagram-language').onchange=e=>{$('#plant-consent').hidden=e.target.value!=='plantuml';const input=$('textarea[name=source]');input.value=e.target.value==='plantuml'?'@startuml\nAlice -> Bob: An idea\nBob --> Alice: Let’s build it\n@enduml':'flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]'}}
// Images sync to every peer, so large photos are resized and re-encoded in the browser first.
const IMAGE_EDGE=1600, MAX_IMAGE_URL=Math.floor(1.3*1024*1024*4/3);
function compactImage(file,image,url){
  // Re-encoding would drop the frames of an animated GIF.
  if(file.type==='image/gif'||(file.size<=256*1024&&Math.max(image.naturalWidth,image.naturalHeight)<=IMAGE_EDGE))return url;
  const scale=Math.min(1,IMAGE_EDGE/Math.max(image.naturalWidth,image.naturalHeight));
  const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const context=canvas.getContext?.('2d');if(!context)return url;
  context.drawImage(image,0,0,canvas.width,canvas.height);
  // Browsers that cannot encode WebP fall back to PNG, which is rarely smaller.
  const encoded=canvas.toDataURL('image/webp',.85);
  return encoded.startsWith('data:image/webp;')&&encoded.length<url.length?encoded:url;
}
async function addImage(file){
  const targetModel=shared;
  if(!file||!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)){toast('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');return}
  if(file.size>(file.type==='image/gif'?1.3:20)*1024*1024){toast(file.type==='image/gif'?'Choose a GIF smaller than 1.3 MB.':'Choose an image smaller than 20 MB.');return}
  try{
    const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('This image could not be opened.'));reader.readAsDataURL(file)});
    const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('This image could not be decoded.'));value.src=url});
    const compact=compactImage(file,image,url);
    if(compact.length>MAX_IMAGE_URL){toast('This image is still larger than 1.3 MB after resizing. Try a smaller one.');return}
    if(shared!==targetModel||board.readOnly){toast('The canvas changed. Choose the image again in this session.');return}
    const width=Math.min(460,image.naturalWidth);
    board.add('image',{url:compact,width,height:width*image.naturalHeight/image.naturalWidth,title:file.name});chooseTool('select');
  }catch(error){toast(error.message||'This image could not be added.')}
}
$('#image-input').onchange=e=>{addImage(e.target.files[0]);e.target.value=''};let dragDepth=0;const wrap=$('.canvas-wrap');wrap.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').classList.add('visible')}});wrap.addEventListener('dragleave',()=>{if(--dragDepth<=0)$('#drop-overlay').classList.remove('visible')});wrap.addEventListener('dragover',e=>e.preventDefault());wrap.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').classList.remove('visible');[...e.dataTransfer.files].slice(0,5).forEach(addImage)});
function tour(){modal(`<span class="modal-symbol">${icon('Sprout',25)}</span><h2 id="modal-title">Common ground.</h2><div class="tour-steps"><div>${icon('Link',21)}<span><strong>Create a session</strong>Invite your team with the session link and password.</span></div><div>${icon('MonitorUp',21)}<span><strong>Share a window</strong>Choose a window in your browser’s share picker. Use Watch window to view a teammate’s share.</span></div><div>${icon('Pencil',21)}<span><strong>Build on the canvas</strong>Add notes, images, drawings, and diagrams. Changes appear for everyone in the session.</span></div></div><p class="help-detail">Drag items to arrange them. Double-click text to edit. Use Pan (H) to move around the canvas. Some networks may block direct screen sharing.</p><button class="primary modal-submit" id="tour-done">Got it ${icon('Check',16)}</button>`);$('#tour-done').onclick=closeModal}
function showSessions(){modal(`<span class="modal-symbol">${icon('Layers',25)}</span><h2 id="modal-title">Recent sessions</h2><p>Saved on this device.</p><div class="sessions-list">${savedRooms().length?savedRooms().map(r=>`<a href="/room/${encodeURIComponent(r.id)}">${icon('Layers',18)}<span>${esc(r.name)}</span>${icon('ArrowUpRight',17)}</a>`).join(''):'<p>No recent sessions.</p>'}</div><button class="primary modal-submit" id="sessions-create">${icon('Plus',16)} Create a session</button>`);$('#sessions-create').onclick=createModal}
function roomMenu(){modal(`<h2 id="modal-title">Canvas options</h2><div class="menu-actions"><button class="button" id="export-canvas">${icon('Download',17)} Export canvas as SVG</button>${sandbox?'':`<button class="button" id="leave-room">${icon('LogOut',17)} Leave session</button>${auth.isAdmin?`<button class="button danger" id="end-room">${icon('CircleStop',17)} End session for everyone</button>`:''}`}</div>`);$('#export-canvas').onclick=async()=>{try{const result=board.exportSvg();const blob=result instanceof Blob?result:new Blob([result],{type:'image/svg+xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='common-canvas.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Canvas exported. Live screens are not included.');closeModal()}catch{toast('This canvas could not be exported.')}};$('#leave-room')?.addEventListener('click',()=>{intentionalClose=true;send({type:'leave'});sessionStorage.removeItem('common.auth.'+auth.room.id);media.destroy();location.href='/'});$('#end-room')?.addEventListener('click',()=>{modal(`<h2 id="modal-title">End this session?</h2><p>Ending the session disconnects everyone and deletes this room and its canvas. Export anything you want to keep first.</p><button class="primary danger-fill modal-submit" id="confirm-end">End session for everyone</button><button class="button modal-submit" id="cancel-end">Keep session open</button>`);$('#confirm-end').onclick=()=>{send({type:'end'});closeModal()};$('#cancel-end').onclick=closeModal})}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();chooseTool('select');return}if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||$('#modal-root').children.length||document.querySelector('dialog[open]'))return;if(e.ctrlKey||e.metaKey)return;const keys={v:'select',h:'hand',p:'draw',t:'text',n:'sticky',r:'rectangle',a:'arrow'};if(keys[e.key.toLowerCase()])chooseTool(keys[e.key.toLowerCase()]);});
window.addEventListener('beforeunload',()=>{disposed=true;clearTimeout(subscriptionTimer);subscriptionResizeObserver.disconnect();intentionalClose=true;capture?.destroy();walkthrough?.stop();agentTools?.destroy();media?.destroy();peerCanvas?.destroy();shared?.destroy();socket?.close()});window.addEventListener('popstate',()=>location.reload());
// Public, opt-in browser agent interface. It never exposes room credentials.
// Loaded in its own chunk so it never delays the first paint of the canvas.
async function loadAgentTools(){
const [{createAgentAPI},{CanvasCapture},{Walkthrough},{installAgentTools}]=await Promise.all([import('./agent-api.js'),import('./capture.js'),import('./walkthrough.js'),import('./agent-tools.js')]);
capture=new CanvasCapture({getBoard:()=>board,getSession:()=>shared,getWindowStream:()=>localStream,onChange:()=>agentTools?.refresh(),onStatus:toast});
capture.exportCanvas=(data,{mimeType,filename,download=false}={})=>{
  if(download){
    const objectUrl=URL.createObjectURL(new Blob([data],{type:mimeType}));
    const link=document.createElement('a');link.href=objectUrl;link.download=filename;link.click();
    setTimeout(()=>URL.revokeObjectURL(objectUrl),1000);
  }
  return {filename,mimeType};
};
walkthrough=new Walkthrough({getBoard:()=>board,onChange:()=>agentTools?.refresh(),onStatus:toast});
const agentAPI=createAgentAPI({
  getBoard:()=>board,getModel:()=>shared,
  getContext:()=>({enabled:agentControlEnabled,sandbox,connected,room:sandbox?null:{id:auth?.room.id,name:roomName},participantId:ownParticipantId(),participants:sandbox?[]:participants}),
  recording:capture,walkthrough,onStatus:toast
});
Object.defineProperty(window,'commonAgent',{value:agentAPI,writable:false,configurable:false});
document.documentElement.dataset.commonAgent='1';
agentTools=installAgentTools({
  api:agentAPI,capture,walkthrough,getEnabled:()=>agentControlEnabled,
  onEnabledChange:enabled=>{agentControlEnabled=!!enabled;window.dispatchEvent(new CustomEvent('common-agent-ready',{detail:{version:'1',enabled:agentControlEnabled}}))},
  onRequestWindowShare:()=>$('#share-screen').click(),onStatus:toast,buttonParent:$('.top-actions')
});
window.dispatchEvent(new CustomEvent('common-agent-ready',{detail:{version:'1',enabled:false}}));
}
loadAgentTools().catch(()=>toast('Agent tools could not be loaded. Reload to try again.'));
const path=location.pathname.match(/^\/room\/([^/]+)$/);if(path)joinFromPath(decodeURIComponent(path[1]));
