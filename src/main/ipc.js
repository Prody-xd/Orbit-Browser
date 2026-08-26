'use strict';

const { ipcMain, app, shell, clipboard } = require('electron');
const settingsModule = require('./settings');
const themes = require('./themes');
const { showPageMenu, showTabMenu } = require('./menus');
const { showNetworkPopup } = require('./network-popup');

/**
 * Puente entre la UI y el proceso principal.
 *
 * Toda la superficie expuesta al renderer pasa por aqui, con `contextIsolation`
 * activo y sin Node en la UI. El renderer solo puede pedir cosas de esta lista.
 *
 * Los handlers se registran una sola vez. Cada mensaje se enruta a la ventana
 * que lo mando: asi pueden convivir varias cascaras.
 */
function registerIpc(ctx) {
  const { host, metrics, blocker, network, visuals, appliedSwitches } = ctx;

  const shellOf = (event) => host.fromSender(event.sender);

  const broadcast = (channel, payload) => {
    for (const s of host.list()) {
      if (!s.window.isDestroyed()) s.window.webContents.send(channel, payload);
    }
  };

  metrics.onSample = () => {
    for (const s of host.list()) {
      if (s.window.isDestroyed()) continue;
      s.window.webContents.send('metrics:sample', metrics.sample(s.tabs));
    }
  };

  // --- arranque ---
  ipcMain.handle('app:bootstrap', (event) => {
    const s = shellOf(event);
    if (!s) return {};
    const { window, tabs, windowMode } = s;
    return {
      settings: settingsModule.getSettings(),
      profiles: Object.fromEntries(
        Object.entries(settingsModule.PROFILES).map(([id, p]) => [id, { label: p.label, description: p.description }]),
      ),
      restartKeys: [...settingsModule.RESTART_KEYS],
      newTabKeys: [...settingsModule.NEW_TAB_KEYS],
      themes: themes.listThemes(),
      visuals,
      windowMode,
      appliedSwitches,
      tabs: tabs.snapshot(),
      network: network ? network.snapshotFor(tabs) : { count: 0, endpoints: [] },
      windowState: { maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() },
      versions: {
        app: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        v8: process.versions.v8,
      },
      paths: { userData: app.getPath('userData'), themes: themes.userThemesDir() },
    };
  });

  // --- pestanas ---
  ipcMain.handle('tabs:snapshot', (e) => shellOf(e)?.tabs.snapshot());
  ipcMain.handle('tabs:create', (e, url, opts) => shellOf(e)?.tabs.create(url, opts));
  ipcMain.handle('tabs:close', (e, id) => shellOf(e)?.tabs.close(id));
  ipcMain.handle('tabs:activate', (e, id) => shellOf(e)?.tabs.activate(id));
  ipcMain.handle('tabs:sleep', (e, id) => shellOf(e)?.tabs.sleep(id));
  ipcMain.handle('tabs:wake', (e, id) => shellOf(e)?.tabs.wake(id));
  ipcMain.handle('tabs:sleepOthers', (e) => shellOf(e)?.tabs.sleepAllButActive());
  ipcMain.handle('tabs:navigate', (e, id, url) => shellOf(e)?.tabs.navigate(id, url));
  ipcMain.handle('tabs:reload', (e, id, opts) => shellOf(e)?.tabs.reload(id, opts));
  ipcMain.handle('tabs:stop', (e, id) => shellOf(e)?.tabs.stop(id));
  ipcMain.handle('tabs:back', (e, id) => shellOf(e)?.tabs.goBack(id));
  ipcMain.handle('tabs:forward', (e, id) => shellOf(e)?.tabs.goForward(id));
  ipcMain.handle('tabs:pin', (e, id, pinned) => shellOf(e)?.tabs.setPinned(id, pinned));
  ipcMain.handle('tabs:mute', (e, id, muted) => shellOf(e)?.tabs.setMuted(id, muted));
  ipcMain.handle('tabs:move', (e, id, index) => shellOf(e)?.tabs.move(id, index));
  ipcMain.handle('tabs:menu', (e, id) => {
    const s = shellOf(e);
    if (s) showTabMenu({ tabs: s.tabs, tabId: id, window: s.window });
  });
  ipcMain.handle('tabs:detach', (e, id, point) => {
    const s = shellOf(e);
    if (s) host.tearOff(s, Number(id), point);
  });
  ipcMain.on('network:menu', (e, anchor) => {
    const s = shellOf(e);
    if (s) showNetworkPopup({ network, tabs: s.tabs, parent: s.window, anchor });
  });
  ipcMain.handle('network:snapshot', (e) => {
    const s = shellOf(e);
    return s && network ? network.snapshotFor(s.tabs) : { count: 0, endpoints: [] };
  });

  // --- layout: la UI mide el hueco de la pagina y el main coloca la vista ---
  ipcMain.on('layout:pageBounds', (e, bounds, radius) => shellOf(e)?.tabs.setPageBounds(bounds, radius));
  ipcMain.on('layout:ignorePageMouse', (e, ignore) => shellOf(e)?.tabs.setPageIgnoreMouse(Boolean(ignore)));

  // --- ajustes ---
  ipcMain.handle('settings:patch', (_e, patch) => {
    const result = settingsModule.patchSettings(patch ?? {});
    if (patch?.resources?.metricsIntervalMs !== undefined) metrics.refreshInterval();
    if (patch?.resources?.maxLiveTabs !== undefined) {
      for (const s of host.list()) s.tabs.enforceLimits();
    }
    broadcast('settings:changed', result.settings);
    return result;
  });

  ipcMain.handle('settings:profile', (_e, name) => {
    const result = settingsModule.applyProfile(name);
    metrics.refreshInterval();
    for (const s of host.list()) s.tabs.enforceLimits();
    broadcast('settings:changed', result.settings);
    return result;
  });

  // --- temas ---
  ipcMain.handle('themes:list', () => themes.listThemes());
  ipcMain.handle('themes:save', (_e, theme) => themes.saveUserTheme(theme));
  ipcMain.handle('themes:openFolder', () => themes.openThemesFolder());

  // --- recursos ---
  ipcMain.handle('metrics:subscribe', (e) => {
    const s = shellOf(e);
    const first = metrics.subscribe();
    return s ? metrics.sample(s.tabs) : first;
  });
  ipcMain.handle('metrics:unsubscribe', () => metrics.unsubscribe());
  ipcMain.handle('metrics:sample', (e) => {
    const s = shellOf(e);
    return s ? metrics.sample(s.tabs) : metrics.sample();
  });
  ipcMain.handle('blocker:stats', () => blocker.stats());
  ipcMain.handle('blocker:reload', () => {
    blocker.loadUserLists();
    return blocker.stats();
  });

  // --- ventana ---
  ipcMain.on('window:minimize', (e) => shellOf(e)?.window.minimize());
  ipcMain.on('window:toggleMaximize', (e) => {
    const window = shellOf(e)?.window;
    if (!window) return;
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
  });
  ipcMain.on('window:close', (e) => shellOf(e)?.window.close());
  ipcMain.on('window:resizeStart', (e, edge) => shellOf(e)?.resize.begin(edge));
  ipcMain.on('window:resizeEnd', (e) => shellOf(e)?.resize.end());

  // --- sistema ---
  ipcMain.handle('app:restart', () => {
    settingsModule.saveSettingsNow();
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
  ipcMain.handle('app:openPath', (_e, target) => shell.openPath(target));
  ipcMain.handle('app:copy', (_e, text) => clipboard.writeText(String(text ?? '')));
}

/** Empuja estado de una cascara concreta hacia su renderer. */
function wireShell(shell, { network }) {
  const { window, tabs } = shell;
  const send = (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  tabs.on('update', (snapshot) => send('tabs:update', snapshot));
  tabs.on('shortcut', (combo) => send('app:shortcut', combo));
  tabs.on('page-context-menu', ({ tabId, params }) => showPageMenu({ tabs, tabId, params, window }));

  const onNet = () => send('network:update', network ? network.snapshotFor(tabs) : { count: 0, endpoints: [] });
  if (network) network.on('update', onNet);

  const pushWindowState = () => {
    if (window.isDestroyed()) return;
    send('window:state', {
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      focused: window.isFocused(),
    });
  };
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    window.on(event, pushWindowState);
  }

  window.on('closed', () => {
    if (network) network.off('update', onNet);
  });
}

module.exports = { registerIpc, wireShell };
