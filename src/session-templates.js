/** Small session recipes. These describe a room; they never start screen capture. */
export const SESSION_TEMPLATES = Object.freeze([
  Object.freeze({
    id: 'team-walkthrough', name: 'Team walkthrough',
    summary: 'One shared stage, a turn for each person, and a few things to do before you begin. The host can feature a window as the team takes turns.',
    tasks: Object.freeze(['Introduce the work you want to show', 'Add a note about what you would like feedback on', 'Mark yourself ready']),
  }),
  Object.freeze({
    id: 'weekly-check-in', name: 'Weekly check-in',
    summary: 'Make a little space for progress, questions, and the next small step. Everyone can share a window, then take a turn on the stage.',
    tasks: Object.freeze(['Add a note about your progress', 'Add a question or a blocker', 'Mark yourself ready']),
  }),
  Object.freeze({
    id: 'design-review', name: 'Design review',
    summary: 'Give the work a shared home, gather questions, and rotate through the windows the team wants to discuss.',
    tasks: Object.freeze(['Name the decision you need from this review', 'Add the question you want the team to consider', 'Mark yourself ready']),
  }),
  Object.freeze({
    id: 'open', name: 'Open canvas',
    summary: 'Start with an open canvas. Share windows, draw, and arrange your thoughts together at your own pace.',
    tasks: Object.freeze([]),
  }),
]);

const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const recipe = id => SESSION_TEMPLATES.find(item => item.id === id);
const freshId = () => globalThis.crypto.randomUUID();

/** Render once inside the create form, then call bindSessionTemplates(form). */
export function renderSessionTemplates(selected = 'team-walkthrough') {
  const template = recipe(selected) || SESSION_TEMPLATES[0];
  return `<div class="session-template-picker">
    <label for="session-template">Start with a template
      <select id="session-template" name="sessionTemplate" aria-describedby="session-template-summary">${SESSION_TEMPLATES.map(item => `<option value="${item.id}"${item.id === template.id ? ' selected' : ''}>${escapeHTML(item.name)}</option>`).join('')}</select>
    </label>
    <p id="session-template-summary" class="session-template-summary" aria-live="polite">${escapeHTML(template.summary)}</p>
    <fieldset class="session-template-plan"${template.id === 'open' ? ' hidden disabled' : ''}>
      <legend>A little preparation</legend>
      <label for="session-attendees">Who are you expecting? <span class="session-template-optional">Optional</span>
        <span class="field-help" id="session-attendees-help">One name per line. People can claim their place when they join.</span>
        <textarea id="session-attendees" name="sessionAttendees" rows="3" maxlength="12200" placeholder="Alex Rivera&#10;Sam Chen&#10;Jordan Patel" aria-describedby="session-attendees-help session-plan-privacy"></textarea>
      </label>
      <label for="session-tasks">Each person's checklist
        <span class="field-help" id="session-tasks-help">One item per line. You can change these before starting.</span>
        <textarea id="session-tasks" name="sessionTasks" rows="3" maxlength="1940" aria-describedby="session-tasks-help">${escapeHTML(template.tasks.join('\n'))}</textarea>
      </label>
      <p class="session-plan-privacy" id="session-plan-privacy">Planning list, not an access restriction. Share the link and password yourself.</p>
    </fieldset>
  </div>`;
}

/** Update only the recipe fields, leaving identity/password and attendee input alone. */
export function bindSessionTemplates(form) {
  const select = form.querySelector('[name="sessionTemplate"]');
  const summary = form.querySelector('.session-template-summary');
  const fields = form.querySelector('.session-template-plan');
  const tasks = form.querySelector('[name="sessionTasks"]');
  if (!select || !summary || !fields || !tasks) return () => {};
  const drafts = new Map();
  let selected = select.value;
  const change = () => {
    drafts.set(selected, tasks.value);
    const template = recipe(select.value) || SESSION_TEMPLATES[0];
    selected = template.id;
    summary.textContent = template.summary;
    fields.hidden = template.id === 'open';
    fields.disabled = fields.hidden;
    tasks.value = drafts.get(template.id) ?? template.tasks.join('\n');
  };
  select.addEventListener('change', change);
  return () => select.removeEventListener('change', change);
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

/** Client validation complements the server's independent payload validation. */
export function readWorkshop(form) {
  const template = form.querySelector('[name="sessionTemplate"]')?.value || 'open';
  if (!recipe(template)) throw new Error('Choose one of the available session templates.');
  if (template === 'open') return null;
  const names = lines(form.querySelector('[name="sessionAttendees"]')?.value);
  const labels = lines(form.querySelector('[name="sessionTasks"]')?.value);
  if (names.length > 200) throw new Error('Keep the planning list to 200 names. More people can still join using the link.');
  if (names.some(name => name.length > 60)) throw new Error('Keep each planned name to 60 characters or fewer.');
  const uniqueNames = new Set(names.map(name => name.normalize('NFKC').toLocaleLowerCase()));
  if (uniqueNames.size !== names.length) throw new Error('Give each planned person a distinct name, such as their full name.');
  if (!labels.length) throw new Error('Add at least one checklist item, or choose Open canvas.');
  if (labels.length > 12) throw new Error('Keep the checklist to 12 items so it is easy to follow.');
  if (labels.some(label => label.length > 160)) throw new Error('Keep each checklist item to 160 characters or fewer.');
  return {
    template,
    attendees: names.map(name => ({ id: freshId(), name })),
    tasks: labels.map(label => ({ id: freshId(), label })),
  };
}

/** No pretend screen objects: all windows still come from a person's explicit share. */
export function templateCanvas(templateId) {
  const template = recipe(templateId);
  if (!template || template.id === 'open') return [];
  const color = '#344a3b';
  const text = (x, y, width, height, value, fontSize = 18) => ({ id: freshId(), type: 'text', x, y, width, height, text: value, fontSize, color, z: 1 });
  const note = (x, y, width, height, value, fill = '#f0e4ad') => ({ id: freshId(), type: 'sticky', x, y, width, height, text: value, fontSize: 17, color, fill, z: 2 });
  const prompts = {
    'team-walkthrough': ['A turn for every window.', 'What are we looking at?\n\nAdd a small note about the work and the feedback you need.', 'Things to take with us', 'Questions for the room\n\nWhat caught your eye?\nWhat should we try next?'],
    'weekly-check-in': ['A little progress, together.', 'Today’s check-in\n\nWhat moved forward?\nWhere could a teammate help?', 'Our next small steps', 'Questions & blockers\n\nLeave a note.\nWe can work through it together.'],
    'design-review': ['Make room for a closer look.', 'A question for the review\n\nWho is this for?\nWhat decision would help the work move forward?', 'Decisions & follow-ups', 'What are we noticing?\n\nAdd observations and questions as we go.'],
  }[template.id];
  return [
    text(70, 55, 840, 60, prompts[0], 30),
    text(70, 130, 280, 62, 'Start with the Session guide.\nShare a window when you are ready.', 15),
    note(70, 220, 280, 250, prompts[1]),
    text(400, 165, 535, 80, 'A shared stage for your windows', 23),
    text(400, 235, 535, 125, 'Share your main window to begin.\nThe host can feature a teammate’s window\nas you take turns.\n\nChoose Explore canvas to add notes and questions.', 17),
    text(70, 535, 380, 44, prompts[2], 23),
    note(70, 595, 385, 135, 'One thing worth remembering…', '#e7eddf'),
    note(490, 535, 410, 195, prompts[3], '#f3e6d3'),
  ];
}
