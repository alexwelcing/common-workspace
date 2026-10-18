import './style.css';
import './board.css';
import {createElement, Check, Plus, LayoutDashboard, Layers, ArrowUpRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Minus, Scan, Sprout, MessagesSquare, ArrowUp, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Link, Download, LogOut, CircleStop, Circle, X} from 'lucide';
const icons={Check, Plus, LayoutDashboard, Layers, ArrowUpRight, LockKeyhole, UserPlus, CircleHelp, Ellipsis, MonitorUp, CloudUpload, PanelRight, MousePointer2, Hand, Pencil, Type, StickyNote, Square, MoveUpRight, ImagePlus, Workflow, Copy, Minus, Scan, Sprout, MessagesSquare, ArrowUp, ArrowRight, DoorOpen, CloudOff, Sunset, MonitorX, Link, Download, LogOut, CircleStop, Circle, X};
import {Board} from './board.js';
import {ScreenSharing} from './media.js';
import {ScreenShareControls} from './sharing-controls.js';
import {SharedCanvas} from './shared-canvas.js';
import {PeerCanvas} from './peer-canvas.js';
import {ScreenSubscriptions} from './screen-subscriptions.js';
import {PollingSessionTransport} from './session-transport.js';
import {initGeometry, geometryBackend} from './geometry.js';
import {getRuntimeConfig, loadRuntimeConfig, cancelRuntimeConfigLoad} from './runtime-config.js';
import {DiagnosticLog, buildDiagnosticReport} from './diagnostics.js';
import {appBasePath, appPath, appURL, appWebSocketURL, appRoute, appStorageKey} from './app-path.js';

const diagnostics=new DiagnosticLog();
async function refreshRuntimeConfiguration(){
  const config=await loadRuntimeConfig({fetch:diagnosticFetch});
  if(disposed)return config;
  diagnostics.record('config',{state:config.available?'config-ready':'config-unavailable'});
  for(const entity of board?.entities?.values?.()||[])if(entity.type==='diagram'&&entity.language==='plantuml'){
    const node=board.nodes.get(entity.id);if(node)node._signature=null;board.renderEntity(entity);
  }
  return config;
}
const runtimeConfigReady=refreshRuntimeConfiguration();

