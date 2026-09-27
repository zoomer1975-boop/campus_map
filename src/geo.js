// Geographic helpers. Local frame: x = east (m), y = north (m).
// World (three.js) frame: x = east, y = up, z = -north.

const R = 6378137;

export function makeProjector([lat0, lon0]) {
  const kx = (Math.cos((lat0 * Math.PI) / 180) * Math.PI * R) / 180;
  const ky = (Math.PI * R) / 180;
  return ([lat, lon]) => ({ x: (lon - lon0) * kx, y: (lat - lat0) * ky });
}

// Drop the closing point of a closed ring.
export function open(ring) {
  const a = ring[0], b = ring[ring.length - 1];
  return a.x === b.x && a.y === b.y ? ring.slice(0, -1) : ring;
}

export function area(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  return Math.abs(s / 2);
}

export function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

// Oriented bounding box from the principal axis of the vertices.
// Returns center, unit long-axis dir (d), normal (n), length (along d), width (along n)
// and rectangularity (footprint area / box area).
export function obb(pts) {
  const n = pts.length;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p.x; my += p.y; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  // Principal axis, then refine by testing edge directions for the tightest box.
  const candidates = [0.5 * Math.atan2(2 * sxy, sxx - syy)];
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    candidates.push(Math.atan2(b.y - a.y, b.x - a.x));
  }
  let best = null;
  for (const th of candidates) {
    const d = { x: Math.cos(th), y: Math.sin(th) };
    const nn = { x: -d.y, y: d.x };
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const p of pts) {
      const u = p.x * d.x + p.y * d.y, v = p.x * nn.x + p.y * nn.y;
      if (u < a0) a0 = u; if (u > a1) a1 = u;
      if (v < b0) b0 = v; if (v > b1) b1 = v;
    }
    const boxArea = (a1 - a0) * (b1 - b0);
    if (!best || boxArea < best.boxArea) best = { d, nn, a0, a1, b0, b1, boxArea };
  }
  let { d, nn, a0, a1, b0, b1 } = best;
  let length = a1 - a0, width = b1 - b0;
  const cu = (a0 + a1) / 2, cv = (b0 + b1) / 2;
  const center = { x: d.x * cu + nn.x * cv, y: d.y * cu + nn.y * cv };
  if (width > length) {
    [length, width] = [width, length];
    [d, nn] = [nn, { x: -d.x, y: -d.y }];
  }
  return { center, d, n: nn, length, width, rect: area(pts) / best.boxArea };
}

// Squared distance from point to segment.
export function distSqToSeg(px, py, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = a.x + t * dx - px, ey = a.y + t * dy - py;
  return ex * ex + ey * ey;
}

// Deterministic PRNG so the scene looks the same on every load.
export function rng(seed = 1) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
