let wasm = null;
let initialization = null;

// Vite fingerprints this asset, so it is served from /assets/ with an immutable cache.
const defaultSource = new URL('./geometry.wasm', import.meta.url);

/** Load the real WASM kernel. A failed download leaves the board usable in JS. */
export async function initGeometry(source = defaultSource) {
  if (wasm) return true;
  if (initialization) return initialization;

  initialization = (async () => {
    try {
      let bytes = source;
      if (typeof source === 'string' || source instanceof URL) {
        const response = await fetch(source);
        if (!response.ok) throw new Error('Geometry module could not be loaded.');
        bytes = await response.arrayBuffer();
      }
      const result = await WebAssembly.instantiate(bytes);
      const instance = result instanceof WebAssembly.Instance ? result : result.instance;
      if (typeof instance.exports.snap_grid !== 'function' ||
          typeof instance.exports.point_segment_distance_sq !== 'function') {
        throw new Error('Geometry module has an incompatible interface.');
      }
      wasm = instance.exports;
      return true;
    } catch {
      return false;
    } finally {
      initialization = null;
    }
  })();

  return initialization;
}

export function geometryBackend() {
  return wasm ? 'wasm' : 'javascript';
}

export function snap(value, grid = 20) {
  if (!Number.isFinite(value) || !Number.isFinite(grid) || grid === 0) return value;
  const spacing = Math.abs(grid);
  return wasm ? wasm.snap_grid(value, spacing) : Math.floor(value / spacing + 0.5) * spacing;
}

function distanceSquared(point, start, end) {
  if (wasm) {
    return wasm.point_segment_distance_sq(point[0], point[1], start[0], start[1], end[0], end[1]);
  }
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared > 0
    ? Math.min(1, Math.max(0, ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSquared))
    : 0;
  const ex = point[0] - (start[0] + t * dx);
  const ey = point[1] - (start[1] + t * dy);
  return ex * ex + ey * ey;
}

/** Iterative Ramer–Douglas–Peucker; never mutates the incoming [x, y] points. */
export function simplifyPoints(points, tolerance = 2) {
  if (!Array.isArray(points)) return [];
  const valid = points
    .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
    .map((point) => [point[0], point[1]]);
  if (valid.length <= 2) return valid;

  const threshold = (Number.isFinite(tolerance) ? Math.max(0, tolerance) : 2) ** 2;
  const retained = new Uint8Array(valid.length);
  retained[0] = 1;
  retained[valid.length - 1] = 1;
  const stack = [[0, valid.length - 1]];

  while (stack.length) {
    const [start, end] = stack.pop();
    let farthest = -1;
    let maximum = threshold;
    for (let index = start + 1; index < end; index += 1) {
      const distance = distanceSquared(valid[index], valid[start], valid[end]);
      if (distance > maximum) {
        maximum = distance;
        farthest = index;
      }
    }
    if (farthest !== -1) {
      retained[farthest] = 1;
      if (farthest > start + 1) stack.push([start, farthest]);
      if (end > farthest + 1) stack.push([farthest, end]);
    }
  }

  return valid.filter((_, index) => retained[index]);
}
