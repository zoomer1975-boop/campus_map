import * as THREE from 'three';
import { pointInPoly } from './geo.js';
import { meterUV } from './uv.js';

// Roofs and architectural extras, built in a local frame per building:
// origin = footprint OBB center at ground, local z = long axis, local x = short axis, y = up.
// rec.style = { roof: flat|gable|hip|mansard|dome|barrel|none, extras: [...] } (see buildings.js).

function frame(rec, group) {
  const { center, d } = rec.obb;
  const g = new THREE.Group();
  g.position.set(center.x, rec.base ?? 0, -center.y);
  g.rotation.y = Math.atan2(d.x, -d.y);
  group.add(g);
  return g;
}

// Map a local (east, north) point into the frame's (x, z).
function toFrame(rec, p) {
  const { center: c, d } = rec.obb;
  const vx = p.x - c.x, vy = p.y - c.y;
  return { x: -vx * d.y + vy * d.x, z: vx * d.x + vy * d.y };
}

function add(rec, parent, geom, mat, x, y, z) {
  if (geom.type === 'BoxGeometry' || geom.type === 'CylinderGeometry') meterUV(geom);
  const m = new THREE.Mesh(geom, mat);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData.record = rec;
  rec.meshes.push(m);
  parent.add(m);
  return m;
}

function box(rec, parent, mat, sx, sy, sz, x, y, z) {
  return add(rec, parent, new THREE.BoxGeometry(sx, sy, sz), mat, x, y + sy / 2, z);
}

// "Front" = the long side facing south-ish (local +x faces south when d.x < 0).
const frontSide = (rec) => (-rec.obb.d.x >= 0 ? 1 : -1);

// Local z of a point `f` (0..1) of the way along the building from its west end.
function alongFromWest(rec, f) {
  const L = rec.obb.length;
  return rec.obb.d.x >= 0 ? -L / 2 + f * L : L / 2 - f * L;
}

// ---------- footprint → rectangles ----------

// Split an (almost) orthogonal footprint into rectangles in the frame, so every wing of an
// L/T/U/cross-shaped building gets its own pitched roof. Returns [] if the shape is not orthogonal.
function rectangles(rec) {
  const pts = rec.outer.map((p) => toFrame(rec, p));
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 1) continue;
    const ang = Math.abs(Math.atan2(b.z - a.z, b.x - a.x)) % (Math.PI / 2);
    if (Math.min(ang, Math.PI / 2 - ang) > 0.21) return []; // > 12° off-axis
  }
  const snap = (vals) => {
    const out = [];
    for (const v of [...vals].sort((p, q) => p - q)) if (!out.length || v - out[out.length - 1] > 1.2) out.push(v);
    return out;
  };
  const xs = snap(pts.map((p) => p.x)), zs = snap(pts.map((p) => p.z));
  const poly = pts.map((p) => ({ x: p.x, y: p.z }));
  const inside = xs.slice(0, -1).map((x0, i) => zs.slice(0, -1).map((z0, j) =>
    pointInPoly((x0 + xs[i + 1]) / 2, (z0 + zs[j + 1]) / 2, poly)));
  const used = inside.map((col) => col.map(() => false));
  const rects = [];
  for (let i = 0; i < inside.length; i++) {
    for (let j = 0; j < inside[i].length; j++) {
      if (!inside[i][j] || used[i][j]) continue;
      let j1 = j;
      while (j1 + 1 < inside[i].length && inside[i][j1 + 1] && !used[i][j1 + 1]) j1++;
      let i1 = i;
      const colFree = (ii) => { for (let jj = j; jj <= j1; jj++) if (!inside[ii][jj] || used[ii][jj]) return false; return true; };
      while (i1 + 1 < inside.length && colFree(i1 + 1)) i1++;
      for (let ii = i; ii <= i1; ii++) for (let jj = j; jj <= j1; jj++) used[ii][jj] = true;
      const x0 = xs[i], x1 = xs[i1 + 1], z0 = zs[j], z1 = zs[j1 + 1];
      if (x1 - x0 > 3 && z1 - z0 > 3) rects.push({ cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, sx: x1 - x0, sz: z1 - z0 });
    }
  }
  return rects;
}