const $=s=>document.querySelector(s);
const icon=(name,size=18)=>{const node=createElement(icons[name]||icons.Circle,{width:size,height:size,'stroke-width':1.7});return node.outerHTML};
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid=()=>crypto.randomUUID();
let shared=null, peerCanvas=null, receivingCanvas=false;
let capture=null, walkthrough=null, agentTools=null, agentControlEnabled=false, agentPermissions=null, webMCP=null, sharingControls=null;
let board, socket, media, auth=null, participants=[], chat=[], connected=false, localStream=null, reconnectTimer, intentionalClose=false, roomSeeded=false;
let rightPanel='people', roomName='Your canvas', sandbox=true, activeColor='#305e48';
const screenSubscriptions=new ScreenSubscriptions();
let subscriptionTimer, disposed=false, embedVisible=true, sessionGeneration=0, roomLookupGeneration=0, modalRevision=0, destroyPromise=null, disconnectExports=null, initialFitNeeded=false;
const mainEvents=new AbortController(), appTimers=new Set(), appFrames=new Set(), activeRequests=new Set(), objectUrls=new Set(), embedListeners=new Set(), visibilityListeners=new Set();
const sessionVisibility={
  get hidden(){return document.hidden||!embedVisible},
  addEventListener(type,listener){if(type==='visibilitychange')visibilityListeners.add(listener);document.addEventListener(type,listener)},
  removeEventListener(type,listener){if(type==='visibilitychange')visibilityListeners.delete(listener);document.removeEventListener(type,listener)}
};
function embedState(){
  const sharing=!disposed&&!!localStream?.getVideoTracks?.().some(track=>track.readyState==='live');
  const recording=!disposed&&['starting','recording','stopping'].includes(capture?.status().state);
  return Object.freeze({destroyed:disposed,visible:!disposed&&embedVisible&&!document.hidden,connected:!disposed&&connected,sharing,recording,hasCapture:sharing||recording});
}
let lastEmbedState='';
function publishEmbedState(){const state=embedState(),key=JSON.stringify(state);if(key===lastEmbedState)return;lastEmbedState=key;for(const listener of Array.from(embedListeners))try{listener(state)}catch{}}
function fitInitialCanvas(){if(!disposed&&initialFitNeeded&&board?.el.clientWidth>0&&board.el.clientHeight>0){board.fit();initialFitNeeded=false}}
function setEmbedVisible(visible){if(disposed)return embedState();embedVisible=Boolean(visible);if(!embedVisible&&media?.getCaptureState().requestPending)media.stop();if(embedVisible&&initialFitNeeded)nextFrame(fitInitialCanvas);syncScreenSubscriptions();for(const listener of Array.from(visibilityListeners))try{listener(new Event('visibilitychange'))}catch{}publishEmbedState();return embedState()}
function destroyCommon(){
  if(destroyPromise)return destroyPromise;
  let finish;destroyPromise=new Promise(resolve=>{finish=resolve});
  disposed=true;embedVisible=false;connected=false;intentionalClose=true;sessionGeneration++;agentControlEnabled=false;
  const stopping=capture?.stop().catch(()=>{});
  mainEvents.abort();cancelLater(reconnectTimer);cancelLater(subscriptionTimer);cancelRuntimeConfigLoad();
  for(const timer of appTimers)clearTimeout(timer);appTimers.clear();
  for(const frame of appFrames)cancelAnimationFrame(frame);appFrames.clear();
  for(const request of activeRequests)request.abort();activeRequests.clear();
  subscriptionResizeObserver.disconnect();
  webMCP?.destroy();agentPermissions?.destroy();agentTools?.destroy();walkthrough?.stop();capture?.destroy();
  disconnectExports?.();
  if(socket){socket.onmessage=null;socket.onclose=null;socket.onerror=null;socket.close()}
  visibilityListeners.clear();
  media?.destroy();for(const track of localStream?.getTracks?.()||[])track.stop();localStream=null;
  sharingControls?.destroy();
  peerCanvas?.destroy();shared?.destroy();board?.destroy();
  for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.clear();
  closeModal();$('#toasts').replaceChildren();$('#app').inert=true;
  publishEmbedState();embedListeners.clear();
  void(async()=>{let timer;try{await Promise.race([Promise.resolve(stopping),new Promise(resolve=>{timer=setTimeout(resolve,1000)})])}finally{clearTimeout(timer);finish()}})();
  return destroyPromise;
}
Object.defineProperty(window,'commonEmbedLifecycle',{value:Object.freeze({
  destroy:destroyCommon,getState:embedState,setVisible:setEmbedVisible,
  subscribe(listener){if(typeof listener!=='function')throw new TypeError('A state listener must be a function.');if(!disposed)embedListeners.add(listener);try{listener(embedState())}catch{}return()=>embedListeners.delete(listener)}
}),writable:false,configurable:false});
function later(callback,delay){if(disposed)return null;const id=setTimeout(()=>{appTimers.delete(id);if(!disposed)callback()},delay);appTimers.add(id);return id}
function cancelLater(id){clearTimeout(id);appTimers.delete(id)}
function nextFrame(callback){if(disposed)return null;const id=requestAnimationFrame(()=>{appFrames.delete(id);if(!disposed)callback()});appFrames.add(id);return id}
function releaseObjectUrl(url){objectUrls.delete(url);URL.revokeObjectURL(url)}
// Storage is optional in private browsing and embedded enterprise applications.
// Keep the current tab usable even when browser storage is denied or full.
const storageFallback={localStorage:new Map(),sessionStorage:new Map()};
const storageOverrides={localStorage:new Set(),sessionStorage:new Set()};
function readStored(kind,key){
  if(storageOverrides[kind].has(key))return storageFallback[kind].get(key)??null;
  try{const value=window[kind].getItem(key);storageFallback[kind].set(key,value);return value}
  catch{return storageFallback[kind].get(key)??null}
}
function writeStored(kind,key,value){
  storageFallback[kind].set(key,value);
  try{if(value===null)window[kind].removeItem(key);else window[kind].setItem(key,value);storageOverrides[kind].delete(key);return true}catch{storageOverrides[kind].add(key);return false}
}
function readStoredJSON(kind,key){try{return JSON.parse(readStored(kind,key))}catch{return null}}
const embedIdentity=window.parent!==window&&/^common-embed-(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(window.name)?window.name:null;
const authStorageKey=id=>appStorageKey('common.auth.'+id+(embedIdentity?'.'+embedIdentity:''));
function savedAuth(id){
  const saved=readStoredJSON('sessionStorage',authStorageKey(id));
  if(saved&&saved.room?.id===id&&typeof saved.room.name==='string'&&typeof saved.token==='string'&&saved.token&&typeof saved.participantId==='string'&&saved.participantId)return saved;
  writeStored('sessionStorage',authStorageKey(id),null);return null;
}
const saveAuth=value=>writeStored('sessionStorage',authStorageKey(value.room.id),JSON.stringify(value));
const forgetAuth=id=>writeStored('sessionStorage',authStorageKey(id),null);
const savedRooms=()=>{
  const data=readStoredJSON('localStorage',appStorageKey('common.rooms'));
  if(!Array.isArray(data))return [];
  const seen=new Set();
  return data.filter(room=>room&&typeof room.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(room.id)&&typeof room.name==='string'&&!seen.has(room.id)&&seen.add(room.id)).slice(0,8).map(room=>({id:room.id,name:room.name.slice(0,60)}));
};
const ownParticipantId=()=>sandbox?'local':auth?.participantId;
const saveRoom=r=>{if(disposed)return;writeStored('localStorage',appStorageKey('common.rooms'),JSON.stringify([{id:r.id,name:r.name},...savedRooms().filter(x=>x.id!==r.id)].slice(0,8)));renderRecent()};
function toast(message){if(disposed)return;const el=document.createElement('div');el.className='toast';el.innerHTML=icon('Check',16);el.append(document.createTextNode(message));$('#toasts').append(el);later(()=>el.remove(),4500)}
function modal(html,onSubmit){if(disposed)return;const revision=++modalRevision,root=$('#modal-root');root.innerHTML=`<div class="modal-overlay"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><button class="icon-button close-modal" aria-label="Close dialog">${icon('X')}</button>${html}</section></div>`;root.querySelector('.close-modal').onclick=closeModal;root.querySelector('.modal-overlay').onclick=e=>{if(e.target===e.currentTarget)closeModal()};root.querySelector('form')?.addEventListener('submit',onSubmit);later(()=>{if(modalRevision===revision)root.querySelector('input,textarea,button:not(.close-modal)')?.focus()},20)}
function closeModal(){modalRevision++;$('#modal-root').replaceChildren()}
function dialogOperation(form){const revision=modalRevision,generation=sessionGeneration;return()=>!disposed&&form.isConnected&&modalRevision===revision&&sessionGeneration===generation}
function formError(form,msg){if(disposed)return;let e=form.querySelector('.form-error');if(!e){e=document.createElement('p');e.className='form-error';e.setAttribute('role','alert');form.append(e)}e.textContent=msg}
async function diagnosticFetch(input,options={}){
  if(disposed)throw new DOMException('Common was closed.','AbortError');
  const controller=new AbortController();activeRequests.add(controller);
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)controller.abort();
  const started=Date.now();
  try{const response=await fetch(input,{...options,signal:controller.signal});diagnostics.record('request',{durationMs:Date.now()-started,status:response.status,requestId:response.headers.get('x-common-request-id')});return response}
  catch(error){diagnostics.record('request',{durationMs:Date.now()-started,state:'failed'});throw error}
  finally{activeRequests.delete(controller);options.signal?.removeEventListener('abort',abort)}
}
async function api(path,body){const r=await diagnosticFetch(appPath(path),{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});let data;try{data=await r.json()}catch{throw new Error([401,403].includes(r.status)?'Your application sign-in is required. Sign in again, then reopen Common.':'The server returned an unreadable response. Try again or check your connection.')}if(disposed)throw new DOMException('Common was closed.','AbortError');if(!r.ok)throw new Error(data?.error||'Something went wrong. Please try again.');return data}
function send(message){if(disposed)return;if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));else if(!sandbox&&message.type!=='cursor'&&message.type!=='signal')toast('Reconnect to edit the shared canvas.')}
const seed=()=>[
 {id:'welcome',type:'text',x:88,y:70,width:600,height:94,text:'A little room for your next idea.',fontSize:32,color:'#283f32',z:1},
 {id:'note',type:'sticky',x:91,y:220,width:258,height:190,text:'One small thought…\n\nShare a window.\nFollow a hunch.',color:'#344a30',fill:'#f0e4ad',fontSize:18,z:2},
 {id:'flow1',type:'rectangle',x:440,y:220,width:220,height:125,text:'What if?',color:'#78927b',fill:'#f3f4e9',z:2},
 {id:'flow-title',type:'text',x:440,y:365,width:320,height:70,text:'Drag objects to arrange them.\nDouble-click text to edit.',fontSize:15,color:'#697565',z:1}
];

