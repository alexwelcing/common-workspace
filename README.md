# Common

A shared browser canvas for the work you want to talk through. Share live windows,
write and draw together, arrange ideas, and let an agent help you explain what is
happening. Use it for a team walkthrough, a design review, or a quiet solo session.

- **Try it now:** open [commonwork.netlify.app](https://commonwork.netlify.app/).
- **Run it locally:** follow the [Bun quickstart](#run-on-your-own-laptop) below.
- **Add it to your app:** use the [Bun integration guide](docs/embedding.md).
- **Work with an agent:** pick an [agent recipe](public/agent-examples.md), or connect your app’s [page context](docs/page-context.md) for a product walkthrough.

## Run on your own laptop

Use **Bun 1.4.3**. Clone this repository with an account that has read access, or
unpack a source archive from your administrator. The repository is private;
access to the hosted app does not include source access.

```sh
bun install --frozen-lockfile
bun run local
```

Open [localhost:3001](http://localhost:3001). Start on your personal canvas, or
create a room with a password of at least eight characters and share its invite
link. Send the password separately.

The launcher builds and starts Common with the private network profile: no
default public STUN or external PlantUML service. Local hosting needs no Netlify
account, Postgres database, or hosted API key. Run `bun run doctor` if setup needs
attention.

To invite people on other laptops, everyone uses the same reachable HTTPS
address. The [laptop setup guide](public/self-hosting.html) walks through LAN/VPN
access, certificates, and keeping the host running. The [hosting reference](docs/hosting.md)
covers built-app commands, Docker, configuration, storage, and network limits.

## Choose your workspace

| Experience | Good for |
| --- | --- |
| **Classic canvas**, the default | A shared canvas with text, notes, images, drawing, diagrams, layers, chat, and simultaneous window sharing. Guided sessions add participant checklists and featured-screen rotation. |
| **Space & Time** | Multiple boards, templates, a 3D overview, and automatic history saved on each device. Agents work on the active board. Chat, participant checklists, and featured-screen rotation are classic features. |

Open [Space & Time](https://commonwork.netlify.app/?experience=space), or add
`?experience=space` to your local address. Existing rooms keep their experience;
invitations open the right one. Earlier `?beta=space` links still work.

In Space & Time, move between working on a board and viewing boards in space.
Explore past edits or branch into a new local workspace while the live room
continues. Its [guide](docs/space-time.md) explains autosave, history, and `.common`
archives. Device autosave is not a server backup; export work you want to keep.

## Use Common with your team

Create a session, share its link and password, and choose the windows you want to
show. Add notes, pictures, boxes, arrows, drawings, and Mermaid or PlantUML
diagrams, then arrange the shared content around the conversation.

Select, Note, and Draw stay close at hand; More tools holds the other choices.
On a phone, a focused writing view gives you room above the keyboard. Window
sharing uses the browser’s picker, and each viewer chooses which remote windows
to watch.

The [session guide](docs/sessions.md) covers templates, checklists, featured
windows, room style, mobile controls, sharing, and recordings. Browser capture
support varies by device. Classic room canvases live in participating browsers;
export work before the last person leaves. Rooms have no fixed participant
cap, but device and network capacity still matter.

## Embed in an existing Bun tool

Put Common beside your product as an inline panel or a floating workspace.
`createCommon` attaches to your existing Bun fetch/WebSocket server;
`mountCommon` loads the interface in a same-origin iframe. The host keeps its
routes, authentication, and listener. Common adds no second port or UI framework.

Download the module and checksum from the [v1.10.0 release](https://github.com/alexwelcing/common-workspace/releases/tag/v1.10.0),
or obtain both from your administrator. Release assets require repository read
access. Install your downloaded archive with
`bun add /absolute/path/common-workspace-0.10.0.tgz`.

Follow the [integration guide](docs/embedding.md), or run the
[complete Bun example](examples/bun-embed/README.md). The package includes its
frontend and example; installing an archive you already have needs no cloud
account or registry login.

## Browser agents and product walkthroughs

Ask an agent to annotate a demo, collect bug evidence, compare generated mockups,
or explain application state. The [agent recipes](public/agent-examples.md) give
you prompts and a working API example to start from.

Open **Agent tools**, choose permissions and a duration, then select
**Allow selected access**. Canvas inspection/editing, capture, and recording have
separate permissions. Sharing a product window still needs the browser’s native
picker. Human recording controls work independently of agent grants.

Agents use the visible command runner, `window.commonAgent`, or an embedded
controller. Supporting browsers also offer experimental WebMCP. Use the
[agent API guide](AGENT_API.md) for interfaces and limits; the recipes explain
external MCP connections and proposed A2A handoffs. Common imports images from
your agent’s own generator and has no embedded model credential, remote MCP
endpoint, or built-in A2A transport.

## Deploy to Netlify

Import the repository from GitHub into your Netlify team. The committed
configuration builds the frontend and deploys the room API and database
migrations. Netlify Database requires a supported credit-based plan.

The [Netlify instructions](docs/hosting.md#deploy-to-netlify) cover build settings,
local platform development, and what to check after deploying. Browser-to-browser
canvas and video connections need no mandatory relay service; investigate actual
connection failures through Connection details.

## Development and troubleshooting

Use `bun run dev` for source changes: it starts Vite at
[localhost:5173](http://localhost:5173) and the Bun API server together.
`bun run build` creates the deployable frontend; `/api/config` chooses its hosting
transport at runtime. The [hosting reference](docs/hosting.md) explains deployment
and operating settings.

Start with the [documentation index](docs/README.md), the
[architecture map](docs/architecture.md), or [contribution guide](CONTRIBUTING.md).
The [maintainer guide](docs/maintaining.md) maps code boundaries and invariants;
the [tool review](docs/tool-design-review.md) explains the interface.

Use **Canvas options → Connection details** for classic connection diagnostics,
or **Performance** in either experience to investigate slow work. For local
quality checks and readable failure reports, see the [validation guide](docs/validation.md).
The [real-device walkthrough](public/self-hosting.html#smoke-test) covers the
browser picker, phone keyboard, and peer video on the team’s actual network.
