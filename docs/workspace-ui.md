# Workspace UI primitives

Classic and Space & Time use a small internal UI library in `src/ui/workspace-primitives.js` and `.css`. It provides shared interaction behavior and a few recognizable shapes without a component-framework dependency. Shared tool definitions live in [`src/canvas-tools.js`](../src/canvas-tools.js); the [tool design review](tool-design-review.md) maps controls and their interaction behavior.

Use the same shapes for the same purpose:

| Primitive | Purpose |
| --- | --- |
| `cw-capsule` / `cw-segment` | Switch between related views. |
| `cw-pebble-dock` | Keep the small set of primary tools together. |
| `cw-board-tab` | Navigate boards with a bookmark edge and selected spine. |
| `cw-round-button` | A compact utility with a full touch target. |
| `cw-folded-menu` | Secondary actions and contextual inspectors. |
| `cw-status-bead` | Report state without adding another button. |

`attachPopover({ trigger, panel, placement, onOpenChange })` returns `open`, `close`, `toggle`, `update`, `isOpen`, and `destroy`. It supplies expanded state, keyboard entry, Escape/outside dismissal, focus return, viewport-aware placement, and hidden/inert closed content. Give the panel its appropriate role and accessible label. Close a surface before opening a modal or starting another interaction.

`bindDetailsMotion(details)` adds short reveal motion to a native disclosure. `bindDetailsDismiss(details)` supplies contextual dismissal. Each returns a cleanup function.

`attachRovingToolbar(toolbar)` keeps keyboard navigation within a compact tool group. Its cleanup restores owned tab stops. Buttons still need useful accessible names and selected/pressed states from the application.

`animatePanel(panel, { opening, duration })` returns `{ cancel, finished }`. Motion uses the Web Animations API with transform and opacity, has a bounded duration, and respects reduced-motion preferences. It leaves no lasting inline animation styles.

Components own shared document state; these primitives own presentation and interaction. Opening a menu, orbiting a camera, and selecting a historical view must not write canvas edits. Call all cleanup functions when a workspace unmounts so observers, listeners, scheduled frames, focus attributes, and owned styles are released.

These are internal frontend building blocks. Bun hosts continue to embed the complete workspace through the existing SDK.
