const MAX_STEPS = 50;
const MAX_TITLE_LENGTH = 200;
const MAX_TEXT_LENGTH = 5000;
const FOCUS_PADDING = 64;

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function copyBounds(value, label) {
  if (!record(value)) throw new TypeError(`${label} must be an object.`);
  const bounds = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key])) {
      throw new TypeError(`${label}.${key} must be a finite number.`);
    }
    bounds[key] = value[key];
  }
  if (bounds.width <= 0 || bounds.height <= 0) {
    throw new RangeError(`${label} must have a positive width and height.`);
  }
  if (!Number.isFinite(bounds.x + bounds.width) || !Number.isFinite(bounds.y + bounds.height)) {
    throw new RangeError(`${label} must fit within finite canvas coordinates.`);
  }
  return bounds;
}

function copyStep(step, index) {
  const label = `Walkthrough step ${index + 1}`;
  if (!record(step)) throw new TypeError(`${label} must be an object.`);
  if (typeof step.title !== 'string' || !step.title.trim() || step.title.length > MAX_TITLE_LENGTH) {
    throw new TypeError(`${label}.title must contain between 1 and ${MAX_TITLE_LENGTH} characters.`);
  }
  const copy = { title: step.title.trim() };
  if (step.text !== undefined) {
    if (typeof step.text !== 'string' || step.text.length > MAX_TEXT_LENGTH) {
      throw new TypeError(`${label}.text must be a string of at most ${MAX_TEXT_LENGTH} characters.`);
    }
    copy.text = step.text;
  }
  if (step.targetId !== undefined) {
    if (typeof step.targetId !== 'string' || !step.targetId.trim() || step.targetId.length > 200) {
      throw new TypeError(`${label}.targetId must be a nonempty string of at most 200 characters.`);
    }
    copy.targetId = step.targetId;
  }
  if (step.bounds !== undefined) copy.bounds = copyBounds(step.bounds, `${label}.bounds`);
  return copy;
}

function detachedStep(step) {
  return { ...step, ...(step.bounds ? { bounds: { ...step.bounds } } : {}) };
}

/** Local presentation controls. Shared canvas content is never changed by a walkthrough. */
export class Walkthrough {
  constructor({ getBoard = () => null, onChange = () => {}, onStatus = () => {} } = {}) {
    this.getBoard = getBoard;
    this.onChange = onChange;
    this.onStatus = onStatus;
    this.steps = [];
    this.index = -1;
    this.active = false;
  }

  load(steps) {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) {
      throw new RangeError(`A walkthrough must contain between 1 and ${MAX_STEPS} steps.`);
    }
    // Validate the whole document before changing either the presentation or the view.
    const validated = Array.from(steps, (step, index) => copyStep(step, index));
    this.steps = validated;
    this.index = 0;
    this.active = true;
    return this.present();
  }

  next() {
    if (!this.active || this.index >= this.steps.length - 1) return this.state();
    this.index += 1;
    return this.present();
  }

  previous() {
    if (!this.active || this.index <= 0) return this.state();
    this.index -= 1;
    return this.present();
  }

  stop() {
    if (!this.active) return this.state();
    this.active = false;
    this.index = -1;
    this.onChange(this.state());
    return this.state();
  }

  state() {
    return {
      active: this.active,
      index: this.index,
      total: this.steps.length,
      current: this.active ? detachedStep(this.steps[this.index]) : null,
    };
  }

  present() {
    const step = this.steps[this.index];
    const board = this.getBoard();
    let bounds = step.bounds;
    if (step.targetId) {
      const target = board?.entities?.get(step.targetId);
      if (target) {
        try { bounds = copyBounds(target, 'Walkthrough target'); }
        catch { this.onStatus('This walkthrough target has no usable bounds. Showing the step text.'); }
      } else {
        this.onStatus('This walkthrough target is no longer on the canvas. Showing the step text.');
      }
    }
    if (bounds && board) this.focus(board, bounds);
    this.onChange(this.state());
    return this.state();
  }

  focus(board, bounds) {
    const width = board.el?.clientWidth;
    const height = board.el?.clientHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    const zoom = Math.max(.15, Math.min(
      1.5,
      Math.max(1, width - FOCUS_PADDING * 2) / bounds.width,
      Math.max(1, height - FOCUS_PADDING * 2) / bounds.height,
    ));
    // Board.setZoom anchors its transform. Center the final transform directly so the
    // view-change callback sees one complete frame and never an intermediate jump.
    board.zoom = zoom;
    board.pan = {
      x: width / 2 - (bounds.x + bounds.width / 2) * zoom,
      y: height / 2 - (bounds.y + bounds.height / 2) * zoom,
    };
    board.updateView();
  }
}
