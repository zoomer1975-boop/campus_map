import * as THREE from 'three';
import { open, area, obb, rng } from './geo.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addLandmark } from './landmarks.js';
import { meterUV } from './uv.js';

// Facade atlas: one canvas holds NB bays x NF floors of windows, repeated in world meters.
// Wall UVs from ExtrudeGeometry are in meters, so photo textures tile at their real size.
const BAY = 3.6, FLOOR = 3.8;
const NB = 8, NF = 8, PX = 96;

// Photo-scanned CC0 PBR sets from Poly Haven (assets/textures). size = real tile size in meters,
// avg = mean sRGB color of the diffuse photo (used to re-tint it to a target color).
const PHOTO = {
  brick: { id: 'red_brick_03', size: 1.0, avg: '#6b544c' },
  concrete: { id: 'concrete_wall_004', size: 2.0, avg: '#767363' },
  slate: { id: 'roof_slates_02', size: 3.0, avg: '#918676' },
  giwa: { id: 'grey_roof_tiles', size: 3.0, avg: '#605b4a' },
};

// tint / roofTint are the target average colors of the photo textures.
export const PALETTES = {
  brick:    { style: 'brick',  base: 'brick',    tint: '#7c4f41', frame: '#e9e1d2', glass: '#1f2833', roofTint: '#8e8b85' },
  modern:   { style: 'modern', base: 'concrete', tint: '#dcd7cc', frame: '#cfcac1', glass: '#2e4257', roofTint: '#a09c94' },
  glass:    { style: 'glass',  base: 'concrete', tint: '#c9ccd0', frame: '#c9ced3', glass: '#2b4560', roofTint: '#a3a4a5' },
  hanok:    { style: 'hanok',  base: 'concrete', tint: '#ece2cc', frame: '#6b4529', glass: '#efe3c4', roofTint: '#8e8b85' },
  concrete: { style: 'plain',  base: 'concrete', tint: '#bdb7ab', frame: '#bdb7ab', glass: '#bdb7ab', roofTint: '#c4beb2' },
  other:    { style: 'apt',    base: 'concrete', tint: '#d6d5d0', frame: '#bfc2c5', glass: '#34414e', roofTint: '#a5a7a9' },
  brickArch:{ style: 'arch',   base: 'brick',    tint: '#7c4f41', frame: '#ece5d6', glass: '#1f2833', roofTint: '#8e8b85' },
  stone:    { style: 'arch',   base: 'concrete', tint: '#e2dccf', frame: '#f3efe6', glass: '#233142', roofTint: '#a09c94' },
};

const nightMaterials = new Set();
let matCache = null;
let nightLevel = 0;
const loader = new THREE.TextureLoader();
const images = new Map();

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  c.offsetHSL(0, 0, k);
  return `#${c.getHexString()}`;
}

// Load each image once; every caller gets its own Texture (own repeat/rotation) sharing the image.
function photoTexture(key, kind, { repeat, rotation = 0 } = {}) {
  const url = `assets/textures/${PHOTO[key].id}_${kind}_1k.jpg`;
  let entry = images.get(url);
  if (!entry) {
    entry = { loaded: false, pending: [] };
    entry.base = loader.load(url, () => {
      entry.loaded = true;
      for (const t of entry.pending) t.needsUpdate = true;
      entry.pending.length = 0;
    });
    images.set(url, entry);
  }
  // A fresh Texture sharing the image source (clone() would flag an upload before the image exists).
  const t = new THREE.Texture();
  t.source = entry.base.source;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = kind === 'diff' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 8;
  const r = repeat ?? [1 / PHOTO[key].size, 1 / PHOTO[key].size];
  t.repeat.set(r[0], r[1]);
  t.rotation = rotation;
  if (entry.loaded) t.needsUpdate = true;
  else entry.pending.push(t);
  return t;
}

// Per-channel linear gain that shifts the photo's average color to `target`.
function tintColor(key, target) {
  if (!target) return new THREE.Color(1, 1, 1);
  const t = new THREE.Color(target), a = new THREE.Color(PHOTO[key].avg);
  return new THREE.Color(t.r / a.r, t.g / a.g, t.b / a.b);
}

