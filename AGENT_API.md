# Common agent API

Read the [full API reference](public/agent-api.md), also served at `/agent-api.md` on each installation. Browser-agent instructions are at [agents.md](public/agents.md), served at `/agents.md` on the same origin. The [self-hosting guide](public/self-hosting.html) explains laptop and team setup without Netlify.

Agent access uses a timed, per-tab grant with separate inspect, edit, capture, and recording capabilities. The default grant permits inspection and editing for 15 minutes. Public API version 1 remains `describe`, `state`, `execute`, and `batch`; it cannot grant itself access.

The build generates `/agent-tools.json` from the same schemas used by the optional experimental WebMCP adapter. The normal UI/JavaScript interfaces work without WebMCP or a hosted MCP endpoint. Consult the full reference for permissions, commands, recording limits, and local deployment behavior.

Text, notes, rectangles, and ellipses fit their text to shared `width` and `height`. Set those box dimensions to control the visual size. Legacy `fontSize` remains accepted and stored for compatibility but does not control fitted text; fitting preserves raw text and object geometry.
