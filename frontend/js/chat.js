/** chat.js — Pfinance BVL
 * Lógica del chat (chat.html). Requiere config.js cargado antes
 * (expone la constante global API).
 */

let historial = [];
let esperando = false;
let tokensSesion = 0;
const LIMITE_DIARIO = 1500;
const TOKENS_POR_MSG = 900;

document.addEventListener('DOMContentLoaded', async () => {
  await verificarBackend();
  await cargarTickers();
  cargarEmpresas();
  setupInput();
  setupSidebarMobile();
});

/* ══════════════ SIDEBAR MÓVIL (off-canvas) ══════════════ */
function setupSidebarMobile() {
  const mq = window.matchMedia('(max-width: 768px)');
  mq.addEventListener('change', (e) => { if (!e.matches) closeSidebar(); });
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  const isOpen = sidebar.classList.contains('open');
  isOpen ? closeSidebar() : openSidebar();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('show');
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'true');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('show');
  document.getElementById('sidebar-toggle').setAttribute('aria-expanded', 'false');
}

async function verificarBackend() {
  try {
    const r = await fetch(`${API}/api`, { signal: AbortSignal.timeout(4000) });
    const d = await r.json();
    if (d.status === 'ok') {
      document.getElementById('status-text').textContent = 'Sistema activo';
    }
  } catch {
    document.getElementById('status-dot').classList.add('offline');
    document.getElementById('status-text').textContent = 'Sin conexión';
  }
}

async function cargarTickers() {
  try {
    const r = await fetch(`${API}/activos`);
    const data = await r.json();
    const track = document.getElementById('ticker-track');

    const html = data.map(a => {
      const up = a.crecimiento >= 0;
      const cls = up ? 't-up' : 't-dn';
      const sig = up ? '▲' : '▼';
      return `<div class="ticker-item">
        <span class="t-name">${a.empresa.toUpperCase()}</span>
        <span class="t-price">S/. ${a.precio}</span>
        <span class="${cls}">${sig}${Math.abs(a.crecimiento)}%</span>
      </div>`;
    }).join('');

    track.innerHTML = html + html;
  } catch {
    document.getElementById('ticker-track').innerHTML =
      '<div class="ticker-item"><span class="t-name" style="color:var(--red)">Error cargando precios</span></div>';
  }
}

function cargarEmpresas() {
  const empresas = {
    'ALICORC1.LM': 'Alicorp',
    'BBVAC1.LM': 'BBVA Perú',
    'CPACASC1.LM': 'Pacasmayo',
    'FERREYC1.LM': 'Ferreycorp',
    'VOLCABC1.LM': 'Volcan',
    'BAP': 'Credicorp',
    'SCCO': 'Southern Copper'
  };
  const list = document.getElementById('empresa-list');
  list.innerHTML = Object.entries(empresas).map(([ticker, nombre]) => `
    <button class="empresa-btn" onclick="enviarRapido('Analiza ${nombre} (${ticker}) y dime si es buena inversión ahora mismo'); closeSidebar();">
      <span><span class="empresa-icon"><i class="fa-regular fa-building"></i></span> ${nombre}</span>
      <span class="empresa-ticker-tag">${ticker.replace('.LM', '')}</span>
    </button>
  `).join('');
}

function setupInput() {
  const input = document.getElementById('chat-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    const est = Math.ceil(input.value.length / 4);
    document.getElementById('input-tokens').textContent = `~${est + 900} tokens estimados`;
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviar(); }
  });
}

function actualizarTokens(tokensUsados) {
  tokensSesion += tokensUsados;
  const pct = Math.min((tokensSesion / 50000) * 100, 100);
  document.getElementById('tok-val').textContent = tokensSesion.toLocaleString();
  document.getElementById('tok-bar').style.width = pct + '%';
  document.getElementById('tok-used').textContent = tokensSesion.toLocaleString() + ' usados';

  const bar = document.getElementById('tok-bar');
  if (pct > 80) bar.style.background = 'linear-gradient(to right,var(--red),#ff6b35)';
  else if (pct > 50) bar.style.background = 'linear-gradient(to right,var(--gold),#ff9800)';
  else bar.style.background = 'linear-gradient(to right,var(--blue),var(--cyan))';
}