// MeshStandardMaterial driven by a photo PBR set (diffuse + normal + AO/roughness/metal).
function photoMaterial(key, { tint, repeat, rotation, normalScale = 1 } = {}) {
  const arm = photoTexture(key, 'arm', { repeat, rotation });
  return new THREE.MeshStandardMaterial({
    color: tintColor(key, tint),
    map: photoTexture(key, 'diff', { repeat, rotation }),
    normalMap: photoTexture(key, 'nor_gl', { repeat, rotation }),
    normalScale: new THREE.Vector2(normalScale, normalScale),
    aoMap: arm,
    roughnessMap: arm,
    metalnessMap: arm,
    roughness: 1,
    metalness: 1,
  });
}

function atlasTexture(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.repeat.set(1 / (NB * BAY), 1 / (NF * FLOOR));
  return t;
}

// Window atlas drawn on transparent canvases: color (rgb + coverage alpha), glass mask, lit windows.
function makeAtlas(pal, seed) {
  const W = NB * PX, H = NF * PX;
  const c = canvas(W, H), gm = canvas(W, H), e = canvas(W, H);
  const g = c.getContext('2d'), gg = gm.getContext('2d'), ge = e.getContext('2d');
  const r = rng(seed);
  gg.fillStyle = '#000'; gg.fillRect(0, 0, W, H);
  ge.fillStyle = '#000'; ge.fillRect(0, 0, W, H);
  const glassRect = (x, y, w, h) => {
    const grad = g.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, shade(pal.glass, 0.1));
    grad.addColorStop(1, pal.glass);
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
    // Reveal: the recessed glass sits in shadow along the top and left edges.
    g.fillStyle = 'rgba(0,0,0,0.45)';
    g.fillRect(x, y, w, Math.max(2, h * 0.09));
    g.fillRect(x, y, Math.max(2, w * 0.07), h);
    gg.fillStyle = '#fff';
    gg.fillRect(x, y, w, h);
  };
  const lit = ['#ffd58a', '#ffe3a8', '#fff1c9', '#ffc873'];
  const u = PX / 64; // drawing unit, sizes below were designed for 64px bays

  for (let f = 0; f < NF; f++) {
    for (let b = 0; b < NB; b++) {
      const x0 = b * PX, y0 = f * PX;
      let wx, wy, ww, wh;
      if (pal.style === 'brick') {
        ww = PX * 0.42; wh = PX * 0.56; wx = x0 + (PX - ww) / 2; wy = y0 + PX * 0.16;
        g.fillStyle = pal.frame;
        g.fillRect(wx - 3 * u, wy - 6 * u, ww + 6 * u, wh + 9 * u); // stone surround + sill
        g.fillStyle = shade(pal.frame, -0.1);
        g.fillRect(wx + ww / 2 - 4 * u, wy - 7 * u, 8 * u, 6 * u); // keystone
        glassRect(wx, wy, ww, wh);
        g.fillStyle = pal.frame;
        g.fillRect(wx + ww / 2 - 1.5 * u, wy, 3 * u, wh); // mullion
        g.fillRect(wx, wy + wh * 0.35, ww, 2 * u); // transom
      } else if (pal.style === 'arch') {
        ww = PX * 0.4; wh = PX * 0.6; wx = x0 + (PX - ww) / 2; wy = y0 + PX * 0.16;
        const rr = ww / 2;
        g.fillStyle = pal.frame;
        g.beginPath();
        g.arc(wx + rr, wy + rr, rr + 4 * u, Math.PI, 0);
        g.lineTo(wx + ww + 4 * u, wy + wh + 4 * u);
        g.lineTo(wx - 4 * u, wy + wh + 4 * u);
        g.closePath();
        g.fill();
        g.save();
        g.beginPath();
        g.arc(wx + rr, wy + rr, rr, Math.PI, 0);
        g.lineTo(wx + ww, wy + wh);
        g.lineTo(wx, wy + wh);
        g.closePath();
        g.clip();
        glassRect(wx, wy, ww, wh);
        g.restore();
        g.fillStyle = pal.frame;
        g.fillRect(wx + ww / 2 - 1.5 * u, wy + rr * 0.3, 3 * u, wh - rr * 0.3);
        g.fillRect(wx, wy + wh * 0.45, ww, 2 * u);
      } else if (pal.style === 'modern') {
        ww = PX; wh = PX * 0.5; wx = x0; wy = y0 + PX * 0.2;
        glassRect(wx, wy, ww, wh);
        g.fillStyle = pal.frame;
        g.fillRect(x0, wy, 2.5 * u, wh);
        g.fillRect(x0 + PX / 2, wy, 1.5 * u, wh);
      } else if (pal.style === 'glass') {
        ww = PX; wh = PX; wx = x0; wy = y0;
        glassRect(wx, wy, ww, wh);
        g.fillStyle = pal.frame;
        g.fillRect(x0, y0, 2 * u, PX);
        g.fillRect(x0, y0 + PX - 3 * u, PX, 3 * u);
        g.fillRect(x0 + PX / 2, y0, 1 * u, PX);
      } else if (pal.style === 'hanok') {
        g.fillStyle = pal.frame;
        g.fillRect(x0, y0, 6 * u, PX); // wooden post
        g.fillRect(x0, y0 + PX * 0.12, PX, 4 * u); // lintel
        ww = PX * 0.5; wh = PX * 0.45; wx = x0 + PX * 0.25; wy = y0 + PX * 0.22;
        glassRect(wx, wy, ww, wh);
        g.strokeStyle = pal.frame; g.lineWidth = 1.5 * u;
        for (let k = 1; k < 4; k++) {
          g.beginPath(); g.moveTo(wx + (ww * k) / 4, wy); g.lineTo(wx + (ww * k) / 4, wy + wh); g.stroke();
          g.beginPath(); g.moveTo(wx, wy + (wh * k) / 4); g.lineTo(wx + ww, wy + (wh * k) / 4); g.stroke();
        }
        gg.fillStyle = '#000'; gg.fillRect(wx, wy, ww, wh); // paper, not glass
      } else if (pal.style === 'apt') {
        ww = PX * 0.62; wh = PX * 0.46; wx = x0 + (PX - ww) / 2; wy = y0 + PX * 0.22;
        g.fillStyle = pal.frame;
        g.fillRect(wx - 2 * u, wy - 2 * u, ww + 4 * u, wh + 4 * u);
        glassRect(wx, wy, ww, wh);
        g.fillStyle = pal.frame;
        g.fillRect(wx + ww / 2 - 1 * u, wy, 2 * u, wh);
      } else {
        continue;
      }
      if (r() < (pal.style === 'apt' ? 0.55 : 0.42)) {
        ge.fillStyle = lit[Math.floor(r() * lit.length)];
        ge.fillRect(wx, wy, ww, wh);
      }
    }
    if (pal.style === 'brick' || pal.style === 'arch') {
      g.fillStyle = pal.frame;
      g.fillRect(0, f * PX + PX - 4 * u, W, 4 * u); // stone string course at each floor slab
    }
  }
  const glassMap = atlasTexture(gm);
  glassMap.colorSpace = THREE.NoColorSpace;
  return { color: atlasTexture(c), glass: glassMap, lit: atlasTexture(e) };
}

