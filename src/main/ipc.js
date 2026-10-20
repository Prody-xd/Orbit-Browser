'use strict';

const { ipcMain, app, shell, clipboard } = require('electron');
const settingsModule = require('./settings');
const themes = require('./themes');
const { showPageMenu, showTabMenu, handlePageShortcut } = require('./menus');
const { showNetworkPopup } = require('./network-popup');
const { showDownloadsPopup } = require('./downloads-popup');
const { getPermissions } = require('./permissions');

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
  const { host, metrics, blocker, network, downloads, visuals, appliedSwitches } = ctx;

  const shellOf = (event) => host.fromSender(event.sender);

  const broadcast = (channel, payload) => {
    for (const s of host.list()) {
      if (!s.window.isDestroyed()) s.window.webContents.send(channel, payload);
    }
  };

  metrics.onSample = () => {
    const managers = host.tabManagers();
    for (const s of host.list()) {
      if (s.window.isDestroyed()) continue;
      s.window.webContents.send('metrics:sample', metrics.sample(managers));
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
      downloads: downloads ? downloads.snapshot() : { busy: false, active: 0, percent: 0, items: [] },
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
  ipcMain.handle('tabs:sleepPid', (_e, pid) => host.sleepTabByPid(pid));
  ipcMain.handle('tabs:wake', (e, id) => shellOf(e)?.tabs.wake(id));
  ipcMain.handle('tabs:sleepOthers', (e) => host.sleepOthersExcept(shellOf(e)));
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
  ipcMain.handle('tabs:viewSource', (e, id) => {
    const s = shellOf(e);
    if (!s) return;
    handlePageShortcut({ tabs: s.tabs, window: s.window, combo: 'ctrl+u' });
  });
  ipcMain.handle('tabs:inspect', (e, id) => {
    const s = shellOf(e);
    const wc = s?.tabs.tabs.get(id)?.view?.webContents;
    wc?.openDevTools({ mode: 'detach' });
  });
  ipcMain.handle('tabs:print', (e, id) => {
    const s = shellOf(e);
    s?.tabs.tabs.get(id)?.view?.webContents.print();
  });
  ipcMain.handle('tabs:save', (e, id) => {
    const s = shellOf(e);
    if (!s) return;
    handlePageShortcut({ tabs: s.tabs, window: s.window, combo: 'ctrl+s' });
  });
  ipcMain.on('network:menu', (e, anchor) => {
    const s = shellOf(e);
    if (s) showNetworkPopup({ network, tabs: s.tabs, parent: s.window, anchor });
  });
  ipcMain.handle('network:snapshot', (e) => {
    const s = shellOf(e);
    return s && network ? network.snapshotFor(s.tabs) : { count: 0, endpoints: [] };
  });

  const { getForms } = require('./forms');
  ipcMain.handle('form:suggest', (_e, payload) => getForms()?.suggest(payload) ?? []);
  ipcMain.on('form:record', (_e, payload) => getForms()?.record(payload));

  ipcMain.on('downloads:menu', (e, anchor) => {
    const s = shellOf(e);
    if (s) showDownloadsPopup({ downloads, parent: s.window, anchor });
  });
  ipcMain.handle('downloads:snapshot', () => downloads?.snapshot() ?? { busy: false, active: 0, percent: 0, items: [] });

  // --- layout: la UI mide el hueco de la pagina y el main coloca la vista ---
  ipcMain.on('layout:pageBounds', (e, bounds, radius) => shellOf(e)?.tabs.setPageBounds(bounds, radius));
  ipcMain.on('layout:ignorePageMouse', (e, ignore) => shellOf(e)?.tabs.setPageIgnoreMouse(Boolean(ignore)));

  ipcMain.handle('find:start', (e, id, text, opts) => shellOf(e)?.tabs.findInPage(id, text, opts));
  ipcMain.handle('find:stop', (e, id) => shellOf(e)?.tabs.stopFind(id));
  ipcMain.on('find:visible', (e, visible) => {
    const s = shellOf(e);
    if (s) s.tabs.findBarOpen = Boolean(visible);
  });

  // --- ajustes ---
  ipcMain.handle('settings:patch', (_e, patch) => {
    const result = settingsModule.patchSettings(patch ?? {});
    if (patch?.resources?.metricsIntervalMs !== undefined) metrics.refreshInterval();
    if (patch?.resources?.maxLiveTabs !== undefined) {
      host.enforceLiveLimits();
    }
    if (patch?.appearance) {
      for (const s of host.list()) s.tabs.refreshPageCanvases();
    }
    if (patch?.browsing) settingsModule.saveSettingsNow();
    broadcast('settings:changed', result.settings);
    return result;
  });

  ipcMain.handle('settings:profile', (_e, name) => {
    const result = settingsModule.applyProfile(name);
    metrics.refreshInterval();
    host.enforceLiveLimits();
    broadcast('settings:changed', result.settings);
    return result;
  });

  // --- temas ---
  ipcMain.handle('themes:list', () => themes.listThemes());
  ipcMain.handle('themes:save', (_e, theme) => themes.saveUserTheme(theme));
  ipcMain.handle('themes:openFolder', () => themes.openThemesFolder());

  // --- recursos ---
  ipcMain.handle('metrics:subscribe', () => {
    metrics.subscribe();
    return metrics.sample(host.tabManagers());
  });
  ipcMain.handle('metrics:unsubscribe', () => metrics.unsubscribe());
  ipcMain.handle('metrics:sample', () => metrics.sample(host.tabManagers()));
  ipcMain.handle('blocker:stats', () => blocker.stats());
  ipcMain.handle('blocker:reload', () => {
    blocker.loadUserLists();
    return blocker.stats();
  });

  ipcMain.handle('permissions:list', () => getPermissions()?.list() ?? []);
  ipcMain.handle('permissions:set', (_e, origin, permission, decision) => {
    getPermissions()?.set(origin, [permission], decision === 'allow' ? 'allow' : 'deny');
    return getPermissions()?.list() ?? [];
  });
  ipcMain.handle('permissions:remove', (_e, origin, permission) => {
    getPermissions()?.remove(origin, permission);
    return getPermissions()?.list() ?? [];
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
function wireShell(shell, { network, downloads }) {
  const { window, tabs } = shell;
  const send = (channel, payload) => {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  };

  tabs.on('update', (snapshot) => send('tabs:update', snapshot));
  tabs.on('shortcut', (combo) => {
    if (handlePageShortcut({ tabs, window, combo })) return;
    send('app:shortcut', combo);
  });
  tabs.on('page-context-menu', ({ tabId, params }) => showPageMenu({ tabs, tabId, params, window }));
  tabs.on('find-result', (payload) => send('find:result', payload));

  const onNet = () => send('network:update', network ? network.snapshotFor(tabs) : { count: 0, endpoints: [] });
  if (network) network.on('update', onNet);
  const onDl = (snap) => send('downloads:update', snap ?? downloads?.snapshot());
  if (downloads) downloads.on('update', onDl);

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
    if (downloads) downloads.off('update', onDl);
  });
}

module.exports = { registerIpc, wireShell };
