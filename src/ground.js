import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { open, area, bounds, pointInPoly, distSqToSeg, rng } from './geo.js';

const ROAD_STYLE = {
  primary: { w: 18, cls: 'major' },
  secondary: { w: 14, cls: 'major' },
  tertiary: { w: 10, cls: 'major' },
  residential: { w: 7, cls: 'minor' },
  unclassified: { w: 7, cls: 'minor' },
  living_street: { w: 6, cls: 'minor' },
  service: { w: 5, cls: 'minor' },
  footway: { w: 2.6, cls: 'foot' },
  pedestrian: { w: 5, cls: 'foot' },
  path: { w: 2.2, cls: 'foot' },
  steps: { w: 3, cls: 'foot' },
};
const ROAD_MAT = {
  major: { color: '#55595f', y: 0.42 },
  minor: { color: '#6b6e74', y: 0.38 },
  foot: { color: '#cdbfa6', y: 0.34 },
};

const AREA_STYLE = {
  parking: { color: '#8c8e92', y: 0.26 },
  grass: { color: '#7eaa55', y: 0.2 },
  meadow: { color: '#86ad5c', y: 0.2 },
  park: { color: '#78a652', y: 0.18 },
  garden: { color: '#6fa24f', y: 0.22 },
  forest: { color: '#557f3f', y: 0.16 },
  wood: { color: '#557f3f', y: 0.16 },
  scrub: { color: '#6f914f', y: 0.16 },
  water: { color: '#5f9dc2', y: 0.24 },
  pitch: { color: '#5a9a47', y: 0.3 },
  track: { color: '#b4553f', y: 0.28 },
  stadium: { color: '#8c8e92', y: 0.24 },
};

function flatShape(rings, y, material) {
  const shape = new THREE.Shape(rings[0].map((p) => new THREE.Vector2(p.x, p.y)));
  for (const h of rings.slice(1)) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
  const geom = new THREE.ShapeGeometry(shape);
  geom.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.y = y;
  mesh.receiveShadow = true;
  return mesh;
}

function ribbon(lines, y) {
  const pos = [], idx = [];
  for (const { pts, w } of lines) {
    const base = pos.length / 3;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
      let tx = b.x - a.x, ty = b.y - a.y;
      const len = Math.hypot(tx, ty) || 1;
      tx /= len; ty /= len;
      const nx = -ty * (w / 2), ny = tx * (w / 2);
      const p = pts[i];
      pos.push(p.x + nx, y, -(p.y + ny), p.x - nx, y, -(p.y - ny));
      if (i > 0) {
        const k = base + (i - 1) * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  // Ribbons are flat; force upward normals regardless of winding.
  const n = geom.attributes.normal;
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return geom;
}

// Uniform grid over road segments for fast "is this point on a road?" checks.
function segmentGrid(roads, cell = 25) {
  const grid = new Map();
  const key = (i, j) => `${i},${j}`;
  for (const r of roads) {
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const pad = r.w / 2 + 2;
      const i0 = Math.floor((Math.min(a.x, b.x) - pad) / cell), i1 = Math.floor((Math.max(a.x, b.x) + pad) / cell);
      const j0 = Math.floor((Math.min(a.y, b.y) - pad) / cell), j1 = Math.floor((Math.max(a.y, b.y) + pad) / cell);
      for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
        const k = key(gi, gj);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push({ a, b, r2: (r.w / 2 + 1.8) ** 2 });
      }
    }
  }
  return (x, y) => {
    const list = grid.get(key(Math.floor(x / cell), Math.floor(y / cell)));
    return !!list && list.some((s) => distSqToSeg(x, y, s.a, s.b) < s.r2);
  };
}

