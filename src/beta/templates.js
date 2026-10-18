/** Template content only: the controller supplies appearance; each call creates fresh IDs. */
export function createWorkspaceTemplate(template = 'walkthrough', appearance) {
  const createEntity = (type, text, x, y, extras = {}) => ({
    id: crypto.randomUUID(),
    type,
    text,
    x,
    y,
    width: 270,
    height: 170,
    color: '#34483b',
    fill: '#fff0b5',
    fontSize: 19,
    ...extras,
  });
  const createBoard = (name, pose, entries) => ({
    id: crypto.randomUUID(),
    name,
    pose: { x: 0, y: 0, z: 0, rotationX: 0, rotationY: 0, rotationZ: 0, ...pose },
    width: 1000,
    height: 700,
    objects: entries,
  });
  return {
    title:
      template === 'review'
        ? 'A room for a design review'
        : template === 'open'
          ? 'A little room to explore'
          : 'A room for your next walkthrough',
    appearance,
    boards:
      template === 'open'
        ? [createBoard('Your first board', {}, [])]
        : [
            createBoard('Demo stage', { x: -560, y: -220, z: 100 }, [
              createEntity(
                'text',
                template === 'review' ? 'A place for the design' : 'A place for the work',
                80,
                65,
                { width: 680, height: 85, fontSize: 34 },
              ),
              createEntity(
                'sticky',
                template === 'review'
                  ? 'Share the design and name the decision you need from this review.\n\nNotes and changes save automatically.'
                  : 'Share a window, add a note, or draw a little clarity.\n\nEverything is saved as you work.',
                90,
                200,
                { height: 230 },
              ),
            ]),
            createBoard('Our flow', { x: 540, y: -220, z: -80, rotationY: -9 }, [
              createEntity('diagram', '', 90, 110, {
                width: 680,
                height: 420,
                language: 'mermaid',
                source:
                  template === 'review'
                    ? 'flowchart TD\n  Work[See the design] --> Questions[Explore the questions]\n  Questions --> Decision[Agree on the next revision]'
                    : 'flowchart TD\n  Begin[Arrive together] --> Explore[Explore the work]\n  Explore --> Decide[Find the next small step]',
                title: 'Our flow',
              }),
            ]),
            createBoard('Questions & decisions', { x: -40, y: 560, z: -260, rotationX: 5 }, [
              createEntity(
                'sticky',
                template === 'review' ? 'What is working well?' : 'What would you like feedback on?',
                70,
                110,
              ),
              createEntity(
                'sticky',
                template === 'review' ? 'What needs another look?' : 'What did we learn?',
                385,
                110,
                { fill: '#e2ecd5' },
              ),
              createEntity(
                'sticky',
                template === 'review' ? 'What decision did we make?' : 'What happens next?',
                700,
                110,
                { fill: '#f3dfd9' },
              ),
            ]),
          ],
  };
}
