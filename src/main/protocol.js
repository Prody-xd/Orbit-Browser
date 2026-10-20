'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');

const PAGES_DIR = path.join(__dirname, '..', 'renderer', 'pages');

/**
 * Tipo MIME por extension.
 *
 * Hay que declararlo explicitamente: sin `content-type` correcto, Chromium no
 * trata el archivo como documento y la pestana se queda sin renderer, lo que
 * deja la pagina en blanco y ademas cuelga cualquier captura o script sobre
 * ella.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Paginas internas bajo `orbit://`.
 *
 * Sirve archivos de `src/renderer/pages` y nada mas: cualquier ruta que se
 * salga de esa carpeta se rechaza, para que una pagina web no pueda usar el
 * esquema interno como puerta al disco.
 */
function registerSchemes() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'orbit',
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
    },
  ]);
}

/**
 * Hoja de estilo generada con el tema activo.
 *
 * Las paginas internas la piden con `<link href="orbit://theme/theme.css">`,
 * asi heredan los colores elegidos por el usuario sin que haya que exponerles
 * ninguna API ni duplicar la paleta en cada pagina.
 */
function themeStylesheet() {
  const { getSettings } = require('./settings');
  const { getTheme } = require('./themes');

  const settings = getSettings();
  const appearance = settings.appearance;
  const theme = getTheme(appearance.theme);
  const c = theme?.colors ?? {};
  const accent = appearance.accent || c.accent || '#7aa2f7';

  return `:root{
  --base:${c.base ?? '#0f1017'};
  --chrome:${c.chrome ?? '#171826'};
  --elevated:${c.elevated ?? '#1f2133'};
  --text:${c.text ?? '#c9d1e6'};
  --muted:${c.muted ?? '#79839e'};
  --accent:${accent};
  --border:${c.border ?? '#2b2e42'};
  --radius:${Number(appearance.radius) || 14}px;
  color-scheme:${theme?.dark === false ? 'light' : 'dark'};
}`;
}

/**
 * Registra `orbit://` en las sesiones indicadas.
 *
 * `protocol.handle` del modulo `electron` solo cubre la sesion por defecto. Las
 * pestanas viven en una particion propia (`persist:orbit`), asi que si no se
 * registra tambien ahi, las paginas internas no cargan: la peticion no
 * encuentra manejador, la pestana queda sin documento y cualquier script o
 * captura sobre ella se queda esperando para siempre.
 *
 * @param {import('electron').Session[]} [sessions] sesiones adicionales
 */
function registerProtocol(sessions = []) {
  const handler = async (request) => {
    const url = new URL(request.url);
    const name = url.hostname || 'start';

    if (name === 'theme') {
      return new Response(themeStylesheet(), {
        headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    if (name === 'source') {
      const { takeSource, sourcePage } = require('./source-view');
      const id = url.pathname.replace(/^\//, '').split('/')[0];
      const entry = takeSource(id);
      if (!entry) {
        return new Response('Fuente no disponible', {
          status: 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return new Response(sourcePage(entry), {
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    const sub = url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.slice(1);

    const target = path.resolve(PAGES_DIR, name, sub);
    if (!target.startsWith(path.resolve(PAGES_DIR))) {
      return new Response('Ruta no permitida', { status: 403 });
    }

    try {
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        headers: {
          'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-cache',
        },
      });
    } catch (err) {
      const missing = err.code === 'ENOENT';
      return new Response(
        missing ? `No existe orbit://${name}/${sub}` : `Error al leer orbit://${name}/${sub}: ${err.message}`,
        { status: missing ? 404 : 500, headers: { 'content-type': 'text/plain; charset=utf-8' } },
      );
    }
  };

  protocol.handle('orbit', handler);
  for (const ses of sessions) {
    try {
      ses.protocol.handle('orbit', handler);
    } catch (err) {
      console.warn('[protocol] no se pudo registrar orbit:// en una sesion:', err.message);
    }
  }
}

module.exports = { registerSchemes, registerProtocol };
