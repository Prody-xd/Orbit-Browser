'use strict';

const path = require('node:path');
const os = require('node:os');
const { app, session, nativeTheme } = require('electron');

const { registerSchemes, registerProtocol } = require('./protocol');
const { readSettingsEarly, initSettings, getSettings, saveSettingsNow } = require('./settings');
const { applyChromiumSwitches } = require('./switches');
const { detectVisuals } = require('./platform');
const { PARTITION } = require('./tabs');
const { MetricsSampler } = require('./metrics');
const { TrackerBlocker } = require('./blocker');
const { NetworkActivity } = require('./network');
const { JsonStore } = require('./store');
const { registerIpc, wireShell } = require('./ipc');
const { createHost } = require('./host');
const { initForms, getForms } = require('./forms');
const { initDownloads, getDownloads } = require('./downloads');
const { applyChromeCompat } = require('./chrome-compat');

const SMOKE = process.env.VITRAL_SMOKE === '1';
if (SMOKE) {
  // Perfil aislado: no pisa la sesion real ni pelea el candado de instancia
  // con un Orbit que el usuario tenga abierto.
  app.setPath('userData', path.join(os.tmpdir(), 'orbit-smoke'));
}

if (process.platform === 'win32') {
  app.setAppUserModelId(SMOKE ? 'com.prodyxd.orbit-browser.smoke' : 'com.prodyxd.orbit-browser');
}

// Una sola instancia: dos procesos escribiendo la misma sesion y la misma
// particion de disco es una forma segura de corromper ambas.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// --- Antes de whenReady: Chromium lee sus switches una sola vez, al arrancar ---
registerSchemes();
const earlySettings = readSettingsEarly();
const appliedSwitches = applyChromiumSwitches(earlySettings);
const visuals = detectVisuals();

// El chrome de Orbit puede ser oscuro; las paginas web no. Chromium sigue
// el modo del sistema para `prefers-color-scheme`, asi un sitio que si
// tiene tema oscuro puede usarlo sin que invertamos el resto.
nativeTheme.themeSource = 'system';

/** @type {ReturnType<typeof createHost>|null} */
let host = null;
let sessionStore = null;

app.on('second-instance', () => {
  const shell = host?.focused();
  if (!shell) return;
  if (shell.window.isMinimized()) shell.window.restore();
  shell.window.focus();
});

app.whenReady().then(async () => {
  await ensureWidevine();
  const settings = initSettings();

  // El protocolo interno debe existir tanto en la sesion por defecto (la del
  // chrome) como en la particion donde viven las pestanas.
  registerProtocol([session.fromPartition(PARTITION)]);

  sessionStore = new JsonStore(path.join(app.getPath('userData'), 'session.json'), { activeId: null, tabs: [] });

  hardenSession();

  const blocker = new TrackerBlocker({ partition: PARTITION, getSettings });
  const network = new NetworkActivity();
  blocker.onRequest = (details) => network.observe(details);
  blocker.install();

  const forms = initForms();
  const downloads = initDownloads();
  downloads.install(session.fromPartition(PARTITION));

  const metrics = new MetricsSampler({
    getTabs: () => host?.tabManagers?.() ?? host?.list().map((s) => s.tabs) ?? [],
    getSettings,
    onSample: () => {},
  });

  host = createHost({
    visuals,
    network,
    sessionStore,
    saveSettingsNow,
    restoreSession,
    onShell: (shell) => wireShell(shell, { network, downloads }),
  });

  registerIpc({
    host,
    metrics,
    blocker,
    network,
    downloads,
    visuals,
    appliedSwitches,
  });

  if (SMOKE) {
    sessionStore.data = { activeId: null, tabs: [], windows: [] };
    host.open({ restore: false });
  } else {
    host.restoreWindows();
  }

  // Recorrido automatizado de verificacion, solo bajo demanda.
  if (SMOKE) {
    const smoke = require('./smoke');
    const first = host.list()[0];
    if (first) {
      smoke.watchConsole(first.window);
      const run = () => {
        smoke
          .runSmoke({
            window: first.window,
            tabs: first.tabs,
            metrics,
            blocker,
            windowMode: first.windowMode,
            host,
            downloads,
            forms,
          })
          .catch((err) => {
            console.error('[smoke] error:', err);
            app.exit(1);
          });
      };
      if (first.window.webContents.isLoading()) {
        first.window.webContents.once('did-finish-load', run);
      } else {
        run();
      }
    }
  }
});

/** Politica de permisos: nada se concede en silencio, salvo lo que un
 *  navegador necesita para sitios normales (pantalla completa, DRM). */
function hardenSession() {
  const ses = session.fromPartition(PARTITION);

  applyChromeCompat(ses);

  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(isAllowedPermission(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission));

  // El chrome de Orbit no puede abrir ventanas sueltas. Las paginas de
  // usuario si: Google y otros SSO necesitan un popup con window.opener.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.session !== ses) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
  });
}

function isAllowedPermission(permission) {
  if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return true;
  // Equivale a "Permitir que los sitios reproduzcan contenido protegido".
  if (permission === 'mediaKeySystem') {
    try {
      return getSettings().browsing?.protectedContent !== false;
    } catch {
      return true;
    }
  }
  return false;
}

/** Widevine CDM (Netflix, etc.). Solo existe en el Electron de Castlabs. */
async function ensureWidevine() {
  let components;
  try {
    ({ components } = require('electron'));
  } catch {
    return;
  }
  if (!components?.whenReady) return;
  try {
    await Promise.race([
      components.whenReady(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), SMOKE ? 25000 : 90000)),
    ]);
  } catch (err) {
    console.warn('[widevine] el CDM no estuvo listo:', err.message);
  }
}

function restoreSession(tabs) {
  const settings = getSettings();
  const saved = sessionStore.data;

  if (!settings.browsing.restoreSession || !saved.tabs?.length) {
    tabs.create(settings.browsing.startPage, { active: true });
    return;
  }

  const sleeping = settings.browsing.restoreAsleep;
  let activeId = null;

  saved.tabs.forEach((entry, index) => {
    const isActive = index === 0;
    const id = tabs.create(entry.url, {
      active: false,
      // La primera pestana se abre de verdad; las demas quedan dormidas para
      // que restaurar 20 pestanas no cueste 20 procesos al arrancar.
      sleeping: sleeping ? !isActive : false,
      pinned: entry.pinned,
      title: entry.title,
    });
    if (isActive) activeId = id;
  });

  if (activeId != null) tabs.activate(activeId);
}

// Un navegador personal no tiene sentido sin ventana: al cerrarla, se cierra.
app.on('before-quit', () => {
  saveSettingsNow();
  getForms()?.saveNow();
  getDownloads()?.saveNow();
});

app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => {
  // Un fallo en un manejador suelto no debe tumbar el navegador con pestanas
  // abiertas: se registra y se sigue.
  console.error('[main] excepcion no capturada:', err);
});