// Lumpy deciduous crown: a few noise-displaced spheres merged, smooth-shaded.
function crownGeometry() {
  const lobes = [[0, 4.9, 0, 2.3], [1.2, 4.4, 0.5, 1.7], [-1.1, 4.5, -0.4, 1.8], [0.2, 6.0, -0.2, 1.6], [-0.3, 4.2, 1.1, 1.5]];
  const parts = lobes.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 3);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const vx = p.getX(i), vy = p.getY(i), vz = p.getZ(i);
      // Position-based noise so coincident vertices move together (no cracks).
      const k = 1 + 0.13 * Math.sin(vx * 3.1 + vz * 1.7) * Math.sin(vy * 2.9 + vx * 1.3) + 0.06 * Math.sin(vz * 7.3 + vy * 5.1);
      p.setXYZ(i, vx * k + x, vy * k + y, vz * k + z);
    }
    return mergeVertices(g);
  });
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  const p = g.attributes.position;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = p.getX(i) + p.getZ(i) * 0.7; uv[i * 2 + 1] = p.getY(i); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// Grey leaf-cluster texture; instance colors tint it green.
function foliageTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const r = rng(5);
  g.fillStyle = '#8c8c8c';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 2600; i++) {
    const v = Math.floor(90 + r() * 165);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.beginPath();
    g.ellipse(r() * 256, r() * 256, 2 + r() * 4, 1.2 + r() * 2.2, r() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.repeat.set(0.6, 0.6);
  return t;
}

export function buildGround(data, proj, records) {
  const group = new THREE.Group();
  group.name = 'ground';

  const base = new THREE.Mesh(
    new THREE.PlaneGeometry(9000, 9000).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: '#98a283', roughness: 1 }),
  );
  base.receiveShadow = true;
  group.add(base);

  const campusRings = data.campusOutline.map((r) => open(r.map(proj)));
  const campusMat = new THREE.MeshStandardMaterial({ color: '#8fb466', roughness: 1 });
  for (const ring of campusRings) group.add(flatShape([ring], 0.1, campusMat));

  // Areas (grass, pitches, parking, ...)
  const areaMats = {};
  const areas = [];
  for (const a of data.areas) {
    let kind = a.kind;
    if (kind === 'pitch' && /athletics|running/.test(a.sport || '')) kind = 'track';
    const style = AREA_STYLE[kind];
    if (!style) continue;
    areaMats[kind] ??= new THREE.MeshStandardMaterial({ color: style.color, roughness: 0.95 });
    const pts = open(a.poly.map(proj));
    if (pts.length < 3) continue;
    group.add(flatShape([pts], style.y, areaMats[kind]));
    areas.push({ kind, pts, bb: bounds(pts) });
  }

  // Roads
  const roads = [];
  const byClass = { major: [], minor: [], foot: [] };
  for (const r of data.roads) {
    const st = ROAD_STYLE[r.kind];
    if (!st) continue;
    const pts = r.line.map(proj);
    if (pts.length < 2) continue;
    byClass[st.cls].push({ pts, w: st.w });
    roads.push({ pts, w: st.w, cls: st.cls });
  }
  for (const [cls, lines] of Object.entries(byClass)) {
    if (!lines.length) continue;
    const mesh = new THREE.Mesh(ribbon(lines, ROAD_MAT[cls].y), new THREE.MeshStandardMaterial({ color: ROAD_MAT[cls].color, roughness: 0.95 }));
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  const onRoad = segmentGrid(roads);
  const buildingBoxes = records.map((r) => ({ pts: r.outer, bb: bounds(r.outer) }));
  const inside = (x, y, list, pad = 0) => list.some((o) =>
    x >= o.bb.minX - pad && x <= o.bb.maxX + pad && y >= o.bb.minY - pad && y <= o.bb.maxY + pad && pointInPoly(x, y, o.pts));
  const hardAreas = areas.filter((a) => ['parking', 'pitch', 'track', 'water', 'stadium'].includes(a.kind));
  const free = (x, y) => !onRoad(x, y) && !inside(x, y, buildingBoxes, 3) && !inside(x, y, hardAreas);

  // Trees
  const rand = rng(7);
  const trees = [];
  const scatter = (pts, density, cap) => {
    const bb = bounds(pts);
    const n = Math.min(cap, Math.round(area(pts) * density));
    for (let i = 0, tries = 0; i < n && tries < n * 4; tries++) {
      const x = bb.minX + rand() * (bb.maxX - bb.minX), y = bb.minY + rand() * (bb.maxY - bb.minY);
      if (!pointInPoly(x, y, pts) || !free(x, y)) continue;
      trees.push({ x, y, s: 0.75 + rand() * 0.6 });
      i++;
    }
  };
  for (const a of areas) {
    if (a.kind === 'wood' || a.kind === 'forest') scatter(a.pts, 1 / 45, 1500);
    else if (['grass', 'park', 'garden', 'meadow', 'scrub'].includes(a.kind)) scatter(a.pts, 1 / 180, 300);
  }
  for (const ring of campusRings) scatter(ring, 1 / 320, 2600);

  const trunkGeom = new THREE.CylinderGeometry(0.22, 0.32, 3, 6).translate(0, 1.5, 0);
  const crownGeom = crownGeometry();
  const trunks = new THREE.InstancedMesh(trunkGeom, new THREE.MeshStandardMaterial({ color: '#5b4331', roughness: 1 }), trees.length);
  const crowns = new THREE.InstancedMesh(crownGeom, new THREE.MeshStandardMaterial({ color: '#ffffff', map: foliageTexture(), roughness: 0.92 }), trees.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const c = new THREE.Color();
  trees.forEach((t, i) => {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, rand() * Math.PI * 2);
    p.set(t.x, 0, -t.y);
    s.set(t.s, t.s * (0.9 + rand() * 0.4), t.s);
    m.compose(p, q, s);
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
    c.setHSL(0.22 + rand() * 0.09, 0.42 + rand() * 0.2, 0.32 + rand() * 0.12);
    crowns.setColorAt(i, c);
  });
  for (const im of [trunks, crowns]) {
    im.castShadow = true;
    im.receiveShadow = true;
    group.add(im);
  }

  // Street lamps along campus roads (lit at night).
  const lamps = [];
  const inCampus = (x, y) => campusRings.some((r) => pointInPoly(x, y, r));
  for (const r of roads) {
    if (r.cls === 'foot') continue;
    let carry = 0, sideSign = 1;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 32 - carry; t < len; t += 32) {
        const x = a.x + ((b.x - a.x) * t) / len, y = a.y + ((b.y - a.y) * t) / len;
        const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        const lx = x + nx * (r.w / 2 + 1) * sideSign, ly = y + ny * (r.w / 2 + 1) * sideSign;
        sideSign *= -1;
        if (inCampus(lx, ly)) lamps.push({ x: lx, y: ly });
      }
      carry = (carry + len) % 32;
    }
  }
  const poleGeom = new THREE.CylinderGeometry(0.08, 0.12, 5, 5).translate(0, 2.5, 0);
  const headGeom = new THREE.SphereGeometry(0.38, 10, 8).translate(0, 5.1, 0);
  const lampMat = new THREE.MeshStandardMaterial({ color: '#f3efe6', emissive: '#ffcf7a', emissiveIntensity: 0 });
  const poles = new THREE.InstancedMesh(poleGeom, new THREE.MeshStandardMaterial({ color: '#34373c', roughness: 0.6 }), lamps.length);
  const heads = new THREE.InstancedMesh(headGeom, lampMat, lamps.length);
  lamps.forEach((l, i) => {
    m.makeTranslation(l.x, 0, -l.y);
    poles.setMatrixAt(i, m);
    heads.setMatrixAt(i, m);
  });
  group.add(poles, heads);

  // Soft warm pools of light under a subset of lamps at night.
  const glowTex = (() => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,210,140,1)');
    grad.addColorStop(1, 'rgba(255,210,140,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(cv);
  })();
  const poolMat = new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
  const pools = new THREE.InstancedMesh(new THREE.PlaneGeometry(16, 16).rotateX(-Math.PI / 2), poolMat, lamps.length);
  lamps.forEach((l, i) => {
    m.makeTranslation(l.x, 0.5, -l.y);
    pools.setMatrixAt(i, m);
  });
  pools.renderOrder = 1;
  group.add(pools);

  let cb = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const r of campusRings) {
    const b = bounds(r);
    cb = { minX: Math.min(cb.minX, b.minX), minY: Math.min(cb.minY, b.minY), maxX: Math.max(cb.maxX, b.maxX), maxY: Math.max(cb.maxY, b.maxY) };
  }

  return {
    group,
    campusBounds: cb,
    stats: { trees: trees.length, lamps: lamps.length, roads: roads.length },
    setNightLevel(t) {
      lampMat.emissiveIntensity = t * 4;
      poolMat.opacity = t * 0.55;
    },
  };
}
