# Space & Time

Space & Time is a regular optional experience in Common 1.10.0 and portable module 0.10.0. Classic remains the default. Choose Space & Time for multiple boards, board templates, a 3D overview, and automatic history; choose classic for chat, guided participant checklists, and featured-screen rotation. Space & Time does not yet have those classic session controls. It loads only when selected and requires no extra account or hosting service.

## Open it

Visit [Space & Time](https://commonwork.aw-ab5.workers.dev/?experience=space), or add `?experience=space` to your local Common address, such as `http://localhost:3001/?experience=space`. For source development, use `http://localhost:5173/?experience=space` after `bun run dev`. The earlier `?beta=space` URL remains a supported alias. Local installation, HTTPS, and team networking follow the [existing instructions](../README.md#run-on-your-own-laptop).

You start with a local workspace. Choose **Start a shared room** in the room-actions menu to bring teammates into a password-protected session. Keep your current boards or choose **Team walkthrough**, **Design review**, or **Open room**. Share the generated invitation and send the password separately. Invitations use `/room/<id>?experience=space`; room metadata also routes an ordinary room link to the right experience, taking precedence over a conflicting query parameter. The query parameter selects an interface, not an access permission.

## Work in space and time

- **Work** opens the selected board for ordinary text, notes, drawing, images, diagrams, layers, and approved window sharing. Select, Note, and Draw stay in the small tool dock; **More board tools** holds the remaining tools. The round share control starts or stops window sharing.
- **Space** steps outside the boards. Drag the open space or use the camera compass to look around; choose a board to step inside. **Position in space** changes its shared X/Y/Z position and rotation. Your camera stays personal. Objects are flat within each board; Space & Time does not provide a general-purpose 3D model editor.
- The timeline contains revisions recorded automatically as people work. Moving into the past makes your view read-only. Teammates continue editing live, and a counter shows new live changes. **Return to live** rejoins the present.
- **Branch from here** creates a new local workspace from the selected past state, with fresh board and object IDs and its own automatic history. It leaves the original room running. Active screen shares are excluded from the new branch.

The walkthrough board template has a **Demo stage**, **Our flow**, and **Questions & decisions**. These are board prompts, not the classic Session guide or participant checkboxes. Design review supplies review prompts; Open room starts with one empty board. Add boards to suit the session. **Room style** offers Meadow, Rose, Lagoon, and Lavender, custom accent/canvas colors, and dots, grid, or plain backgrounds. Style and board-placement changes join the automatic history; existing objects retain their chosen colors.

Text in notes, text objects, rectangles, and ellipses fits the shared object box automatically. Resize the box to adjust its displayed text size. Fitting preserves all text and shared geometry; it does not enlarge the object for you. Legacy `fontSize` values remain in compatible data but do not control fitted text size.

## Write on a phone

Select a text object or note and tap **Edit**. A focused writing view keeps text at a readable 18 px independently of board zoom and follows the space available above the keyboard. The room header, board tabs, drawing tools, and timeline tuck away until editing finishes; active sharing/recording Stop controls remain available. Tap **Done** to return to the fitted board text. Writing changes the same object through the existing live-edit and autosave flow; it does not resize objects or move your camera. Desktop text editing stays inline on the board.

## Autosave and archives

There is no manual save or named-moment step. Edits create automatic revisions, and the browser appends small edit records to an IndexedDB journal. It occasionally compacts the journal into a full-history snapshot, preserving all revisions rather than discarding the past. The save status reports whether that device has saved successfully; it does not mean a server has backed up the content or that every peer has received it. Storage failures stay visible instead of claiming success.

The journal avoids rewriting the whole history for every small edit. Each document compacts after 128 journal segments or 256 KiB of pending journal data. IndexedDB schema 2 automatically upgrades earlier device storage. Loro runs in WASM, while ordinary browser storage handles persistence; no custom filesystem or OPFS setup is required.

The same origin and Common mount path identify the device's workspace storage. Other tabs on that installation exchange updates through BroadcastChannel where available; browsers with Web Locks coordinate writes and merge saved history before replacing it. This is device persistence, not a promise of unrestricted offline collaboration.

Leaving or ending a shared session does not erase its device archive. **On this device** in the room-actions menu reopens saved local branches and room history. A closed room opens its saved history read-only; branch from the past to continue locally. Room access, passwords, and expiry still belong to the existing room service. Clearing site data, private-browsing restrictions, storage eviction, or switching browser/origin can make a device copy unavailable. Use **Export room** for work you want to keep outside browser storage.

**Export room** downloads a binary `.common` replay containing the manifest, boards, embedded images, and complete available automatic history. The version 2 format begins with `CSPACE02`, stores raw Loro documents without base64 expansion, and checks their payload with CRC32. Built-in browser GZIP adds compression when it makes the file smaller. File-size savings depend on the content; this is structured canvas replay, not continuous screen video.

**Import room** opens a replay as a local workspace with its history. Earlier schema 1 JSON archives, including `.common.json` files, still import. Imported content does not overwrite the live shared room. Archives contain the workspace content; share and store them accordingly. Export can still download the in-memory history if device autosave has failed.

Screen-share history preserves window metadata and placement, not previous video frames. To keep pixels, explicitly record the active flat board or an approved window and download that recording separately. Recordings are not included in the spatial archive. Existing recording size, duration, permission, and download rules still apply.

## Embedding and agents

The portable Bun module includes Space & Time and its bundled WASM. Open a local workspace with `mountCommon({ target, basePath, experience: 'space' })`; omit `experience` for classic. To join an existing room, use `mountCommon({ target, basePath, roomId })`. Room metadata selects the experience and overrides an optional `experience` preference. See [the embedding guide](embedding.md#space--time).

Existing opt-in agent tools inspect and edit the active flat board, guide walkthroughs, and capture snapshots or recordings within their granted scopes. They do not yet provide commands to navigate space, select history, or operate across boards. Past views are read-only. Opening Space & Time does not grant an agent access or approve screen capture.

## Current boundaries

Loro 1.16.4 provides the browser's WASM history engine. A workspace manifest and one document per board form the synchronization boundary. Connected browsers currently synchronize **all** board documents and their history; selective board loading is future work. The room service handles admission, presence, and signaling; it does not store spatial content. Chat is currently exposed only in classic. Hosted Cloudflare and standalone Bun use the same Space & Time frontend and native peer connections.

| Limit | Current budget |
| --- | --- |
| Boards | 64 board records per workspace |
| Objects | 1,000 object records per board |
| Current board content | 16 MiB, before decoded-image overhead |
| History document | 12 MiB per serialized Loro document |
| Combined workspace history | 40 MiB |
| Portable archive | 64 MiB |

History retains records, so deleting visible content does not necessarily recover every budget. A fresh branch can start a new history; export before approaching a limit. These are validation budgets, not measured device-memory or room-size guarantees. Browser storage quota, document history, decoded images, peer connectivity, and presenter upload all affect practical capacity.

For a quick walkthrough, use two browser profiles: join a Space & Time room, edit a note from each, change a board's Z position, and explore history in one profile while the other continues writing. Return live, reload to confirm device autosave, then export and import the archive locally. The regular five-journey validation includes the Space & Time peer flow; no additional suite is needed.

## Compatibility with earlier rooms

The stable name and entry URL do not change existing room content or device storage. Older `?beta=space` invitations still open, the room protocol retains `experience: "spatial-beta"`, and existing authentication keys and the `common-spatial-beta` IndexedDB database keep their names. No new database or protocol migration is required for this promotion. Existing `.common` archives and earlier JSON replays remain supported. Classic and Space & Time keep separate document engines; selecting an experience does not convert a room.