function roofRects(rec) {
  const rects = rectangles(rec);
  if (rects.length && rects.length <= 12) return rects;
  if (rec.obb.rect > 0.8) return [{ cx: 0, cz: 0, sx: rec.obb.width, sz: rec.obb.length }];
  return [];
}

// ---------- roof geometry ----------

// Gable prism over a rectangle; ridge along its longer side.
function gablePrism(rec, parent, r, pitch, maxRise, overhang = 0.7) {
  const alongZ = r.sz >= r.sx;
  const w = alongZ ? r.sx : r.sz, l = alongZ ? r.sz : r.sx;
  const rise = Math.min(w * pitch, maxRise);
  const hw = w / 2 + overhang, len = l + overhang * 2;
  const shape = new THREE.Shape([new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0), new THREE.Vector2(0, rise)]);
  const geom = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
  geom.translate(0, 0, -len / 2);
  if (!alongZ) geom.rotateY(Math.PI / 2);
  add(rec, parent, geom, [rec.set.plain, rec.set.slate], r.cx, rec.height, r.cz);
  return rise;
}

// Hip roof over a rectangle (ridge along its longer side), with planar UVs in meters.
function hipPrism(rec, parent, r, pitch, maxRise, overhang = 0.7, mat = rec.set.slate) {
  const alongZ = r.sz >= r.sx;
  const W = (alongZ ? r.sx : r.sz) / 2 + overhang, L = (alongZ ? r.sz : r.sx) / 2 + overhang;
  const rise = Math.min(W * 2 * pitch, maxRise);
  const ridge = Math.max(L - W, 0);
  const v = [[-W, 0, -L], [W, 0, -L], [W, 0, L], [-W, 0, L], [0, rise, -ridge], [0, rise, ridge]];
  const tris = [[0, 4, 1], [3, 2, 5], [1, 4, 5], [1, 5, 2], [0, 3, 5], [0, 5, 4], [0, 1, 2], [0, 2, 3]];
  const pos = [], uv = [];
  for (const t of tris) for (const i of t) { pos.push(...v[i]); uv.push(v[i][0], v[i][2]); }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geom.computeVertexNormals();
  if (!alongZ) geom.rotateY(Math.PI / 2);
  add(rec, parent, geom, mat, r.cx, rec.height, r.cz);
  return rise;
}

// Half-cylinder (barrel vault) along the rectangle's longer side, e.g. a gymnasium.
function barrelVault(rec, parent, r) {
  const alongZ = r.sz >= r.sx;
  const w = alongZ ? r.sx : r.sz, l = alongZ ? r.sz : r.sx;
  const rise = Math.min(w * 0.22, 10);
  const radius = (rise * rise + (w / 2) ** 2) / (2 * rise);
  const half = Math.asin(w / 2 / radius);
  // Arc around the top (theta = PI) of a cylinder whose axis is turned onto local z.
  const geom = new THREE.CylinderGeometry(radius, radius, l + 1, 48, 1, false, Math.PI - half, half * 2);
  geom.rotateX(Math.PI / 2);
  geom.translate(0, rise - radius, 0);
  if (!alongZ) geom.rotateY(Math.PI / 2);
  meterUV(geom);
  const mesh = new THREE.Mesh(geom, [rec.set.slate, rec.set.plain, rec.set.plain]);
  mesh.position.set(r.cx, rec.height, r.cz);
  mesh.castShadow = mesh.receiveShadow = true;
  mesh.userData.record = rec;
  rec.meshes.push(mesh);
  parent.add(mesh);
  return rise;
}

function rooftopUnits(rec, parent, mats) {
  const { length: L, width: W, rect } = rec.obb;
  if (rec.footprint < 500 || rect < 0.6) return 0;
  box(rec, parent, mats.dark, Math.min(W * 0.3, 8), 2.4, Math.min(L * 0.18, 10), 0, rec.height, L * 0.15);
  return 2.4;
}

