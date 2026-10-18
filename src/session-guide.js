import './session-guide.css';

const TEMPLATE_NAMES={
  'team-walkthrough':'Team walkthrough',
  'weekly-check-in':'Weekly check-in',
  'design-review':'Design review',
};
let guideSequence=0;
const make=(tag,className,text)=>{
  const el=document.createElement(tag);
  if(className)el.className=className;
  if(text!==undefined)el.textContent=text;
  return el;
};
const button=(className,text)=>{const el=make('button',className,text);el.type='button';return el};
const checkedTasks=person=>new Set(person?.checklist?.completed||[]);
const participation=(person,supported)=>supported&&person?.checklist?.participation==='viewer'?'viewer':'presenter';
const setText=(node,text)=>{if(node.textContent!==text)node.textContent=text};

/** Guided sessions display authenticated roster state; the canvas view stays local. */
export class SessionGuide {
  constructor({el,getContext=()=>({}),onShare=()=>{},onSend=()=>false,onFollowChange=()=>{},onWatchFeatured=null,onStatus=()=>{}}) {
    this.getContext=getContext;this.onShare=onShare;this.onSend=onSend;
    this.onFollowChange=onFollowChange;this.onWatchFeatured=onWatchFeatured;this.onStatus=onStatus;
    this.tasks=new Map();this.roster=new Map();this.pending=new Map();this.destroyed=false;this.hasShownGuide=false;
    this.node=make('section','session-guide');this.node.hidden=true;
    this.node.setAttribute('aria-label','Session guide');
    this.header=make('div','session-guide-header');
    this.toggle=button('session-guide-toggle','');
    this.toggle.setAttribute('aria-expanded','false');
    this.title=make('strong','session-guide-title');this.summary=make('span','session-guide-summary');
    this.toggle.append(make('span','session-guide-flower','✳︎'),this.title,this.summary);
    this.chevron=make('span','session-guide-chevron','▾');this.chevron.setAttribute('aria-hidden','true');this.toggle.append(this.chevron);
    this.headerActions=make('div','session-guide-header-actions');
    this.follow=button('session-guide-follow','Explore canvas');
    this.next=button('session-guide-next','Next window →');
    this.headerActions.append(this.follow,this.next);this.header.append(this.toggle,this.headerActions);
    this.body=make('div','session-guide-body');this.body.id=`session-guide-${++guideSequence}`;this.body.hidden=true;
    this.toggle.setAttribute('aria-controls',this.body.id);
    this.feature=make('div','session-guide-feature');
    this.featureText=make('p','session-guide-feature-text');this.featureText.setAttribute('role','status');
    this.featureText.setAttribute('aria-live','polite');this.featureText.setAttribute('aria-atomic','true');
    this.featureHint=make('p','session-guide-hint','The host chooses the featured window. Explore freely, then follow again when you’re ready.');
    this.resume=button('session-guide-small-button','Resume watching');
    this.myWindow=button('session-guide-small-button','Feature my window');
    const featureActions=make('div','session-guide-feature-actions');featureActions.append(this.resume,this.myWindow);
    this.feature.append(this.featureText,this.featureHint,featureActions);
    this.columns=make('div','session-guide-columns');this.own=make('div','session-guide-own');
    const ownHeading=make('div','session-guide-section-heading');
    ownHeading.append(make('h3','','Your checklist'));this.progress=make('span','');ownHeading.append(this.progress);
    this.claimLabel=make('label','session-guide-claim-label','Your place in the plan');
    this.claim=make('select','session-guide-claim');this.claim.setAttribute('aria-label','Your place in the session plan');
    this.claimLabel.append(this.claim);
    this.claimHelp=make('p','session-guide-hint','Choose your planned name, or join as an additional participant.');
    this.participation=make('fieldset','session-guide-participation');
    this.participation.append(make('legend','','How you’ll take part'));
    this.participationChoices=make('div','session-guide-participation-choices');
    this.presenter=button('session-guide-participation-choice','Share a window');
    this.viewer=button('session-guide-participation-choice','Watch & contribute');
    this.presenter.setAttribute('aria-pressed','false');this.viewer.setAttribute('aria-pressed','false');
    this.participationChoices.append(this.presenter,this.viewer);
    this.participationHelp=make('p','session-guide-hint');this.participationHelp.id=`session-participation-${guideSequence}`;
    this.participationHelp.setAttribute('role','status');this.participationHelp.setAttribute('aria-live','polite');
    this.participation.setAttribute('aria-describedby',this.participationHelp.id);
    this.participation.append(this.participationChoices,this.participationHelp);
    this.checklist=make('div','session-guide-checklist');
    this.joined=this.makeDerived('Joined the session');this.sharing=this.makeDerived('Share a window');
    this.checklist.append(this.joined.node,this.sharing.node);
    this.share=button('session-guide-share','Share a window');
    this.shareHelp=make('p','session-guide-hint','Choose one window in your browser’s picker. Sharing starts only after you allow it.');
    this.own.append(ownHeading,this.claimLabel,this.claimHelp,this.participation,this.share,this.shareHelp,this.checklist);
    this.host=make('div','session-guide-host');
    const rosterHeading=make('div','session-guide-section-heading');
    rosterHeading.append(make('h3','','Who’s ready'));this.rosterCount=make('span','');rosterHeading.append(this.rosterCount);
    this.rosterList=make('div','session-guide-roster');this.rosterList.setAttribute('role','list');
    this.rosterList.setAttribute('aria-label','Planned attendees and people in the session');
    this.host.append(rosterHeading,this.rosterList);
    this.columns.append(this.own,this.host);
    this.connection=make('p','session-guide-connection');this.connection.setAttribute('role','status');
    this.body.append(this.feature,this.columns,this.connection);this.node.append(this.header,this.body);el.append(this.node);
    this.toggle.onclick=()=>{this.setOpen(this.body.hidden);this.update()};
    this.body.onkeydown=event=>{
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.setOpen(false);this.update();this.toggle.focus()}
    };
    this.follow.onclick=()=>{const context=this.getContext();this.onFollowChange(context.following===false)};
    this.share.onclick=()=>{if(!this.share.disabled)this.onShare()};
    this.resume.onclick=()=>this.onWatchFeatured?.();
    this.myWindow.onclick=()=>this.send('feature',{participantId:this.getContext().participantId});
    this.next.onclick=()=>this.featureNext();
    this.claim.onchange=()=>{
      const pending=this.pending.get('claim');
      if(pending){this.claim.value=pending.value||'';return}
      this.send('claim',{slotId:this.claim.value||null},'claim',this.claim.value||null);
    };
    this.claim.onpointerdown=event=>{if(this.pending.has('claim'))event.preventDefault()};
    this.claim.onkeydown=event=>{
      if(this.pending.has('claim')&&['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End',' ','Enter'].includes(event.key))event.preventDefault();
    };
    this.presenter.onclick=()=>this.chooseParticipation('presenter');
    this.viewer.onclick=()=>this.chooseParticipation('viewer');
    this.onResize=()=>this.fitPanel();window.addEventListener('resize',this.onResize);
    this.update();
  }

  makeDerived(label) {
    const node=make('div','session-guide-task is-derived');
    const mark=make('span','session-guide-check','○');mark.setAttribute('aria-hidden','true');
    const copy=make('span','session-guide-task-label',label);const state=make('span','session-guide-task-state');
    node.append(mark,copy,state);return {node,mark,copy,state};
  }

  setDerived(item,complete) {
    item.node.classList.toggle('is-complete',complete);item.mark.textContent=complete?'✓':'○';
    item.state.textContent=complete?'Done':'Waiting';
  }

  setOpen(open) {
    if(this.destroyed)return;
    const returnFocus=!open&&this.body.contains(document.activeElement);
    this.body.hidden=!open;this.toggle.setAttribute('aria-expanded',String(open));
    this.node.classList.toggle('is-open',open);
    this.chevron.textContent=open?'▴':'▾';if(returnFocus)this.toggle.focus({preventScroll:true});
    if(open)this.fitPanel();
  }

  fitPanel() {
    if(this.destroyed||this.node.hidden||this.body.hidden)return;
    const viewport=window.visualViewport;
    const normalZoom=!viewport||!Number.isFinite(viewport.scale)||Math.abs(viewport.scale-1)<.05;
    const height=normalZoom&&viewport?.height>0?viewport.height:window.innerHeight;
    const top=normalZoom&&Number.isFinite(viewport?.offsetTop)?Math.max(0,viewport.offsetTop):0;
    const available=Math.max(0,top+height-this.node.getBoundingClientRect().bottom-12);
    this.body.style.maxHeight=`${Math.min(height*.58,available)}px`;
  }

  send(action,fields,pendingKey=null,value=null) {
    if(this.destroyed)return false;
    if(!this.getContext().connected){this.onStatus('Reconnect to update the session guide.');this.update();return false}
    const sent=this.onSend({type:'workshop',action,...fields});
    if(sent===false){this.onStatus('The update was not sent. Reconnect and try again.');this.update();return false}
    if(pendingKey){
      this.pending.set(pendingKey,{value,until:Date.now()+8000});
      clearTimeout(this.pendingTimer);this.pendingTimer=setTimeout(()=>this.update(),8100);
    }
    this.update();return true;
  }

  pendingValue(key,current) {
    const pending=this.pending.get(key);if(!pending)return null;
    if(pending.value===current){this.pending.delete(key);return null}
    if(Date.now()>=pending.until){this.pending.delete(key);this.onStatus('The session guide update is still unconfirmed. Please try again.');return null}
    return pending;
  }

  chooseParticipation(mode) {
    const context=this.getContext();
    if(!context.participationSupported||!context.connected||this.pending.has('participation'))return;
    if(mode==='presenter'&&context.captureSupport?.available===false)return;
    const own=(context.participants||[]).find(person=>person.id===context.participantId);
    if(!own||participation(own,true)===mode)return;
    this.send('participation',{mode},'participation',mode);
  }

  featureNext() {
    const context=this.getContext(),workshop=context.workshop;
    if(!workshop)return;
    const sharing=new Set((context.screens||[]).map(screen=>screen.participantId));
    const participants=(context.participants||[]).filter(person=>person.id!==context.participantId&&sharing.has(person.id));
    const bySlot=new Map();
    for(const person of participants){
      const slotId=person.checklist?.slotId;
      if(!bySlot.has(slotId))bySlot.set(slotId,[]);
      bySlot.get(slotId).push(person);
    }
    const planned=(workshop.attendees||[]).flatMap(slot=>bySlot.get(slot.id)||[]);
    const plannedIds=new Set(planned.map(person=>person.id));
    const queue=[...planned,...participants.filter(person=>!plannedIds.has(person.id))];
    if(!queue.length)return;
    const index=queue.findIndex(person=>person.id===workshop.featuredParticipantId);
    this.send('feature',{participantId:queue[(index+1)%queue.length].id});
  }

  update() {
    if(this.destroyed)return;
    const context=this.getContext(),workshop=context.workshop;
    this.node.hidden=!workshop||context.enabled===false;
    if(this.node.hidden)return;
    if(!this.hasShownGuide){this.hasShownGuide=true;this.setOpen(true)}
    const people=context.participants||[],screens=context.screens||[],tasks=workshop.tasks||[],slots=workshop.attendees||[];
    const own=people.find(person=>person.id===context.participantId),completed=checkedTasks(own);
    const ownScreen=screens.some(screen=>screen.participantId===context.participantId),connected=Boolean(context.connected);
    const ownMode=participation(own,context.participationSupported),viewer=ownMode==='viewer';
    const ownCompleted=Number(Boolean(own))+Number(!viewer&&ownScreen)+tasks.filter(task=>completed.has(task.id)).length;
    const total=tasks.length+(viewer?1:2);
    const featured=people.find(person=>person.id===workshop.featuredParticipantId);
    const featuredScreen=featured&&screens.some(screen=>screen.participantId===featured.id);
    const title=context.templateName||TEMPLATE_NAMES[workshop.template]||'Guided session';
    this.title.textContent=title;this.progress.textContent=`${ownCompleted}/${total} done`;
    this.toggle.title=this.body.hidden?'Open session guide':'Close session guide';
    this.summary.textContent=this.body.hidden?`${featured?featured.name+' featured · ':''}${ownCompleted}/${total} ready`:'Close guide';
    let featureText;
    if(!connected)featureText='Reconnecting. Your checklist will update when the session returns.';
    else if(!workshop.featuredParticipantId)featureText=context.isAdmin?'Choose a shared window to start the walkthrough.':'Waiting for the host to feature a window.';
    else if(!featured)featureText='The featured person has left. Waiting for the host’s next window.';
    else if(!featuredScreen)featureText=`Waiting for ${featured.name} to share a window.`;
    else if(context.following===false)featureText=`Exploring canvas · ${featured.name} is featured.`;
    else featureText=context.featuredStatus||`Showing ${featured.name}’s window.`;
    if(this.featureText.textContent!==featureText)this.featureText.textContent=featureText;
    this.featureHint.textContent=connected&&!context.isAdmin&&own&&!people.some(person=>person.isAdmin)
      ?'The host is offline. You can keep sharing and explore the canvas.'
      :'The host chooses the featured window. Explore freely, then follow again when you’re ready.';
    this.follow.textContent=context.following===false?'Follow featured':'Explore canvas';
    this.follow.title=context.following===false?'Follow the host’s featured window in your view':'Explore the canvas without changing anyone else’s view';
    this.follow.disabled=!connected;
    this.next.hidden=!context.isAdmin;
    this.next.disabled=!connected||!people.some(person=>person.id!==context.participantId&&screens.some(screen=>screen.participantId===person.id));
    this.myWindow.hidden=!context.isAdmin;this.myWindow.disabled=!connected||!ownScreen||workshop.featuredParticipantId===context.participantId;
    this.myWindow.textContent=workshop.featuredParticipantId===context.participantId?'Your window is featured':'Feature my window';
    this.resume.hidden=!context.featuredPaused||!this.onWatchFeatured||context.following===false;
    this.resume.disabled=!connected||!featuredScreen;
    this.host.hidden=!context.isAdmin;this.columns.classList.toggle('has-roster',Boolean(context.isAdmin));
    this.setDerived(this.joined,Boolean(own));this.setDerived(this.sharing,ownScreen);
    this.sharing.copy.textContent=viewer?'Share a window (optional)':'Share a window';
    this.sharing.node.classList.toggle('is-optional',viewer);
    if(viewer)this.sharing.state.textContent=ownScreen?'Live · optional':'Not needed';
    const captureAvailable=context.captureSupport?.available!==false;
    this.updateParticipation(context,own,ownScreen,connected);
    this.share.textContent=ownScreen?'Your window is sharing':'Share a window';
    this.share.disabled=!connected||ownScreen||Boolean(context.sharePending)||!captureAvailable;
    this.share.hidden=!captureAvailable&&!ownScreen&&!context.sharePending;
    if(context.sharePending)this.share.textContent='Choose in your browser…';
    this.shareHelp.textContent=ownScreen?'Your window is still sharing. Use Stop sharing at the top to end it.':!captureAvailable
      ?`${context.captureSupport?.detail||'This browser cannot share a window.'} ${context.participationSupported?'Choose Watch & contribute to take part without sharing.':'You can still follow the session, chat, and add to the canvas.'}`
      :viewer
        ?'Sharing is optional. You can follow, chat, draw, and complete your tasks.'
        :'Choose one window in your browser’s picker. Sharing starts only after you allow it.';
    this.shareHelp.hidden=!captureAvailable&&Boolean(context.participationSupported)&&!ownScreen;
    this.claimLabel.hidden=!slots.length;this.claimHelp.hidden=!slots.length;
    this.updateClaim(slots,people,own,connected);
    this.updateTasks(tasks,completed,connected);
    if(context.isAdmin)this.updateRoster(slots,people,screens,tasks,workshop.featuredParticipantId,context);
    else if(this.roster.size){this.roster.clear();this.rosterList.replaceChildren();this.rosterCount.textContent=''}
    this.connection.hidden=connected;
    this.connection.textContent='Your progress is readable while reconnecting. Sharing, checkboxes, and featured-window changes resume when connected.';
    this.fitPanel();
  }

  updateParticipation(context,own,ownScreen,connected) {
    const supported=context.participationSupported===true;
    this.participation.hidden=!supported;
    if(!supported){this.pending.delete('participation');return}
    const mode=participation(own,true),pending=this.pendingValue('participation',mode),selected=pending?.value||mode;
    const unavailable=context.captureSupport?.available===false;
    this.participation.classList.toggle('capture-unavailable',unavailable);
    for(const [control,value] of [[this.presenter,'presenter'],[this.viewer,'viewer']]){
      control.setAttribute('aria-pressed',String(selected===value));
      control.setAttribute('aria-busy',String(Boolean(pending)&&selected===value));
      control.disabled=!connected||!own||(value==='presenter'&&unavailable);
      // Pending choices remain focused and visible; repeated clicks are ignored.
      control.setAttribute('aria-disabled',String(control.disabled||Boolean(pending)));
    }
    this.presenter.title=unavailable?'Window sharing is unavailable in this browser':'Include a live window in your checklist; choosing this does not start capture';
    this.viewer.textContent=unavailable&&mode!=='viewer'?'Join without sharing':'Watch & contribute';
    let help;
    if(pending)help='Saving how you’ll take part…';
    else if(mode==='viewer'&&ownScreen)help='Your checklist does not require a shared window. Your existing window is still sharing; use Stop sharing at the top to end it.';
    else if(unavailable)help=`${context.captureSupport?.detail||'This browser cannot share a window.'} ${mode==='viewer'?'You can follow, chat, draw, and complete your tasks without sharing.':'Choose Join without sharing to remove the window requirement from your checklist.'}`;
    else if(mode==='viewer')help='Your checklist does not require a shared window. You can follow, chat, draw, and complete your tasks.';
    else help='Share a window during your turn, or watch and contribute without sharing. You choose when capture starts.';
    setText(this.participationHelp,help);
  }

  updateClaim(slots,people,own,connected) {
    const slotId=own?.checklist?.slotId||null,pending=this.pendingValue('claim',slotId);
    const occupiedSlots=new Set(people.filter(person=>person.id!==own?.id).map(person=>person.checklist?.slotId));
    const choices=[{id:'',name:'Additional participant',disabled:false},...slots.map(slot=>({
      ...slot,disabled:occupiedSlots.has(slot.id),
    }))];
    const signature=JSON.stringify(choices);
    if(signature!==this.claimSignature){
      const options=choices.map(choice=>{
        const option=make('option','',choice.name+(choice.disabled?' · already here':''));option.value=choice.id;
        option.disabled=choice.disabled;return option;
      });
      this.claim.replaceChildren(...options);this.claimSignature=signature;
    }
    this.claim.value=pending?.value??slotId??'';this.claim.disabled=!connected;
    this.claim.setAttribute('aria-busy',String(Boolean(pending)));this.claim.setAttribute('aria-disabled',String(Boolean(pending)||!connected));
  }

  updateTasks(tasks,completed,connected) {
    const ids=new Set(tasks.map(task=>task.id));
    for(const [id,item] of this.tasks)if(!ids.has(id)){item.node.remove();this.tasks.delete(id)}
    for(let index=0;index<tasks.length;index++){
      const task=tasks[index];let item=this.tasks.get(task.id);
      if(!item){
        const node=make('label','session-guide-task'),input=make('input','');input.type='checkbox';
        const label=make('span','session-guide-task-label'),state=make('span','session-guide-task-state');
        node.append(input,label,state);item={node,input,label,state};this.tasks.set(task.id,item);
        input.onclick=event=>{if(this.pending.has(`task:${task.id}`))event.preventDefault()};
        input.onchange=()=>{
          const pending=this.pending.get(`task:${task.id}`);
          if(pending){input.checked=pending.value;return}
          this.send('complete',{taskId:task.id,completed:input.checked},`task:${task.id}`,input.checked);
        };
      }
      const canonical=completed.has(task.id),pending=this.pendingValue(`task:${task.id}`,canonical);
      item.label.textContent=task.label;item.input.checked=pending?pending.value:canonical;
      item.input.disabled=!connected;item.node.classList.toggle('is-complete',canonical);
      item.state.textContent=pending?'Saving…':canonical?'Done':'';item.input.setAttribute('aria-busy',String(Boolean(pending)));
      item.input.setAttribute('aria-disabled',String(Boolean(pending)||!connected));
      // Existing focused controls stay mounted through roster and video updates.
      const position=this.checklist.children[index+2];
      if(position!==item.node)this.checklist.insertBefore(item.node,position||null);
    }
  }

  updateRoster(slots,people,screens,tasks,featuredId,context) {
    const sharing=new Set(screens.map(screen=>screen.participantId));
    const plannedIds=new Set(slots.map(slot=>slot.id));
    const bySlot=new Map(),completionCounts=new Map();
    for(const person of people){
      const slotId=person.checklist?.slotId;
      if(!bySlot.has(slotId))bySlot.set(slotId,person);
      const completed=checkedTasks(person);
      completionCounts.set(person.id,tasks.filter(task=>completed.has(task.id)).length);
    }
    const entries=slots.map(slot=>({key:`slot:${slot.id}`,slot,person:bySlot.get(slot.id)}));
    for(const person of people)if(!plannedIds.has(person.checklist?.slotId))entries.push({key:`person:${person.id}`,person});
    const keys=new Set(entries.map(entry=>entry.key));
    for(const [key,item] of this.roster)if(!keys.has(key)){item.node.remove();this.roster.delete(key)}
    const ready=people.filter(person=>(participation(person,context.participationSupported)==='viewer'||sharing.has(person.id))&&completionCounts.get(person.id)===tasks.length).length;
    const joinedPlanned=entries.filter(entry=>entry.slot&&entry.person).length;
    setText(this.rosterCount,slots.length?`${joinedPlanned}/${slots.length} planned here · ${ready} ready`:`${people.length} here · ${ready} ready`);
    for(let index=0;index<entries.length;index++){
      const entry=entries[index];let item=this.roster.get(entry.key);
      if(!item){
        const node=make('div','session-guide-person');node.setAttribute('role','listitem');
        const dot=make('span','session-guide-person-dot');dot.setAttribute('aria-hidden','true');
        const copy=make('div','session-guide-person-copy'),name=make('strong',''),detail=make('span','');copy.append(name,detail);
        const feature=button('session-guide-small-button','Feature');
        node.append(dot,copy,feature);item={node,name,detail,feature};this.roster.set(entry.key,item);
      }
      const person=entry.person,hasScreen=Boolean(person&&sharing.has(person.id));
      const viewer=participation(person,context.participationSupported)==='viewer';
      const complete=person?completionCounts.get(person.id):0;
      const signature=JSON.stringify([entry.slot?.name,person?.id,person?.name,person?.id===context.participantId,hasScreen,viewer,complete,tasks.length,person?.id===featuredId,Boolean(context.connected)]);
      // Roster/video updates also refresh this panel. Keep unchanged rows intact
      // so larger sessions do not rebuild every name and button on each tick.
      if(item.signature!==signature){
        item.signature=signature;
        item.name.textContent=entry.slot?.name||person?.name||'Participant';
        if(person?.id===context.participantId)item.name.append(make('span','session-guide-you',' (you)'));
        const extra=!entry.slot?'Additional participant · ':'';
        const actualName=entry.slot&&person&&person.name!==entry.slot.name?`Joined as ${person.name} · `:'';
        const sharingDetail=viewer?`Watch & contribute · ${hasScreen?'Window shared':'No window needed'}`:hasScreen?'Window shared':'Window not shared';
        item.detail.textContent=person?`${extra}${actualName}${sharingDetail} · ${complete}/${tasks.length} tasks`:'Not here yet';
        item.node.classList.toggle('is-waiting',!person);item.node.classList.toggle('is-sharing',hasScreen);
        item.node.classList.toggle('is-featured',Boolean(person&&person.id===featuredId));
        item.feature.hidden=!hasScreen;item.feature.disabled=!context.connected||person?.id===featuredId;
        item.feature.textContent=person?.id===featuredId?'Featured':'Feature';
        item.feature.setAttribute('aria-label',`Feature ${person?.name||entry.slot?.name||'participant'}’s window`);
        item.feature.onclick=()=>{if(person)this.send('feature',{participantId:person.id})};
      }
      const position=this.rosterList.children[index];if(position!==item.node)this.rosterList.insertBefore(item.node,position||null);
    }
  }

  reset() {
    clearTimeout(this.pendingTimer);this.pending.clear();this.setOpen(false);
    this.claimSignature=null;this.hasShownGuide=false;this.update();
  }

  destroy() {
    if(this.destroyed)return;
    this.destroyed=true;clearTimeout(this.pendingTimer);this.pending.clear();window.removeEventListener('resize',this.onResize);this.node.remove();
  }
}