async function enviar() {
  const input = document.getElementById('chat-input');
  const mensaje = input.value.trim();
  if (!mensaje || esperando) return;

  input.value = '';
  input.style.height = 'auto';
  document.getElementById('input-tokens').textContent = '~0 tokens estimados';

  const welcome = document.getElementById('welcome');
  if (welcome) welcome.remove();

  agregarMensaje('user', mensaje);
  historial.push({ role: 'user', content: mensaje });

  const typingId = mostrarTyping();
  esperando = true;
  document.getElementById('btn-send').disabled = true;

  const t0 = Date.now();

  try {
    const perfil = document.getElementById('sel-perfil').value;
    const r = await fetch(`${API}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: mensaje,
        history: historial.slice(-10),
        perfil: perfil
      }),
      signal: AbortSignal.timeout(60000)
    });

    if (!r.ok) throw new Error(`Error ${r.status}`);
    const data = await r.json();
    const latencia = ((Date.now() - t0) / 1000).toFixed(1);

    quitarTyping(typingId);

    const tokEst = Math.ceil((mensaje.length + data.response.length) / 4) + 600;
    actualizarTokens(tokEst);

    agregarMensaje('assistant', data.response, tokEst, latencia);
    historial.push({ role: 'assistant', content: data.response });

    if (historial.length > 20) historial = historial.slice(-20);

  } catch (e) {
    quitarTyping(typingId);
    agregarMensaje('assistant', `No pude conectar con el servidor. Intenta de nuevo. (${e.message})`);
  } finally {
    esperando = false;
    document.getElementById('btn-send').disabled = false;
    document.getElementById('chat-input').focus();
  }
}

function enviarRapido(texto) {
  const input = document.getElementById('chat-input');
  input.value = texto;
  enviar();
}

function agregarMensaje(role, contenido, tokens = null, latencia = null) {
  const messages = document.getElementById('messages');
  const isUser = role === 'user';
  const hora = new Date().toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });

  const metaHtml = !isUser ? `
    <div class="msg-meta">
      <span class="msg-time"><i class="fa-regular fa-clock"></i> ${hora}</span>
      ${tokens ? `<span class="msg-tokens"><i class="fa-regular fa-token"></i> ${tokens.toLocaleString()} tokens · ${latencia}s</span>` : ''}
    </div>` : `<div class="msg-meta"><span class="msg-time"><i class="fa-regular fa-clock"></i> ${hora}</span></div>`;

  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="msg-avatar">${isUser ? '<i class="fa-solid fa-user"></i>' : '<i class="fa-solid fa-robot"></i>'}</div>
    <div class="msg-content">
      <div class="msg-bubble">${isUser ? escapeHtml(contenido) : markdownAHtml(contenido)}</div>
      ${metaHtml}
    </div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

function mostrarTyping() {
  const messages = document.getElementById('messages');
  const id = 'typing-' + Date.now();
  const div = document.createElement('div');
  div.className = 'typing-wrap';
  div.id = id;
  div.innerHTML = `
    <div class="typing-avatar">PF</div>
    <div class="typing-bubble">
      <div class="typing-dots">
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
        <div class="typing-dot"></div>
      </div>
      <span class="typing-text"><i class="fa-solid fa-spinner fa-spin"></i> Pfinance analizando...</span>
    </div>`;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return id;
}

function quitarTyping(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function nuevaConversacion() {
  historial = [];
  tokensSesion = 0;
  actualizarTokens(0);
  document.getElementById('tok-val').textContent = '0';
  document.getElementById('tok-used').textContent = '0 usados';
  document.getElementById('tok-bar').style.width = '0%';

  const messages = document.getElementById('messages');
  messages.innerHTML = `
    <div class="welcome" id="welcome">
      <div class="welcome-logo">PF</div>
      <div class="welcome-title">Hola, soy <span>Pfinance</span></div>
      <div class="welcome-sub">Tu asesor financiero con IA para la Bolsa de Valores de Lima.</div>
      <div class="welcome-chips">
        <div class="chip" onclick="enviarRapido('¿Debo comprar Alicorp ahora?')"><i class="fa-regular fa-building"></i> ¿Compro Alicorp?</div>
        <div class="chip" onclick="enviarRapido('¿Cómo está BBVA Perú hoy?')"><i class="fa-regular fa-bank"></i> BBVA Perú</div>
        <div class="chip" onclick="enviarRapido('¿Cuál es la mejor acción para invertir S/. 1000?')"><i class="fa-regular fa-sack-dollar"></i> Invertir S/. 1000</div>
        <div class="chip" onclick="enviarRapido('¿Qué es la BVL y cómo funciona?')"><i class="fa-regular fa-circle-info"></i> ¿Qué es la BVL?</div>
      </div>
    </div>`;
}

function markdownAHtml(texto) {
  return texto
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/###\s+(.+)/g, '<h3>$1</h3>')
    .replace(/##\s+(.+)/g, '<h3>$1</h3>')
    .replace(/^[\*\-]\s+(.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\s*)+)/g, '<ul>$1</ul>')
    .split('\n')
    .map(l => {
      const t = l.trim();
      if (!t) return '';
      if (t.startsWith('<h3>') || t.startsWith('<ul>') || t.startsWith('<li>')) return t;
      return `<p>${t}</p>`;
    })
    .filter(Boolean)
    .join('');
}

function escapeHtml(t) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}