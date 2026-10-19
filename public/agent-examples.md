# Make something together: Common agent recipes

Use Common as the place where people can see, question, and edit an agent's work.
These recipes combine a live canvas with the tools your agent already uses.
Each one names a concrete result and gives you a prompt to adapt.

## Choose your connection

| Connection | How it participates |
| --- | --- |
| Browser API | Use `window.commonAgent` inside the Common tab, the visible JSON command runner, or `controller.agent` from an existing embedded mount. |
| Experimental WebMCP | Supporting browsers expose granted tools such as `common_canvas_add`. This is an in-browser adapter; Common does not currently provide a remote MCP server. |
| Your agent's other MCP servers | Bring PR context, issue details, or observability findings into the workflow through connections your agent already has. Common supplies the shared canvas, rather than those integrations. |
| A2A handoffs | Coordinate specialists through your own agent system, then let a presenter write their results into Common. The handoff recipe below is an integration design; this main checkout does not implement an A2A transport or Agent Card. |

Start on a personal canvas or join a room with the people who should participate.
In **Agent tools**, the person grants **Read the canvas** and **Edit and present**.
Add capture and recording permissions when the recipe needs them. To include a
product window, the person selects it through **Share a window** and the browser
picker. These are separate approvals.

Canvas edits are shared with admitted peers. View focus, walkthrough playback,
snapshots, and recordings belong to the presenting tab. In Space & Time, agent
commands act on the active board; people select boards and navigate history.
See the [API reference](agent-api.md) for schemas and exact limits.

## 1. Turn a feature branch into a 90-second release film

**You bring:** a running feature, its PR description, and a shared product window.
Your agent can obtain the PR through its existing GitHub tools or use text you
provide. Its normal browser tools operate the product.

**Make together:** place three captions beside the live screen: **Before**,
**What changed**, and **Why it matters**. Draw a box around the new interaction,
then load a walkthrough using the actual screen and caption object IDs. Present
the feature and record the canvas as the view moves between those objects.

**Take away:** a short annotated video and an editable explanation your reviewer
can question directly on the canvas. Common records video only; put essential
captions on canvas objects because the walkthrough text overlay is outside the
recorded canvas. Download the clip before reloading or closing the tab.

**Give your agent this prompt:**

> Help me demonstrate this feature to someone who has never seen it. Inspect the
> canvas and the PR context I provide. Keep the shared product window central.
> Add Before, What changed, and Why it matters captions without covering it.
> Load three walkthrough steps using the actual object IDs. Wait for me to say
> ready before recording the canvas. After the demonstration, stop and download
> the clip. Keep the annotations for discussion.

**Connect it:** browser/WebMCP canvas tools plus your agent's existing PR and
browser tools. Common actions: `canvas.inspect`, `canvas.add`, `walkthrough.load`,
`walkthrough.next`, `recording.start`, `recording.stop`, `recording.download`.

## 2. Make a disappearing bug leave an evidence kit

**You bring:** a staging checkout where changing the delivery country sometimes
leaves the previous tax total visible. This is a sample scenario, not a reported
Common defect.

**Make together:** reproduce the behavior in a shared window. Keep four distinct
areas: **Expected**, **Observed**, **Steps**, and **Still unknown**. Put an
annotation next to the stale total. Have the agent record what it actually saw,
including which attempt reproduced it, rather than inventing a root cause.

**Take away:** a PNG with the approved, decoded window and annotations, an optional
short video, and a structured summary for the engineer who will investigate.
An SVG/JSON canvas export preserves board content but excludes live video frames.

**Give your agent this prompt:**

> Help me turn this intermittent checkout issue into something another engineer
> can investigate. Set up Expected, Observed, Steps, and Still unknown areas.
> After I reproduce it, write the exact sequence and visible result. Keep
> observations separate from hypotheses. Capture a PNG of the evidence and
> summarize the unresolved question. Leave unrelated objects alone.

**Connect it:** browser API or WebMCP for annotation and capture. A handoff to a
coding agent can carry the summary and downloaded evidence through your existing
orchestration. Common actions: `canvas.add`, `canvas.update`, `capture.snapshot`.

## 3. Compare three futures for the same screen

**You bring:** an onboarding screen and one constraint: a first-time user should
understand the next action without reading a paragraph.

**Make together:** ask a design agent to generate three raster mockups with its
own image tool: a guided checklist, a single next-action card, and an empty state
with an example. Import them side by side. Have a reviewer place one benefit,
one tradeoff, and one question under each. People move and annotate the candidates,
then select one direction for a second iteration.