function buildRoof(rec, g, mats) {
  const kind = rec.style.roof;
  let rise = 0;
  if (kind === 'none' || kind === 'flat' || kind === 'dome') return 0;
  const rects = roofRects(rec);
  if (!rects.length) return 0; // irregular footprint: keep the flat roof
  const steep = rec.style.extras.includes('central_tower') ? 0.7 : 0;
  for (const r of rects) {
    if (kind === 'gable') rise = Math.max(rise, gablePrism(rec, g, r, steep || 0.33, steep ? 14 : 8));
    else if (kind === 'hip') rise = Math.max(rise, hipPrism(rec, g, r, 0.3, 8));
    else if (kind === 'mansard') rise = Math.max(rise, hipPrism(rec, g, r, 0.55, 5, 0.4));
    else if (kind === 'barrel') rise = Math.max(rise, barrelVault(rec, g, r));
  }
  return rise;
}

// ---------- extras ----------

function clockFaces(rec, g, mats, s, y, x = 0, z = 0) {
  const clockGeom = new THREE.CircleGeometry(s * 0.3, 32);
  const rimGeom = new THREE.RingGeometry(s * 0.3, s * 0.34, 32);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const nx = Math.sin(a), nz = Math.cos(a), off = s / 2 + 0.06;
    add(rec, g, clockGeom, mats.clock, x + nx * off, y, z + nz * off).rotation.y = a;
    add(rec, g, rimGeom, mats.stone, x + nx * (off + 0.02), y, z + nz * (off + 0.02)).rotation.y = a;
  }
}

// Smooth painted-metal material in the building's roof color (domes over towers/rotundas).
const paints = new Map();
function roofPaint(rec) {
  const hex = rec.style.roofHex ?? '#6b7383';
  if (!paints.has(hex)) paints.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.45, metalness: 0.35 }));
  return paints.get(hex);
}

function cross(rec, g, mats, x, y, z) {
  box(rec, g, mats.gold, 0.3, 3.2, 0.3, x, y, z);
  box(rec, g, mats.gold, 1.8, 0.3, 0.3, x, y + 2, z);
  return y + 3.2;
}

