/** dashboard.js — Pfinance BVL
 * Lógica del dashboard (index.html). Requiere config.js cargado antes
 * (expone la constante global API) y Chart.js.
 */

let barChart = null,
  donutChart = null;
let tickersMap = {},
  ultimosTickers = [],
  ultimoPerfil = 'Moderado',
  ultimosActivosData = [],
  currentSort = 'default',
  compareMode = false,
  compareSelected = [],
  autoRefreshTimer = null,
  refreshSeconds = 30;

const PERFIL_MSGS = {
  Conservador: 'Prioriza seguridad del capital. Activos estables, baja volatilidad, caídas máx. 1.5%.',
  Moderado: 'Busca equilibrio entre seguridad y rendimiento. Tolera caídas de hasta 2%.',
  Agresivo: 'Maximiza retorno asumiendo mayor riesgo. Horizonte largo, alta tolerancia a volatilidad.'
};
const PERFIL_CLS = { Conservador: 'conservador', Moderado: 'moderado', Agresivo: 'agresivo' };

/* ══════════════ WATCHLIST (localStorage) ══════════════ */
function getWatchlist() {
  try { return new Set(JSON.parse(localStorage.getItem('pfinance_watchlist') || '[]')); }
  catch { return new Set(); }
}
function saveWatchlist(set) {
  localStorage.setItem('pfinance_watchlist', JSON.stringify([...set]));
}
let watchlist = getWatchlist();

function toggleWatchlist(ticker) {
  if (watchlist.has(ticker)) {
    watchlist.delete(ticker);
    showToast(`${ticker} quitado de favoritos`, 'info', 'star');
  } else {
    watchlist.add(ticker);
    showToast(`${ticker} agregado a favoritos`, 'success', 'star');
  }
  saveWatchlist(watchlist);
  document.querySelectorAll(`.mcard[data-ticker="${ticker}"] .card-star`)
    .forEach(b => b.classList.toggle('active', watchlist.has(ticker)));
  document.querySelectorAll(`.activo-item[data-ticker="${ticker}"] .activo-star`)
    .forEach(b => b.classList.toggle('active', watchlist.has(ticker)));
  const favFilter = document.getElementById('fav-filter');
  if (favFilter?.checked) applyFavoritosFilter(true);
}

function applyFavoritosFilter(checked) {
  document.querySelectorAll('.activo-item').forEach(item => {
    if (!checked) { item.classList.remove('fav-hidden'); return; }
    item.classList.toggle('fav-hidden', !watchlist.has(item.dataset.ticker));
  });
}

/* ══════════════ TOASTS ══════════════ */
function showToast(msg, type = 'info', icon) {
  const cont = document.getElementById('toast-container');
  if (!cont) return;
  const div = document.createElement('div');
  div.className = `toast ${type}`;
  const ic = icon || (type === 'success' ? 'circle-check' : type === 'error' ? 'circle-exclamation' : 'circle-info');
  div.innerHTML = `<i class="fa-solid fa-${ic}"></i><span>${msg}</span>`;
  cont.appendChild(div);
  requestAnimationFrame(() => div.classList.add('show'));
  setTimeout(() => {
    div.classList.remove('show');
    setTimeout(() => div.remove(), 300);
  }, 3200);
}