$('#app').innerHTML=`
<aside class="sidebar">
 <a class="brand" href="${esc(appPath('/'))}" aria-label="Common home"><span class="brand-mark">${icon('Sprout',22)}</span>common</a>
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

sharingControls=new ScreenShareControls({
  button:$('#share-screen'),insertAfter:$('.topbar'),icon,
  getContext:()=>({sandbox,connected,roomName,recordingReady:!!agentTools}),
  onAction:()=>$('#share-screen').click(),onRecord:()=>agentTools?.openCapture()
});

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
  if(disposed)return;
  const toolbar=$('.canvas-toolbar').getBoundingClientRect();
  if(toolbar.height>0)document.documentElement.style.setProperty('--canvas-overlay-bottom',`${Math.max(0,window.innerHeight-toolbar.top)+14}px`);
}
const subscriptionResizeObserver=new ResizeObserver(()=>{scheduleScreenSubscriptions();positionCanvasOverlays()});
subscriptionResizeObserver.observe($('#board-viewport'));
function isPeerRoom(){return !sandbox&&auth?.room?.collaboration==='peer'}
function refreshCanvas(){if(!disposed&&shared){board.setEntities(shared.all());board.setLayerOrder(shared.getOrder());scheduleScreenSubscriptions()}}
function scheduleScreenSubscriptions(){cancelLater(subscriptionTimer);if(!disposed)subscriptionTimer=later(syncScreenSubscriptions,150)}
function syncScreenSubscriptions(){
  cancelLater(subscriptionTimer);
  if(disposed||!board||!media||!shared)return;
  const el=$('#board-viewport');
  const active=new Set(participants.map(person=>person.id));
  const screens=shared.all().filter(entity=>entity.type==='screen'&&(sandbox||active.has(entity.participantId)));
  const ids=screenSubscriptions.plan(screens,{participantId:ownParticipantId(),selectedId:board.selectedId,view:board.getView(),width:el.clientWidth,height:el.clientHeight,hidden:document.hidden||!embedVisible||(!sandbox&&!connected)});
  board.setScreenSubscriptions(ids,ownParticipantId());
  media.setSubscriptions(ids);
}
document.addEventListener('visibilitychange',()=>{syncScreenSubscriptions();publishEmbedState()},{signal:mainEvents.signal});
window.addEventListener('resize',scheduleScreenSubscriptions,{signal:mainEvents.signal});
function stopDeletedLocalScreen(){
  if(localStream&&!shared?.all().some(e=>e.type==='screen'&&e.participantId===ownParticipantId())){
    media?.stop();localStream=null;updateShareButton();
  }
}
function makeCanvasModel(){
  if(disposed)return;
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

let warnedCanvasStorage=false;
function saveSandbox(){if(disposed)return;const saved=writeStored('localStorage',appStorageKey('common.canvas'),JSON.stringify([...board.entities.values()].filter(e=>e.type!=='screen')));if(!saved&&!warnedCanvasStorage){warnedCanvasStorage=true;toast('This browser cannot save the canvas on this device. Export it to keep your changes.')}}
function loadSandbox(){const stored=readStoredJSON('localStorage',appStorageKey('common.canvas')),data=Array.isArray(stored)?stored:null;makeCanvasModel();shared.replaceInitial(data||seed());renderPeople();renderRecent();setPanelOpen(false);if(!data||appBasePath!=='/'){initialFitNeeded=true;nextFrame(fitInitialCanvas)}}
loadSandbox();
setupMedia();
initGeometry().then(()=>{if(!disposed){$('#engine-label').textContent='Canvas ready';$('#engine-label').title=geometryBackend()}});

function chooseTool(next){if(disposed)return;if(next==='image'){$('#image-input').click();return}if(next==='diagram'){diagramModal();return}board.setTool(next);document.querySelectorAll('.canvas-toolbar [data-tool]').forEach(e=>{const selected=e.dataset.tool===next;e.classList.toggle('selected',selected);e.setAttribute('aria-pressed',String(selected))});$('#canvas-hint').textContent=({select:'Drag to move · Double-click text to edit',hand:'Drag to pan the canvas',draw:'Click and drag to draw',text:'Click to add text',sticky:'Click to add a note',rectangle:'Click and drag to draw a box',arrow:'Click and drag to draw an arrow'})[next]||''}
document.querySelectorAll('.canvas-toolbar [data-tool]').forEach(e=>e.onclick=()=>chooseTool(e.dataset.tool));
$('#tool-color').oninput=e=>{activeColor=e.target.value;board.setColor(activeColor)};
$('#zoom-in').onclick=()=>board.setZoom(Math.min(2,board.getView().zoom+.1));$('#zoom-out').onclick=()=>board.setZoom(Math.max(.25,board.getView().zoom-.1));$('#zoom-label').onclick=()=>board.setZoom(1);$('#fit-canvas').onclick=()=>board.fit();
function setPanelOpen(open){$('#right-panel').classList.toggle('collapsed',!open);$('#toggle-panel').setAttribute('aria-expanded',String(open))}
$('#toggle-panel').onclick=()=>setPanelOpen($('#right-panel').classList.contains('collapsed'));
$('#new-session').onclick=()=>createModal();$('#invite').onclick=()=>sandbox?createModal():inviteModal();$('#how-it-works').onclick=tour;$('#sessions-nav').onclick=showSessions;$('#sandbox-nav').onclick=()=>{if(sandbox)board.fit();else location.href=appPath('/')};
$('#room-menu').onclick=roomMenu;
document.querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>{rightPanel=b.dataset.panel;document.querySelectorAll('[data-panel]').forEach(e=>e.classList.toggle('active',e===b));renderPanel()});
function renderPanel(){if(rightPanel==='people')renderPeople();else renderChat()}
function renderPeople(){if(rightPanel!=='people')return;const list=sandbox?[{id:'local',name:'You',color:'#365f4a'}]:participants;$('#panel-content').innerHTML=`<div class="people-list" role="list" aria-label="${sandbox?'On this canvas':'Session participants'}">${list.map(p=>`<div class="person" role="listitem"><span class="avatar" aria-hidden="true" style="--avatar-color:${esc(p.color)}">${esc(p.name.slice(0,1).toUpperCase())}</span><div><strong>${esc(p.name)} ${!sandbox&&p.id===auth?.participantId?'<span class="you-tag">(you)</span>':''}</strong><small>${sandbox?'This device':p.isAdmin?'Host':'Participant'}</small></div><span class="person-online" title="Online"></span></div>`).join('')}</div><button class="invite-dashed" id="panel-invite">${icon('UserPlus',15)} Invite people</button><p class="panel-invite-hint">${sandbox?'Create a session to invite your team.':'Share the session link and password to invite your team.'}</p>`;$('#panel-invite').onclick=()=>sandbox?createModal():inviteModal()}
function renderChat(){if(rightPanel!=='chat')return;$('#panel-content').innerHTML=`<div class="chat-messages" id="chat-messages">${chat.length?chat.map(m=>`<div class="chat-message"><div><strong>${esc(m.name)}</strong><time>${new Date(m.createdAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</time></div><p>${esc(m.text)}</p></div>`).join(''):`<div class="chat-empty">${icon('MessagesSquare',26)}<strong>No messages yet</strong><p>${sandbox?'Create a session to chat with your team.':'Send a message or share a useful link.'}</p></div>`}</div><form id="chat-form"><label class="sr-only" for="chat-text">Message your team</label><input id="chat-text" maxlength="2000" placeholder="Message the team" autocomplete="off" ${sandbox?'disabled':''}><button aria-label="Send message" ${sandbox?'disabled':''}>${icon('ArrowUp',17)}</button></form>`;$('#chat-form').onsubmit=e=>{e.preventDefault();const input=$('#chat-text');if(input.value.trim()){if(!connected){toast('Reconnect to send your message.');return}send({type:'chat',text:input.value.trim()});input.value=''}};const m=$('#chat-messages');m.scrollTop=m.scrollHeight}
function updatePresence(){const count=sandbox?1:participants.length;$('#member-count').textContent=sandbox?'Only you':`${count} ${count===1?'person':'people'}`;$('#people-number').textContent=count;const avatar=$('#header-presence .avatar');avatar.textContent=auth?.displayName?.slice(0,1)||'Y';renderPanel();sharingControls?.updateContext()}
function renderRecent(){$('.recent-count').textContent=savedRooms().length;$('#recent-rooms').innerHTML=savedRooms().length?savedRooms().slice(0,4).map(r=>`<a class="recent-room" href="${esc(appPath('/room/'+encodeURIComponent(r.id)))}"><span class="room-dot"></span><span>${esc(r.name)}</span>${icon('ArrowUpRight',12)}</a>`).join(''):'<p class="no-recent">No recent sessions</p>'}
function createModal(){if(disposed)return;modal(`<span class="modal-symbol">${icon('Plus',25)}</span><h2 id="modal-title">Create a session</h2><p>Start a private session and invite your teammates.</p><form id="create-form"><label>Session name<input name="name" placeholder="e.g. Weekly product review" maxlength="60" required value="Team workspace"></label><label>Your name<input name="displayName" placeholder="Your name" maxlength="60" required autocomplete="given-name"></label><label>Room password<span class="field-help">Share this with your team separately.</span><input name="password" type="password" minlength="8" maxlength="128" placeholder="At least 8 characters" required autocomplete="new-password"></label><button class="primary modal-submit">Create session ${icon('ArrowRight',17)}</button><small class="form-footnote">${icon('LockKeyhole',12)} Link and password required to join.</small></form>`,async e=>{e.preventDefault();const form=e.target,current=dialogOperation(form);const b=form.querySelector('button');b.disabled=true;b.textContent='Creating…';try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms',{...vals,collaboration:'peer'});if(!current())return;result.displayName=vals.displayName;saveAuth(result);saveRoom(result.room);closeModal();await enterRoom(result,true);if(!disposed&&auth===result)inviteModal()}catch(err){if(!current())return;formError(form,err.message);b.disabled=false;b.innerHTML='Create session '+icon('ArrowRight',17)}})}
function inviteModal(){if(disposed||!auth)return;const url=appURL('/room/'+encodeURIComponent(auth.room.id));modal(`<span class="modal-symbol">${icon('UserPlus',25)}</span><h2 id="modal-title">Invite your team</h2><p>Anyone with this link and the session password can join. Windows load when you watch them.</p><label class="link-label">SESSION LINK<div class="copy-field"><input id="invite-link" readonly value="${esc(url)}"><button class="button" id="copy-link">${icon('Copy',16)} Copy</button></div></label><div class="invite-password">${icon('LockKeyhole',17)}<div><strong>Share the password separately.</strong><span>Your password is never included in the link.</span></div></div><button class="primary modal-submit" id="done-invite">Done ${icon('ArrowRight',16)}</button>`);const copyButton=$('#copy-link'),linkInput=$('#invite-link'),revision=modalRevision;copyButton.onclick=async()=>{const current=()=>!disposed&&modalRevision===revision&&copyButton.isConnected;try{await navigator.clipboard.writeText(url);if(!current())return;copyButton.innerHTML=icon('Check',16)+' Copied';toast('Session link copied')}catch{if(!current())return;linkInput.select();toast('Select and copy the session link')}};$('#done-invite').onclick=closeModal}
async function joinFromPath(id){if(disposed)return;const lookup=++roomLookupGeneration,generation=sessionGeneration,revision=modalRevision,current=()=>!disposed&&lookup===roomLookupGeneration&&generation===sessionGeneration&&revision===modalRevision;const saved=savedAuth(id);if(saved){await enterRoom(saved);return}let room;try{({room}=await api('/api/rooms/'+encodeURIComponent(id)));if(!current())return}catch(err){if(!current())return;toast(err.message);if(!sandbox){location.replace(appPath('/'));return}history.replaceState(null,'',appPath('/'));return}modal(`<span class="modal-symbol">${icon('DoorOpen',26)}</span><h2 id="modal-title">${esc(room.name)}</h2><p>Enter your name and the session password.</p><form><label>Your name<input name="displayName" placeholder="Your name" maxlength="60" autocomplete="given-name" required></label><label>Room password<input name="password" type="password" required autocomplete="current-password" placeholder="The password from your host"></label><button class="primary modal-submit">Join session ${icon('ArrowRight',17)}</button></form>`,async e=>{e.preventDefault();const form=e.target,b=form.querySelector('button'),current=dialogOperation(form);b.disabled=true;try{const vals=Object.fromEntries(new FormData(form));const result=await api('/api/rooms/'+encodeURIComponent(id)+'/join',vals);if(!current())return;result.displayName=vals.displayName;saveAuth(result);saveRoom(result.room);closeModal();await enterRoom(result)}catch(err){if(!current())return;formError(form,err.message);b.disabled=false}})}
async function enterRoom(result,isNew=false){
  if(disposed)return;
  sessionGeneration++;
  agentPermissions?.revoke('session-changed');webMCP?.refresh();
  capture?.stop().catch(()=>{});walkthrough?.stop();
  intentionalClose=true;cancelLater(reconnectTimer);socket?.close();media?.destroy();
  auth=result;sandbox=false;intentionalClose=false;localStream=null;roomSeeded=!isNew;
  participants=[];screenSubscriptions.reset();board.setScreenSubscriptions([],result.participantId);
  makeCanvasModel();roomName=result.room.name;
  history.pushState(null,'',appPath('/room/'+encodeURIComponent(result.room.id)));
  $('#room-title').textContent=roomName;
  $('#session-kind').textContent='LIVE SESSION';$('#privacy-status').textContent='Password protected';
  $('#room-subtitle').textContent='Share windows and work on the canvas together.';
  $('#footer-access').textContent=isPeerRoom()?'Shared directly between browsers':'Password-protected room';
  document.title=roomName+' — Common';$('#sandbox-nav').classList.remove('active');$('#sessions-nav').classList.add('active');
  setPanelOpen(innerWidth>=1100);
  if(isPeerRoom())peerCanvas=new PeerCanvas({model:shared,send:(id,bytes)=>media?.sendData(id,bytes)||false,onStatus:toast});
  setupMedia();
  $('#share-screen').disabled=false;
  updateShareButton();
  connect();
}
function setupMedia(){
  if(disposed)return;
  const generation=sessionGeneration,roomAuth=auth,isSandbox=sandbox;
  const current=()=>!disposed&&generation===sessionGeneration&&media===instance;
  const instance=new ScreenSharing({
    send:message=>{if(current())send(message)},
    onStream:(id,stream)=>{if(!current())return;board.setStream(id==='local'?ownParticipantId():id,stream);if(id==='local'){localStream=stream;updateShareButton()}},
    onData:(id,bytes)=>{if(current())peerCanvas?.receive(id,bytes)},
    onPeerOpen:id=>{if(current()){peerCanvas?.open(id);updateCanvasStatus()}},
    onPeerClose:id=>{if(current()){peerCanvas?.close(id);updateCanvasStatus()}},
    onStatus:message=>{if(current())toast(message)},
    onCaptureState:state=>{if(current()){diagnostics.record('capture',{phase:state.phase,code:state.code});sharingControls?.setState(state);updateShareButton()}},
    onStopped:()=>{
      if(!current())return;
      localStream=null;updateShareButton();
      const entity=shared.all().find(e=>e.type==='screen'&&e.participantId===ownParticipantId());
      if(entity)shared.deleteLocal(entity.id);
    },
    getIceConfig:async()=>{
      if(isSandbox){const r=await diagnosticFetch(appPath('/api/ice'));if(!r.ok)throw new Error('ICE configuration unavailable');return r.json()}
      const r=await diagnosticFetch(appPath('/api/ice?room='+encodeURIComponent(roomAuth.room.id)),{headers:{Authorization:'Bearer '+roomAuth.token}});
      if(!r.ok)throw new Error('ICE configuration unavailable');return r.json();
    },
    fallbackIceConfig:()=>({iceServers:getRuntimeConfig().rtc.iceServers,iceTransportPolicy:getRuntimeConfig().rtc.iceTransportPolicy})
  });
  media=instance;
  sharingControls?.setState(instance.getCaptureState());
}
function updateCanvasStatus(){
  if(disposed||sandbox)return;
  const count=peerCanvas?.peers.size||0;
  // Canvas gossip needs only the sparse overlay, independent of video viewers.
  const ready=Boolean(media)&&[...media.desiredCanvasPeers].every(id=>peerCanvas?.peers.has(id));
  socket?.setIdle?.(isPeerRoom()&&ready);
  const text=!connected?'Reconnecting…':isPeerRoom()?(participants.length<=1?'Live · Connected':count?`Live · Connected · ${count} ${count===1?'peer':'peers'}`:'Live · Connected · finding peers…'):'Live · Connected';
  $('#connection-status').innerHTML=icon(connected?'CloudUpload':'CloudOff',15)+' '+text;
}
function setConnection(status){
  if(disposed)return;
  diagnostics.record('connection',{state:status,participants:participants.length});
  connected=status==='connected';board.setReadOnly(!sandbox&&!connected);
  $('#connection-status').classList.toggle('disconnected',!connected);updateCanvasStatus();
  scheduleScreenSubscriptions();
  agentTools?.refresh();
  agentPermissions?.state();webMCP?.refresh();
  publishEmbedState();
  sharingControls?.updateContext();
}
function syncPeople(){
  if(disposed||!media)return;
  media.syncParticipants(participants,auth.participantId).then(updateCanvasStatus);updatePresence();updateCanvasStatus();
  scheduleScreenSubscriptions();
  const active=new Set(participants.map(p=>p.id));
  document.querySelectorAll('.remote-cursor').forEach(el=>{if(!active.has(el.dataset.person))el.remove()});
  if(isPeerRoom())for(const entity of shared.all())if(entity.type==='screen'&&!active.has(entity.participantId))shared.deleteLocal(entity.id);
}
async function connect(){
  if(disposed||!auth)return;
  const generation=sessionGeneration,roomAuth=auth;
  const current=()=>!disposed&&generation===sessionGeneration&&auth===roomAuth;
  setConnection('connecting');
  await runtimeConfigReady;
  if(!current())return;
  const runtime=getRuntimeConfig().available?getRuntimeConfig():await refreshRuntimeConfiguration();
  if(!current())return;
  try{
    const response=await diagnosticFetch(appPath('/api/rooms/'+encodeURIComponent(auth.room.id)+'/session'),{headers:{Authorization:'Bearer '+auth.token}});
    if(!current())return;
    if(response.status===401||response.status===404){
      forgetAuth(auth.room.id);localStream=null;media?.destroy();updateShareButton();intentionalClose=true;
      toast(response.status===404?'This room has ended.':'Please enter the password to rejoin.');await joinFromPath(auth.room.id);return;
    }
    if(!response.ok)throw new Error('unavailable');
  }catch{if(current())reconnectTimer=later(connect,2500);return}
  if(!current()||intentionalClose)return;
  const ws=(runtime.transport||(import.meta.env.VITE_SESSION_TRANSPORT==='polling'?'polling':'websocket'))==='polling'
    ?new PollingSessionTransport({room:auth.room.id,token:auth.token,basePath:appPath('/api/rooms'),documentImpl:sessionVisibility,fetchImpl:diagnosticFetch,onDiagnostic:(type,values)=>diagnostics.record(type,values)})
    :new WebSocket(appWebSocketURL('/ws?room='+encodeURIComponent(auth.room.id)+'&token='+encodeURIComponent(auth.token)));socket=ws;
  ws.onmessage=e=>{
    if(!current()||ws!==socket)return;
    let m;try{m=JSON.parse(e.data)}catch{return}
    switch(m.type){
      case 'init':{
        diagnostics.record('request',{requestId:m.diagnostics?.requestId});
        auth.room=m.room;saveAuth(auth);
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
        intentionalClose=true;connected=false;agentPermissions?.revoke('session-ended');webMCP?.refresh();capture?.stop().catch(()=>{});walkthrough?.stop();board.setReadOnly(true);localStream=null;updateShareButton();forgetAuth(auth.room.id);media.destroy();peerCanvas?.destroy();$('#connection-status').textContent='Session ended';closeModal();
        toast('This session has ended. Your host closed the room.');
        modal(`<span class="modal-symbol">${icon('Sunset',25)}</span><h2 id="modal-title">Session ended</h2><p>The host has ended this session.</p><button class="primary modal-submit" id="back-home">Back to your canvas ${icon('ArrowRight',16)}</button>`);
        $('#back-home').onclick=()=>location.href=appPath('/');break;
      case 'error':toast(m.error);break;
    }
  };
  ws.onclose=e=>{
    if(!current()||ws!==socket||intentionalClose)return;
    setConnection('disconnected');
    const wasSharing=!!localStream;media.stop();
    if(wasSharing){localStream=null;const ownScreen=shared.all().find(e=>e.type==='screen'&&e.participantId===auth.participantId);if(ownScreen)shared.deleteLocal(ownScreen.id);updateShareButton();toast('Sharing stopped when the connection dropped. Share again after reconnecting.')}
    media.syncParticipants([],auth.participantId);
    if([4001,4003,4004,1008].includes(e.code)){
      forgetAuth(auth.room.id);toast('Your room access has expired. Please join again.');intentionalClose=true;joinFromPath(auth.room.id);return;
    }
    reconnectTimer=later(connect,2000);
  };
  ws.onerror=()=>{};
}

function renderCursor(m){const p=participants.find(x=>x.id===m.participantId);if(!p)return;let el=document.querySelector(`[data-person="${CSS.escape(p.id)}"]`);if(!el){el=document.createElement('div');el.className='remote-cursor';el.dataset.person=p.id;el.innerHTML=icon('MousePointer2',17)+`<span>${esc(p.name)}</span>`;el.style.color=p.color;$('#remote-cursors').append(el)}const v=board.getView();el.style.transform=`translate(${m.x*v.zoom+v.x}px,${m.y*v.zoom+v.y}px)`;el.style.opacity='1';cancelLater(el.fade);el.fade=later(()=>el.style.opacity='0',5000)}
let shareRequestRevision=0;
async function requestWindowShare(event){
  if(disposed)return;
  if(event?.detail>1)return null;
  if(!sandbox&&!connected){toast('Wait for your room to reconnect before sharing.');return}
  const targetMedia=media,targetModel=shared,generation=sessionGeneration,revision=++shareRequestRevision;
  const current=()=>!disposed&&media===targetMedia&&shared===targetModel&&generation===sessionGeneration&&revision===shareRequestRevision;
  if(targetMedia.getCaptureState().requestPending){await targetMedia.stop();return null}
  if(localStream){
    const entity=targetModel.all().find(e=>e.type==='screen'&&e.participantId===ownParticipantId());
    const stopping=targetMedia.stop();
    if(entity)targetModel.deleteLocal(entity.id);
    await stopping;if(current())updateShareButton();return null;
  }
  try{
    const stream=await targetMedia.start();
    if(!current()||(!sandbox&&!connected)){for(const track of stream?.getTracks?.()||[])track.stop();if(stream&&targetMedia.localStream===stream)targetMedia.stop();return}
    if(stream){
      localStream=stream;
      const entity={id:uid(),type:'screen',participantId:ownParticipantId(),streamId:stream.id,x:130+Math.random()*100,y:150+Math.random()*100,width:620,height:390,title:sandbox?'Your window':auth.displayName+"’s window",z:20};
      if(!targetModel.setLocal(entity)){const stopping=targetMedia.stop();toast('There is no room for this shared window on the canvas.');await stopping;return null}
      board.setStream(ownParticipantId(),stream);
      toast(sandbox?'Window added to your canvas.':'Window shared with the session.');
      return stream;
    }
  }catch(err){if(current())toast(err.message||'Unable to share this window.')}
  finally{if(current())updateShareButton()}
  return null;
}
$('#share-screen').onclick=requestWindowShare;
function updateShareButton(){
  if(disposed)return;
  sharingControls?.updateContext();
  capture?.syncSource();agentTools?.refresh();
  publishEmbedState();
}
function diagramModal(){if(disposed)return;modal(`<span class="modal-symbol">${icon('Workflow',25)}</span><h2 id="modal-title">Add a diagram</h2><p>Use Mermaid or PlantUML syntax.</p><form><label>Diagram language<select name="language" id="diagram-language"><option value="mermaid">Mermaid · renders in your browser</option><option value="plantuml" ${getRuntimeConfig().plantUml.enabled?'':'disabled'}>PlantUML · ${getRuntimeConfig().plantUml.enabled?'configured renderer':'disabled here'}</option></select></label><label>Diagram source<textarea name="source" rows="8" spellcheck="false" required>flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]</textarea></label><label class="consent-label" id="plant-consent" hidden><input type="checkbox" name="consent">Allow sending this diagram to ${esc(getRuntimeConfig().plantUml.endpoint?new URL(getRuntimeConfig().plantUml.endpoint).host:'the configured renderer')} for rendering. Everyone in this room can see the result.</label><button class="primary modal-submit">Add to canvas ${icon('Plus',17)}</button></form>`,e=>{e.preventDefault();const vals=Object.fromEntries(new FormData(e.target));if(vals.language==='plantuml'&&(!getRuntimeConfig().plantUml.enabled||!vals.consent)){formError(e.target,'Allow external rendering to use PlantUML.');return}board.add('diagram',{source:vals.source,language:vals.language,externalConsent:vals.language==='plantuml',title:vals.language==='mermaid'?'Mermaid diagram':'PlantUML diagram',width:500,height:300});closeModal();chooseTool('select')});$('#diagram-language').onchange=e=>{$('#plant-consent').hidden=e.target.value!=='plantuml';const input=$('textarea[name=source]');input.value=e.target.value==='plantuml'?'@startuml\nAlice -> Bob: An idea\nBob --> Alice: Let’s build it\n@enduml':'flowchart LR\n  idea[An idea] --> together[A conversation]\n  together --> next[Something great]'}}
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
  if(disposed)return;
  const targetModel=shared;
  if(!file||!/^image\/(png|jpeg|webp|gif|avif)$/.test(file.type)){toast('Choose a PNG, JPEG, WebP, GIF, or AVIF image.');return}
  if(file.size>(file.type==='image/gif'?1.3:20)*1024*1024){toast(file.type==='image/gif'?'Choose a GIF smaller than 1.3 MB.':'Choose an image smaller than 20 MB.');return}
  try{
    const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('This image could not be opened.'));reader.readAsDataURL(file)});
    const image=await new Promise((resolve,reject)=>{const value=new Image();value.onload=()=>resolve(value);value.onerror=()=>reject(new Error('This image could not be decoded.'));value.src=url});
    const compact=compactImage(file,image,url);
    if(compact.length>MAX_IMAGE_URL){toast('This image is still larger than 1.3 MB after resizing. Try a smaller one.');return}
    if(disposed||shared!==targetModel||board.readOnly){toast('The canvas changed. Choose the image again in this session.');return}
    const width=Math.min(460,image.naturalWidth);
    board.add('image',{url:compact,width,height:width*image.naturalHeight/image.naturalWidth,title:file.name});chooseTool('select');
  }catch(error){toast(error.message||'This image could not be added.')}
}
$('#image-input').onchange=e=>{addImage(e.target.files[0]);e.target.value=''};let dragDepth=0;const wrap=$('.canvas-wrap');wrap.addEventListener('dragenter',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();dragDepth++;$('#drop-overlay').classList.add('visible')}});wrap.addEventListener('dragleave',()=>{if(--dragDepth<=0)$('#drop-overlay').classList.remove('visible')});wrap.addEventListener('dragover',e=>e.preventDefault());wrap.addEventListener('drop',e=>{e.preventDefault();dragDepth=0;$('#drop-overlay').classList.remove('visible');[...e.dataTransfer.files].slice(0,5).forEach(addImage)});
function tour(){if(disposed)return;modal(`<span class="modal-symbol">${icon('Sprout',25)}</span><h2 id="modal-title">Common ground.</h2><div class="tour-steps"><div>${icon('Link',21)}<span><strong>Create a session</strong>Invite your team with the session link and password.</span></div><div>${icon('MonitorUp',21)}<span><strong>Share a window</strong>Choose a window in your browser’s share picker. Use Watch window to view a teammate’s share.</span></div><div>${icon('Pencil',21)}<span><strong>Build on the canvas</strong>Add notes, images, drawings, and diagrams. Changes appear for everyone in the session.</span></div></div><p class="help-detail">Drag items to arrange them. Double-click text to edit. Use Pan (H) to move around the canvas. Some networks may block direct screen sharing.</p><a class="local-guide-link" href="${esc(appPath('/self-hosting.html'))}" target="_blank" rel="noopener">Run Common on your own laptop ${icon('ArrowUpRight',15)}</a><button class="primary modal-submit" id="tour-done">Got it ${icon('Check',16)}</button>`);$('#tour-done').onclick=closeModal}
function showSessions(){if(disposed)return;modal(`<span class="modal-symbol">${icon('Layers',25)}</span><h2 id="modal-title">Recent sessions</h2><p>Saved on this device.</p><div class="sessions-list">${savedRooms().length?savedRooms().map(r=>`<a href="${esc(appPath('/room/'+encodeURIComponent(r.id)))}">${icon('Layers',18)}<span>${esc(r.name)}</span>${icon('ArrowUpRight',17)}</a>`).join(''):'<p>No recent sessions.</p>'}</div><button class="primary modal-submit" id="sessions-create">${icon('Plus',16)} Create a session</button>`);$('#sessions-create').onclick=createModal}
async function showConnectionDetails(){
  if(!getRuntimeConfig().available){toast('Refreshing connection settings…');await refreshRuntimeConfiguration()}
  if(disposed)return;
  const runtime={...getRuntimeConfig(),frontendBuildId:typeof __COMMON_BUILD_ID__==='string'?__COMMON_BUILD_ID__:'development'};
  const report=buildDiagnosticReport({runtime,connection:{sandbox,connected,participants:sandbox?1:participants.length},canvas:{objects:shared?.all().length,connectedNeighbors:peerCanvas?.peers.size},media,transport:socket,log:diagnostics,agentAccess:agentPermissions?.state()});
  const state=sandbox?'Working on this device':connected?'Connected to your session':'Reconnecting to your session';
  modal(`<span class="modal-symbol">${icon('Sprout',25)}</span><h2 id="modal-title">Connection details</h2><p>${state}</p><dl class="connection-details"><div><dt>Installation</dt><dd>${runtime.networkProfile==='private'?'Private network':'Standard'}</dd></div><div><dt>People</dt><dd>${report.session.participants}</dd></div><div><dt>Canvas connections</dt><dd>${report.media.openCanvasNeighbors} ready · ${report.media.canvasNeighbors} planned</dd></div><div><dt>Windows watched</dt><dd>${report.media.watchedWindows}</dd></div><div><dt>Waiting to sync</dt><dd>${Math.ceil(report.media.queuedBytes/1024)} KB</dd></div><div><dt>Video relay</dt><dd>${runtime.rtc.hasTurn?'Configured':'Direct connections only'}</dd></div><div><dt>Build</dt><dd>${esc(runtime.buildId)}</dd></div></dl><p class="help-detail">${runtime.available?'':'Server configuration is unavailable. External rendering stays disabled. '}${runtime.rtc.hasTurn?'If a window won’t connect, download a report to help investigate.':'A relay can help teammates connect across restricted networks. Your organization can run one independently.'}</p><p class="help-detail">The report contains connection measurements. Canvas content, room identifiers, passwords, and screen recordings are excluded.</p><button class="primary modal-submit" id="download-diagnostics">${icon('Download',17)} Download connection report</button>`);
  $('#download-diagnostics').onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link=document.createElement('a');link.href=url;link.download='common-connection-report.json';link.click();objectUrls.add(url);later(()=>releaseObjectUrl(url),1000);
  };
}
async function showMediaExports(){
  if(disposed)return;
  if(!capture){toast('Recording tools are still loading. Try again in a moment.');return}
  const {openMediaExportDialog,disconnectMediaExport}=await import('./media-export-tools.js');
  if(disposed){disconnectMediaExport();return}
  disconnectExports=disconnectMediaExport;
  openMediaExportDialog({capture,modal,closeModal,onStatus:toast});
}
function roomMenu(){if(disposed)return;modal(`<h2 id="modal-title">Canvas options</h2><div class="menu-actions"><button class="button" id="export-canvas">${icon('Download',17)} Export canvas as SVG</button><button class="button" id="connection-details">${icon('CircleHelp',17)} Connection details</button><button class="button" id="media-exports">${icon('MonitorUp',17)} Recording exports</button>${sandbox?'':`<button class="button" id="leave-room">${icon('LogOut',17)} Leave session</button>${auth.isAdmin?`<button class="button danger" id="end-room">${icon('CircleStop',17)} End session for everyone</button>`:''}`}</div>`);$('#connection-details').onclick=showConnectionDetails;$('#media-exports').onclick=showMediaExports;$('#export-canvas').onclick=async()=>{try{const result=board.exportSvg();const blob=result instanceof Blob?result:new Blob([result],{type:'image/svg+xml'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='common-canvas.svg';a.click();objectUrls.add(url);later(()=>releaseObjectUrl(url),1000);toast('Canvas exported. Live screens are not included.');closeModal()}catch{toast('This canvas could not be exported.')}};$('#leave-room')?.addEventListener('click',()=>{intentionalClose=true;send({type:'leave'});forgetAuth(auth.room.id);media.destroy();location.href=appPath('/')});$('#end-room')?.addEventListener('click',()=>{modal(`<h2 id="modal-title">End this session?</h2><p>Ending the session disconnects everyone and deletes this room and its canvas. Export anything you want to keep first.</p><button class="primary danger-fill modal-submit" id="confirm-end">End session for everyone</button><button class="button modal-submit" id="cancel-end">Keep session open</button>`);$('#confirm-end').onclick=()=>{send({type:'end'});closeModal()};$('#cancel-end').onclick=closeModal})}
document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeModal();chooseTool('select');return}if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName)||e.target.isContentEditable||$('#modal-root').children.length||document.querySelector('dialog[open]'))return;if(e.ctrlKey||e.metaKey)return;const keys={v:'select',h:'hand',p:'draw',t:'text',n:'sticky',r:'rectangle',a:'arrow'};if(keys[e.key.toLowerCase()])chooseTool(keys[e.key.toLowerCase()]);},{signal:mainEvents.signal});
window.addEventListener('beforeunload',destroyCommon,{signal:mainEvents.signal});window.addEventListener('popstate',()=>{if(!disposed)location.reload()},{signal:mainEvents.signal});
// Public, opt-in browser agent interface. It never exposes room credentials.
// Loaded in its own chunk so it never delays the first paint of the canvas.
async function loadAgentTools(){
if(disposed)return;
const [{createAgentAPI,createAgentPermissions},{CanvasCapture},{Walkthrough},{installAgentTools},{installWebMCP}]=await Promise.all([import('./agent-api.js'),import('./capture.js'),import('./walkthrough.js'),import('./agent-tools.js'),import('./webmcp.js')]);
if(disposed)return;
capture=new CanvasCapture({getBoard:()=>board,getSession:()=>shared,getWindowStream:()=>localStream,onChange:()=>{if(!disposed)agentTools?.refresh();publishEmbedState()},onStatus:toast});
capture.exportCanvas=(data,{mimeType,filename,download=false}={})=>{
  if(disposed)throw new Error('Common was closed.');
  if(download){
    const objectUrl=URL.createObjectURL(new Blob([data],{type:mimeType}));
    const link=document.createElement('a');link.href=objectUrl;link.download=filename;link.click();
    objectUrls.add(objectUrl);later(()=>releaseObjectUrl(objectUrl),1000);
  }
  return {filename,mimeType};
};
walkthrough=new Walkthrough({getBoard:()=>board,onChange:()=>agentTools?.refresh(),onStatus:toast});
const getAgentContext=()=>({enabled:!disposed&&agentControlEnabled,sandbox,connected,room:sandbox?null:{id:auth?.room.id,name:roomName},participantId:ownParticipantId(),participants:sandbox?[]:participants});
agentPermissions=createAgentPermissions({
  getContext:getAgentContext,getSession:()=>shared,
  onChange:()=>agentTools?.refresh(),
  onRevoke:reason=>{
    capture?.stop().catch(()=>{});walkthrough?.stop();
    if(reason!=='permissions-reduced')agentControlEnabled=false;
    agentTools?.refresh();
    window.dispatchEvent(new CustomEvent('common-agent-ready',{detail:{version:'1',enabled:agentControlEnabled}}));
  }
});
const agentAPI=createAgentAPI({
  getBoard:()=>disposed?null:board,getModel:()=>disposed?null:shared,
  getContext:getAgentContext,permissions:agentPermissions,
  recording:capture,walkthrough,onStatus:toast
});
Object.defineProperty(window,'commonAgent',{value:agentAPI,writable:false,configurable:false});
document.documentElement.dataset.commonAgent='1';
agentTools=installAgentTools({
  api:agentAPI,capture,walkthrough,permissions:agentPermissions,getEnabled:()=>agentControlEnabled,
  onEnabledChange:enabled=>{agentControlEnabled=!!enabled;window.dispatchEvent(new CustomEvent('common-agent-ready',{detail:{version:'1',enabled:agentControlEnabled}}))},
  onRequestWindowShare:requestWindowShare,getSharingState:()=>media?.getCaptureState()||{},onStatus:toast,buttonParent:$('.top-actions')
});
sharingControls?.updateContext();
webMCP=installWebMCP({api:agentAPI,permissions:agentPermissions,onStatus:toast});
window.dispatchEvent(new CustomEvent('common-agent-ready',{detail:{version:'1',enabled:false}}));
}
loadAgentTools().catch(()=>toast('Agent tools could not be loaded. Reload to try again.'));
const path=appRoute().match(/^\/room\/([^/]+)$/);if(path){let id;try{id=decodeURIComponent(path[1])}catch{}if(id&&/^[A-Za-z0-9_-]{1,100}$/.test(id))joinFromPath(id);else{history.replaceState(null,'',appPath('/'));toast('This session link is not valid. Ask the host for a new invitation.')}}
