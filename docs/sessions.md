# Use Common with your team

Bring a window you want to discuss, a few ideas to sketch, or a feature to walk
through together. You can start on a personal canvas or create a room and share
its invitation. Room passwords need at least eight characters; send the password
separately from the link.

This guide covers the classic canvas, including guided sessions, drawing controls,
chat, and recording. [Space & Time](space-time.md) has its own boards, templates,
and automatic history; it does not yet include classic chat, participant
checklists, or featured-screen rotation. For setup and networking, use the
[hosting guide](hosting.md).

## Guided team sessions in classic

In the classic canvas, choose **Team walkthrough**, **Weekly check-in**, or **Design review** when creating a session. Each preset starts a canvas with prompts and a **Session guide**. Add expected names and edit the checklist before starting, or choose **Open canvas** for a freeform room. Space & Time has separate board templates; it does not yet have this participant-checklist or featured-screen interface.

1. The host shares the session link and password, then approves their main window with **Share a window**. The first host window is featured automatically.
2. Each person joins, chooses their name in the plan (or joins as an additional participant), chooses **I'll present** or **Watch & contribute**, and completes their checklist. Choosing a role does not start capture; **Share a window** opens the browser picker when ready. Watching does not require capture or count an unavailable window as shared. The host sees waiting names, joined people, shared-window status, and progress.
3. The host chooses **Feature** beside a person or **Next window** to rotate through sharing teammates in planned order. **Feature my window** returns to the main presentation.
4. **Follow featured** shows the host's selection in this browser. **Explore canvas** or Back/Escape leaves that view so you can write and draw. Following never starts screen capture or resumes a window you paused; **Resume watching** does that explicitly.

The planning list is not an identity check or invitation restriction. Everyone still needs the room link and password. Checkboxes belong to the signed-in room participant; only the host can choose the shared featured person. The planning list is bounded to 200 names and the checklist to 12 items to keep setup manageable; additional people can still join. Session metadata and checklist state use the existing room service and expire with the room. Canvas content remains ephemeral and lives in the participating browsers. The app does not send invitations for you.

## Give a room its own style

In classic, choose **Room style** while creating a session, or open **Canvas options → Room style** afterward. In Space & Time, open **Room → Room style**. Start with **Meadow**, **Rose**, **Lagoon**, or **Lavender**, then choose custom accent and canvas colors and a **Little dots**, **Quiet grid**, or **Plain canvas** background. The preview stays in the editor until you apply it.

The host controls the shared style; everyone receives it when joining, reconnecting, or reloading. Room style works in freeform and guided rooms on Netlify, standalone Bun, and embedded installations. Participants can inspect the style, while only the host can apply changes. Existing rooms start in Meadow.

Room colors style the interface and background. Existing notes, drawings, and diagrams keep their own colors; a dark canvas can need lighter text. PNG snapshots, canvas recordings, and SVG exports include the background. A personal canvas has **Canvas options → Canvas style**, saved only in this browser. Styling needs no account, external asset, or new service.

## Phones and tablets

Join with the same link and password. In a classic guided room, choose **Watch & contribute** in the Session guide to take part without sharing a window; complete your manual checklist items, chat, and edit the canvas. The host sees your participation choice and readiness. You can change that choice later without losing progress. Choosing a mode never opens a capture picker, stops capture, or resumes a paused video. Space & Time uses its board and timeline interface instead of the classic Session guide and chat.

Use two fingers to pan and pinch to zoom. With one finger, drag objects or use a drawing tool. Starting a pinch cancels the unfinished one-finger edit. **Focus** enlarges a window or note for your view and hides the mobile drawing tools; **Back to canvas** restores them. Pinching leaves Focus so you can explore independently. Touch controls have larger targets, and People/chat has its own close button.

Select a text object or note and tap **Edit** to write. On a phone, writing opens a focused view with readable text independent of canvas zoom. Tap **Done** to return to the board; its object sizes and your camera stay unchanged. Navigation and drawing controls tuck away while writing, with active sharing/recording Stop controls still available. Desktop editing stays inline.

The mobile writer stays at 18 px. On the board, text in notes, text objects, rectangles, and ellipses fits the shared box automatically. Resize the box to change its displayed text size; fitting preserves the complete text and does not move or resize the object for you.

