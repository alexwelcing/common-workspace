/** Guided-session state. The caller supplies authenticated identity and live presence. */
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const defaults = {
  'team-walkthrough': [{ id: 'ready', label: 'Ready for my turn' }, { id: 'shared', label: 'Shared my window' }, { id: 'reviewed', label: 'Completed my walkthrough' }],
  'weekly-check-in': [{ id: 'update', label: 'Added my update' }, { id: 'blockers', label: 'Shared blockers or questions' }, { id: 'next', label: 'Agreed on next steps' }],
  'design-review': [{ id: 'context', label: 'Added context for my design' }, { id: 'feedback', label: 'Collected feedback' }, { id: 'next', label: 'Recorded next steps' }],
};

/** Returns null for an ordinary canvas; roster capacity never limits admission. */
export function normalizeWorkshop(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || typeof value.template !== 'string' || !Object.hasOwn(defaults, value.template)) fail(400, 'INVALID_WORKSHOP', 'Choose a supported session template.');
  const attendees = value.attendees ?? [];
  const tasks = value.tasks ?? defaults[value.template];
  if (!Array.isArray(attendees) || attendees.length > 200 || !Array.isArray(tasks) || tasks.length < 1 || tasks.length > 12) fail(400, 'INVALID_WORKSHOP', 'Use up to 200 planned attendees and 1–12 checklist items.');
  function entries(values, key, max) {
    const seen = new Set();
    return values.map(item => {
      if (!object(item) || !id(item.id) || seen.has(item.id) || typeof item[key] !== 'string' || !item[key].trim() || item[key].trim().length > max) fail(400, 'INVALID_WORKSHOP', 'Each planned attendee and checklist item needs a unique ID and a short label.');
      seen.add(item.id);
      return { id: item.id, [key]: item[key].trim() };
    });
  }
  return { template: value.template, attendees: entries(attendees, 'name', 60), tasks: entries(tasks, 'label', 160), featuredParticipantId: null };
}

/** Restores trusted persisted state while discarding stale or unrecognized checklist fields. */
export function restoreWorkshop(value) {
  if (!value) return null;
  const workshop = normalizeWorkshop(value);
  if (id(value.featuredParticipantId)) workshop.featuredParticipantId = value.featuredParticipantId;
  return workshop;
}

export function workshopChecklist(workshop, value) {
  const valid = object(value) ? value : {};
  const completed = new Set(Array.isArray(valid.completed) ? valid.completed : []);
  return { slotId: workshop?.attendees.some(slot => slot.id === valid.slotId) ? valid.slotId : null,
    completed: workshop ? workshop.tasks.filter(task => completed.has(task.id)).map(task => task.id) : [] };
}

export function workshopSnapshot(workshop) {
  return workshop ? { template: workshop.template, attendees: workshop.attendees.map(item => ({ ...item })), tasks: workshop.tasks.map(item => ({ ...item })), featuredParticipantId: workshop.featuredParticipantId ?? null } : null;
}

/** Compute first, then apply/persist atomically under the caller's room lock. */
export function workshopUpdate(workshop, members, actor, input) {
  if (!workshop) fail(409, 'NO_WORKSHOP', 'This canvas does not have a guided session.');
  const result = { workshop: null, members: [] };
  const self = members.find(member => member.id === actor.id);
  if (!self || !self.active) fail(409, 'RESYNC_REQUIRED', 'Reconnect before updating this session.');
  const checklist = workshopChecklist(workshop, self.checklist);
  if (input.action === 'claim') {
    if (input.slotId !== null && !workshop.attendees.some(slot => slot.id === input.slotId)) fail(400, 'INVALID_WORKSHOP_SLOT', 'Choose an attendee from this session.');
    if (input.slotId !== null) {
      const previous = members.filter(member => member.id !== actor.id && workshopChecklist(workshop, member.checklist).slotId === input.slotId);
      if (previous.some(member => member.active)) fail(409, 'WORKSHOP_SLOT_TAKEN', 'That attendee is already connected. Choose another name or join as yourself.');
      for (const member of previous) result.members.push({ id: member.id, checklist: { slotId: null, completed: [] } });
    }
    result.members.push({ id: actor.id, checklist: { ...checklist, slotId: input.slotId } });
  } else if (input.action === 'complete') {
    if (!workshop.tasks.some(task => task.id === input.taskId) || typeof input.completed !== 'boolean') fail(400, 'INVALID_WORKSHOP_TASK', 'Choose a checklist item and whether it is complete.');
    const completed = new Set(checklist.completed);
    if (input.completed) completed.add(input.taskId); else completed.delete(input.taskId);
    result.members.push({ id: actor.id, checklist: workshopChecklist(workshop, { ...checklist, completed: [...completed] }) });
  } else if (input.action === 'feature') {
    if (!actor.isAdmin) fail(403, 'FORBIDDEN', 'Only the host can choose the featured window.');
    if (input.participantId !== null && !members.some(member => member.id === input.participantId && member.active)) fail(409, 'WORKSHOP_MEMBER_UNAVAILABLE', 'Choose someone who is connected to this session.');
    result.workshop = { ...workshopSnapshot(workshop), featuredParticipantId: input.participantId };
  } else fail(400, 'INVALID_WORKSHOP_ACTION', 'Choose a supported session action.');
  return result;
}
