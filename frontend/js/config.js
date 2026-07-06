/** config.js — Pfinance BVL
 * Configuración compartida entre dashboard.js y chat.js.
 *
 * Detecta automáticamente si estás corriendo en local (127.0.0.1 / localhost)
 * o en producción (Netlify), y apunta al backend correcto en cada caso.
 *
 * IMPORTANTE: reemplaza la URL de PRODUCCION más abajo por la URL real que
 * te dé Render una vez que despliegues el backend (algo como
 * https://pfinance-bvl.onrender.com).
 */
const ES_LOCAL = ['localhost', '127.0.0.1'].includes(window.location.hostname);

const API = ES_LOCAL
  ? 'http://127.0.0.1:8000'
  : 'https://TU-BACKEND.onrender.com';   // ← reemplaza esto con tu URL real de Render