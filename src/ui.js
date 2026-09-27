// DOM side of the app: building list + search, info panel, toolbar buttons.

const $ = (sel) => document.querySelector(sel);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function initUI({ entries, categories, onPick, onClose, onNight, onLabels, onReset }) {
  const list = $('#building-list');
  const search = $('#search');
  const info = $('#info');
  const listed = [...entries.values()].filter((e) => e.campus && e.name);
  const order = new Map(categories.map((c, i) => [c, i]));

  function renderList() {
    const q = search.value.trim().toLowerCase();
    const shown = listed.filter((e) => !q || [e.label, e.name, e.meta?.desc].some((t) => (t ?? '').toLowerCase().includes(q)));
    const groups = new Map();
    for (const e of shown) {
      const cat = e.category ?? '기타';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(e);
    }
    const cats = [...groups.keys()].sort((a, b) => (order.get(a) ?? 99) - (order.get(b) ?? 99));
    list.innerHTML = cats.length
      ? cats.map((cat) => `
        <li class="group">
          <h3>${escapeHtml(cat)} <span>${groups.get(cat).length}</span></h3>
          <ul>${groups.get(cat).sort((a, b) => a.label.localeCompare(b.label, 'ko')).map((e) =>
            `<li><button type="button" data-key="${escapeHtml(e.key)}">${escapeHtml(e.label)}</button></li>`).join('')}</ul>
        </li>`).join('')
      : '<li class="empty">검색 결과가 없습니다</li>';
    $('#count').textContent = `${shown.length}개 건물`;
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-key]');
    if (!btn) return;
    onPick(entries.get(btn.dataset.key), { fly: true });
    document.body.classList.remove('sidebar-open');
  });
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const first = list.querySelector('button[data-key]');
    if (first) first.click();
  });

  $('#toggle-sidebar').addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
  $('#info-close').addEventListener('click', () => onClose());

  const nightBtn = $('#btn-night');
  nightBtn.addEventListener('click', () => {
    const night = nightBtn.getAttribute('aria-pressed') !== 'true';
    nightBtn.setAttribute('aria-pressed', String(night));
    nightBtn.querySelector('.txt').textContent = night ? '밤' : '낮';
    nightBtn.querySelector('.ico').textContent = night ? '☾' : '☀';
    onNight(night);
  });
  const labelBtn = $('#btn-labels');
  labelBtn.addEventListener('click', () => {
    const on = labelBtn.getAttribute('aria-pressed') !== 'true';
    labelBtn.setAttribute('aria-pressed', String(on));
    onLabels(on);
  });
  $('#btn-reset').addEventListener('click', () => onReset());

  renderList();

  return {
    show(entry) {
      const m = entry.meta;
      const r0 = entry.records[0];
      const floors = Math.max(...entry.records.map((r) => r.floors));
      const height = Math.max(...entry.records.map((r) => r.topY)); // above the building's own base
      const src = { register: '건축물대장', osm: 'OSM 기준', estimate: '추정', default: '기본값' }[r0.floorsSource];
      const reg = entry.records.map((r) => r.tags).find((t) => t['reg:name'] || t['reg:dong'] || t['reg:use']);
      const approved = reg?.['reg:approved']?.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1.$2.$3');
      const regLine = reg
        ? [[reg['reg:name'], reg['reg:dong']].filter(Boolean).join(' '), reg['reg:use'], approved && `사용승인 ${approved}`].filter(Boolean).join(' · ')
        : '';
      const title = entry.label ?? '이름 없는 건물';
      const cat = entry.category ?? (entry.campus ? '캠퍼스 건물' : '주변 건물');
      const osmLinks = [...new Set(entry.records.map((r) => r.osm).filter(Boolean))].map((ref) =>
        `<a href="https://www.openstreetmap.org/${ref}" target="_blank" rel="noopener">${ref}</a>`).join(' · ');
      info.innerHTML = `
        <div class="info-head">
          <span class="chip">${escapeHtml(cat)}</span>
          <h2>${escapeHtml(title)}</h2>
          ${r0.tags['name:en'] ? `<p class="en">${escapeHtml(r0.tags['name:en'])}</p>` : ''}
        </div>
        ${m?.desc ? `<p class="desc">${escapeHtml(m.desc)}</p>` : entry.campus ? '<p class="desc muted">상세 용도 정보가 아직 없습니다. <code>data/buildings_meta.json</code>에 추가할 수 있어요.</p>' : ''}
        <dl>
          <div><dt>층수</dt><dd>${floors}층 <small>${src}</small></dd></div>
          <div><dt>최고 높이</dt><dd>약 ${Math.round(height)} m</dd></div>
          <div><dt>바닥 면적</dt><dd>${Math.round(entry.footprint).toLocaleString()} m²${entry.records.length > 1 ? ` <small>${entry.records.length}개 동</small>` : ''}</dd></div>
        </dl>
        ${regLine ? `<p class="osm">건축물대장: ${escapeHtml(regLine)}</p>` : ''}
        ${osmLinks ? `<p class="osm">OSM: ${osmLinks}</p>` : ''}`;
      $('#info-wrap').hidden = false;
      for (const b of list.querySelectorAll('button[data-key]')) b.classList.toggle('active', b.dataset.key === entry.key);
    },
    hide() {
      $('#info-wrap').hidden = true;
      for (const b of list.querySelectorAll('button.active')) b.classList.remove('active');
    },
  };
}