// Photo wall + window atlas blended in the shader. Windows get their own roughness,
// metalness and a flat normal so the brick relief and AO do not show through the glass.
const atlases = new Map();
function facadeMaterial(key, tint) {
  const pal = PALETTES[key];
  if (!atlases.has(key)) atlases.set(key, makeAtlas(pal, 11 + atlases.size));
  const atlas = atlases.get(key);
  const m = photoMaterial(pal.base, { tint: tint ?? pal.tint });
  m.emissiveMap = atlas.lit;
  m.emissive = new THREE.Color(0xffffff);
  m.emissiveIntensity = 0;
  m.onBeforeCompile = (shader) => {
    shader.uniforms.facadeMap = { value: atlas.color };
    shader.uniforms.glassMap = { value: atlas.glass };
    shader.uniforms.facadeScale = { value: new THREE.Vector2(1 / (NB * BAY), 1 / (NF * FLOOR)) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform vec2 facadeScale;\nvarying vec2 vFacadeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = uv * facadeScale;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D facadeMap;\nuniform sampler2D glassMap;\nvarying vec2 vFacadeUv;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        vec4 facadeTexel = texture2D( facadeMap, vFacadeUv );
        float facadeGlass = texture2D( glassMap, vFacadeUv ).r * facadeTexel.a;
        diffuseColor.rgb = mix( diffuseColor.rgb, facadeTexel.rgb, facadeTexel.a );`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix( roughnessFactor, 0.7, facadeTexel.a );
        roughnessFactor = mix( roughnessFactor, 0.12, facadeGlass );`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix( metalnessFactor, 0.0, facadeTexel.a );
        metalnessFactor = mix( metalnessFactor, 0.3, facadeGlass );`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize( mix( normal, nonPerturbedNormal, facadeTexel.a ) );`)
      .replace('#include <aomap_fragment>', `
        #ifdef USE_AOMAP
          float facadeAo = mix( ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0, 1.0, facadeTexel.a );
          reflectedLight.indirectDiffuse *= facadeAo;
          reflectedLight.indirectSpecular *= facadeAo;
        #endif`);
  };
  m.customProgramCacheKey = () => 'facade-v1';
  nightMaterials.add(m);
  return m;
}