/* ══════════════ INIT ══════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  await checkBackend();
  await cargarTickers();
  await cargarTickerBar();
  initKeyboardShortcuts();
});

async function checkBackend() {
  try {
    const r = await fetch(`${API}/api`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    if (d.status === 'ok') {
      document.getElementById('stext').textContent = 'Sistema activo';
    }
  } catch {
    document.getElementById('sdot').classList.add('offline');
    document.getElementById('stext').textContent = 'Backend offline';
  }
}

async function cargarTickerBar() {
  try {
    const r = await fetch(`${API}/activos`);
    const data = await r.json();
    const html = data.map(a => {
      const up = a.crecimiento >= 0;
      return `<div class="ticker-item" data-ticker="${a.ticker}">
        <span class="t-name">${a.empresa.toUpperCase()}</span>
        <span class="t-price">S/. ${a.precio}</span>
        <span class="${up ? 't-up' : 't-dn'}">${up ? '▲' : '▼'}${Math.abs(a.crecimiento)}%</span>
      </div>`;
    }).join('');
    const track = document.getElementById('ticker-track');
    track.innerHTML = html + html;
    track.onclick = (e) => {
      const item = e.target.closest('.ticker-item');
      if (!item) return;
      const ticker = item.dataset.ticker;
      const gridItem = document.querySelector(`.activo-item[data-ticker="${ticker}"]`);
      if (!gridItem) return;
      if (!gridItem.classList.contains('selected')) {
        gridItem.classList.add('selected');
        gridItem.querySelector('.activo-check').innerHTML = '<i class="fa-solid fa-check"></i>';
        showToast(`${ticker} agregado a la selección`, 'success');
        gridItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else {
        showToast(`${ticker} ya está seleccionado`, 'info');
      }
    };
  } catch { /* silencioso */ }
}

async function cargarTickers() {
  try {
    const r = await fetch(`${API}/tickers`);
    const d = await r.json();
    tickersMap = d.tickers;
    const grid = document.getElementById('activos-grid');
    grid.innerHTML = '';
    const defaultSel = Object.keys(tickersMap).slice(0, 3);
    for (const [ticker, nombre] of Object.entries(tickersMap)) {
      const sel = defaultSel.includes(ticker);
      const fav = watchlist.has(ticker);
      const item = document.createElement('div');
      item.className = 'activo-item' + (sel ? ' selected' : '');
      item.dataset.ticker = ticker;
      item.innerHTML =
        `<div class="activo-check">${sel ? '<i class="fa-solid fa-check"></i>' : ''}</div>
         <span class="activo-label">${nombre}</span>
         <button class="activo-star ${fav ? 'active' : ''}" title="Favorito" onclick="event.stopPropagation(); toggleWatchlist('${ticker}')">
           <i class="fa-solid fa-star"></i>
         </button>`;
      item.onclick = () => {
        item.classList.toggle('selected');
        const check = item.querySelector('.activo-check');
        check.innerHTML = item.classList.contains('selected') ? '<i class="fa-solid fa-check"></i>' : '';
      };
      grid.appendChild(item);
    }
  } catch {
    document.getElementById('activos-grid').innerHTML =
      '<p style="color:var(--muted);font-size:.78rem;">Error al cargar.</p>';
  }
}

function filterActivosGrid(q) {
  q = q.trim().toLowerCase();
  document.querySelectorAll('.activo-item').forEach(item => {
    const label = item.querySelector('.activo-label')?.textContent || '';
    const txt = (item.dataset.ticker + ' ' + label).toLowerCase();
    item.classList.toggle('search-hidden', !!q && !txt.includes(q));
  });
}

function cambiarPerfil(perfil) {
  const el = document.getElementById('perfil-msg');
  el.className = 'perfil-msg ' + PERFIL_CLS[perfil];
  el.innerHTML = `<i class="fa-solid fa-circle-info"></i> ${PERFIL_MSGS[perfil]}`;
  ultimoPerfil = perfil;
}

