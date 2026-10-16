import './style.css';
import './board.css';
import {createElement, Check, PanelsTopLeft, ChevronsUpDown, Plus, LayoutDashboard, Layers, Clock3, ArrowUpRight, Settings2, ChevronRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, Shapes, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Trash2, Minus, Scan, ShieldCheck, Sprout, Lightbulb, MessagesSquare, ArrowUp, Sparkles, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Files, Link, Download, LogOut, CircleStop, Circle} from 'lucide';
const icons={Check, PanelsTopLeft, ChevronsUpDown, Plus, LayoutDashboard, Layers, Clock3, ArrowUpRight, Settings2, ChevronRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, Shapes, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Trash2, Minus, Scan, ShieldCheck, Sprout, Lightbulb, MessagesSquare, ArrowUp, Sparkles, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Files, Link, Download, LogOut, CircleStop, Circle};
import {Board} from './board.js';
import {ScreenSharing} from './media.js';
import {SharedCanvas} from './shared-canvas.js';
import {PeerCanvas} from './peer-canvas.js';
import {PollingSessionTransport} from './session-transport.js';
import {initGeometry, geometryBackend} from './geometry.js';
import {createAgentAPI} from './agent-api.js';
import {CanvasCapture} from './capture.js';
import {Walkthrough} from './walkthrough.js';
import {installAgentTools} from './agent-tools.js';

const $=s=>document.querySelector(s);
const icon=(name,size=18)=>{const node=createElement(icons[name]||icons.Circle,{width:size,height:size,'stroke-width':1.7});return node.outerHTML};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
let shared=null, peerCanvas=null, receivingCanvas=false;
let capture=null, walkthrough=null, agentTools=null, agentControlEnabled=false;
let board, socket, media, auth=null, participants=[], chat=[], connected=false, localStream=null, reconnectTimer, intentionalClose=false, roomSeeded=false;
let rightPanel='people', tool='select', roomName='A little room for big ideas', sandbox=true, startedAt=Date.now(), activeColor='#305e48';
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
 {id:'welcome',type:'text',x:88,y:62,width:550,height:122,text:'Good things happen\nwhen we think together.',fontSize:35,color:'#283f32',title:'START HERE',z:1},
 {id:'note',type:'sticky',x:91,y:239,width:258,height:230,text:'One space. All your ideas.\n\nShare a window, sketch a thought, or leave a little note.\n\nMake yourself at home.',color:'#344a30',fill:'#edf1cb',fontSize:18,z:2},
 {id:'flow-title',type:'text',x:431,y:244,width:350,height:56,text:'From a spark to something real',fontSize:18,color:'#3d5144',z:1},
 {id:'flow1',type:'rectangle',x:438,y:320,width:130,height:64,text:'An idea',color:'#78927b',fill:'#f9faf4',z:2},
 {id:'arrow1',type:'arrow',x:573,y:351,width:65,height:1,color:'#829480',points:[{x:0,y:0},{x:65,y:0}],z:1},
 {id:'flow2',type:'rectangle',x:645,y:320,width:155,height:64,text:'A conversation',color:'#78927b',fill:'#e8efdf',z:2},
 {id:'arrow2',type:'arrow',x:806,y:351,width:65,height:1,color:'#829480',points:[{x:0,y:0},{x:65,y:0}],z:1},
 {id:'flow3',type:'rectangle',x:878,y:320,width:148,height:64,text:'What’s next?',color:'#78927b',fill:'#dce8d1',z:2},
 {id:'tip',type:'text',x:454,y:434,width:500,height:70,text:'A thought is better with a second pair of eyes.\nInvite your people and find your next step.',fontSize:16,color:'#7b8777',z:1}
];