export function materials() {
  if (matCache) return matCache;
  matCache = {};
  for (const key of Object.keys(PALETTES)) matCache[key] = styleSet(key);
  // Cones and spheres have 0..1 UVs, so they need their own repeat.
  matCache.slateCone = photoMaterial('slate', { tint: '#595d63', repeat: [10, 4] });
  matCache.stone = photoMaterial('concrete', { tint: '#ddd5c4', normalScale: 0.6 });
  matCache.white = photoMaterial('concrete', { tint: '#f1eee8', normalScale: 0.4 });
  matCache.copper = new THREE.MeshStandardMaterial({ color: '#6fa597', roughness: 0.45, metalness: 0.6 });
  matCache.gold = new THREE.MeshStandardMaterial({ color: '#d8b35a', roughness: 0.3, metalness: 0.9 });
  matCache.dark = photoMaterial('concrete', { tint: '#4e4f52' });
  const face = clockFace();
  matCache.clock = new THREE.MeshStandardMaterial({ map: face, roughness: 0.4, emissive: '#fff4d6', emissiveMap: face, emissiveIntensity: 0 });
  matCache.clock.userData.isClock = true;
  nightMaterials.add(matCache.clock);
  matCache.canopy = new THREE.MeshStandardMaterial({ color: '#e7e8ea', roughness: 0.35, metalness: 0.5 });
  matCache.glassPanel = new THREE.MeshStandardMaterial({ color: '#5d7894', roughness: 0.08, metalness: 0.7, transparent: true, opacity: 0.85 });
  return matCache;
}

// Wall/roof material set for a palette, optionally re-tinted to a building's own colors.
// Sets are cached per (palette, wall color, roof color), so buildings sharing colors share materials.
const setCache = new Map();
export function styleSet(key, wallHex, roofHex) {
  const id = `${key}|${wallHex ?? ''}|${roofHex ?? ''}`;
  if (setCache.has(id)) return setCache.get(id);
  const pal = PALETTES[key];
  // Slates/tiles rows must run along the ridge: roof UVs put u across the slope.
  const roofRot = Math.PI / 2;
  const slateKey = key === 'hanok' ? 'giwa' : 'slate';
  const set = {
    key,
    pal,
    wall: facadeMaterial(key, wallHex),
    plain: photoMaterial(pal.base, { tint: wallHex ?? pal.tint }),
    roof: photoMaterial('concrete', { tint: pal.roofTint }),
    slate: photoMaterial(slateKey, { tint: roofHex ?? (key === 'hanok' ? '#46484c' : '#595d63'), rotation: roofRot }),
    slateCone: photoMaterial('slate', { tint: roofHex ?? '#595d63', repeat: [10, 4] }),
  };
  setCache.set(id, set);
  return set;
}

// Clock dial: roman-style ticks and hands at 10:10.
function clockFace() {
  const c = canvas(256, 256), g = c.getContext('2d');
  g.fillStyle = '#f4efe2'; g.beginPath(); g.arc(128, 128, 126, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#2b2b2b';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2, major = i % 5 === 0;
    g.lineWidth = major ? 7 : 2;
    const r0 = major ? 94 : 106;
    g.beginPath();
    g.moveTo(128 + Math.sin(a) * r0, 128 - Math.cos(a) * r0);
    g.lineTo(128 + Math.sin(a) * 116, 128 - Math.cos(a) * 116);
    g.stroke();
  }
  g.lineCap = 'round';
  const hand = (a, len, w) => {
    g.lineWidth = w; g.beginPath(); g.moveTo(128, 128);
    g.lineTo(128 + Math.sin(a) * len, 128 - Math.cos(a) * len); g.stroke();
  };
  hand((10 / 12 + 10 / 720) * Math.PI * 2, 58, 9);
  hand((10 / 60) * Math.PI * 2, 88, 6);
  g.fillStyle = '#2b2b2b'; g.beginPath(); g.arc(128, 128, 8, 0, Math.PI * 2); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function nightIntensity(m) {
  return nightLevel * (m.userData.isClock ? 0.8 : 1.35);
}

export function setNightLevel(t) {
  nightLevel = t;
  for (const m of nightMaterials) m.emissiveIntensity = nightIntensity(m);
}

// Floors/height from tags (OSM or the building register). Zero or missing values are ignored.
function parseLevels(tags) {
  const floors = parseFloat(tags['building:levels']);
  const height = parseFloat(tags.height);
  const f = floors > 0 ? floors : null;
  const h = height > 0 ? height : null;
  if (f == null && h == null) return null;
  return { floors: f ?? Math.max(1, Math.round(h / 3.6)), height: h };
}

// Thin boxes along every wall edge (stone cornice at the roof line, dark plinth at the base).
function edgeStrips(outer, y0, h, depth, inset, list) {
  let signed = 0;
  for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) signed += (outer[j].x - outer[i].x) * (outer[j].y + outer[i].y);
  const ccw = signed > 0;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 0.6) continue;
    const s = ccw ? 1 : -1;
    const nx = (dy / len) * s, ny = (-dx / len) * s; // outward normal (local x east, y north)
    const off = depth / 2 - inset;
    const g = new THREE.BoxGeometry(len + depth, h, depth);
    g.rotateY(Math.atan2(dy, dx));
    g.translate((a.x + b.x) / 2 + nx * off, y0 + h / 2, -((a.y + b.y) / 2 + ny * off));
    list.push(g);
  }
}

