import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Floating name tags above buildings. Major buildings stay visible from far away.
export function createLabels(container, scene) {
  const renderer = new CSS2DRenderer();
  renderer.domElement.className = 'label-layer';
  container.appendChild(renderer.domElement);

  const items = [];
  let enabled = true;
  let selectedKey = null;

  return {
    renderer,
    add(entry, onClick) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `label${entry.meta?.major ? ' major' : ''}`;
      el.textContent = entry.label ?? entry.name;
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => { e.stopPropagation(); onClick(entry); });
      const obj = new CSS2DObject(el);
      obj.center.set(0.5, 1);
      obj.position.set(entry.center.x, entry.top + 3, -entry.center.y);
      scene.add(obj);
      items.push({ entry, obj, el, far: entry.meta?.major ? 3000 : 650 });
    },
    update(camera) {
      for (const it of items) {
        const sel = it.entry.key === selectedKey;
        const d = camera.position.distanceTo(it.obj.position);
        it.obj.visible = sel || (enabled && d < it.far);
        it.el.classList.toggle('selected', sel);
        it.el.style.opacity = sel ? 1 : Math.min(1, (it.far - d) / 150 + 0.15).toFixed(2);
      }
    },
    setEnabled(v) { enabled = v; },
    setSelected(key) { selectedKey = key; },
    resize(w, h) { renderer.setSize(w, h); },
    render(sceneRef, camera) { renderer.render(sceneRef, camera); },
  };
}
