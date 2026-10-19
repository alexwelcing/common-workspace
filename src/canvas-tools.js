// Both workspaces use the same names, shortcuts, and placement instructions.
export const CANVAS_TOOLS = Object.freeze([
  { id: 'select', label: 'Select', icon: 'MousePointer2', shortcut: 'v', hint: 'Drag to move · Enter to edit · F to focus', touchHint: 'Tap to select · Drag to move · Pinch to zoom' },
  { id: 'hand', label: 'Pan', icon: 'Hand', shortcut: 'h', hint: 'Drag to move your view · Scroll to pan', touchHint: 'Drag to move your view · Pinch to zoom' },
  { id: 'draw', label: 'Draw', icon: 'Pencil', shortcut: 'p', hint: 'Drag to draw · Escape cancels the stroke', touchHint: 'Drag to draw · Two fingers to move your view' },
  { id: 'text', label: 'Text', icon: 'Type', shortcut: 't', hint: 'Click to add text · Resize the box to change text size', touchHint: 'Tap to write · Resize the box to change text size' },
  { id: 'sticky', label: 'Note', icon: 'StickyNote', shortcut: 'n', hint: 'Click to add a note · Resize the box to change text size', touchHint: 'Tap to write a note · Resize the box to change text size' },
  { id: 'rectangle', label: 'Box', icon: 'Square', shortcut: 'r', hint: 'Drag to draw a box · Double-click to add a label', touchHint: 'Drag to draw a box · Select, then Edit to add a label' },
  { id: 'ellipse', label: 'Ellipse', icon: 'Circle', shortcut: 'o', hint: 'Drag to draw an ellipse · Double-click to add a label', touchHint: 'Drag to draw an ellipse · Select, then Edit to add a label' },
  { id: 'arrow', label: 'Arrow', icon: 'MoveUpRight', shortcut: 'a', hint: 'Drag from the start to the arrowhead', touchHint: 'Drag from the start to the arrowhead' },
].map(tool => Object.freeze(tool)));

export const PRIMARY_TOOL_IDS = Object.freeze(['select', 'sticky', 'draw']);
export const CANVAS_TOOL_SHORTCUTS = Object.freeze(Object.fromEntries(CANVAS_TOOLS.map(tool => [tool.shortcut, tool.id])));
export const DEFAULT_TOOL_COLOR = '#305e48';
