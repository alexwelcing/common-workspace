# Tool design review

The tool review covers Classic and Space & Time, including the compact mobile
layout and keyboard operation. The aim is a small set of visible everyday tools,
clear names for secondary actions, and recovery that preserves people's work.

## Canvas tools

Both experiences use [the same tool definitions](../src/canvas-tools.js).
Select, Note, and Draw stay in the dock. More tools contains the other drawing
tools, image and diagram insertion, and ink color. When a secondary tool is
active, its name remains visible in the dock.

| Tool | Key | Interaction reviewed |
| --- | --- | --- |
| Select | V | Select and move an object; Enter edits its text; F focuses your view. |
| Pan | H | Move the view without editing shared objects. Space temporarily pans. |
| Draw | P | Draw repeated strokes; Escape cancels the unfinished stroke. |
| Text | T | Place text, write, then resize its box to change the displayed size. |
| Note | N | Place a note with the same focused mobile writer and fitted text. |
| Box | R | Draw a rectangle and edit its label. |
| Ellipse | O | Draw an ellipse with its label fitted inside the curved border. |
| Arrow | A | Drag from the start to the arrowhead; horizontal arrows keep their heads. |
| Image | — | Choose or drop images; asynchronous insertion respects the active session. |
| Diagram | — | Enter source; Classic preserves drafts and validation errors before insertion. |
| Ink color | — | Edit eligible selected content or choose ink for the next object. |

Tool shortcuts apply to the canvas and its tool controls. They do not consume
typing, composition, modal input, or unrelated navigation keys. Image and diagram
insertion are actions, rather than toggle modes. Pan, Select, and view controls
remain usable while editing is unavailable.

## Object and view controls

| Control | Review outcome |
| --- | --- |
| Move and resize | Escape restores the original position or size, including an in-progress shared drag. |
| Focus | Enlarge an object locally; returning preserves the shared layout. |
| Layers | Viewport-bounded disclosure with keyboard entry, outside dismissal, and Escape. Lock/reorder updates preserve logical focus. |
| Layer order | Move objects forward/backward without changing their content. A duplicate receives a new top position. |
| Position lock | Keep movement and content editing distinct; reflect the current locked state. |
| Duplicate and delete | Respect editing and screen-ownership rules. Classic undo and Space history provide their existing recovery paths. |
| Zoom, reset, and fit | Zoom buttons move consistently throughout the engine's supported range; fit and camera changes stay local. |
| Space placement | Shared board placement remains separate from the personal camera. |
| Space history and branching | Historical content is read-only; navigation remains available and returning to live is explicit. |
| Import and archive export | Describe the complete workspace/history scope, rather than implying only the visible board is saved. |

## Communication and capture

| Tool | Review outcome |
| --- | --- |
| Window sharing | Keep the browser's native picker, pending/cancel feedback, help, and active Stop control. |
| Recording | Open human recording controls directly from the workspace menu; agent grants remain separate. |
| Recording preparation | Cancel from the panel or active strip; closing the tools cancels preparation. Active recordings continue until stopped. |
| Saved recordings | Download the local clip; confirm discard inline and keep keyboard focus deliberate. |
| PNG and SVG | Preserve the existing fitted-text layout; exported arrows retain their overhanging heads. |
| Local MP4 worker | Cancel connection/export work and ignore late responses. Keep the original recording and useful retry state. |
| Agent access | Keep visible, time-bounded grants separate from human recording and native capture permission. |
| Walkthrough | Announce the current step and preserve focus at step boundaries and Stop. |
| Chat | Preserve drafts, IME input, and uncertain-delivery handling. Actionable send/reconnect feedback remains visible with the mobile keyboard. |
| Session guide | Distinguish choosing to present from opening the sharing picker. Keep pending checklist controls and featured-window following explicit. |
| Templates and themes | Keep per-template drafts and isolated style previews; canceling a preview does not change the shared room. |

## Maintenance

The review uses actual browser interactions and controlled delayed responses for
cancellation and recovery. Existing end-to-end journeys cover both hosting
adapters. No additional test suite or UI dependency is introduced.

Use the existing [workspace primitives](workspace-ui.md) for popovers, focus,
keyboard navigation, and reduced-motion behavior. A narrow toolbar scrolls its
focused action into view without scrolling the canvas or changing its camera.
Tool menus and recording controls release owned listeners and pending work when
the workspace is destroyed.