const extras = {
  // White square base + octagonal lantern + slender spire, centered on the roof (본관).
  white_cupola_spire(rec, g, mats, ctx) {
    const s = THREE.MathUtils.clamp(rec.obb.width * 0.28, 6, 9);
    const baseTop = rec.height + ctx.rise + 5;
    box(rec, g, mats.white, s, baseTop - rec.height, s, 0, rec.height, 0);
    box(rec, g, mats.stone, s + 0.8, 0.7, s + 0.8, 0, baseTop - 0.7, 0);
    if (rec.style.extras.includes('clock')) clockFaces(rec, g, mats, s, baseTop - 2.6);
    const r = s * 0.36, lh = 4.2;
    add(rec, g, new THREE.CylinderGeometry(r, r, lh, 8), mats.white, 0, baseTop + lh / 2, 0);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      add(rec, g, new THREE.CylinderGeometry(0.16, 0.16, lh, 6), mats.stone, Math.cos(a) * (r + 0.25), baseTop + lh / 2, Math.sin(a) * (r + 0.25));
    }
    const spireH = 9;
    add(rec, g, new THREE.ConeGeometry(r * 1.15, spireH, 8), rec.set.slateCone, 0, baseTop + lh + spireH / 2, 0);
    ctx.top = cross(rec, g, mats, 0, baseTop + lh + spireH, 0);
  },

  // Tall tower on the front facade (아담스채플): position from meta.towerAt (0..1 from the west
  // end, default middle); capped with a dome when the style also lists `dome`, else a spire.
  central_tower(rec, g, mats, ctx) {
    const { width: W } = rec.obb;
    const s = THREE.MathUtils.clamp(W * 0.42, 6, 10);
    const x = frontSide(rec) * (W / 2 - s / 2 + 1.5);
    const z = alongFromWest(rec, rec.meta?.towerAt ?? 0.5);
    const th = rec.height + ctx.rise + 8;
    box(rec, g, rec.set.plain, s, th, s, x, 0, z);
    box(rec, g, mats.stone, s + 0.8, 0.8, s + 0.8, x, th - 0.8, z);
    if (rec.style.extras.includes('clock')) clockFaces(rec, g, mats, s, th - 4, x, z);
    if (rec.style.extras.includes('dome')) {
      const r = s * 0.48;
      add(rec, g, new THREE.CylinderGeometry(r, r, 2, 24), mats.white, x, th + 1, z);
      add(rec, g, new THREE.SphereGeometry(r, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2), roofPaint(rec), x, th + 2, z);
      add(rec, g, new THREE.ConeGeometry(0.35, 2.4, 8), mats.gold, x, th + 2 + r + 1.1, z);
      ctx.top = th + 2 + r + 2.3;
      ctx.towerDome = true;
      return;
    }
    for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      add(rec, g, new THREE.ConeGeometry(0.6, 3, 4), rec.set.slateCone, x + (dx * s) / 2, th + 1.5, z + (dz * s) / 2);
    }
    const spireH = 14;
    const spire = add(rec, g, new THREE.ConeGeometry(s * 0.62, spireH, 4), rec.set.slateCone, x, th + spireH / 2, z);
    spire.rotation.y = Math.PI / 4;
    ctx.top = rec.style.extras.includes('spire_cross') ? cross(rec, g, mats, x, th + spireH, z) : th + spireH;
  },

  // White columns + pediment on the middle of the front facade.
  portico_columns(rec, g, mats, ctx) {
    const { length: L, width: W } = rec.obb;
    const side = frontSide(rec);
    const run = THREE.MathUtils.clamp(L * 0.4, 12, 34);
    const colH = Math.min(rec.height - 1.5, 13);
    const depth = 4.5;
    const n = Math.max(4, Math.round(run / 4) + 1);
    const cx = side * (W / 2 + depth - 0.8);
    const z0 = alongFromWest(rec, rec.meta?.porticoAt ?? 0.5);
    box(rec, g, mats.stone, depth + 3, 0.5, run + 4, side * (W / 2 + (depth + 3) / 2), 0, z0);
    box(rec, g, mats.stone, depth + 1.6, 0.5, run + 2, side * (W / 2 + (depth + 1.6) / 2), 0.5, z0);
    const colGeom = new THREE.CylinderGeometry(0.5, 0.58, colH, 14);
    for (let i = 0; i < n; i++) add(rec, g, colGeom, mats.white, cx, 1 + colH / 2, z0 - run / 2 + (run * i) / (n - 1));
    box(rec, g, mats.white, depth + 0.4, 1.3, run + 1.2, side * (W / 2 + depth / 2), 1 + colH, z0);
    const ped = new THREE.Shape([new THREE.Vector2(-(run + 1.2) / 2, 0), new THREE.Vector2((run + 1.2) / 2, 0), new THREE.Vector2(0, run * 0.14)]);
    const pg = new THREE.ExtrudeGeometry(ped, { depth: depth + 0.4, bevelEnabled: false });
    pg.translate(0, 0, -(depth + 0.4) / 2);
    pg.rotateY(Math.PI / 2);
    add(rec, g, pg, [mats.white, rec.set.slate], side * (W / 2 + depth / 2), 2.3 + colH, z0);
    ctx.top = Math.max(ctx.top, 2.3 + colH + run * 0.14);
  },

  // Semicircular colonnade bulging out of the front facade (계명아트센터, 동천관 rotunda).
  // meta.colonnadeAt (0..1 from the west end), meta.colonnadeRadius, meta.colonnadeDome.
  curved_colonnade(rec, g, mats, ctx) {
    const { length: L, width: W } = rec.obb;
    const side = frontSide(rec);
    const R = rec.meta?.colonnadeRadius ?? THREE.MathUtils.clamp(L * 0.28, 10, 24);
    const colH = Math.min(rec.height - 2, rec.meta?.colonnadeHeight ?? 15);
    const cx = side * (W / 2);
    const z0 = alongFromWest(rec, rec.meta?.colonnadeAt ?? 0.5);
    const n = Math.max(6, Math.round((Math.PI * R) / 3.2));
    const colGeom = new THREE.CylinderGeometry(0.55, 0.62, colH, 14);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI;
      add(rec, g, colGeom, mats.white, cx + side * Math.sin(a) * R, 0.6 + colH / 2, z0 - Math.cos(a) * R);
    }
    // Curved entablature and a half-disc canopy on top of the columns.
    const theta0 = side > 0 ? 0 : Math.PI;
    const band = new THREE.CylinderGeometry(R + 0.8, R + 0.8, 1.6, 48, 1, true, theta0, Math.PI);
    const bandMat = mats.white.clone(); // open band is seen from both sides
    bandMat.side = THREE.DoubleSide;
    add(rec, g, band, bandMat, cx, 0.6 + colH + 0.8, z0);
    // CircleGeometry lies in XY; after rotateX(-PI/2) its x stays x, so cos(theta) >= 0 faces +x.
    const discStart = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const disc = new THREE.CircleGeometry(R + 0.8, 48, discStart, Math.PI);
    disc.rotateX(-Math.PI / 2);
    add(rec, g, disc, mats.white, cx, 0.6 + colH + 1.6, z0);
    const base = new THREE.CircleGeometry(R + 3, 48, discStart, Math.PI);
    base.rotateX(-Math.PI / 2);
    add(rec, g, base, mats.stone, cx, 0.6, z0);
    let top = colH + 2.2;
    if (rec.meta?.colonnadeDome) {
      // Quarter sphere over the rotunda; SphereGeometry x = -r cos(phi) sin(theta).
      const phi0 = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      add(rec, g, new THREE.SphereGeometry(R + 0.8, 32, 12, phi0, Math.PI, 0, Math.PI / 2), roofPaint(rec), cx, 0.6 + colH + 1.6, z0);
      top += R + 0.8;
    }
    ctx.top = Math.max(ctx.top, top);
  },

  // Stage fly tower rising above the auditorium roof, on the north side (계명아트센터).
  fly_tower(rec, g, mats, ctx) {
    const { length: L, width: W, d } = rec.obb;
    const h = rec.height * 0.6 + ctx.rise;
    const z = (d.y >= 0 ? 1 : -1) * L * 0.22;
    box(rec, g, rec.set.plain, W * 0.5, rec.height + h, L * 0.3, 0, 0, z);
    box(rec, g, mats.white, W * 0.5 + 0.8, 0.9, L * 0.3 + 0.8, 0, rec.height + h - 0.9, z);
    ctx.top = Math.max(ctx.top, rec.height + h);
  },

  // Drum + dome on the roof center (skipped when the tower already carries the dome).
  dome(rec, g, mats, ctx) {
    if (ctx.towerDome) return;
    const r = Math.min(rec.obb.width, rec.obb.length) * 0.28;
    const y = rec.height + ctx.rise * 0.6;
    add(rec, g, new THREE.CylinderGeometry(r, r, 3, 32), mats.stone, 0, y + 1.5, 0);
    add(rec, g, new THREE.SphereGeometry(r, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), mats.copper, 0, y + 3, 0);
    add(rec, g, new THREE.CylinderGeometry(r * 0.12, r * 0.12, 2.4, 12), mats.stone, 0, y + 3 + r + 1, 0);
    add(rec, g, new THREE.SphereGeometry(r * 0.14, 12, 8), mats.gold, 0, y + 3 + r + 2.6, 0);
    ctx.top = Math.max(ctx.top, y + 3 + r + 3);
  },

  // Glass box on the middle of the front facade.
  glass_atrium(rec, g, mats, ctx) {
    const { length: L, width: W } = rec.obb;
    const side = frontSide(rec);
    const h = Math.max(6, rec.height * 0.75);
    box(rec, g, mats.glassPanel, 7, h, Math.min(L * 0.3, 20), side * (W / 2 + 3.2), 0, 0);
    ctx.top = Math.max(ctx.top, h);
  },

  rooftop_structure(rec, g, mats, ctx) {
    if (ctx.rise > 0) return;
    const h = rooftopUnits(rec, g, mats);
    ctx.top = Math.max(ctx.top, rec.height + h);
  },

  // Small gabled dormers along both slopes of each pitched wing.
  dormers(rec, g, mats, ctx) {
    if (!['gable', 'hip', 'mansard'].includes(rec.style.roof) || ctx.rise < 2) return;
    for (const r of roofRects(rec)) {
      const alongZ = r.sz >= r.sx;
      const l = alongZ ? r.sz : r.sx, w = alongZ ? r.sx : r.sz;
      for (let t = -l / 2 + 5; t <= l / 2 - 5; t += 7) {
        for (const s of [-1, 1]) {
          const off = s * w * 0.22;
          const x = r.cx + (alongZ ? off : t), z = r.cz + (alongZ ? t : off);
          box(rec, g, rec.set.plain, 1.8, 1.8, 1.8, x, rec.height + ctx.rise * 0.25, z);
          const cap = add(rec, g, new THREE.ConeGeometry(1.45, 1.1, 4), rec.set.slateCone, x, rec.height + ctx.rise * 0.25 + 2.35, z);
          cap.rotation.y = Math.PI / 4;
        }
      }
    }
  },

  // Korean tiled hip roof (한학촌).
  hanok_roof(rec, g, mats, ctx) {
    for (const r of roofRects(rec).length ? roofRects(rec) : [{ cx: 0, cz: 0, sx: rec.obb.width, sz: rec.obb.length }]) {
      ctx.rise = Math.max(ctx.rise, hipPrism(rec, g, r, 0.42, 3.8, 1.6));
    }
  },
};