**Take away:** a comparison board that retains the alternatives and the reason
for the decision, along with the selected image.

**Give your agent this prompt:**

> Use your image generator to explore these three onboarding directions. Import
> the resulting raster images into Common in a row. Below each, add a benefit,
> a tradeoff, and a question about first-use comprehension. Label generated
> concepts clearly. Wait for our choice before producing another iteration;
> keep the original candidates visible.

**Connect it:** your agent's image generator supplies files; `image.add` imports
them. Use `canvas.add`, `canvas.layer`, and `canvas.lock` for labels and layout.
Common accepts inline raster images within the [documented image limits](agent-api.md#generated-images).

## 4. Give an incident room an evidence map

**You bring:** a slow checkout, a dashboard window, and an agent with an existing
observability MCP connection or a supplied trace excerpt.

**Make together:** arrange **Observed**, **Hypotheses**, and **Next action** areas.
An investigator gathers request durations and timestamps. A diagramming agent
turns those findings into a Mermaid path such as browser → checkout API → payment
provider. Highlight the measured slow hop and label unverified explanations as
hypotheses. Update existing objects as new evidence arrives.

**Take away:** a service map with evidence references and one explicit next
investigation step, visible to the human incident lead and other participants.

**Give your agent this prompt:**

> Use the trace evidence I provide or your authorized observability tools to
> explain this slow checkout. Put timestamps and source references beside facts.
> Diagram the request path in Mermaid and highlight measured delays. Keep
> hypotheses separate. Update your existing findings by object ID as evidence
> changes. Ask the incident lead to choose the next action.

**Connect it:** an external MCP connection supplies evidence; Common renders
`canvas.add` diagram objects with `language: "mermaid"` and accepts `canvas.update`
for subsequent findings. An A2A coordinator could hand investigator findings to
the diagrammer using the pattern below.

## 5. Add “Explain this state” to an existing Bun application

**You bring:** an internal order-management app. An order says “accepted” while
payment confirmation is pending, and new support staff keep asking what to do.

**Make together:** embed Common as a floating workspace using the
[Bun integration guide](https://github.com/alexwelcing/common-workspace/blob/main/docs/embedding.md)
(repository access required). A host-page button supplies a selected
state summary to your agent. The agent draws the relevant state machine and adds
three notes: **What happened**, **What is pending**, and **What I can do next**.
The person can rearrange the explanation beside the live application.

**Take away:** an explanation tied to the current task, with editable reasoning
rather than another static help page.

**Give your agent this prompt:**

> Explain this supplied order state in the Common panel. Draw a small Mermaid
> state diagram and add What happened, What is pending, and What I can do next
> notes. Name missing information rather than guessing. Keep the explanation
> editable. Refresh only the objects you created when I supply a new state.

**Connect it:** the host owns the selected state and agent invocation. Use the
mounted controller's asynchronous `agent.execute()` or `agent.batch()` proxy.
Mounting the panel does not grant access or connect a model automatically.
The panel and command registry work with local Bun hosting.

## 6. Run an A2A design relay with a visible human decision

**Integration design:** bring your own A2A coordinator and specialist agents.
Common is their shared presentation surface, not the dispatcher.

**You bring:** a brief: “Invite a teammate, assign their role, and show the first
useful task.” Assign three roles: a **Builder** proposes the flow, a **Skeptic**
looks for abandonment and accessibility problems, and a **Presenter** turns their
findings into canvas objects. A person makes the final decision.

**Make together:** the Builder returns a flow and assumptions. The Skeptic
returns specific objections and alternatives tied to the Builder's findings.
The Presenter creates a Mermaid flow, numbered objection notes, and a **Decision
needed** box. When a person changes the brief on the board, the Presenter asks
the coordinator for a revision rather than overwriting that edit blindly.

**Take away:** a reviewable proposal, its strongest objections, and an explicit
human decision with rationale. The intermediate work remains visible.

**Give your coordinating agent this prompt:**

> Run a design relay for this teammate-invitation flow. Ask the Builder for a
> proposal and assumptions. Pass that result to the Skeptic for three concrete
> failure cases and possible remedies. Have the Presenter draw the proposal and
> objections in Common, then ask us to choose what to change. Keep each agent's
> contribution identifiable. Re-inspect before revising a human-edited object.

### A small handoff to adapt

Use your A2A library for discovery, task messages, status, and artifact delivery.
The following is **application-defined artifact content**, not an A2A wire
envelope or a built-in Common command:

```json
{
  "kind": "common.review-findings.v1",
  "reviewId": "invite-flow-review-1",
  "authorRole": "skeptic",
  "summary": "Explain pending invitations before asking for another invite.",
  "findings": [
    {
      "key": "pending-invite",
      "observation": "The supplied mockup shows no pending-invitation state.",
      "question": "How does the inviter know whether to resend?",
      "suggestion": "Show the invite status and a deliberate resend action."
    }
  ],
  "needsHumanDecision": true
}
```

Keep one Presenter as the canvas writer for a review. It maps artifact findings
to a namespaced set of object IDs and retains that mapping in your coordinator.
Other agents send findings rather than issuing conflicting canvas commands.
The Presenter uses the authorized browser API or embedded controller in the
current tab. Remote agents do not gain canvas access from an artifact or a room
link. On a grant or session change, stop and obtain fresh human authorization.
Re-inspect before applying a delayed response; inspection and updates are not an
atomic conflict check, so present overlapping human changes for review.

Common's [discovery manifest](.well-known/agent.json) describes its browser tools;
it is not an A2A Agent Card. Locate or add your A2A adapter separately.

## Try the API: create the bug exhibit

This creates a new example exhibit below the existing objects on the active
canvas each time you invoke it.
It uses the existing API, not a server-side room write endpoint. Run it in the
Common tab after granting read/edit access, or pass `controller.agent` from an
existing host integration. The sample text is fictional and remains editable.

```js
async function createBugExhibit(api) {
  if (!api) throw new Error('Open Agent tools and wait for Common to finish loading.');
  const state = await api.state();
  if (state.ok === false) throw new Error(state.error.message);
  if (!state.ready || state.readOnly || !Array.isArray(state.entities)) {
    throw new Error('Open an editable canvas and grant read/edit access in Agent tools.');
  }
  const top = state.entities.reduce((bottom, entity) =>
    Math.max(bottom, entity.y + entity.height + 60), 100);
  const prefix = `repro-${crypto.randomUUID()}`;
  const cards = [
    ['expected', 'Expected\nChanging the delivery country recalculates the tax total.'],
    ['observed', 'Observed\nRecord what the shared product window actually shows.'],
    ['steps', 'Steps\n1. Open staging checkout.\n2. Change the delivery country.\n3. Compare the tax total.'],
    ['unknown', 'Still unknown\nDoes the API return the new total, or is the view stale?']
  ];
  const commands = cards.map(([key, text], index) => ({
    action: 'canvas.add', requestId: `${prefix}-${key}`,
    entity: {
      id: `${prefix}-${key}`, type: 'sticky',
      x: 80 + index * 280, y: top, width: 250, height: 220, text
    }
  }));
  const response = await api.batch(commands);
  if (!response.ok) throw new Error(response.error.message);
  const failures = response.result.filter(result => !result.ok);
  if (failures.length) {
    throw new Error(`Some cards were not added. Inspect the canvas before retrying: ${failures.map(result => result.error.message).join('; ')}`);
  }
  const view = await api.execute({
    action: 'view.focus', bounds: { x: 60, y: top - 20, width: 1130, height: 260 }
  });
  if (!view.ok) throw new Error(view.error.message);
  return commands.map(command => command.entity.id);
}

const objectIds = await createBugExhibit(window.commonAgent);
```

Batches run in order and can partially succeed; inspect each result. For an
identical retry, retain the original commands and request IDs within the same
grant/session instead of invoking the function again. Keep returned object IDs
to update your exhibit without touching another participant's work.

### The same edit through WebMCP

In a supporting browser, discover the granted tool `common_canvas_add` and supply
these arguments. This is tool argument data, not a call to an HTTP endpoint:

```json
{
  "requestId": "repro-question-1",
  "entity": {
    "id": "repro-question",
    "type": "sticky",
    "x": 80,
    "y": 380,
    "width": 420,
    "height": 200,
    "text": "Question: which response first contains the updated tax total?"
  }
}
```

Parse the returned JSON string and check `ok`. With the browser API, add
`action: "canvas.add"` to that object and pass it to `execute()`. With the visible
JSON runner, paste that command and choose **Run command**. Use a fresh object ID
for another note; reuse a request ID only for an identical retry.
