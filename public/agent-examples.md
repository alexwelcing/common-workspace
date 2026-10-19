# Make something together

Bring a feature, a tricky bug, or a rough idea. Here are six things you and your
agent can make with Common. Pick one, try the prompt, and make it your own.

## Get ready

1. Open a personal canvas, or join a room with your team.
2. In **Agent tools**, choose **Read the canvas** and **Edit and present**.
   Add capture and recording access for examples that need them, then select
   **Allow selected access**.
3. To include your product, choose **Share a window** and select it in the
   browser picker. Sharing a window and granting agent access are separate steps.

Start with the examples below, or jump to the [working API example](#try-the-api-create-a-bug-board).
The [connection notes](#how-the-tools-connect) explain where MCP, the API, and A2A fit.

## 1. Make a 90-second feature demo

Your feature is running. Give your agent the PR description, or let it read the
PR through its existing GitHub connection. Share the product window and build
three captions beside it: **Before**, **What changed**, and **Why it matters**.
Use a three-step walkthrough to present and record the feature.

**Prompt to copy:**

> Help me show this feature to someone seeing it for the first time. Read the PR
> context and inspect the canvas. Add Before, What changed, and Why it matters
> captions beside the shared window. Load three walkthrough steps using the
> actual object IDs. Wait for me to say ready, then record the canvas. Stop and
> download the clip when we're done. Keep the annotations for discussion.

**You’ll have:** a short demo to share and an editable explanation to discuss.

Common records video only. Put captions on canvas objects; the walkthrough text
bar is outside the recording. Download the clip before closing or reloading.

**For developers:** use GitHub tools for PR context and the agent’s browser tools
to operate the product. Common’s `canvas.add`, `walkthrough.load`, and recording
commands handle the presentation.

## 2. Catch an intermittent bug

Imagine a staging checkout where changing the delivery country sometimes leaves
the old tax total on screen. Share the window and reproduce it. Have your agent
organize four areas: **Expected**, **Observed**, **Steps**, and **Still unknown**.
Keep what happened separate from what might explain it.

**Prompt to copy:**

> Help me capture this intermittent checkout bug. Set up Expected, Observed,
> Steps, and Still unknown areas. After I reproduce it, write the exact sequence
> and visible result. Mark hypotheses clearly. Once the shared video is playing,
> capture a PNG of the evidence. Leave unrelated objects alone.

**You’ll have:** an annotated screenshot and a clear reproduction summary for
the next engineer. Record a short clip too if the sequence matters.

**For developers:** use `canvas.add`, `canvas.update`, and `capture.snapshot`.
[Try the working API example](#try-the-api-create-a-bug-board) to create the four cards.

## 3. Explore three versions of a screen

Take an onboarding screen with one goal: a new user should understand the next
action at a glance. Ask your agent’s image generator for three directions:
a checklist, a single next-action card, and an empty state with an example.
Place them side by side in Common and invite your team to annotate them.

**Prompt to copy:**

> Generate these three onboarding directions with your image tool and import
> them into Common in a row. Under each, add one benefit, one tradeoff, and one
> question about first-use comprehension. Label the images as concepts. Wait
> for our choice before making another version, and keep the originals visible.

**You’ll have:** three possibilities, the feedback on each, and a reason for
the direction you choose.

**For developers:** the agent’s image tool supplies the files; Common imports
them through `image.add`. Use notes and layers to organize the comparison.
See the [supported formats and image limits](agent-api.md#generated-images).

## 4. Make an incident easier to understand

Checkout is slow, and the team is looking at different dashboards. Give an
investigator agent a trace excerpt or access through your existing observability
MCP connection. Ask a diagramming agent to turn its findings into a Mermaid map:
browser → checkout API → payment provider. Keep **Observed**, **Hypotheses**, and
**Next action** areas beside the map.

**Prompt to copy:**

> Use the supplied traces or your authorized observability tools to explain
> this slow checkout. Add timestamps and source references to facts. Draw the
> request path in Mermaid and highlight measured delays. Keep hypotheses
> separate. Update your existing notes as evidence changes, then ask the
> incident lead to choose the next action.

**You’ll have:** one shared picture of the evidence and a clear next step.

**For developers:** your MCP connection supplies the evidence. Common renders
Mermaid diagram objects and accepts updates through `canvas.update`. A coordinator
can pass the investigator’s findings to the diagramming agent.

## 5. Add an “Explain this” panel to your Bun app

An order says “accepted,” but payment confirmation is still pending. A support
colleague wants to know what to do. Embed Common beside the order and have a
host-page button send selected state to your agent. The agent draws a small
state diagram and adds **What happened**, **What is pending**, and **What I can
do next** notes.

**Prompt to copy:**

> Explain this supplied order state in Common. Draw a small Mermaid state
> diagram and add What happened, What is pending, and What I can do next notes.
> Point out missing information. Keep the explanation editable. When I supply
> new state, refresh only the objects you created.

**You’ll have:** an explanation beside the application, ready to edit or share
with a colleague.

**For developers:** your host app supplies the state and invokes the agent.
The mounted Common controller exposes `agent.execute()` and `agent.batch()`;
the person grants access in the panel. See the
[Bun integration guide](https://github.com/alexwelcing/common-workspace/blob/main/docs/embedding.md)
(repository access required). This also works with local Bun hosting.

## 6. Let specialist agents review a design together

**Bring your own A2A coordinator.** This is an integration design for connecting
your agent system to Common.

Start with a brief: “Invite a teammate, assign their role, and show the first
useful task.” A **Builder** proposes the flow. A **Skeptic** looks for confusing
steps and accessibility problems. A **Presenter** draws their findings in Common.
Your team discusses the proposal and decides what to change.

**Prompt to copy:**

> Ask the Builder for an invitation flow and its assumptions. Pass the proposal
> to the Skeptic for three concrete failure cases and possible remedies. Have
> the Presenter draw the flow and numbered objections in Common. Keep each
> contribution identifiable. Ask us what to change, and check for our canvas
> edits before applying a revision.

**You’ll have:** a proposal, useful objections, and a visible human decision
with its rationale.

**For developers:** use your A2A system for agent coordination and Common’s
browser API for presentation. The [handoff example](#pass-findings-between-agents)
below gives you a small artifact to adapt.

## How the tools connect

| Connection | What it does |
| --- | --- |
| Browser API | Edit Common through `window.commonAgent` in its tab, the JSON command runner, or `controller.agent` in an embedded app. |
| Experimental WebMCP | Supporting browsers expose granted tools such as `common_canvas_add`. Common’s adapter runs in the browser; a remote MCP server is not included. |
| Your other MCP connections | Supply PR context, issues, or observability findings through tools your agent already uses. |
| A2A | Your coordinator passes work between agents. Common currently has no built-in A2A transport or Agent Card. |

Canvas edits are shared with people in the room. View changes, walkthrough playback,
snapshots, and recordings stay with the presenting tab. In Space & Time, agents
work on the active board; people choose boards and navigate history.

For a still image that includes a shared window, wait until its video is playing,
then capture a PNG. SVG and JSON exports preserve board content but exclude live
video frames. The [API reference](agent-api.md) covers commands and limits.

## Pass findings between agents

Use your A2A library for discovery, task messages, status, and artifact delivery.
This JSON is **application-defined artifact content** to carry between agents.
It is separate from the A2A wire format and Common’s command API:

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

Let one Presenter write to the canvas. Other agents return findings, and your
coordinator keeps the mapping from those findings to Common object IDs. This
keeps specialists from overwriting each other’s layout.

The Presenter needs an authorized browser API or embedded controller in the
current tab. A room link or artifact does not grant access. Stop on a grant or
session change and ask the person to authorize the new context.

Before applying delayed findings, inspect the canvas again. If someone has edited
the same object, bring the proposed revision back for review. Inspection does not
lock the object against further edits.

Common’s [discovery manifest](.well-known/agent.json) describes its browser tools;
your A2A adapter supplies its own Agent Card and transport.

## Try the API: create a bug board

This starter adds four editable cards below existing content and brings them
into view. Run it in the Common tab after granting read/edit access. For an
embedded app, replace the final call with `await createBugExhibit(controller.agent)`.
The checkout text is sample content. Each invocation creates a new exhibit.

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

A batch can partially succeed. Check every result before retrying. For an
identical retry in the same grant/session, keep the original commands and request
IDs; calling the function again creates another exhibit. Keep the returned
object IDs to update your cards later.

### Try WebMCP: add a question

In a supporting browser, discover the granted `common_canvas_add` tool and pass
these arguments. Adjust the coordinates to place the note in a clear area.

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

Parse the tool’s returned JSON string and check `ok`.

To use the browser API instead, add `action: "canvas.add"` to the argument object
and pass it to `execute()`. You can also paste that command into **Agent command**
in the visible panel and choose **Run command**. Give each new note a fresh object
ID; reuse a request ID only for an identical retry.