/* ══════════════ ANALIZAR ══════════════ */
async function analizar() {
  const tickers = Array.from(document.querySelectorAll('.activo-item.selected'))
    .map(i => i.dataset.ticker).filter(Boolean);
  if (!tickers.length) { showToast('Selecciona al menos un activo.', 'error'); return; }

  ultimosTickers = tickers;
  ultimoPerfil = document.getElementById('sel-perfil').value;

  document.getElementById('loading').classList.add('show');
  document.getElementById('dashboard').style.display = 'none';

  try {
    const ts = tickers.join(',');
    const [rA, rR] = await Promise.all([
      fetch(`${API}/activos?tickers=${ts}`).then(r => r.json()),
      fetch(`${API}/reglas?tickers=${ts}&perfil=${ultimoPerfil}`).then(r => r.json())
    ]);
    ultimosActivosData = rA;
    currentSort = 'default';
    compareSelected = [];
    document.querySelectorAll('.sort-btn').forEach(b => b.classList.toggle('active', b.dataset.sort === 'default'));

    renderMetricas(rA);
    renderGraficas(rA);
    renderReglas(rR, ultimoPerfil);
    actualizarInfoPanel(rA, rR);
    if (compareMode) renderComparePanel();
    document.getElementById('ia-output').innerHTML = '';
    document.getElementById('dashboard').style.display = 'block';
    showToast('Análisis completado', 'success');
  } catch (e) {
    showToast('Error: ' + e.message, 'error');
  } finally {
    document.getElementById('loading').classList.remove('show');
  }
}

/* ══════════════ AUTO-REFRESH ══════════════ */
function toggleAutoRefresh(on) {
  if (on) {
    startAutoRefresh();
    showToast(`Auto-actualización activada cada ${refreshSeconds}s`, 'info', 'arrows-rotate');
  } else {
    stopAutoRefresh();
    showToast('Auto-actualización desactivada', 'info');
  }
}
function updateRefreshInterval(v) {
  refreshSeconds = parseInt(v, 10);
  if (autoRefreshTimer) { stopAutoRefresh(); startAutoRefresh(); }
}
function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = setInterval(() => { if (ultimosTickers.length) refrescarSilencioso(); }, refreshSeconds * 1000);
}
function stopAutoRefresh() {
  if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
}
async function refrescarSilencioso() {
  try {
    const ts = ultimosTickers.join(',');
    const [rA, rR] = await Promise.all([
      fetch(`${API}/activos?tickers=${ts}`).then(r => r.json()),
      fetch(`${API}/reglas?tickers=${ts}&perfil=${ultimoPerfil}`).then(r => r.json())
    ]);
    ultimosActivosData = rA;
    renderMetricas(currentSort === 'default' ? rA : sortedCopy(rA, currentSort));
    renderGraficas(rA);
    renderReglas(rR, ultimoPerfil);
    actualizarInfoPanel(rA, rR);
    if (compareMode) renderComparePanel();
    showToast(`Datos actualizados · ${new Date().toLocaleTimeString('es-PE')}`, 'success', 'arrows-rotate');
  } catch (e) {
    showToast('Error al actualizar: ' + e.message, 'error');
  }
}

