import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { open, area, bounds, pointInPoly, distSqToSeg, rng } from './geo.js';
import { buildTerrainMeshes, forestMask } from './terrain.js';

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
const ROAD_PAINT = {
  major: { color: '#4f5257', edge: '#c9c6bd', edgeW: 1.2 },
  minor: { color: '#66686d', edge: '#bdb9ae', edgeW: 0.8 },
  foot: { color: '#c9b9a0', edge: null, edgeW: 0 },
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

// Paint lawns, pitches, parking and roads into one canvas that is draped over the terrain.
// Canvas covers `extent` (square, local meters); transparent where the terrain shows through.
function paintGround(extent, campusRings, areas, roads, heightAt, slopeAt, pavings = []) {
  const W = 4096, k = W / extent.size;
  const cv = document.createElement('canvas');
  cv.width = cv.height = W;
  const g = cv.getContext('2d');
  const P = (p) => [(p.x - extent.minX) * k, (extent.minY + extent.size - p.y) * k];
  const path = (pts) => {
    g.beginPath();
    pts.forEach((p, i) => (i ? g.lineTo(...P(p)) : g.moveTo(...P(p))));
  };
  // Campus lawn, darkened toward forest on the wooded upper slopes.
  g.fillStyle = '#86ad5f';
  for (const ring of campusRings) { path(ring); g.closePath(); g.fill(); }
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const cell = 6;
  for (let y = extent.minY; y < extent.minY + extent.size; y += cell) {
    for (let x = extent.minX; x < extent.minX + extent.size; x += cell) {
      const f = forestMask(heightAt(x, y), slopeAt(x, y));
      if (f < 0.05) continue;
      g.fillStyle = `rgba(58,88,46,${(f * 0.9).toFixed(2)})`;
      const [px, py] = P({ x, y: y + cell });
      g.fillRect(px, py, cell * k + 1, cell * k + 1);
    }
  }
  g.restore();
  // Brick pavers requested by custom structures (e.g. the 정문 forecourts).
  for (const pv of pavings) {
    path(pv.pts); g.closePath();
    g.fillStyle = '#93503f'; g.fill();
    g.save(); g.clip();
    g.strokeStyle = 'rgba(60,25,18,0.35)'; g.lineWidth = Math.max(1, 0.06 * k);
    const bb = bounds(pv.pts);
    for (let y = bb.minY; y < bb.maxY; y += 0.6) { path([{ x: bb.minX, y }, { x: bb.maxX, y }]); g.stroke(); }
    g.restore();
  }
  for (const a of areas) {
    const st = AREA_STYLE[a.kind];
    path(a.pts); g.closePath();
    g.fillStyle = st.color; g.fill();
    if (a.kind === 'pitch') { g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 0.15 * k; g.stroke(); }
  }
  // Roads: curb/edge line first, then asphalt, then a dashed centre line on major roads.
  g.lineCap = g.lineJoin = 'round';
  for (const cls of ['foot', 'minor', 'major']) {
    const st = ROAD_PAINT[cls];
    const list = roads.filter((r) => r.cls === cls);
    if (st.edge) {
      g.strokeStyle = st.edge;
      for (const r of list) { g.lineWidth = (r.w + st.edgeW * 2) * k; path(r.pts); g.stroke(); }
    }
    g.strokeStyle = st.color;
    for (const r of list) { g.lineWidth = r.w * k; path(r.pts); g.stroke(); }
  }
  g.strokeStyle = 'rgba(240,236,220,0.85)';
  g.lineWidth = 0.25 * k;
  g.setLineDash([3 * k, 4 * k]);
  for (const r of roads) if (r.cls === 'major') { path(r.pts); g.stroke(); }
  g.setLineDash([]);
  // Fine grain so flat colors read as grass / asphalt texture up close.
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const rand = rng(3);
  for (let i = 0; i < 420000; i++) {
    const v = rand() < 0.5 ? 0 : 255;
    g.fillStyle = `rgba(${v},${v},${v},${(0.04 + rand() * 0.06).toFixed(3)})`;
    g.fillRect(rand() * W, rand() * W, 1 + rand() * 2, 1 + rand() * 2);
  }
  g.restore();
  g.clearRect(0, 0, W, 2); g.clearRect(0, W - 2, W, 2); g.clearRect(0, 0, 2, W); g.clearRect(W - 2, 0, 2, W);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
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
  const lobes = [[0, 4.9, 0, 2.5], [1.2, 4.5, 0.6, 1.9], [-1.0, 5.4, -0.5, 1.9]];
  const parts = lobes.map(([x, y, z, r]) => {
    const g = new THREE.IcosahedronGeometry(r, 1); // ~80 triangles per lobe keeps 4.5k trees cheap
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

export function buildGround(data, proj, records, terrain) {
  const group = new THREE.Group();
  group.name = 'ground';
  const { heightAt, slopeAt } = terrain;

  const campusRings = data.campusOutline.map((r) => open(r.map(proj)));

  const areas = [];
  for (const a of data.areas) {
    let kind = a.kind;
    if (kind === 'pitch' && /athletics|running/.test(a.sport || '')) kind = 'track';
    if (!AREA_STYLE[kind]) continue;
    const pts = open(a.poly.map(proj));
    if (pts.length >= 3) areas.push({ kind, pts, bb: bounds(pts) });
  }
  const roads = [];
  for (const r of data.roads) {
    const st = ROAD_STYLE[r.kind];
    const pts = r.line.map(proj);
    if (st && pts.length >= 2) roads.push({ pts, w: st.w, cls: st.cls });
  }

  // Ground map covers the fetched data area (plus a margin) as one square.
  const all = [...roads.flatMap((r) => r.pts), ...campusRings.flat()];
  const bb = bounds(all);
  const size = Math.max(bb.maxX - bb.minX, bb.maxY - bb.minY) + 200;
  const extent = { minX: (bb.minX + bb.maxX) / 2 - size / 2, minY: (bb.minY + bb.maxY) / 2 - size / 2, size };
  const canopy = foliageTexture();
  const pavings = records.flatMap((r) => r.groundPaint ?? []);
  group.add(...buildTerrainMeshes(terrain, paintGround(extent, campusRings, areas, roads, heightAt, slopeAt, pavings), extent, canopy));

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
    p.set(t.x, heightAt(t.x, t.y) - 0.3, -t.y);
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

  // Wooded hills around the campus: a dense, cheaper canopy (no trunks, no shadow casting).
  const cbb = bounds(campusRings.flat());
  const cx = (cbb.minX + cbb.maxX) / 2, cy = (cbb.minY + cbb.maxY) / 2;
  const fr = rng(21);
  const forest = [];
  for (let i = 0; i < 60000 && forest.length < 10000; i++) {
    const x = cx + (fr() * 2 - 1) * 1600, y = cy + (fr() * 2 - 1) * 1600;
    if (Math.hypot(x - cx, y - cy) > 1600) continue;
    const f = forestMask(heightAt(x, y), slopeAt(x, y));
    if (fr() > f * 0.9 || onRoad(x, y) || inside(x, y, buildingBoxes, 4)) continue;
    forest.push({ x, y, s: 0.9 + fr() * 0.7 });
  }
  const lobe = (r, x, y, z) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    g.deleteAttribute('uv');
    g.deleteAttribute('normal');
    g.translate(x, y, z);
    return mergeVertices(g);
  };
  const forestGeom = lobe(2.8, 0, 4.8, 0);
  forestGeom.computeVertexNormals();
  const fp = forestGeom.attributes.position, fuv = new Float32Array(fp.count * 2);
  for (let i = 0; i < fp.count; i++) { fuv[i * 2] = fp.getX(i) + fp.getZ(i) * 0.7; fuv[i * 2 + 1] = fp.getY(i); }
  forestGeom.setAttribute('uv', new THREE.BufferAttribute(fuv, 2));
  const forestMesh = new THREE.InstancedMesh(forestGeom, crowns.material, forest.length);
  forest.forEach((t, i) => {
    q.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, fr() * Math.PI * 2);
    p.set(t.x, heightAt(t.x, t.y) - 1.2, -t.y);
    s.set(t.s, t.s * (0.85 + fr() * 0.5), t.s);
    m.compose(p, q, s);
    forestMesh.setMatrixAt(i, m);
    c.setHSL(0.24 + fr() * 0.07, 0.38 + fr() * 0.18, 0.2 + fr() * 0.1);
    forestMesh.setColorAt(i, c);
  });
  forestMesh.receiveShadow = true;
  group.add(forestMesh);

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
    m.makeTranslation(l.x, heightAt(l.x, l.y) - 0.2, -l.y);
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
    m.makeTranslation(l.x, heightAt(l.x, l.y) + 0.6, -l.y);
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
    stats: { trees: trees.length, forest: forest.length, lamps: lamps.length, roads: roads.length },
    setNightLevel(t) {
      lampMat.emissiveIntensity = t * 4;
      poolMat.opacity = t * 0.55;
    },
  };
}
