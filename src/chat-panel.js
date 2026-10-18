// Conversation state belongs to this mounted browser session. Drafts never go
// to storage or the server until the user chooses Send.
export class ChatPanel {
  constructor({container, icon, send, onUnread=()=>{}, visibility=document}) {
    this.icon=icon;this.send=send;this.onUnread=onUnread;this.visibility=visibility;
    this.events=new AbortController();this.messages=new Map();this.unread=new Set();this.submissions=[];
    this.context={sandbox:true,connected:false,participantId:null};this.active=false;this.pinned=true;this.initialized=false;this.revision=0;this.scrollPosition=0;this.pending=null;this.notice='';
    this.el=document.createElement('section');this.el.className='chat-panel';this.el.hidden=true;this.el.setAttribute('aria-label','Team conversation');
    this.el.innerHTML=`<div class="chat-messages" id="chat-messages" role="log" aria-label="Team messages" aria-live="off" tabindex="0"></div><button class="chat-jump" type="button" hidden></button><form id="chat-form"><label class="sr-only" for="chat-text">Message your team</label><textarea id="chat-text" rows="2" maxlength="2000" placeholder="Leave a little thought…" autocomplete="off" aria-describedby="chat-compose-help chat-send-status"></textarea><button type="submit" aria-label="Send message" title="Send message (Enter)">${icon('ArrowUp',17)}</button></form><div class="chat-compose-meta"><span id="chat-compose-help">Enter to send · Shift + Enter for a new line</span><span id="chat-counter" hidden></span></div><p class="chat-send-status" id="chat-send-status" role="status" aria-live="polite"></p><div class="sr-only" id="chat-announcement" role="status" aria-live="polite"></div>`;
    container.append(this.el);this.log=this.el.querySelector('#chat-messages');this.input=this.el.querySelector('#chat-text');this.form=this.el.querySelector('#chat-form');this.submit=this.form.querySelector('button');this.jump=this.el.querySelector('.chat-jump');this.status=this.el.querySelector('#chat-send-status');this.counter=this.el.querySelector('#chat-counter');this.announcement=this.el.querySelector('#chat-announcement');
    const options={signal:this.events.signal};
    this.form.addEventListener('submit',event=>{event.preventDefault();this.sendDraft()},options);
    this.input.addEventListener('input',()=>{this.revision++;this.notice='';this.updateComposer()},options);
    this.input.addEventListener('compositionstart',()=>{this.composing=true},options);
    this.input.addEventListener('compositionend',()=>{this.composing=false;this.compositionFinishedAt=performance.now()},options);
    this.input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!this.composing&&!event.isComposing&&event.keyCode!==229&&performance.now()-(this.compositionFinishedAt??-Infinity)>50){event.preventDefault();this.sendDraft()}},options);
    this.input.addEventListener('focus',()=>{this.resumeComposer=true},options);
    this.log.addEventListener('focus',()=>{this.resumeComposer=false},options);
    this.log.addEventListener('scroll',()=>{if(!this.visible)return;this.scrollPosition=this.log.scrollTop;this.pinned=this.atBottom();if(this.pinned)this.markRead()},options);
    this.jump.addEventListener('click',()=>{this.scrollToLatest();this.input.focus({preventScroll:true})},options);
    this.onVisibility=()=>{if(this.visible&&this.pinned)this.scrollToLatest();this.updateUnread()};
    visibility.addEventListener('visibilitychange',this.onVisibility);
    this.resize=new ResizeObserver(()=>{if(this.visible&&this.pinned)this.scrollToLatest()});this.resize.observe(this.log);
    this.dialogObserver=new this.el.ownerDocument.defaultView.MutationObserver(()=>this.refreshVisibility());this.dialogObserver.observe(document.body,{childList:true});
    this.renderEmpty();this.updateComposer();
  }

  get visible(){return this.active&&!this.visibility.hidden&&!this.el.closest('[inert]')&&!document.querySelector('dialog[open]')}
  refreshVisibility(){this.onVisibility()}
  atBottom(){return this.log.scrollHeight-this.log.clientHeight-this.log.scrollTop<36}

  resetSession(context={}){
    this.clearPending();this.submissions=[];this.messages.clear();this.unread.clear();this.initialized=false;this.pinned=true;this.scrollPosition=0;this.resumeComposer=false;this.composing=false;this.revision++;this.input.value='';this.notice='';this.log.replaceChildren();this.context={sandbox:true,connected:false,participantId:null,...context};this.renderEmpty();this.updateComposer();this.updateUnread();
  }

  setContext(context){
    const wasConnected=this.context.connected;this.context={...this.context,...context};
    if(wasConnected&&!this.context.connected&&this.pending)this.unconfirmed('Connection interrupted. Check chat before sending again; your draft is kept.');
    if(!this.messages.size)this.renderEmpty();this.updateComposer();
  }

  setVisible(active){
    const wasActive=this.active;
    if(this.active&&!active)this.scrollPosition=this.log.scrollTop;
    this.active=Boolean(active);this.el.hidden=!this.active;
    if(this.active){if(this.pinned)this.scrollToLatest();else this.log.scrollTop=this.scrollPosition;if(!wasActive&&this.resumeComposer&&!this.context.sandbox)this.input.focus({preventScroll:true})}
    this.updateUnread();
  }

  setMessages(messages){
    const initial=!this.initialized;this.initialized=true;
    for(const message of messages||[])this.receive(message,{initial});
    this.updateUnread();
  }

  receive(message,{initial=false}={}){
    if(!message||typeof message.id!=='string'||typeof message.text!=='string'||this.messages.has(message.id))return;
    const own=message.participantId===this.context.participantId;
    const stick=this.visible&&this.pinned;
    this.el.querySelector('.chat-empty')?.remove();
    const node=document.createElement('article');node.className='chat-message'+(own?' chat-message-own':'');node.dataset.messageId=message.id;
    const header=document.createElement('div'),name=document.createElement('strong'),time=document.createElement('time'),text=document.createElement('p');
    name.textContent=(message.name||'Teammate')+(own?' (you)':'');
    const date=new Date(message.createdAt);if(!Number.isNaN(date.getTime())){time.dateTime=date.toISOString();time.textContent=date.toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});time.title=date.toLocaleString()}
    text.textContent=message.text;header.append(name,time);node.append(header,text);this.log.append(node);this.messages.set(message.id,{message,node});
    if(own)this.confirm(message);
    else if(!initial&&!stick)this.unread.add(message.id);
    // Server history is limited to 100 messages; keep a bounded local reading
    // window across reconnect snapshots without discarding the current draft.
    while(this.messages.size>300){const [id,entry]=this.messages.entries().next().value;const height=entry.node.getBoundingClientRect().height;entry.node.remove();this.messages.delete(id);this.unread.delete(id);if(!this.pinned){this.scrollPosition=Math.max(0,this.scrollPosition-height);if(this.visible)this.log.scrollTop=this.scrollPosition}}
    if(stick)this.scrollToLatest();
    if(!initial&&this.visible&&!own)this.announcement.textContent=stick?`${message.name||'A teammate'}: ${message.text}`:`${this.unread.size} new ${this.unread.size===1?'message':'messages'}. Jump to the latest messages when ready.`;
    this.updateUnread();
  }

  renderEmpty(){
    if(this.messages.size)return;
    let empty=this.el.querySelector('.chat-empty');if(!empty){empty=document.createElement('div');empty.className='chat-empty';this.log.append(empty)}
    empty.innerHTML=`${this.icon('MessagesSquare',26)}<strong>A little room to talk.</strong><p>${this.context.sandbox?'Create a session to chat with your team.':'Share a thought, a question, or a useful link.'}</p>`;
  }

  markRead(){if(!this.visible)return;this.unread.clear();this.updateUnread()}
  scrollToLatest(){this.pinned=true;if(this.active){this.log.scrollTop=this.log.scrollHeight;this.scrollPosition=this.log.scrollTop}this.markRead()}
  updateUnread(){
    const count=this.unread.size;this.jump.hidden=!count;this.jump.textContent=`${count} new ${count===1?'message':'messages'} ↓`;this.jump.setAttribute('aria-label',`Jump to ${count} new ${count===1?'message':'messages'}`);this.onUnread(count);
  }

  updateComposer(){
    const {sandbox,connected}=this.context;this.input.disabled=sandbox;this.submit.disabled=sandbox||!connected||Boolean(this.pending)||!this.input.value.trim();
    this.input.setAttribute('aria-label',sandbox?'Create a session to message your team':'Message your team');
    this.counter.hidden=this.input.value.length<1600;this.counter.textContent=`${this.input.value.length.toLocaleString()} / 2,000`;this.counter.classList.toggle('chat-limit',this.input.value.length>=2000);
    const status=sandbox?'Chat opens when you create a session.':this.notice||(this.pending?'Sending… Your draft stays here until confirmed.':!connected?'Reconnecting… You can keep writing; send when connected.':'Drafts stay in this tab until you send.');if(this.status.textContent!==status)this.status.textContent=status;
    this.status.classList.toggle('chat-unconfirmed',Boolean(this.notice));
  }

  sendDraft(){
    if(this.composing||this.pending||this.context.sandbox||!this.context.connected)return;
    const raw=this.input.value,text=raw.trim();if(!text)return;
    const submission={text,raw,revision:this.revision,active:true};
    // Keep the draft until the server broadcasts our own message back. The
    // polling transport may accept a POST whose response never reaches us.
    this.pending=submission;this.submissions.push(submission);if(this.submissions.length>32){const oldest=this.submissions.shift();clearTimeout(oldest.timer)}this.notice='';this.updateComposer();
    let accepted=false;try{accepted=this.send({type:'chat',text})===true}catch{}
    if(!accepted){this.submissions.splice(this.submissions.indexOf(submission),1);this.unconfirmed('Message was not sent. Your draft is kept.');return}
    submission.timer=setTimeout(()=>{if(this.pending===submission)this.unconfirmed('Not confirmed yet. Check chat before sending again; your draft is kept.')},15000);
  }

  confirm(message){
    const index=this.submissions.findIndex(submission=>submission.text===message.text);if(index<0)return;
    const [submission]=this.submissions.splice(index,1);clearTimeout(submission.timer);
    if(!submission.active||this.pending!==submission){if(!this.pending){this.notice='Your earlier message arrived. Your current draft is kept.';this.updateComposer()}return}
    this.pending=null;submission.active=false;
    if(this.revision===submission.revision&&this.input.value===submission.raw){this.input.value='';this.revision++}
    this.notice='';this.updateComposer();
  }

  clearPending(){if(this.pending){clearTimeout(this.pending.timer);this.pending.active=false;this.pending=null}}
  unconfirmed(message='Message was not confirmed. Check chat before sending again; your draft is kept.'){
    if(!this.pending)return;this.clearPending();this.notice=message;this.updateComposer();
  }
  transportError(){this.unconfirmed('Message may not have been sent. Check chat before sending again; your draft is kept.')}
  destroy(){this.clearPending();for(const submission of this.submissions)clearTimeout(submission.timer);this.submissions=[];this.input.value='';this.messages.clear();this.unread.clear();this.events.abort();this.resize.disconnect();this.dialogObserver.disconnect();this.visibility.removeEventListener('visibilitychange',this.onVisibility);this.el.remove()}
}