/* ══════════════ ORDENAR ══════════════ */
function sortedCopy(arr, criterio) {
  const copy = [...arr];
  if (criterio === 'precio') copy.sort((a, b) => b.precio - a.precio);
  else if (criterio === 'variacion') copy.sort((a, b) => b.crecimiento - a.crecimiento);
  else if (criterio === 'alfabetico') copy.sort((a, b) => a.empresa.localeCompare(b.empresa));
  return copy;
}
function sortMetrics(criterio, btn) {
  currentSort = criterio;
  document.querySelectorAll('.sort-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderMetricas(sortedCopy(ultimosActivosData, criterio));
}

/* ══════════════ INFO PANEL ══════════════ */
function actualizarInfoPanel(activos, reglas) {
  document.getElementById('info-activos').textContent = `${activos.length} activos analizados`;
  document.getElementById('info-reglas').textContent = `${reglas.length} reglas CLIPS activadas`;
  document.getElementById('info-perfil').textContent = ultimoPerfil;
  document.getElementById('info-hora').textContent = new Date().toLocaleTimeString('es-PE');
}

/* ══════════════ MÉTRICAS (tarjetas) ══════════════ */
function renderMetricas(activos) {
  const grid = document.getElementById('metrics-grid');
  grid.innerHTML = activos.map(a => {
    const up = a.crecimiento >= 0;
    const cls = a.crecimiento >= 1 ? 'up-card' : a.crecimiento <= -1 ? 'dn-card' : '';
    const icono = up ? '<i class="fa-solid fa-arrow-up"></i>' : '<i class="fa-solid fa-arrow-down"></i>';
    const fav = watchlist.has(a.ticker);
    return `<div class="mcard ${cls}" draggable="true" data-ticker="${a.ticker}">
      <button class="card-star ${fav ? 'active' : ''}" title="Favorito" onclick="event.stopPropagation(); toggleWatchlist('${a.ticker}')">
        <i class="fa-solid fa-star"></i>
      </button>
      <div class="mlabel"><i class="fa-solid fa-building"></i> ${a.empresa}</div>
      <div class="mval">S/. <span class="count-num" data-target="${a.precio}">0.00</span></div>
      <div class="mdelta ${up ? 'up' : 'dn'}">${icono} <span class="count-num" data-target="${Math.abs(a.crecimiento)}">0.00</span>%</div>
      <div class="msector">${a.sector} · ${a.ticker}</div>
      <div class="mcard-expand-info"></div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.count-num').forEach(el => animateCount(el, parseFloat(el.dataset.target)));

  grid.querySelectorAll('.mcard').forEach(card => {
    card.addEventListener('click', () => onMcardClick(card));
    card.addEventListener('dragstart', e => {
      e.dataTransfer.setData('text/plain', card.dataset.ticker);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', e => e.preventDefault());
    card.addEventListener('drop', e => {
      e.preventDefault();
      const draggedTicker = e.dataTransfer.getData('text/plain');
      const draggedEl = grid.querySelector(`.mcard[data-ticker="${draggedTicker}"]`);
      if (draggedEl && draggedEl !== card) grid.insertBefore(draggedEl, card);
    });
    if (compareSelected.includes(card.dataset.ticker)) card.classList.add('compare-selected');
  });
}

function animateCount(el, target) {
  const duration = 600;
  const start = performance.now();
  function step(now) {
    const progress = Math.min((now - start) / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = (target * eased).toFixed(2);
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = target.toFixed(2);
  }
  requestAnimationFrame(step);
}

function onMcardClick(card) {
  const ticker = card.dataset.ticker;
  if (compareMode) { toggleCompareSelection(ticker, card); return; }
  card.classList.toggle('expanded');
  const infoDiv = card.querySelector('.mcard-expand-info');
  infoDiv.innerHTML = card.classList.contains('expanded') ? buildExpandInfo(ticker) : '';
}

function buildExpandInfo(ticker) {
  const data = ultimosActivosData;
  const activo = data.find(a => a.ticker === ticker);
  if (!activo) return '';
  const rank = [...data].sort((a, b) => b.crecimiento - a.crecimiento).findIndex(a => a.ticker === ticker) + 1;
  const totalPrecio = data.reduce((s, a) => s + a.precio, 0);
  const peso = totalPrecio ? ((activo.precio / totalPrecio) * 100).toFixed(1) : '0.0';
  return `
    <div class="expand-row"><span>Puesto por variación</span><strong>#${rank} de ${data.length}</strong></div>
    <div class="expand-row"><span>Peso en la selección</span><strong>${peso}%</strong></div>
    <div class="expand-row"><span>Sector</span><strong>${activo.sector}</strong></div>
  `;
}

/* ══════════════ MODO COMPARAR ══════════════ */
function toggleCompareMode() {
  compareMode = !compareMode;
  const btn = document.getElementById('compare-toggle-btn');
  btn.classList.toggle('active', compareMode);
  document.getElementById('compare-panel').style.display = compareMode ? 'block' : 'none';
  if (!compareMode) {
    compareSelected = [];
    document.querySelectorAll('.mcard.compare-selected').forEach(c => c.classList.remove('compare-selected'));
  } else {
    showToast('Modo comparar activado: elige 2 activos', 'info', 'code-compare');
    renderComparePanel();
  }
}

function toggleCompareSelection(ticker, card) {
  const idx = compareSelected.indexOf(ticker);
  if (idx > -1) {
    compareSelected.splice(idx, 1);
    card.classList.remove('compare-selected');
  } else {
    if (compareSelected.length >= 2) {
      const removed = compareSelected.shift();
      document.querySelector(`.mcard[data-ticker="${removed}"]`)?.classList.remove('compare-selected');
    }
    compareSelected.push(ticker);
    card.classList.add('compare-selected');
  }
  renderComparePanel();
}

function renderComparePanel() {
  const panel = document.getElementById('compare-panel');
  if (!panel) return;
  if (compareSelected.length < 2) {
    panel.innerHTML = `<div class="compare-hint"><i class="fa-solid fa-code-compare"></i> Selecciona 2 activos en las tarjetas para compararlos lado a lado.</div>`;
    return;
  }
  const [t1, t2] = compareSelected;
  const a1 = ultimosActivosData.find(a => a.ticker === t1);
  const a2 = ultimosActivosData.find(a => a.ticker === t2);
  if (!a1 || !a2) return;
  const rows = [
    ['Precio', `S/. ${a1.precio}`, `S/. ${a2.precio}`, a1.precio - a2.precio],
    ['Variación %', `${a1.crecimiento}%`, `${a2.crecimiento}%`, a1.crecimiento - a2.crecimiento],
    ['Sector', a1.sector, a2.sector, null]
  ];
  panel.innerHTML = `
    <div class="compare-header">
      <div class="compare-col-title">${a1.empresa}</div>
      <div class="compare-col-title center">VS</div>
      <div class="compare-col-title">${a2.empresa}</div>
    </div>
    ${rows.map(r => `
      <div class="compare-row">
        <div class="compare-cell ${r[3] != null && r[3] > 0 ? 'better' : ''}">${r[1]}</div>
        <div class="compare-label">${r[0]}</div>
        <div class="compare-cell ${r[3] != null && r[3] < 0 ? 'better' : ''}">${r[2]}</div>
      </div>`).join('')}
  `;
}

/* ══════════════ GRÁFICAS ══════════════ */
function renderGraficas(activos) {
  const labels = activos.map(a => a.empresa);
  const valores = activos.map(a => a.crecimiento);
  const precios = activos.map(a => a.precio);
  const COLORS = ['#2979ff', '#00e5ff', '#00e676', '#ffd740', '#ff6d00', '#ea80fc', '#ff1744'];

  if (barChart) barChart.destroy();
  if (donutChart) donutChart.destroy();

  barChart = new Chart(document.getElementById('bar-chart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        data: valores,
        backgroundColor: valores.map(v => v >= 0 ? 'rgba(41,121,255,.6)' : 'rgba(255,23,68,.6)'),
        borderColor: valores.map(v => v >= 0 ? '#2979ff' : '#ff1744'),
        borderWidth: 1,
        borderRadius: 4,
        borderSkipped: false
      }]
    },
    options: {
      responsive: true,
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const ticker = activos[idx].ticker;
        const card = document.querySelector(`.mcard[data-ticker="${ticker}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('highlight-pulse');
          setTimeout(() => card.classList.remove('highlight-pulse'), 1200);
        }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#141414',
          titleColor: '#f5f5f5',
          bodyColor: '#00e5ff',
          borderColor: '#2a2a2a',
          borderWidth: 1,
          callbacks: { label: c => ` ${c.parsed.y.toFixed(2)}%  ·  S/. ${precios[c.dataIndex]}` }
        }
      },
      scales: {
        x: { ticks: { color: '#606060', font: { size: 10, family: 'JetBrains Mono' } }, grid: { color: '#1a1a1a' } },
        y: { beginAtZero: true, ticks: { color: '#606060', font: { family: 'JetBrains Mono' }, callback: v => v + '%' }, grid: { color: '#1a1a1a' } }
      }
    }
  });

  donutChart = new Chart(document.getElementById('donut-chart'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: valores.map(Math.abs),
        backgroundColor: COLORS,
        borderColor: '#141414',
        borderWidth: 3,
        hoverOffset: 5
      }]
    },
    options: {
      responsive: true,
      cutout: '70%',
      onClick: (evt, elements) => {
        if (!elements.length) return;
        const idx = elements[0].index;
        const ticker = activos[idx].ticker;
        const card = document.querySelector(`.mcard[data-ticker="${ticker}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          card.classList.add('highlight-pulse');
          setTimeout(() => card.classList.remove('highlight-pulse'), 1200);
        }
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: '#606060', font: { size: 9, family: 'JetBrains Mono' }, boxWidth: 8, padding: 8 } },
        tooltip: { backgroundColor: '#141414', titleColor: '#f5f5f5', bodyColor: '#ffd740', borderColor: '#2a2a2a', borderWidth: 1 }
      }
    }
  });
}

function renderReglas(reglas, perfil) {
  document.getElementById('clips-meta').textContent =
    `PERFIL: ${perfil.toUpperCase()} · ${reglas.length} reglas activadas · Motor: ClipsRulesEngine v2.0 · 90 reglas totales`;
  document.getElementById('rules-list').innerHTML = reglas.map(r => `
    <div class="rule-card" style="border-left-color:${r.color}">
      <div class="rule-icon"><i class="fa-solid fa-${r.icono || 'circle-check'}"></i></div>
      <div>
        <div class="rule-empresa"><i class="fa-solid fa-building"></i> ${r.empresa}</div>
        <div class="rule-id"><i class="fa-solid fa-tag"></i> ${r.regla}</div>
        <div class="rule-accion" style="color:${r.color}"><i class="fa-solid fa-arrow-right"></i> ${r.accion}</div>
      </div>
    </div>`).join('');
}

function markdownAHtml(texto) {
  return texto
    .replace(/^\s*\*{0,2}(\d+\.\s+[^\n]+)\*{0,2}/gm, (_, t) => `<h2>${t.replace(/\*\*/g, '').trim()}</h2>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\n)\*(?!\s)(.+?)\*/g, '<em>$1</em>')
    .replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>[\s\S]*?<\/li>\s*)+)/g, '<ul>$1</ul>')
    .split('\n').map(line => {
      const t = line.trim();
      if (!t) return '';
      if (t.startsWith('<h2>') || t.startsWith('<ul>') || t.startsWith('<li>') || t.startsWith('<p>')) return t;
      return `<p>${t}</p>`;
    }).filter(Boolean).join('\n');
}

