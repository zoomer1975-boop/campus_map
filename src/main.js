import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { makeProjector } from './geo.js';
import { buildBuildings, setHighlight, setNightLevel as setWindowNight } from './buildings.js';
import { buildGround } from './ground.js';
import { createLabels } from './labels.js';
import { initUI } from './ui.js';

const container = document.getElementById('scene');

const [data, meta] = await Promise.all([
  fetch('data/campus.json').then((r) => r.json()),
  fetch('data/buildings_meta.json').then((r) => r.json()),
]);
const proj = makeProjector(data.center);
if (data.buildingSource) {
  document.getElementById('attribution').innerHTML =
    '건물: 국토교통부 GIS건물통합정보 (브이월드, CC BY) · 도로·녹지 © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
}

// ---------- renderer / scene / camera ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog('#dfe9f1', 1400, 5200);

const camera = new THREE.PerspectiveCamera(42, 1, 1, 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.47;
controls.minDistance = 25;
controls.maxDistance = 2800;
controls.screenSpacePanning = false;
// Map-style mouse: left drag pans, right drag rotates.
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };

// ---------- sky ----------
// Day: photographed HDRI sky (Poly Haven, CC0). Night: dark gradient. Blended by `night`.
const skyUniforms = {
  top: { value: new THREE.Color('#5d9ad6') },
  bottom: { value: new THREE.Color('#e3edf4') },
  hdr: { value: null },
  hasHdr: { value: 0 },
  hdrExposure: { value: 1.0 },
  night: { value: 0 },
};
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(8000, 48, 24),
  new THREE.ShaderMaterial({
    uniforms: skyUniforms,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `#include <common>
      uniform vec3 top; uniform vec3 bottom; uniform sampler2D hdr; uniform float hasHdr; uniform float hdrExposure; uniform float night;
      varying vec3 vDir;
      void main(){
        vec3 dir = normalize(vDir);
        float h = clamp(dir.y * 1.6 + 0.08, 0.0, 1.0);
        vec3 col = mix(bottom, top, pow(h, 0.7));
        if (hasHdr > 0.5) {
          // Below the horizon the puresky HDRI is empty; reuse the horizon row instead.
          vec3 d = normalize(vec3(dir.x, max(dir.y, 0.015), dir.z));
          vec3 photo = texture2D(hdr, equirectUv(d)).rgb * hdrExposure;
          col = mix(photo, col, night);
        }
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -2;
sky.frustumCulled = false;
scene.add(sky);

const stars = (() => {
  const pos = [];
  for (let i = 0; i < 1600; i++) {
    const u = Math.random() * Math.PI * 2, v = Math.random() * 0.45 + 0.08;
    const r = 7000;
    pos.push(Math.cos(u) * Math.cos(v) * r, Math.sin(v) * r, Math.sin(u) * Math.cos(v) * r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: '#ffffff', size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, fog: false, depthWrite: false }));
  p.renderOrder = -1;
  return p;
})();
scene.add(stars);

// ---------- lights ----------
const hemi = new THREE.HemisphereLight('#e2efff', '#7a6c58', 0.45);
scene.add(hemi);
const sun = new THREE.DirectionalLight('#fff0d8', 2.6);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
Object.assign(sun.shadow.camera, { left: -850, right: 850, top: 850, bottom: -850, near: 10, far: 4000 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.6;
scene.add(sun, sun.target);

// Image-based lighting: reflections in windows and soft sky light on facades.
const pmrem = new THREE.PMREMGenerator(renderer);
new RGBELoader().load('assets/hdri/kloofendal_48d_partly_cloudy_puresky_1k.hdr', (hdr) => {
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  scene.environment = pmrem.fromEquirectangular(hdr).texture;
  skyUniforms.hdr.value = hdr;
  skyUniforms.hasHdr.value = 1;
});

// ---------- content ----------
const { group: buildingGroup, records, entries } = buildBuildings(data, meta, proj);
const ground = buildGround(data, proj, records);
scene.add(ground.group, buildingGroup);

const cb = ground.campusBounds;
const campusCenter = new THREE.Vector3((cb.minX + cb.maxX) / 2, 0, -(cb.minY + cb.maxY) / 2);
sun.target.position.copy(campusCenter);
const SUN_DAY = new THREE.Vector3(-0.55, 0.72, 0.42).normalize();
const SUN_NIGHT = new THREE.Vector3(0.45, 0.8, -0.4).normalize();

const labels = createLabels(container, scene);
const pickables = records.flatMap((r) => r.meshes);

// ---------- selection & camera flight ----------
let selected = null;
let flight = null;

function flyTo(entry) {
  const target = new THREE.Vector3(entry.center.x, entry.top * 0.35, -entry.center.y);
  const dir = camera.position.clone().sub(controls.target).normalize();
  dir.y = Math.max(dir.y, 0.55);
  dir.normalize();
  const dist = THREE.MathUtils.clamp(entry.size * 2.4 + entry.top * 1.5, 90, 420);
  flight = {
    t0: performance.now(),
    dur: 1300,
    fromP: camera.position.clone(),
    fromT: controls.target.clone(),
    toP: target.clone().addScaledVector(dir, dist),
    toT: target,
  };
}

function resetView() {
  const dist = 1250;
  flight = {
    t0: performance.now(),
    dur: 1300,
    fromP: camera.position.clone(),
    fromT: controls.target.clone(),
    toP: campusCenter.clone().add(new THREE.Vector3(-0.38, 0.62, 0.69).normalize().multiplyScalar(dist)),
    toT: campusCenter.clone(),
  };
}

function select(entry, { fly = false } = {}) {
  if (selected) setHighlight(selected, false);
  selected = entry;
  if (entry) {
    setHighlight(entry, true);
    ui.show(entry);
    if (fly) flyTo(entry);
  } else {
    ui.hide();
  }
  labels.setSelected(entry?.key ?? null);
}

controls.addEventListener('start', () => { flight = null; });

// ---------- day / night ----------
const DAY = {
  top: new THREE.Color('#5d9ad6'), bottom: new THREE.Color('#e3edf4'),
  hemiSky: new THREE.Color('#e2efff'), hemiGround: new THREE.Color('#7a6c58'), hemiI: 0.45,
  sun: new THREE.Color('#fff0d8'), sunI: 2.4, exposure: 1.0, env: 0.9,
};
const NIGHT = {
  top: new THREE.Color('#040816'), bottom: new THREE.Color('#1a2342'),
  hemiSky: new THREE.Color('#6a7fbf'), hemiGround: new THREE.Color('#23232e'), hemiI: 0.75,
  sun: new THREE.Color('#a9bcff'), sunI: 0.55, exposure: 1.0, env: 0.12,
};
let night = 0, nightTarget = 0;

function applyNight(t) {
  skyUniforms.top.value.lerpColors(DAY.top, NIGHT.top, t);
  skyUniforms.bottom.value.lerpColors(DAY.bottom, NIGHT.bottom, t);
  skyUniforms.night.value = t;
  scene.environmentIntensity = THREE.MathUtils.lerp(DAY.env, NIGHT.env, t);
  scene.fog.color.lerpColors(new THREE.Color('#d3dde6'), NIGHT.bottom, t);
  hemi.color.lerpColors(DAY.hemiSky, NIGHT.hemiSky, t);
  hemi.groundColor.lerpColors(DAY.hemiGround, NIGHT.hemiGround, t);
  hemi.intensity = THREE.MathUtils.lerp(DAY.hemiI, NIGHT.hemiI, t);
  sun.color.lerpColors(DAY.sun, NIGHT.sun, t);
  sun.intensity = THREE.MathUtils.lerp(DAY.sunI, NIGHT.sunI, t);
  const dir = SUN_DAY.clone().lerp(SUN_NIGHT, t).normalize();
  sun.position.copy(campusCenter).addScaledVector(dir, 1800);
  renderer.toneMappingExposure = THREE.MathUtils.lerp(DAY.exposure, NIGHT.exposure, t);
  stars.material.opacity = t * 0.9;
  setWindowNight(t);
  ground.setNightLevel(t);
  document.body.classList.toggle('is-night', t > 0.5);
}

// ---------- UI ----------
const ui = initUI({
  entries,
  categories: meta.categories,
  onPick: (entry, opts) => select(entry, opts),
  onClose: () => select(null),
  onNight: (v) => { nightTarget = v ? 1 : 0; },
  onLabels: (v) => labels.setEnabled(v),
  onReset: () => { select(null); resetView(); },
});

for (const e of entries.values()) {
  if (e.campus && e.name) labels.add(e, (entry) => select(entry, { fly: true }));
}

// ---------- picking ----------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down = null;

function pick(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, camera);
  const hit = raycaster.intersectObjects(pickables, false)[0];
  return hit?.object.userData.record?.entry ?? null;
}

renderer.domElement.addEventListener('pointerdown', (e) => { down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
  select(pick(e));
});
let hoverFrame = 0;
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || ++hoverFrame % 3) return;
  renderer.domElement.style.cursor = pick(e) ? 'pointer' : '';
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(null);
});

// ---------- resize & loop ----------
function resize() {
  const w = container.clientWidth, h = container.clientHeight;
  renderer.setSize(w, h);
  labels.resize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(container);
resize();

camera.position.copy(campusCenter).add(new THREE.Vector3(-0.38, 0.62, 0.69).normalize().multiplyScalar(1250));
controls.target.copy(campusCenter);
applyNight(0);

const ease = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
let last = performance.now();

renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (night !== nightTarget) {
    night = nightTarget > night ? Math.min(nightTarget, night + dt / 1.4) : Math.max(nightTarget, night - dt / 1.4);
    applyNight(night);
  }
  if (flight) {
    const k = ease(Math.min(1, (now - flight.t0) / flight.dur));
    camera.position.lerpVectors(flight.fromP, flight.toP, k);
    controls.target.lerpVectors(flight.fromT, flight.toT, k);
    if (k >= 1) flight = null;
  }
  controls.update();
  sky.position.copy(camera.position);
  stars.position.copy(camera.position);
  labels.update(camera);
  renderer.render(scene, camera);
  labels.render(scene, camera);
});

// Keep the loading screen until photo textures and the HDRI have arrived (or 10 s pass).
const loadingEl = document.getElementById('loading');
const hideLoading = () => loadingEl?.remove();
THREE.DefaultLoadingManager.onProgress = (_url, loaded, total) => {
  if (loadingEl) loadingEl.textContent = `실사 텍스처 불러오는 중… ${loaded}/${total}`;
};
THREE.DefaultLoadingManager.onLoad = hideLoading;
setTimeout(hideLoading, 10000);
Object.assign(window, { __campus: { scene, camera, controls, entries, records, select, stats: ground.stats } });
