# Common agent API

Give an authorized browser agent a canvas for walkthroughs, annotations, image imports, and local recordings. Start in the user's existing Common tab or installation; local and embedded installations have their own rooms and mount paths.

## Choose a guide

| You want to… | Start here |
| --- | --- |
| Try a walkthrough or another complete workflow | [Agent workflow recipes](public/agent-examples.md) |
| Operate Common through browser controls | [Browser-agent instructions](public/agents.md) |
| Find canvas objects and read exact text in small pages | [Search and read](public/agent-api.md#search-and-read-canvas-content) |
| Understand an embedded host page and its controls | [Page companion](docs/page-context.md) and [source commands](public/agent-api.md#linked-page-context) |
| Call `window.commonAgent` or inspect command fields | [Browser canvas API reference](public/agent-api.md) |
| Build room admission or signaling | [Room session API](API.md) |
| Run Common on a laptop or private team network | [Self-hosting guide](public/self-hosting.html) |

The workflow recipes cover feature demos, bug evidence, image comparisons, incident maps, embedded explanations, and an A2A design relay. They include a working canvas API starter and distinguish current interfaces from proposed agent handoffs.

## Access and discovery

The public documentation map is served at [`/llms.txt`](public/llms.txt) on a standalone installation, the browser canvas API reference at `/agent-api.md`, and browser-agent instructions at `/agents.md`. For embedded installations, resolve these files beneath the Common mount rather than the host application's root. The map and Common-specific [discovery manifest](public/.well-known/agent.json) describe interfaces, not private room content or an A2A endpoint.

Agent access uses a timed, per-tab grant with separate inspect, edit, capture, recording, and optional linked-page capabilities. The default grant permits inspection and editing for 15 minutes. Public API version 1 remains `describe`, `state`, `execute`, and `batch`; it cannot grant itself access.

The build generates `/agent-tools.json` from the same schemas used by the optional experimental WebMCP adapter. The normal UI/JavaScript interfaces work without WebMCP or a hosted MCP endpoint. Consult the full reference for permissions, commands, recording limits, and local deployment behavior.

Start content discovery with `canvas.search`: query titles, text, and diagram source, filter by object type, or ask for this browser's selection. Use `canvas.read` for exact text and follow `nextOffset` for more. Both require inspection permission and return bounded pages from the current active canvas. Existing full-state inspection and export remain available.

## Linked product pages

An embedded host can attach `createPageCompanion({root, describe, targets})` through `mountCommon({pageContext})`. The separate **Read linked page** permission enables `source.inspect`, `source.search`, and `source.locate`; `source.highlight` also needs canvas editing and a verified live browser-tab share. These commands describe approved host context and visible controls, without clicking or filling the product. Context is local to the source owner and is not automatically shared or saved in room history.

Read the [integration guide](docs/page-context.md) for a working checkout example and the [source reference](public/agent-api.md#linked-page-context) for permissions, bounded results, and revision checks.

## Text sizing

Text, notes, rectangles, and ellipses fit their text to shared `width` and `height`. Set those box dimensions to control the visual size. Legacy `fontSize` remains accepted and stored for compatibility but does not control fitted text; fitting preserves raw text and object geometry.
