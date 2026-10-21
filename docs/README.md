# Find your way around Common

Start with what you want to do. Each guide has a different job, so you can read
the part you need and get back to your work.

## Use Common

| Goal | Guide |
| --- | --- |
| Understand the project and try it | [Project README](../README.md) |
| Run a session, share windows, and organize the room | [Sessions and canvas tools](sessions.md) |
| Use multiple boards, a 3D overview, and automatic history | [Space & Time](space-time.md) |
| Run on a laptop or invite teammates over LAN/VPN | [Self-hosting walkthrough](../public/self-hosting.html) |
| Deploy to Cloudflare or configure local hosting, network settings, and diagnostics | [Hosting and operations](hosting.md) |

## Build with Common

| Goal | Guide |
| --- | --- |
| Embed a workspace in an existing Bun app | [Embedding guide](embedding.md) |
| Give an agent approved page context and target highlights | [Page companion](page-context.md) |
| Run a complete example host | [Bun example](../examples/bun-embed/README.md) |
| Make something with an agent | [Six practical recipes](../public/agent-examples.md) |
| Choose the right agent interface | [Agent API entry point](../AGENT_API.md) |
| Look up canvas commands and grants | [Browser agent API reference](../public/agent-api.md) |
| Discover agent interfaces or search active canvas content | [Public discovery map](../public/llms.txt) and [search/read reference](../public/agent-api.md#search-and-read-canvas-content) |
| Understand room admission and signaling | [Room protocol reference](../API.md) |
| Convert local recordings or PNG frames to MP4 | [Media worker](../media/README.md) |

## Work on the project

| Goal | Guide |
| --- | --- |
| Set up a first contribution | [Contributing](../CONTRIBUTING.md) |
| Understand the system | [Architecture](architecture.md) |
| Find code, lifecycle rules, troubleshooting, or release steps | [Maintainer guide](maintaining.md) |
| Check a change and read a failure | [Validation](validation.md) |
| Find and compare bottlenecks | [Performance guide](performance.md) |
| Understand earlier optimization decisions | [Performance investigation](performance-investigation.md) |
| Reuse focus, popover, toolbar, and motion behavior | [Workspace UI primitives](workspace-ui.md) |
| Understand the tool interaction decisions | [Tool design review](tool-design-review.md) |
| See what shipped | [Changelog](../CHANGELOG.md) |

The **browser agent API** edits the current canvas. The **room protocol** handles
admission, presence, chat, and connection signaling. Choose the agent API when
your goal is to draw, write, arrange objects, or present a walkthrough.