Common fits chat and dialogs to the visible viewport when the keyboard opens and respects device safe areas. Floating embeds follow the host page's visible viewport too; inline embeds remain in their application's layout. Browser zoom remains available for accessibility.

Screen capture and recording depend on the actual browser APIs, rather than a phone/desktop label. If capture is unavailable, **Sharing help** explains why and the guide offers **Join without sharing**. Canvas snapshots and recording have their own capability requirements. Keep the session tab active for live collaboration; mobile operating systems can suspend background tabs. Download recordings before closing or reloading. Mobile layouts and touch gestures are checked in browser emulation; native keyboard, browser picker, and device-to-device video still need a check on the team's physical devices.

## Sharing and collaboration

The canvas controls below describe classic. Space & Time shares the drawing and window-capture foundations, with its own [board, overview, and history controls](space-time.md#work-in-space-and-time).

Select, Note, and Draw stay in the dock; **More canvas tools** holds the other tools, image/diagram insertion, and color. Space & Time uses **More board tools** for the same drawing choices. Shortcuts work while using the canvas or its tool controls, leaving text fields and other navigation alone. See the [tool design review](tool-design-review.md) for the full control map and interaction details.

### Share and watch windows

**Share a window** opens the browser picker directly. The sharing strip shows the request, approved source type, and audience, with Stop and an entry to the manual recorder. A dismissed or blocked request stays retryable with **Sharing help** for browser, system, HTTPS, and embedding restrictions. Common requests video only; canvas recording and agent access have their own visible controls.

- Each participant can share one selected window or screen at a time. The browser requires a click and its native capture picker. An operating system window cannot be dragged directly into a web page to grant capture access. Image files can be dropped onto the canvas.
- Screen sharing is video-only. Use **Watch window** or **Pause view** on a remote screen tile to choose the video this browser receives. The frontend defaults to watching up to four remote windows, or two when reported memory or CPU resources are low; a hidden tab pauses its remote video subscriptions. Pausing is local and does not stop the presenter's capture or change shared annotations. Sharing pixels does not provide remote control of another participant's computer.
- Screen tiles are removed when their owner disconnects. The room service retains room metadata and recent chat for the room's short lifetime. Ending a room revokes access. Only the standalone Bun service supports older rooms with server-based canvas storage.

### Draw and organize

- Select an object to use Bring to front, Bring forward, Send backward, Send to back, and Lock position. Open Layers at the top right of the canvas to select a covered object. Position locks prevent accidental dragging/resizing for everyone; participants can unlock the object. Text remains editable. Screen tiles remain under their owner’s control.
- Use **Focus** or F to enlarge a selected object just in your browser; Escape or **Back to canvas** restores your previous view. Other objects are hidden locally during Focus. It respects paused windows, and canvas snapshots/recordings capture that focused view. SVG export still includes the whole canvas.
- Move and resize with the mouse or pointer; hold Shift while resizing to preserve proportions. Resize targets stay usable at every zoom. Arrow keys move a selected object, Alt + arrows resize it, and Shift makes 10-pixel steps. Use **Edit** or Enter for text and diagram editing. Ctrl/Cmd + ] or [ moves a layer one place, with Shift moving it to the front/back.
- **Undo/Redo** reverses this browser's canvas actions, including moves, text, layers, locks, deletes, and image batches. Ctrl/Cmd + Z and Ctrl/Cmd + Shift + Z work with the canvas focused; text fields keep their native undo. Newer peer field changes are kept. Recovering a deleted object makes a new copy with a new ID and the snapshot at deletion time; live screens are excluded. History stays in this tab/session, bounded to 100 entries and 24 MiB of recorded actions, with one active group also capped at 24 MiB.
- Drop up to five images at the pointer, pick multiple files, or paste a screenshot onto the canvas without clipboard-read access. Batches are spaced apart and undo together. Text and editable-field paste remain unchanged; an import finishing after a session change is discarded.
- Mermaid renders locally. PlantUML needs an enabled renderer and explicit consent to send it the complete diagram source. The standard profile uses `plantuml.com` by default; the private profile leaves rendering disabled unless you configure an endpoint. Choose a renderer appropriate for your diagram's content.

### Chat and dialogs

- Chat keeps your draft and cursor through incoming messages, participant updates, panel switches, and reconnects. Enter sends; Shift + Enter adds a line. Drafts live only in this mounted tab/session and are lost on reload or room change. Sending keeps the draft until the server echoes the message; uncertain delivery keeps it for review, without automatic retries. Delivery and reconnect feedback stays visible while typing on a phone. Unread badges and a new-message jump let you read earlier messages without being scrolled away.
- Dialogs keep keyboard focus inside, support Escape, and return to their opening control. Replacing a dialog keeps the original opener. Background controls stay inactive until dismissal, and destructive session confirmation starts on **Keep session open**.

### Room data and capacity

- Classic rooms use Yjs with a shared map for each object property. Reordering an object merges with another person’s resize or text change. Concurrent changes to the same property resolve deterministically. Canvas updates are forwarded across a sparse network, with five-second state-vector checks between neighbors to repair missed updates; the canvas does not promise offline editing. Space & Time uses separate Loro documents and automatic history, covered in the [Space & Time guide](space-time.md).
- New classic room canvas documents live in browser memory, including shared images, layer order and locks. A late joiner gets the document from connected participants. Once every participant closes the room, its canvas is gone unless someone exported it. The personal canvas still saves on the current device. Space & Time also saves its boards and history to each participating browser's IndexedDB.
- Rooms have no fixed participant admission cap. Authentication, rate limits, connection leases, canvas budgets, and hosting resources still apply. See the [capacity notes](hosting.md#scope-and-limits) before choosing a room size.

## Browser agents and product walkthroughs

Open **Agent tools**, choose the scopes and duration, then select **Allow selected access** in the current tab. The default grant allows canvas inspection and editing for 15 minutes; capture and recording are separate choices. Access can be revoked and expires on a session change. Browser agents can use the labeled JSON command runner, or `window.commonAgent` when their tools permit page JavaScript. They can inspect object IDs, write text, draw annotations, import generated images, change geometry and layers, focus objects, and guide a walkthrough. Edits use the same shared document as human edits. Solo walkthroughs and window sharing also work on the personal canvas without creating a room.

Agents discover instructions at `agents.md`, interfaces at `.well-known/agent.json`, and generated command schemas at `agent-tools.json` beneath the current Common mount: `/` for the standalone app or `/__common/` for the default embedded mount. Supported browsers can expose the same registry through experimental WebMCP, with only currently granted tools registered. The UI/JavaScript bridge works without WebMCP. See [AGENT_API.md](../AGENT_API.md) for commands and [workflow recipes](../public/agent-examples.md) for concrete projects to try. Image generation uses the agent's own tool and imports its output; there is no embedded model credential or remote MCP endpoint.

Agent control starts disabled on each page load. Grants are limited to the current browser/session and at most 60 minutes; the agent API cannot grant itself more access. Position locks, screen ownership, room access, and disconnect behavior still apply. Commands and pending captures retain their original session scope, so changing rooms cannot redirect queued edits into another room. The browser's native picker and the person's manual recording controls remain separate from agent grants.

## Snapshots and recordings

Use **Canvas + annotations** to record the current canvas view, including live windows and drawings, or **Shared window only** to record a window already approved with the browser's native share picker. Recordings contain video only, stay in browser memory, and can be downloaded as WebM or MP4 depending on browser support. Download before reloading. Each recording is capped at five minutes or 100 MiB; a tab retains up to three recordings and 150 MiB total. PNG snapshots are available too. External PlantUML images use a placeholder in canvas captures.

### Optional local MP4 export

Browser recording/downloads work on their own. To convert a saved clip or a sequence of PNG snapshots into MP4, install FFmpeg (`ffmpeg` and `ffprobe`) on the same computer as the browser and start:

```sh
bun run media:export --origin http://localhost:3001
```

Use your actual app origin, including its HTTPS port for a team installation. Open **Canvas options → Recording exports**, connect to the printed loopback worker address, and paste its session token. The token stays in this tab. Choose a retained recording, or 1–50 PNG frames and their duration, then export. Busy controls show the current operation; **Cancel connection** or **Cancel export** lets you retry, and closing the dialog cancels its active operation. The worker processes temporary files locally and removes them after the job; it does not require Cloudflare, Netlify, or Docker. Original browser recordings remain available. The self-hosting guide covers the optional Docker engine and limits. No agent command exposes worker tokens or starts conversion.
