# Common agent API

Read the [full API reference](public/agent-api.md), also served at `/agent-api.md` on each installation. Browser-agent instructions are at [agents.md](public/agents.md), served at `/agents.md` on the same origin. The [self-hosting guide](public/self-hosting.html) explains laptop and team setup without Netlify.

Room admission has no fixed participant cap. Canvas updates use at most six neighbors per browser and propagate the full Yjs document through that overlay. Video is selected separately: use **Watch window** / **Pause view** in the canvas before capturing remote windows. The frontend defaults to four remote windows on desktop and two on small devices, and pauses incoming video when its tab is hidden. There is no agent command for changing video subscriptions; use the browser controls.

These changes do not promise a particular room size or unlimited video. Each device retains the full canvas, with local editing limits of 1000 objects and 16 MiB. A presenter's upload still grows with viewers; room-wide rosters and Netlify signaling/polling remain limits. A large audience may need an optional SFU server, and restrictive networks can still require TURN. Synthetic topology and convergence tests do not establish real-device media capacity.
