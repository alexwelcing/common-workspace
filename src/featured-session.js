/** The host selects a participant; each browser keeps its own following choice. */
export class FeaturedSession {
  constructor({board,onChange=()=>{},onStatus=()=>{}}){
    this.board=board;this.onChange=onChange;this.onStatus=onStatus;
    this.following=true;this.appliedId=null;this.busy=false;this.destroyed=false;this.context={};
  }
  reset(){this.release();this.following=true;this.context={};this.onChange()}
  duringModelUpdate(action){const busy=this.busy;this.busy=true;try{return action()}finally{this.busy=busy}}
  release(){
    this.duringModelUpdate(()=>{if(this.appliedId&&this.board.focusedId===this.appliedId)this.board.exitFocus()});
    this.appliedId=null;
  }
  setFollowing(value){
    if(this.destroyed)return;
    this.following=Boolean(value);if(!this.following)this.release();else this.apply();this.onChange();
  }
  update(context){if(this.destroyed)return;this.context=context;this.apply()}
  apply(){
    const {workshop,connected,screens=[],participants=[]}=this.context;
    if(!workshop||!this.following){this.release();return}
    const owner=workshop.featuredParticipantId;
    const active=participants.some(person=>person.id===owner);
    const target=active&&[...screens].filter(screen=>screen.participantId===owner).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)[0];
    if(!connected||!target){this.release();return}
    if(this.appliedId===target.id&&this.board.focusedId===target.id)return;
    if(this.board.gesture||this.board.editingId){
      this.following=false;this.release();this.onStatus('Finish your current edit, then choose Follow featured when you are ready.');this.onChange();return;
    }
    this.duringModelUpdate(()=>{
      if(this.board.focusEntity(target.id,{hint:'Following the featured window · Explore the canvas whenever you like',focusControls:false}))this.appliedId=target.id;
    });
  }
  viewChanged(){
    if(this.destroyed||this.busy||!this.following||!this.appliedId)return;
    if(this.board.focusedId!==this.appliedId){this.following=false;this.appliedId=null;this.onChange()}
  }
  status(){
    const {workshop,connected,screens=[],participants=[],participantId,paused=false}=this.context;
    if(!workshop)return '';
    if(!connected)return 'Reconnecting to the session. Your following choice is kept.';
    const id=workshop.featuredParticipantId;
    if(!id)return 'The host can feature a shared window when someone is ready.';
    const person=participants.find(person=>person.id===id);
    const name=id===participantId?'Your':person?`${person.name}’s`:'The featured';
    if(!screens.some(screen=>screen.participantId===id))return `Waiting for ${name.toLowerCase()} shared window to reach this canvas.`;
    if(paused)return `${name} window is featured. Watching is paused on this device.`;
    return `${name} window is featured${this.following?' · Following':' · You are exploring the canvas'}.`;
  }
  destroy(){this.release();this.destroyed=true;this.context={}}
}
