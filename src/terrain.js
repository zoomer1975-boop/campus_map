import * as THREE from 'three';

// Terrain from assets/terrain (built by scripts/fetch_terrain.py): two int16 heightmaps in the
// same local frame as the map data (x = east, y = north, meters), values in decimeters above `ref`.
//   inner: fine grid around the campus, outer: coarse grid for the distant mountains.

export async function loadTerrain() {
  const meta = await fetch('assets/terrain/terrain.json', { cache: 'no-cache' }).then((r) => r.json());
  const grids = {};
  await Promise.all(Object.entries(meta.grids).map(async ([name, g]) => {
    const buf = await fetch(`assets/terrain/${g.file}`, { cache: 'no-cache' }).then((r) => r.arrayBuffer());
    grids[name] = { ...g, data: new Int16Array(buf) };
  }));

  // Interpolate on the same two triangles per cell that the mesh uses (split along the
  // (i+1, j) – (i, j+1) diagonal), so objects sit exactly on the rendered surface.
  const sample = (g, x, y) => {
    const fx = (x + g.half) / g.step, fy = (y + g.half) / g.step;
    if (!(fx >= 0 && fy >= 0 && fx <= g.n - 1 && fy <= g.n - 1)) return null;
    const i = Math.min(Math.floor(fx), g.n - 2), j = Math.min(Math.floor(fy), g.n - 2);
    const tx = fx - i, ty = fy - j, d = g.data, n = g.n;
    const v00 = d[j * n + i], v10 = d[j * n + i + 1], v01 = d[(j + 1) * n + i], v11 = d[(j + 1) * n + i + 1];
    const v = tx + ty <= 1
      ? v00 + (v10 - v00) * tx + (v01 - v00) * ty
      : v11 + (v01 - v11) * (1 - tx) + (v10 - v11) * (1 - ty);
    return v / 10;
  };
  const heightAt = (x, y) => sample(grids.inner, x, y) ?? sample(grids.outer, x, y) ?? 0;
  const slopeAt = (x, y, d = 8) => Math.hypot(heightAt(x + d, y) - heightAt(x - d, y), heightAt(x, y + d) - heightAt(x, y - d)) / (2 * d);
  return { meta, grids, heightAt, slopeAt };
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// 0..1: how likely a spot is wooded hillside (the campus backs onto forested hills).
export function forestMask(h, slope) {
  return Math.max(smooth(0.06, 0.16, slope) * smooth(12, 35, h), smooth(55, 90, h));
}

function gridGeometry(g, { hole = 0, offset = 0, extent }) {
  const n = g.n, d = g.data;
  const pos = new Float32Array(n * n * 3), col = new Float32Array(n * n * 3);
  const forest = new Float32Array(n * n), uv = new Float32Array(n * n * 2);
  const low = new THREE.Color('#a29d8f'), high = new THREE.Color('#3d5a31'), c = new THREE.Color();
  const h = (i, j) => d[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))] / 10;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i, x = -g.half + i * g.step, y = -g.half + j * g.step, z = h(i, j);
      pos.set([x, z + offset, -y], k * 3);
      const slope = Math.hypot(h(i + 1, j) - h(i - 1, j), h(i, j + 1) - h(i, j - 1)) / (2 * g.step);
      const f = forestMask(z, slope);
      forest[k] = f;
      c.copy(low).lerp(high, f);
      col.set([c.r, c.g, c.b], k * 3);
      uv.set([(x - extent.minX) / extent.size, (y - extent.minY) / extent.size], k * 2);
    }
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      if (hole) {
        const x0 = -g.half + i * g.step, y0 = -g.half + j * g.step;
        if (x0 > -hole && x0 + g.step < hole && y0 > -hole && y0 + g.step < hole) continue;
      }
      const a = j * n + i, b = a + 1, cc = a + n, dd = cc + 1;
      idx.push(a, b, cc, b, dd, cc);
    }
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geom.setAttribute('forest', new THREE.BufferAttribute(forest, 1));
  geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geom.setIndex(idx);
  geom.computeVertexNormals();
  return geom;
}

// Vertex-colored hills (lowland → forest) with the painted ground map (campus lawns, roads,
// pitches) blended on top by its alpha, and a canopy detail texture on wooded slopes.
function terrainMaterial(groundTex, canopyTex) {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: groundTex, roughness: 1 });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.canopyMap = { value: canopyTex };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float forest;\nvarying float vForest;\nvarying vec2 vCanopyUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvForest = forest;\nvCanopyUv = position.xz / 9.0;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D canopyMap;\nvarying float vForest;\nvarying vec2 vCanopyUv;')
      .replace('#include <map_fragment>', `
        vec4 groundTexel = vec4( 0.0 );
        #ifdef USE_MAP
          groundTexel = texture2D( map, vMapUv );
        #endif`)
      .replace('#include <color_fragment>', `
        vec3 terrainCol = diffuseColor.rgb * vColor;
        float canopy = texture2D( canopyMap, vCanopyUv ).r;
        terrainCol *= mix( 1.0, 0.55 + 0.8 * canopy, vForest );
        diffuseColor.rgb = mix( terrainCol, groundTexel.rgb, groundTexel.a );`);
  };
  m.customProgramCacheKey = () => 'terrain-v1';
  return m;
}

export function buildTerrainMeshes(terrain, groundTex, extent, canopyTex) {
  const { inner, outer } = terrain.grids;
  const mat = terrainMaterial(groundTex, canopyTex);
  const innerMesh = new THREE.Mesh(gridGeometry(inner, { extent }), mat);
  innerMesh.receiveShadow = true;
  // The outer ring skips the inner square and sits slightly lower so the seam stays hidden.
  const outerMesh = new THREE.Mesh(gridGeometry(outer, { extent, hole: inner.half - outer.step, offset: -1.5 }), mat);
  outerMesh.receiveShadow = true;
  return [innerMesh, outerMesh];
}
