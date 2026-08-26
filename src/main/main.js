'use strict';

const path = require('node:path');
const { app, session } = require('electron');

const { registerSchemes, registerProtocol } = require('./protocol');
const { readSettingsEarly, initSettings, getSettings, saveSettingsNow } = require('./settings');
const { applyChromiumSwitches } = require('./switches');
const { detectVisuals } = require('./platform');
const { createShellWindow, createResizeController } = require('./window');
const { TabManager, PARTITION } = require('./tabs');
const { MetricsSampler } = require('./metrics');
const { TrackerBlocker } = require('./blocker');
const { JsonStore } = require('./store');
const { registerIpc } = require('./ipc');

// Una sola instancia: dos procesos escribiendo la misma sesion y la misma
// particion de disco es una forma segura de corromper ambas.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// Agrupa la app en la barra de tareas de Windows bajo nuestro nombre, no
// bajo "Electron". Tiene que ir antes de crear ventanas.
if (process.platform === 'win32') {
  app.setAppUserModelId('com.prodyxd.orbit-browser');
}

// --- Antes de whenReady: Chromium lee sus switches una sola vez, al arrancar ---
registerSchemes();
const earlySettings = readSettingsEarly();
const appliedSwitches = applyChromiumSwitches(earlySettings);
const visuals = detectVisuals();

/** @type {{window: import('electron').BrowserWindow, tabs: TabManager}|null} */
let shell = null;
let sessionStore = null;

app.on('second-instance', () => {
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
  blocker.install();

  const { window, mode } = createShellWindow({ settings, visuals });
  const resize = createResizeController(window);
  const tabs = new TabManager({ window, getSettings });
  const metrics = new MetricsSampler({ tabs, getSettings, onSample: () => {} });

  shell = { window, tabs };

  registerIpc({
    window,
    tabs,
    metrics,
    blocker,
    resize,
    visuals,
    appliedSwitches,
    windowMode: mode,
  });

  // La UI arranca sin pestanas y pide la sesion cuando ya midio su layout,
  // asi la ventana aparece de inmediato en vez de esperar a la red.
  window.webContents.once('did-finish-load', () => restoreSession(tabs));

  wireWindowPersistence(window, tabs);

  // Recorrido automatizado de verificacion, solo bajo demanda.
  if (process.env.VITRAL_SMOKE === '1') {
    const smoke = require('./smoke');
    smoke.watchConsole(window);
    window.webContents.once('did-finish-load', () => {
      smoke.runSmoke({ window, tabs, metrics, blocker, windowMode: mode }).catch((err) => {
        console.error('[smoke] error:', err);
        app.exit(1);
      });
    });
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

  // Sin extensiones ni ventanas nativas nuevas: cada navegacion nueva termina
  // siendo una pestana gestionada por TabManager.
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
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

function wireWindowPersistence(window, tabs) {
  const persistBounds = () => {
    if (window.isDestroyed()) return;
    const settings = getSettings();
    settings.window.maximized = window.isMaximized();
    if (!window.isMaximized() && !window.isFullScreen()) {
      const bounds = window.getBounds();
      Object.assign(settings.window, bounds);
    }
  };

  let boundsTimer = null;
  const scheduleBounds = () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 400);
    if (typeof boundsTimer.unref === 'function') boundsTimer.unref();
  };
  window.on('resize', scheduleBounds);
  window.on('move', scheduleBounds);
  window.on('maximize', scheduleBounds);
  window.on('unmaximize', scheduleBounds);

  window.on('close', () => {
    persistBounds();
    sessionStore.data = tabs.serializeSession();
    sessionStore.saveNow();
    saveSettingsNow();
    tabs.dispose();
  });

  window.on('closed', () => {
    shell = null;
  });
}

// Un navegador personal no tiene sentido sin ventana: al cerrarla, se cierra.
app.on('window-all-closed', () => app.quit());

process.on('uncaughtException', (err) => {
  // Un fallo en un manejador suelto no debe tumbar el navegador con pestanas
  // abiertas: se registra y se sigue.
  console.error('[main] excepcion no capturada:', err);
});
