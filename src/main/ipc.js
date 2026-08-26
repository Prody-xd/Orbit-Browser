'use strict';

const { ipcMain, app, shell, clipboard } = require('electron');
const settingsModule = require('./settings');
const themes = require('./themes');
const { showPageMenu, showTabMenu } = require('./menus');

/**
 * Puente entre la UI y el proceso principal.
 *
 * Toda la superficie expuesta al renderer pasa por aqui, con `contextIsolation`
 * activo y sin Node en la UI. El renderer solo puede pedir cosas de esta lista.
 */
function registerIpc(ctx) {
  const { window, tabs, metrics, blocker, resize, visuals, appliedSwitches, windowMode } = ctx;

  const send = (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  // --- empuje de estado hacia la UI ---
  tabs.on('update', (snapshot) => send('tabs:update', snapshot));
  tabs.on('shortcut', (combo) => send('app:shortcut', combo));
  tabs.on('page-context-menu', ({ tabId, params }) => showPageMenu({ tabs, tabId, params, window }));
  metrics.onSample = (sample) => send('metrics:sample', sample);

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

  // --- arranque ---
  ipcMain.handle('app:bootstrap', () => ({
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
    windowState: { maximized: window.isMaximized(), fullscreen: window.isFullScreen(), focused: window.isFocused() },
    versions: {
      app: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      v8: process.versions.v8,
    },
    paths: { userData: app.getPath('userData'), themes: themes.userThemesDir() },
  }));

  // --- pestanas ---
  ipcMain.handle('tabs:snapshot', () => tabs.snapshot());
  ipcMain.handle('tabs:create', (_e, url, opts) => tabs.create(url, opts));
  ipcMain.handle('tabs:close', (_e, id) => tabs.close(id));
  ipcMain.handle('tabs:activate', (_e, id) => tabs.activate(id));
  ipcMain.handle('tabs:sleep', (_e, id) => tabs.sleep(id));
  ipcMain.handle('tabs:wake', (_e, id) => tabs.wake(id));
  ipcMain.handle('tabs:sleepOthers', () => tabs.sleepAllButActive());
  ipcMain.handle('tabs:navigate', (_e, id, url) => tabs.navigate(id, url));
  ipcMain.handle('tabs:reload', (_e, id, opts) => tabs.reload(id, opts));
  ipcMain.handle('tabs:stop', (_e, id) => tabs.stop(id));
  ipcMain.handle('tabs:back', (_e, id) => tabs.goBack(id));
  ipcMain.handle('tabs:forward', (_e, id) => tabs.goForward(id));
  ipcMain.handle('tabs:pin', (_e, id, pinned) => tabs.setPinned(id, pinned));
  ipcMain.handle('tabs:move', (_e, id, index) => tabs.move(id, index));
  ipcMain.handle('tabs:menu', (_e, id) => showTabMenu({ tabs, tabId: id, window }));

  // --- layout: la UI mide el hueco de la pagina y el main coloca la vista ---
  ipcMain.on('layout:pageBounds', (_e, bounds, radius) => tabs.setPageBounds(bounds, radius));

  // --- ajustes ---
  ipcMain.handle('settings:patch', (_e, patch) => {
    const result = settingsModule.patchSettings(patch ?? {});
    if (patch?.resources?.metricsIntervalMs !== undefined) metrics.refreshInterval();
    if (patch?.resources?.maxLiveTabs !== undefined) tabs.enforceLimits();
    send('settings:changed', result.settings);
    return result;
  });

  ipcMain.handle('settings:profile', (_e, name) => {
    const result = settingsModule.applyProfile(name);
    metrics.refreshInterval();
    tabs.enforceLimits();
    send('settings:changed', result.settings);
    return result;
  });

  // --- temas ---
  ipcMain.handle('themes:list', () => themes.listThemes());
  ipcMain.handle('themes:save', (_e, theme) => themes.saveUserTheme(theme));
  ipcMain.handle('themes:openFolder', () => themes.openThemesFolder());

  // --- recursos ---
  ipcMain.handle('metrics:subscribe', () => metrics.subscribe());
  ipcMain.handle('metrics:unsubscribe', () => metrics.unsubscribe());
  ipcMain.handle('metrics:sample', () => metrics.sample());
  ipcMain.handle('blocker:stats', () => blocker.stats());
  ipcMain.handle('blocker:reload', () => {
    blocker.loadUserLists();
    return blocker.stats();
  });

  // --- ventana ---
  ipcMain.on('window:minimize', () => window.minimize());
  ipcMain.on('window:toggleMaximize', () => (window.isMaximized() ? window.unmaximize() : window.maximize()));
  ipcMain.on('window:close', () => window.close());
  ipcMain.on('window:resizeStart', (_e, edge) => resize.begin(edge));
  ipcMain.on('window:resizeEnd', () => resize.end());

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

module.exports = { registerIpc };