// ---------- custom structures (not extruded footprints) ----------

// Ionic column: plinth, base ring, tapering shaft, capital with side volutes.
function ionicColumn(rec, g, mats, x, z, h, r = 0.42) {
  box(rec, g, mats.white, r * 2.7, 0.35, r * 2.7, x, 0, z);
  add(rec, g, new THREE.CylinderGeometry(r * 1.25, r * 1.35, 0.3, 20), mats.white, x, 0.5, z);
  const shaftH = h - 1.2;
  add(rec, g, new THREE.CylinderGeometry(r * 0.88, r, shaftH, 20), mats.white, x, 0.65 + shaftH / 2, z);
  box(rec, g, mats.white, r * 3, 0.28, r * 2.3, x, h - 0.28, z);
  const volute = new THREE.CylinderGeometry(r * 0.42, r * 0.42, r * 2.3, 16);
  volute.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) add(rec, g, volute, mats.white, x + sx * r * 1.25, h - 0.5, z);
}

// Colonnaded pavilion: rows of columns under an entablature, optionally with a pediment
// facing local +z. Width runs along x, depth along z.
function pavilion(rec, g, mats, { cx, cz = 0, w, d, colH, cols = 4, rows = 2, pediment = 0 }) {
  for (let r = 0; r < rows; r++) {
    const z = cz + (rows === 1 ? 0 : -d / 2 + (d * r) / (rows - 1));
    for (let c = 0; c < cols; c++) ionicColumn(rec, g, mats, cx - w / 2 + (w * c) / (cols - 1), z, colH);
  }
  box(rec, g, mats.white, w + 1.1, 0.55, d + 1.1, cx, colH, cz); // architrave
  box(rec, g, mats.stone, w + 1.2, 0.65, d + 1.2, cx, colH + 0.55, cz); // frieze
  box(rec, g, mats.white, w + 1.8, 0.35, d + 1.8, cx, colH + 1.2, cz); // cornice
  let top = colH + 1.55;
  if (pediment > 0) {
    const hw = (w + 1.8) / 2;
    const shape = new THREE.Shape([new THREE.Vector2(-hw, 0), new THREE.Vector2(hw, 0), new THREE.Vector2(0, pediment)]);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: d + 1.8, bevelEnabled: false });
    geom.translate(0, 0, -(d + 1.8) / 2);
    add(rec, g, geom, [mats.stone, mats.white], cx, top, cz);
    // Raking cornices and the university emblem in the tympanum.
    const slope = Math.atan2(pediment, hw), len = Math.hypot(hw, pediment) + 0.3;
    for (const sx of [-1, 1]) {
      const rake = box(rec, g, mats.white, len, 0.3, d + 2.1, cx + (sx * hw) / 2, top + pediment / 2 - 0.15, cz);
      rake.rotation.z = -sx * slope;
    }
    add(rec, g, new THREE.CircleGeometry(pediment * 0.28, 32), mats.white, cx, top + pediment * 0.38, cz + (d + 1.8) / 2 + 0.03);
    top += pediment;
  }
  return top;
}