async function generarIA() {
  if (!ultimosTickers.length) { showToast('Primero analiza el mercado.', 'error'); return; }
  const output = document.getElementById('ia-output');
  output.innerHTML = '<div class="ia-loading"><div class="spinner"></div> <span>Procesando con Gemini Transformer...</span></div>';
  try {
    const r = await fetch(`${API}/analisis-ia?tickers=${ultimosTickers.join(',')}&perfil=${ultimoPerfil}`);
    const d = await r.json();
    output.innerHTML = `<div class="ia-output">${markdownAHtml(d.analisis)}</div>`;
    showToast('Análisis IA generado', 'success', 'wand-magic-sparkles');
  } catch (e) {
    output.innerHTML =
      `<div style="color:var(--red);padding:16px;font-family:'JetBrains Mono',monospace;font-size:.8rem;"><i class="fa-solid fa-circle-exclamation"></i> ERROR: ${e.message}</div>`;
    showToast('Error al generar análisis IA', 'error');
  }
}

function switchTab(name, btn) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

/* ══════════════ ATAJOS DE TECLADO ══════════════ */
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
    if (e.key === '/' && !typing) {
      e.preventDefault();
      document.getElementById('activos-search')?.focus();
    } else if (e.key === 'Enter' && !typing) {
      analizar();
    } else if (e.key === 'Escape') {
      const search = document.getElementById('activos-search');
      if (search) { search.value = ''; filterActivosGrid(''); search.blur(); }
      if (compareMode) toggleCompareMode();
    }
  });
}