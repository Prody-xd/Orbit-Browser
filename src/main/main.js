'use strict';

const path = require('node:path');
const os = require('node:os');
const { app, session } = require('electron');

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

/** @type {ReturnType<typeof createHost>|null} */
let host = null;
let sessionStore = null;

app.on('second-instance', () => {
  const shell = host?.focused();
  if (!shell) return;
  if (shell.window.isMinimized()) shell.window.restore();
  shell.window.focus();
});

app.whenReady().then(() => {
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

  const metrics = new MetricsSampler({
    getTabs: () => host?.focused()?.tabs ?? null,
    getSettings,
    onSample: () => {},
  });

  host = createHost({
    visuals,
    network,
    sessionStore,
    saveSettingsNow,
    restoreSession,
    onShell: (shell) => wireShell(shell, { network }),
  });

  registerIpc({
    host,
    metrics,
    blocker,
    network,
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

/** Politica de permisos: nada se concede en silencio. */
function hardenSession() {
  const ses = session.fromPartition(PARTITION);

  // Denegamos por defecto lo que un navegador personal casi nunca necesita.
  // Es mas facil abrir un permiso a proposito que darse cuenta de que estaba
  // abierto desde el principio.
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(allowed.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  // El chrome de Orbit no puede abrir ventanas sueltas. Las paginas de
  // usuario si: Google y otros SSO necesitan un popup con window.opener.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.session !== ses) {
      contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    }
  });
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
app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => {
  // Un fallo en un manejador suelto no debe tumbar el navegador con pestanas
  // abiertas: se registra y se sigue.
  console.error('[main] excepcion no capturada:', err);
});
