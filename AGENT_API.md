# Common agent API

Give an authorized browser agent a canvas for walkthroughs, annotations, image imports, and local recordings. Start in the user's existing Common tab or installation; local and embedded installations have their own rooms and mount paths.

## Choose a guide

| You want to… | Start here |
| --- | --- |
| Try a walkthrough or another complete workflow | [Agent workflow recipes](public/agent-examples.md) |
| Operate Common through browser controls | [Browser-agent instructions](public/agents.md) |
| Call `window.commonAgent` or inspect command fields | [Browser canvas API reference](public/agent-api.md) |
| Build room admission or signaling | [Room session API](API.md) |
| Run Common on a laptop or private team network | [Self-hosting guide](public/self-hosting.html) |

The workflow recipes cover feature demos, bug evidence, image comparisons, incident maps, embedded explanations, and an A2A design relay. They include a working canvas API starter and distinguish current interfaces from proposed agent handoffs.

## Access and discovery

The browser canvas API reference is also served at `/agent-api.md` on a standalone installation, and browser-agent instructions at `/agents.md`. For embedded installations, resolve both files beneath the Common mount rather than the host application's root.

Agent access uses a timed, per-tab grant with separate inspect, edit, capture, and recording capabilities. The default grant permits inspection and editing for 15 minutes. Public API version 1 remains `describe`, `state`, `execute`, and `batch`; it cannot grant itself access.

The build generates `/agent-tools.json` from the same schemas used by the optional experimental WebMCP adapter. The normal UI/JavaScript interfaces work without WebMCP or a hosted MCP endpoint. Consult the full reference for permissions, commands, recording limits, and local deployment behavior.

## Text sizing

Text, notes, rectangles, and ellipses fit their text to shared `width` and `height`. Set those box dimensions to control the visual size. Legacy `fontSize` remains accepted and stored for compatibility but does not control fitted text; fitting preserves raw text and object geometry.