$('#app').innerHTML=`
<aside class="sidebar">
 <a class="brand" href="/" aria-label="Common home"><span class="brand-mark">${icon('PanelsTopLeft',23)}</span>common<span class="brand-dot">®</span></a>
 <div class="workspace-switch"><span class="workspace-avatar">S</span><div><strong>Your workspace</strong><span>A place to think together</span></div>${icon('ChevronsUpDown',15)}</div>
 <button class="new-session primary" id="new-session">${icon('Plus',17)} New session</button>
 <div class="nav-label">WORKSPACE</div>
 <button class="nav-item active" id="sandbox-nav">${icon('LayoutDashboard')} Your canvas <span class="nav-badge">1</span></button>
 <button class="nav-item" id="sessions-nav">${icon('Layers')} Your sessions <span class="recent-count">0</span></button>
 <div class="recent-block"><div class="nav-label">RECENT SESSIONS <span>${icon('Clock3',13)}</span></div><div id="recent-rooms"></div></div>
 <div class="sidebar-bottom"><div class="together-graphic"><i></i><i></i><i></i><span>✦</span></div><h3>Better, together.</h3><p>A shared space for your next<br>“oh, I see it now.”</p><button id="how-it-works">A little tour ${icon('ArrowUpRight',14)}</button></div>
 <div class="user-block"><div class="avatar user-avatar">Y</div><div><strong>You</strong><span>Personal workspace</span></div><button class="icon-button" id="settings" aria-label="Workspace help">${icon('Settings2',17)}</button></div>
</aside>
<main class="main">
 <header class="topbar"><div class="breadcrumb">Workspace ${icon('ChevronRight',13)} <strong id="breadcrumb-room">Your canvas</strong></div><div class="top-actions"><span class="privacy-label">${icon('LockKeyhole',13)} <span id="privacy-status">Only you</span></span><button class="button invite-button" id="invite">${icon('UserPlus',16)} Invite people</button><button class="icon-button help" id="help" aria-label="Help">${icon('CircleHelp',20)}</button></div></header>
 <section class="session-header"><div><div class="eyebrow"><span class="small-dot"></span><span id="session-kind">YOUR PERSONAL CANVAS</span></div><div class="title-row"><h1 id="room-title">A little room for big ideas</h1><button class="icon-button" id="room-menu" aria-label="Session options">${icon('Ellipsis',21)}</button></div><p id="room-subtitle">Bring your screens, your sketches, and your next big thought.</p></div><div class="session-actions"><div class="presence" id="header-presence"><span class="avatar avatar-small">Y</span><span id="member-count">Just you for now</span></div><button class="primary share-button" id="share-screen">${icon('MonitorUp',17)} Share a window</button></div></section>
 <div class="canvas-bar"><div class="canvas-tabs"><button class="canvas-tab active">${icon('Shapes',16)} Shared canvas <span class="tiny-label">BETA</span></button></div><div class="canvas-status"><span id="connection-status">${icon('CloudUpload',15)} Saved on this device</span><button class="icon-button" id="toggle-panel" aria-label="Toggle participants panel">${icon('PanelRight',17)}</button></div></div>
 <section class="workspace-area">
 <div class="canvas-wrap"><div id="board-viewport" aria-label="Collaborative canvas"></div><div id="remote-cursors"></div>
 <div class="canvas-top-hint"><span class="hint-icon">${icon('MousePointer2',13)}</span><span id="canvas-hint">A blank space. A fresh perspective.</span></div>
 <div class="canvas-toolbar" role="toolbar" aria-label="Canvas tools">${[['select','MousePointer2','Select (V)'],['hand','Hand','Pan (H)'],['draw','Pencil','Draw (P)'],['text','Type','Text (T)'],['sticky','StickyNote','Sticky note (N)'],['rectangle','Square','Rectangle (R)'],['arrow','MoveUpRight','Arrow (A)'],['image','ImagePlus','Upload image'],['diagram','Workflow','Add diagram']].map(([id,i,label],n)=>`${n===2||n===7?'<span class="tool-divider"></span>':''}<button class="tool ${id==='select'?'selected':''}" data-tool="${id}" aria-label="${label}" title="${label}">${icon(i,20)}</button>`).join('')}<span class="tool-divider"></span><input type="color" value="#305e48" id="tool-color" title="Drawing color" aria-label="Drawing color"></div>
 <div class="selection-tools" id="selection-tools" hidden><span id="selection-name"></span><button id="duplicate-selection" class="icon-button" aria-label="Duplicate selected item">${icon('Copy',16)}</button><button id="delete-selection" class="icon-button" aria-label="Delete selected item">${icon('Trash2',16)}</button></div>
 <div class="canvas-bottom"><div class="canvas-powered"><span class="small-dot"></span><span id="engine-label">Loading canvas engine</span></div><div class="zoom-controls"><button class="icon-button" id="zoom-out" aria-label="Zoom out">${icon('Minus',15)}</button><button id="zoom-label" title="Reset zoom">100%</button><button class="icon-button" id="zoom-in" aria-label="Zoom in">${icon('Plus',15)}</button><span></span><button class="icon-button" id="fit-canvas" aria-label="Fit canvas to view">${icon('Scan',16)}</button></div></div>
 <div class="drop-overlay" id="drop-overlay">${icon('ImagePlus',40)}<strong>Drop an image into the conversation</strong></div>
 </div>
 <aside class="right-panel" id="right-panel"><div class="panel-tabs"><button class="panel-tab active" data-panel="people">People <span id="people-number">1</span></button><button class="panel-tab" data-panel="chat">Chat <span id="chat-number" hidden>0</span></button></div><div id="panel-content"></div></aside>
 </section>
 <footer class="footer"><span>${icon('ShieldCheck',13)} <span id="footer-access">Your ideas have a little space of their own.</span></span><span id="footer-tip">A little less presenting. A little more creating.</span></footer>
</main><input type="file" id="image-input" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" hidden>`;

