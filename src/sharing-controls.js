import './sharing-controls.css';

/** A quiet status strip beside the canvas, never a second permission prompt. */
export class ScreenShareControls {
  constructor({button,insertAfter,getContext=()=>({}),onAction=()=>{},onRecord=()=>{},icon=()=>''}) {
    this.button=button;this.getContext=getContext;this.onAction=onAction;this.onRecord=onRecord;this.icon=icon;
    this.state={phase:'idle',requestPending:false,viewerCount:0,source:null};
    this.dismissed=false;this.destroyed=false;this.lastPhase='idle';
    const node=document.createElement('section');
    node.className='sharing-strip';node.hidden=true;node.setAttribute('aria-label','Window sharing');
    node.innerHTML=`<span class="sharing-strip-mark" aria-hidden="true"></span><div class="sharing-strip-body"><div class="sharing-strip-copy" role="status" aria-live="polite" aria-atomic="true"><strong id="sharing-title"></strong><span id="sharing-detail"></span></div><details class="sharing-help"><summary>Sharing help</summary><ul></ul><a class="sharing-own-tab" target="_blank" rel="noopener">Open Common in its own tab</a><small class="sharing-code"></small></details></div><div class="sharing-strip-actions"><button class="sharing-record button" type="button">${icon('Circle',13)} Record</button><button class="sharing-retry button" type="button"></button><button class="sharing-dismiss icon-button" type="button" aria-label="Dismiss sharing message">${icon('X',16)}</button></div>`;
    insertAfter.after(node);this.node=node;
    this.title=node.querySelector('#sharing-title');this.detail=node.querySelector('#sharing-detail');
    this.help=node.querySelector('.sharing-help');this.helpList=this.help.querySelector('ul');
    this.ownTab=node.querySelector('.sharing-own-tab');this.code=node.querySelector('.sharing-code');
    this.action=node.querySelector('.sharing-retry');this.dismiss=node.querySelector('.sharing-dismiss');
    this.record=node.querySelector('.sharing-record');this.record.onclick=()=>this.onRecord();
    this.action.onclick=()=>this.onAction();
    this.dismiss.onclick=()=>{this.dismissed=true;this.render()};
    this.button.setAttribute('aria-describedby','sharing-detail');
    this.showUnsupportedHelp=event=>{
      const support=this.getContext().captureSupport;
      if(support?.available!==false||this.state.phase==='sharing'||this.state.requestPending)return;
      // Unsupported capture is an explanation, not a request that can succeed.
      // Keep the main button useful without reopening an impossible picker.
      event.preventDefault();event.stopImmediatePropagation();this.dismissed=false;this.render();
      this.help.open=true;
    };
    this.button.addEventListener('click',this.showUnsupportedHelp,true);
    this.render();
  }

  setState(state) {
    if(this.destroyed)return;
    if(state.phase!==this.state.phase||state.code!==this.state.code)this.dismissed=false;
    this.state=state;this.render();
  }

  updateContext(){if(!this.destroyed)this.render()}

  render() {
    const context=this.getContext(),sharing=this.state.phase==='sharing',pending=this.state.requestPending;
    const unsupported=!sharing&&!pending&&context.captureSupport?.available===false;
    const state=unsupported?{...this.state,...context.captureSupport,phase:'blocked'}:this.state;
    this.node.dataset.phase=state.phase;
    this.node.hidden=this.dismissed||state.phase==='idle';
    this.button.classList.toggle('is-sharing',sharing);
    this.button.classList.toggle('is-requesting',pending);
    this.button.disabled=state.phase==='abandoning';
    const label=sharing?'Stop sharing':pending?'Cancel request':unsupported?'Sharing help':'Share a window';
    this.button.innerHTML=this.icon(sharing?'MonitorX':pending?'X':unsupported?'CircleHelp':'MonitorUp',17)+' '+label;
    this.button.setAttribute('aria-label',label);this.button.setAttribute('aria-pressed',String(sharing));
    this.button.setAttribute('aria-busy',String(pending));
    this.button.title=pending?'The browser picker is waiting for your choice':sharing?'Stop sharing your chosen source':unsupported?'See why window sharing is unavailable and how you can still take part':'Choose a tab, window, or screen';
    this.title.textContent=sharing?`${state.source?.label||'Chosen source'} · ${state.paused?'paused by browser':'sharing'}`:state.title||'';
    if(sharing){
      const viewers=state.viewerCount||0;
      const audience=context.sandbox?'Only on your canvas':`Available to everyone in this session · ${viewers} watching`;
      this.detail.textContent=state.paused?`${audience}. Keep the source open; your browser controls when it resumes.`:`${audience}. Sound is off.`;
    }else this.detail.textContent=state.detail||'';
    const assistance=Array.isArray(state.help)?state.help:[];
    this.help.hidden=!assistance.length;
    // Keep expanded help open while a state repeats; clear it for a new choice.
    if(this.lastPhase!==state.phase)this.help.open=false;
    this.lastPhase=state.phase;
    this.helpList.replaceChildren(...assistance.map(text=>{const li=document.createElement('li');li.textContent=text;return li}));
    const embedded=window.parent!==window;
    this.ownTab.hidden=!embedded;this.ownTab.href=location.href;
    this.code.hidden=!state.code;this.code.textContent=state.code?`Browser detail: ${state.code}`:'';
    this.dismiss.hidden=sharing||pending;
    this.action.hidden=state.phase==='abandoning'||state.phase==='blocked'||state.phase==='idle';
    this.record.hidden=!sharing;
    this.record.disabled=context.recordingReady===false;
    this.record.title=context.recordingReady===false?'Preparing recording controls':'Choose a source and record to this tab';
    this.action.textContent=sharing?'Stop sharing':pending?'Cancel request':'Choose again';
    this.node.querySelector('.sharing-strip-mark').innerHTML=this.icon(sharing?'MonitorUp':pending?'MonitorUp':state.phase==='stopped'?'Check':'CircleHelp',17);
  }

  destroy(){if(this.destroyed)return;this.destroyed=true;this.button.removeEventListener('click',this.showUnsupportedHelp,true);this.button.removeAttribute('aria-describedby');this.node.remove()}
}