function mergedStrips(list, material) {
  if (!list.length) return null;
  const mesh = new THREE.Mesh(meterUV(mergeGeometries(list)), material);
  list.forEach((g) => g.dispose());
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function osmRef(b) {
  const id = b.tags['osm:id'] ?? (/^[wr]\d/.test(b.id) ? b.id : null);
  if (!id) return null;
  return id.startsWith('r') ? `relation/${id.slice(1)}` : `way/${id.slice(1)}`;
}

// Legacy `detail` values map onto roof shape + extras; explicit roof/extras in the meta win.
const DETAIL_STYLE = {
  auto: { roof: 'gable', extras: [] },
  flat: { roof: 'flat', extras: ['rooftop_structure'] },
  tower: { roof: 'hip', extras: ['white_cupola_spire', 'clock'] },
  chapel: { roof: 'gable', extras: ['central_tower', 'spire_cross'] },
  library: { roof: 'flat', extras: ['portico_columns'] },
  dome: { roof: 'hip', extras: ['dome'] },
  modern: { roof: 'flat', extras: ['curved_colonnade'] },
  hanok: { roof: 'hip', extras: ['hanok_roof'] },
  amphi: { roof: 'none', extras: [] },
};

function resolveStyle(campus, detail, m, tags) {
  const base = DETAIL_STYLE[detail] ?? DETAIL_STYLE.flat;
  const roof = m?.roof ?? base.roof;
  const extras = m?.extras ?? base.extras;
  const wall = m?.wall ?? (detail === 'hanok' ? 'stucco' : detail === 'modern' ? 'glass' : detail === 'amphi' ? 'concrete' : null);
  let palette;
  if (m?.palette) palette = m.palette;
  else if (detail === 'hanok' || extras.includes('hanok_roof')) palette = 'hanok';
  else if (detail === 'amphi') palette = 'concrete';
  else if (!campus) palette = 'other';
  else if (wall === 'glass') palette = 'glass';
  else if (wall === 'stone') palette = 'stone';
  else if (wall === 'concrete' || wall === 'stucco') palette = 'modern';
  else if (wall === 'brick') palette = extras.includes('arched_windows') ? 'brickArch' : 'brick';
  else palette = tags.building === 'hospital' ? 'modern' : 'brick';
  return { palette, roof, extras, wallHex: m?.wallHex ?? null, roofHex: m?.roofHex ?? null };
}

/**
 * Build meshes for every OSM building.
 * Returns { group, records, entries } where entries groups records by display name.
 */
export function buildBuildings(data, meta, proj) {
  const mats = materials();
  const group = new THREE.Group();
  group.name = 'buildings';
  const records = [];
  const fh = meta.defaults.floorHeight;
  const cornices = [], plinths = [];

  for (const b of data.buildings) {
    const outer = open(b.outer.map(proj));
    if (outer.length < 3) continue;
    const holes = (b.holes || []).map((h) => open(h.map(proj)));
    const displayName = b.name ? meta.aliases[b.name] ?? b.name : null;
    const m = displayName ? meta.buildings[displayName] : null;
    const campus = b.campus;
    const detail = m?.detail ?? (campus ? 'auto' : 'flat');
    const tagLevels = parseLevels(b.tags);

    // Surveyed values (building register or OSM) win over the hand estimates in buildings_meta.json.
    const floors = tagLevels?.floors ?? m?.floors ?? (campus ? meta.defaults.campusFloors : meta.defaults.otherFloors);
    let height = tagLevels?.height ?? floors * fh + 0.6;
    if (detail === 'amphi') height = 1.4;
    if (detail === 'hanok') height = 4.2;

    const style = resolveStyle(campus, detail, m, b.tags);
    const paletteKey = style.palette;
    const set = styleSet(paletteKey, style.wallHex, style.roofHex);

    const shape = new THREE.Shape(outer.map((p) => new THREE.Vector2(p.x, p.y)));
    for (const h of holes) shape.holes.push(new THREE.Path(h.map((p) => new THREE.Vector2(p.x, p.y))));
    const geom = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geom.rotateX(-Math.PI / 2);

    const mesh = new THREE.Mesh(geom, [set.roof, set.wall]);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const box = obb(outer);
    const rec = {
      id: b.id,
      osm: osmRef(b),
      name: displayName,
      rawName: b.name,
      tags: b.tags,
      meta: m,
      campus,
      detail,
      paletteKey,
      style,
      set,
      floors,
      floorsSource: tagLevels ? (b.tags['reg:id'] != null ? 'register' : 'osm') : m?.floors != null ? 'estimate' : 'default',
      height,
      topY: height,
      footprint: area(outer),
      outer,
      obb: box,
      meshes: [mesh],
    };
    mesh.userData.record = rec;
    group.add(mesh);
    if (campus && !['hanok', 'amphi'].includes(detail) && height > 5) {
      edgeStrips(outer, height - 0.75, 0.75, 0.55, 0.12, cornices);
      edgeStrips(outer, 0, 0.9, 0.22, 0.06, plinths);
    }
    addLandmark(rec, group, mats);
    records.push(rec);
  }
  for (const m of [mergedStrips(cornices, mats.stone), mergedStrips(plinths, mats.dark)]) if (m) group.add(m);

  // Group named buildings (e.g. two 한학촌 wings) into one list entry.
  const entries = new Map();
  for (const rec of records) {
    const key = rec.name ?? rec.id;
    if (!entries.has(key)) entries.set(key, { key, name: rec.name, records: [], meta: rec.meta, campus: rec.campus });
    entries.get(key).records.push(rec);
  }
  for (const e of entries.values()) {
    let ax = 0, ay = 0, wsum = 0, top = 0, ext = 0;
    for (const r of e.records) {
      ax += r.obb.center.x * r.footprint; ay += r.obb.center.y * r.footprint; wsum += r.footprint;
      top = Math.max(top, r.topY);
      ext = Math.max(ext, r.obb.length);
      r.entry = e;
    }
    e.center = { x: ax / wsum, y: ay / wsum };
    e.top = top;
    e.size = ext;
    e.footprint = wsum;
    e.category = e.meta?.category ?? (e.campus ? '기타' : null);
    e.label = e.meta?.displayName ?? e.name; // official name shown in the UI
  }
  return { group, records, entries };
}

// Tint every mesh of an entry so the selection stands out.
export function setHighlight(entry, on) {
  for (const rec of entry.records) {
    for (const mesh of rec.meshes) {
      if (on) {
        if (mesh.userData.baseMaterial) continue;
        mesh.userData.baseMaterial = mesh.material;
        // Warm color tint; lit windows stay lit because the emissive map is kept.
        const tint = (m) => {
          const c = m.clone();
          c.onBeforeCompile = m.onBeforeCompile; // clone() drops the facade shader hook
          c.customProgramCacheKey = m.customProgramCacheKey;
          c.color = new THREE.Color(m.color).multiply(new THREE.Color('#ffc07a'));
          if (nightMaterials.has(m)) {
            nightMaterials.add(c);
            c.emissiveIntensity = nightIntensity(c);
          } else {
            c.emissive = new THREE.Color('#ff9a1f');
            c.emissiveIntensity = 0.18;
          }
          return c;
        };
        mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material);
      } else if (mesh.userData.baseMaterial) {
        const clones = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        clones.forEach((c) => { nightMaterials.delete(c); c.dispose(); });
        mesh.material = mesh.userData.baseMaterial;
        delete mesh.userData.baseMaterial;
      }
    }
  }
}