board=new Board({
  el:$('#board-viewport'),
  canEdit:entity=>entity.type!=='screen'||sandbox||entity.participantId===auth?.participantId,
  onChange:(entity,patch)=>{if(!shared?.setLocal(entity,patch))refreshCanvas()},
  onDelete:id=>{shared?.deleteLocal(id);stopDeletedLocalScreen()},
  onLayerAction:(id,action)=>shared?.reorder(id,action),
  onLockChange:(id,locked)=>shared?.patch(id,{locked}),
  onCursor:({x,y})=>{if(!sandbox&&connected)send({type:'cursor',x,y})},
  onSelect:entity=>{const bar=$('#selection-tools');bar.hidden=!entity;if(entity)$('#selection-name').textContent=entity.type==='sticky'?'Sticky note':entity.type[0].toUpperCase()+entity.type.slice(1);agentTools?.refresh()},
  onStatus:toast,onToolChange:next=>chooseTool(next),
  onViewChange:view=>{$('#zoom-label').textContent=Math.round(view.zoom*100)+'%'}
});
function isPeerRoom(){return !sandbox&&auth?.room?.collaboration==='peer'}
function refreshCanvas(){if(shared){board.setEntities(shared.all());board.setLayerOrder(shared.getOrder())}}
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
      if(sandbox)saveSandbox();else if(!isPeerRoom()&&!receivingCanvas)send({type:'upsert',entity});
    },
    onDelete:id=>{
      board.remove(id);board.setLayerOrder(shared.getOrder());stopDeletedLocalScreen();
      if(sandbox)saveSandbox();else if(!isPeerRoom()&&!receivingCanvas)send({type:'delete',id});
    },
    onUpdate:(update,origin)=>{if(isPeerRoom())peerCanvas?.broadcast(update,origin)},
    onInvalid:error=>toast(error.message)
  });
  board.setEntities([]);board.setLayerOrder([]);
}
function receiveCanvas(action){receivingCanvas=true;try{return action()}finally{receivingCanvas=false}}