// Frame for custom structures: centered on the (shifted) anchor, local x along meta.axisDeg
// (degrees from east, counter-clockwise), local +z facing the approach.
function customFrame(rec, group) {
  const g = new THREE.Group();
  g.position.set(rec.obb.center.x, rec.base ?? 0, -rec.obb.center.y);
  g.rotation.y = THREE.MathUtils.degToRad(rec.meta?.axisDeg ?? 0);
  group.add(g);
  return g;
}

// Frame (x, z) of a custom structure → local map coords (east, north).
function frameToMap(rec, x, z) {
  const a = THREE.MathUtils.degToRad(rec.meta?.axisDeg ?? 0), c = rec.obb.center;
  return { x: c.x + Math.cos(a) * x + Math.sin(a) * z, y: c.y + Math.sin(a) * x - Math.cos(a) * z };
}

// Ask the ground painter to pave a frame-aligned rectangle (drapes exactly on the terrain).
function pave(rec, x0, x1, z0, z1, kind = 'pavers') {
  (rec.groundPaint ??= []).push({ kind, pts: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => frameToMap(rec, x, z)) });
}

const custom = {
  // 정문: pedimented central gate over the entry road, a colonnaded pavilion on each side,
  // brick-paved forecourts and low brick walls continuing the gate line.
  main_gate(rec, g, mats) {
    const top = pavilion(rec, g, mats, { cx: 0, w: 14, d: 6, colH: 7.2, pediment: 2.7 });
    for (const sx of [-1, 1]) {
      pavilion(rec, g, mats, { cx: sx * 21, w: 13, d: 4.4, colH: 6 });
      pave(rec, sx * 8.5, sx * 34, -5, 17); // brick-paved forecourt under and in front of the pavilion
      box(rec, g, mats.brick.plain, 14, 1.7, 0.5, sx * 42, 0, 0);
      box(rec, g, mats.stone, 14.2, 0.18, 0.7, sx * 42, 1.7, 0);
    }
    rec.topY = top;
  },

  // 정문수위실: small temple-front guardhouse on the median.
  gatehouse(rec, g, mats) {
    box(rec, g, mats.white, 4.6, 3.4, 5.2, 0, 0, -0.8);
    const shape = new THREE.Shape([new THREE.Vector2(-3, 0), new THREE.Vector2(3, 0), new THREE.Vector2(0, 1.4)]);
    const geom = new THREE.ExtrudeGeometry(shape, { depth: 7.4, bevelEnabled: false });
    geom.translate(0, 0, -3.7 - 0.2);
    add(rec, g, geom, [mats.white, rec.set.slate], 0, 3.4, 0);
    box(rec, g, mats.white, 6, 0.3, 7.6, 0, 3.2, -0.2);
    for (const sx of [-1, 1]) ionicColumn(rec, g, mats, sx * 1.9, 2.8, 3.2, 0.24);
    box(rec, g, mats.glassPanel, 2.8, 1.2, 0.1, 0, 1.1, 1.85);
    rec.topY = 4.8;
  },
};

export function addLandmark(rec, group, mats) {
  const special = rec.meta?.custom && custom[rec.meta.custom];
  if (special) {
    special(rec, customFrame(rec, group), mats);
    return;
  }
  if (rec.style.roof === 'none') return;
  const g = frame(rec, group);
  const ex = rec.style.extras;
  const rise = ex.includes('hanok_roof') ? 0 : buildRoof(rec, g, mats);
  const ctx = { rise, top: rec.height + rise };
  for (const name of ['hanok_roof', 'white_cupola_spire', 'central_tower', 'dome', 'portico_columns', 'curved_colonnade', 'fly_tower', 'glass_atrium', 'dormers', 'rooftop_structure']) {
    if (ex.includes(name) || (name === 'dome' && rec.style.roof === 'dome')) extras[name](rec, g, mats, ctx);
  }
  rec.topY = Math.max(rec.height + ctx.rise, ctx.top);
}