function saveSandbox(){try{localStorage.setItem('common.canvas',JSON.stringify([...board.entities.values()].filter(e=>e.type!=='screen')))}catch{toast('This device’s canvas storage is full. Export your canvas to keep these changes.')}}
function loadSandbox(){let data;try{data=JSON.parse(localStorage.getItem('common.canvas'))}catch{}makeCanvasModel();shared.replaceInitial(data||seed());renderPeople();renderRecent();if(innerWidth<720)$('#right-panel').classList.add('collapsed');if(!data)requestAnimationFrame(()=>board.fit())}
loadSandbox();
setupMedia();
initGeometry().then(ok=>{$('#engine-label').textContent=ok?'Powered by WebAssembly':'Canvas ready';$('#engine-label').title=geometryBackend()});

function chooseTool(next){if(next==='image'){$('#image-input').click();return}if(next==='diagram'){diagramModal();return}tool=next;board.setTool(next);document.querySelectorAll('[data-tool]').forEach(e=>e.classList.toggle('selected',e.dataset.tool===next));$('#canvas-hint').textContent=({select:'A blank space. A fresh perspective.',hand:'Drag the canvas to explore.',draw:'Draw a thought. Let it take shape.',text:'Click anywhere to add a little context.',sticky:'Click anywhere to leave a thought.',rectangle:'Click and drag to draw a box.',arrow:'Click and drag to connect your ideas.'})[next]||''}
document.querySelectorAll('[data-tool]').forEach(e=>e.onclick=()=>chooseTool(e.dataset.tool));
$('#tool-color').oninput=e=>{activeColor=e.target.value;board.setColor(activeColor)};
$('#zoom-in').onclick=()=>board.setZoom(Math.min(2,board.getView().zoom+.1));$('#zoom-out').onclick=()=>board.setZoom(Math.max(.25,board.getView().zoom-.1));$('#zoom-label').onclick=()=>board.setZoom(1);$('#fit-canvas').onclick=()=>board.fit();
$('#delete-selection').onclick=()=>board.deleteSelected();$('#duplicate-selection').onclick=()=>board.duplicateSelected();
$('#toggle-panel').onclick=()=>{$('#right-panel').classList.toggle('collapsed');$('#toggle-panel').setAttribute('aria-expanded',String(!$('#right-panel').classList.contains('collapsed')))};
$('#new-session').onclick=()=>createModal();$('#invite').onclick=()=>sandbox?createModal():inviteModal();$('#how-it-works').onclick=tour;$('#help').onclick=tour;$('#settings').onclick=tour;$('#sessions-nav').onclick=showSessions;$('#sandbox-nav').onclick=()=>{if(sandbox)board.fit();else location.href='/'};
$('#room-menu').onclick=roomMenu;
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>{rightPanel=b.dataset.panel;document.querySelectorAll('[data-panel]').forEach(e=>e.classList.toggle('active',e===b));renderPanel()});
function renderPanel(){rightPanel==='people'?renderPeople():renderChat()}
function renderPeople(){if(rightPanel!=='people')return;const list=sandbox?[{id:'local',name:'You',color:'#365f4a',isAdmin:true}]:participants;$('#panel-content').innerHTML=`<div class="panel-heading"><span>IN THIS SPACE</span><span>${list.length} / 10</span></div><div class="people-list">${list.map(p=>`<div class="person"><span class="avatar" style="--avatar-color:${esc(p.color)}">${esc(p.name.slice(0,1).toUpperCase())}</span><div><strong>${esc(p.name)} ${p.id===auth?.participantId||sandbox?'<span class="you-tag">(you)</span>':''}</strong><small>${p.isAdmin?'Host':'Team member'}</small></div><span class="person-online" title="Online"></span></div>`).join('')}</div><button class="invite-dashed" id="panel-invite">${icon('Plus',15)} Bring someone in</button><div class="room-note"><div class="note-symbol">${icon('Sprout',23)}</div><strong>Ideas grow here.</strong><p>Share a window. Draw a connection. See something differently.</p><div class="note-rule"></div><span>Up to 10 curious minds.<br>One shared canvas.</span></div><div class="panel-bottom-tip">${icon('Lightbulb',15)} <span>Double-click a note or text<br>to make it your own.</span></div>`;$('#panel-invite').onclick=()=>sandbox?createModal():inviteModal()}
function renderChat(){if(rightPanel!=='chat')return;$('#panel-content').innerHTML=`<div class="chat-messages" id="chat-messages">${chat.length?chat.map(m=>`<div class="chat-message"><div><strong>${esc(m.name)}</strong><time>${new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>${esc(m.text)}</p></div>`).join(''):`<div class="chat-empty">${icon('MessagesSquare',30)}<strong>A conversation starts here.</strong><p>${sandbox?'Create a session to chat with your team.':'A quick question, a useful link, a little context.'}</p></div>`}</div><form id="chat-form"><label class="sr-only" for="chat-text">Message your team</label><input id="chat-text" maxlength="2000" placeholder="A thought to share…" autocomplete="off" ${sandbox?'disabled':''}><button aria-label="Send message" ${sandbox?'disabled':''}>${icon('ArrowUp',17)}</button></form>`;$('#chat-form').onsubmit=e=>{e.preventDefault();const input=$('#chat-text');if(input.value.trim()){if(!connected){toast('Reconnect to send your message.');return}send({type:'chat',text:input.value.trim()});input.value=''}};const m=$('#chat-messages');m.scrollTop=m.scrollHeight}
function updatePresence(){const count=sandbox?1:participants.length;$('#member-count').textContent=count===1?'Just you for now':`${count} minds in the room`;$('#people-number').textContent=count;const avatar=$('#header-presence .avatar');avatar.textContent=auth?.isAdmin?'Y':auth?.displayName?.slice(0,1)||'Y';renderPanel()}
function renderRecent(){$('.recent-count').textContent=savedRooms().length;$('#recent-rooms').innerHTML=savedRooms().length?savedRooms().slice(0,4).map(r=>`<a class="recent-room" href="/room/${encodeURIComponent(r.id)}"><span class="room-dot"></span><span>${esc(r.name)}</span>${icon('ArrowUpRight',12)}</a>`).join(''):'<p class="no-recent">Your next session starts here.</p>'}
function createModal(){modal(`<span class="modal-symbol">${icon('Sparkles',25)}</span><div class="eyebrow">MAKE A LITTLE SPACE</div><h2 id="modal-title">Good ideas need good company.</h2><p>Start a private session and bring up to nine teammates along.</p><form id="create-form"><label>Session name<input name="name" placeholder="e.g. Friday’s next big idea" maxlength="60" required value="Team thinking space"></label><label>Your name<input name="displayName" placeholder="What should we call you?" maxlength="60" required autocomplete="given-name"></label><label>Room password<span class="field-help">Share this with your team separately.</span><input name="password" type="password" minlength="8" maxlength="128" placeholder="At least 8 characters" required autocomplete="new-password"></label><button class="primary modal-submit">Create session ${icon('ArrowRight',17)}</button><small class="form-footnote">${icon('LockKeyhole',12)} A link gets them here. A password lets them in.</small></form>`,async e=>{e.preventDefault();const form=e.target;const b=form.querySelector('button');b.disabled=true;b.textContent='Making space…';try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms',{...vals,collaboration:'peer'});result.displayName=vals.displayName;sessionStorage.setItem('common.auth.'+result.room.id,JSON.stringify(result));saveRoom(result.room);closeModal();await enterRoom(result,true);inviteModal()}catch(err){formError(form,err.message);b.disabled=false;b.innerHTML='Create session '+icon('ArrowRight',17)}})}
function inviteModal(){const url=location.origin+'/room/'+auth.room.id;modal(`<span class="modal-symbol">${icon('UserPlus',25)}</span><div class="eyebrow">MAKE ROOM FOR YOUR PEOPLE</div><h2 id="modal-title">Better with a few more minds.</h2><p>Anyone with this link and your room password can join.<br>The room holds up to 10 people, including you.</p><label class="link-label">SESSION LINK<div class="copy-field"><input id="invite-link" readonly value="${esc(url)}"><button class="button" id="copy-link">${icon('Copy',16)} Copy</button></div></label><div class="invite-password">${icon('LockKeyhole',17)}<div><strong>Share the password separately.</strong><span>Your password is never included in the link.</span></div></div><button class="primary modal-submit" id="done-invite">Back to our space ${icon('ArrowRight',16)}</button>`);$('#copy-link').onclick=async()=>{try{await navigator.clipboard.writeText(url);$('#copy-link').innerHTML=icon('Check',16)+' Copied';toast('Session link copied')}catch{$('#invite-link').select();toast('Select and copy the session link')}};$('#done-invite').onclick=closeModal}
async function joinFromPath(id){let saved;try{saved=JSON.parse(sessionStorage.getItem('common.auth.'+id))}catch{}if(saved){await enterRoom(saved);return}let room;try{({room}=await api('/api/rooms/'+encodeURIComponent(id)))}catch(err){toast(err.message);if(!sandbox){location.replace('/');return}history.replaceState(null,'','/');return}modal(`<span class="modal-symbol">${icon('DoorOpen',26)}</span><div class="eyebrow">THERE’S A PLACE FOR YOU</div><h2 id="modal-title">${esc(room.name)}</h2><p>Your team is just a password away.</p><form><label>Your name<input name="displayName" placeholder="What should we call you?" maxlength="60" autocomplete="given-name" required></label><label>Room password<input name="password" type="password" required autocomplete="current-password" placeholder="The password from your host"></label><button class="primary modal-submit">Join the conversation ${icon('ArrowRight',17)}</button></form>`,async e=>{e.preventDefault();const form=e.target,b=form.querySelector('button');b.disabled=true;try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms/'+encodeURIComponent(id)+'/join',vals);result.displayName=vals.displayName;sessionStorage.setItem('common.auth.'+id,JSON.stringify(result));saveRoom(result.room);closeModal();await enterRoom(result)}catch(err){formError(form,err.message);b.disabled=false}})}
async function enterRoom(result,isNew=false){
  capture?.stop().catch(()=>{});walkthrough?.stop();
  intentionalClose=true;clearTimeout(reconnectTimer);socket?.close();media?.destroy();
  auth=result;sandbox=false;intentionalClose=false;localStream=null;roomSeeded=!isNew;
  makeCanvasModel();roomName=result.room.name;startedAt=Date.now();
  history.pushState(null,'','/room/'+result.room.id);
  $('#room-title').textContent=roomName;$('#breadcrumb-room').textContent=roomName;
  $('#session-kind').textContent='A LIVE SPACE TO THINK TOGETHER';$('#privacy-status').textContent='Password protected';
  $('#room-subtitle').textContent='Different windows. Shared perspective. Everyone’s invited to create.';
  $('#footer-access').textContent=isPeerRoom()?'Shared directly between browsers · Up to 10 people':'Password-protected room · Up to 10 people';
  document.title=roomName+' — Common';$('#sandbox-nav').classList.remove('active');$('#sessions-nav').classList.add('active');
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
  const text=!connected?'Reconnecting…':isPeerRoom()?(participants.length<=1?'Live · Connected':count?`Live · Connected · ${count} ${count===1?'peer':'peers'}`:'Live · Connected · finding peers…'):'Live · Connected';
  $('#connection-status').innerHTML=icon(connected?'CloudUpload':'CloudOff',15)+' '+text;
}
function setConnection(status){
  connected=status==='connected';board.setReadOnly(!sandbox&&!connected);
  $('#connection-status').classList.toggle('disconnected',!connected);updateCanvasStatus();
  agentTools?.refresh();
}
function syncPeople(){
  media.syncParticipants(participants,auth.participantId);updatePresence();updateCanvasStatus();
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
          shared.replaceInitial([{id:uid(),type:'text',x:120,y:85,width:600,height:110,text:'A little space for\nsomething great.',fontSize:34,color:'#2b4936',z:1},{id:uid(),type:'sticky',x:125,y:252,width:270,height:210,text:'What are we thinking about?\n\nStart here. Add a thought, share a window, or sketch your next idea.',fontSize:18,color:'#364c31',fill:'#edf1cb',z:2}]);
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
        modal(`<span class="modal-symbol">${icon('Sunset',25)}</span><h2 id="modal-title">A good place to leave it.</h2><p>The host ended this session. Thanks for bringing your perspective.</p><button class="primary modal-submit" id="back-home">Back to your canvas ${icon('ArrowRight',16)}</button>`);
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
      toast(sandbox?'Your selected window is on your private canvas.':'Your selected window is now shared with the room.');
    }
  }catch(err){toast(err.message||'Unable to share this window.')}
  finally{b.disabled=false;updateShareButton()}
};
function updateShareButton(){
  $('#share-screen').innerHTML=icon(localStream?'MonitorX':'MonitorUp',17)+(localStream?' Stop sharing':' Share a window');
  $('#share-screen').classList.toggle('is-sharing',!!localStream);
  capture?.syncSource();agentTools?.refresh();
}
function diagramModal(){modal(`<span class="modal-symbol">${icon('Workflow',25)}</span><h2 id="modal-title">A little structure for your ideas.</h2><p>Turn a few lines of text into a shared diagram.</p><form><label>Diagram language<select name="language" id="diagram-language"><option value="mermaid">Mermaid · renders in your browser</option><option value="plantuml">PlantUML · external renderer</option></select></label><label>Diagram source<textarea name="source" rows="8" spellcheck="false" required>flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]</textarea></label><label class="consent-label" id="plant-consent" hidden><input type="checkbox" name="consent">Allow sending this diagram to plantuml.com for rendering. Everyone in this room can see the result.</label><button class="primary modal-submit">Add to canvas ${icon('Plus',17)}</button></form>`,e=>{e.preventDefault();const vals=Object.fromEntries(new FormData(e.target));if(vals.language==='plantuml'&&!vals.consent){formError(e.target,'Allow external rendering to use PlantUML.');return}board.add('diagram',{source:vals.source,language:vals.language,externalConsent:vals.language==='plantuml',title:vals.language==='mermaid'?'Mermaid diagram':'PlantUML diagram',width:500,height:300});closeModal();chooseTool('select')});$('#diagram-language').onchange=e=>{$('#plant-consent').hidden=e.target.value!=='plantuml';const input=$('textarea[name=source]');input.value=e.target.value==='plantuml'?'@startuml\nAlice -> Bob: An idea\nBob --> Alice: Let’s build it\n@enduml':'flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]'}}
async function addImage(file){
  const targetModel=shared;
  if(!file||!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)){toast('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');return}
  if(file.size>1.3*1024*1024){toast('Choose an image smaller than 1.3 MB.');return}
  try{
    const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('This image could not be opened.'));reader.readAsDataURL(file)});
    const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('This image could not be decoded.'));value.src=url});
    if(shared!==targetModel||board.readOnly){toast('The canvas changed. Choose the image again in this session.');return}
    const width=Math.min(460,image.naturalWidth);
    board.add('image',{url,width,height:width*image.naturalHeight/image.naturalWidth,title:file.name});chooseTool('select');
  }catch(error){toast(error.message||'This image could not be added.')}
}
$('#image-input').onchange=e=>{addImage(e.target.files[0]);e.target.value=''};let dragDepth=0;const wrap=$('.canvas-wrap');wrap.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').classList.add('visible')}});wrap.addEventListener('dragleave',()=>{if(--dragDepth<=0)$('#drop-overlay').classList.remove('visible')});wrap.addEventListener('dragover',e=>e.preventDefault());wrap.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').classList.remove('visible');[...e.dataTransfer.files].slice(0,5).forEach(addImage)});
function tour(){modal(`<span class="modal-symbol">${icon('Sprout',27)}</span><div class="eyebrow">A LITTLE TOUR</div><h2 id="modal-title">Find your common ground.</h2><p>One shared canvas. A few curious minds. Plenty of possibilities.</p><div class="tour-steps"><div>${icon('Link',21)}<span><strong>Make a space.</strong>Create a session, then share its link and password.</span></div><div>${icon('MonitorUp',21)}<span><strong>Bring your perspective.</strong>Choose a window with the browser’s share picker. Everyone can share one at once.</span></div><div>${icon('Pencil',21)}<span><strong>Think out loud.</strong>Add notes, images, boxes, arrows, or diagrams. Every change appears for the whole room.</span></div></div><p class="help-detail">Drag an item to move it. Double-click text to edit. Use the hand tool to pan, and the controls below to zoom. Sharing needs HTTPS or localhost; restrictive networks may need a TURN server.</p><button class="primary modal-submit" id="tour-done">Let’s make something ${icon('ArrowRight',16)}</button>`);$('#tour-done').onclick=closeModal}
function showSessions(){modal(`<span class="modal-symbol">${icon('Layers',25)}</span><h2 id="modal-title">A space worth coming back to.</h2><p>Your recent sessions on this device.</p><div class="sessions-list">${savedRooms().length?savedRooms().map(r=>`<a href="/room/${encodeURIComponent(r.id)}">${icon('Layers',18)}<span>${esc(r.name)}</span>${icon('ArrowUpRight',17)}</a>`).join(''):'<p>No sessions yet. Start a little something.</p>'}</div><button class="primary modal-submit" id="sessions-create">${icon('Plus',16)} Create a session</button>`);$('#sessions-create').onclick=createModal}
function roomMenu(){modal(`<h2 id="modal-title">Your space, your way.</h2><div class="menu-actions"><button class="button" id="export-canvas">${icon('Download',17)} Export canvas as SVG</button>${sandbox?'':`<button class="button" id="leave-room">${icon('LogOut',17)} Leave session</button>${auth.isAdmin?`<button class="button danger" id="end-room">${icon('CircleStop',17)} End session for everyone</button>`:''}`}</div>`);$('#export-canvas').onclick=async()=>{try{const result=board.exportSvg();const blob=result instanceof Blob?result:new Blob([result],{type:'image/svg+xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='common-canvas.svg';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Canvas exported. Live screens are not included.');closeModal()}catch{toast('This canvas could not be exported.')}};$('#leave-room')?.addEventListener('click',()=>{intentionalClose=true;send({type:'leave'});sessionStorage.removeItem('common.auth.'+auth.room.id);media.destroy();location.href='/'});$('#end-room')?.addEventListener('click',()=>{modal(`<h2 id="modal-title">Call it a good session?</h2><p>Ending the session disconnects everyone and deletes this room and its canvas. Export anything you want to keep first.</p><button class="primary danger-fill modal-submit" id="confirm-end">End session for everyone</button><button class="button modal-submit" id="cancel-end">Keep thinking</button>`);$('#confirm-end').onclick=()=>{send({type:'end'});closeModal()};$('#cancel-end').onclick=closeModal})}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();chooseTool('select');return}if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||$('#modal-root').children.length||document.querySelector('dialog[open]'))return;if(e.ctrlKey||e.metaKey)return;const keys={v:'select',h:'hand',p:'draw',t:'text',n:'sticky',r:'rectangle',a:'arrow'};if(keys[e.key.toLowerCase()])chooseTool(keys[e.key.toLowerCase()]);});
window.addEventListener('beforeunload',()=>{intentionalClose=true;capture?.destroy();walkthrough?.stop();agentTools?.destroy();media?.destroy();peerCanvas?.destroy();shared?.destroy();socket?.close()});window.addEventListener('popstate',()=>location.reload());
// Public, opt-in browser agent interface. It never exposes room credentials.
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
const path=location.pathname.match(/^\/room\/([^/]+)$/);if(path)joinFromPath(decodeURIComponent(path[1]));
