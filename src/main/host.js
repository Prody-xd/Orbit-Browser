'use strict';

const { screen } = require('electron');
const { createShellWindow, createResizeController } = require('./window');
const { TabManager } = require('./tabs');
const { getSettings } = require('./settings');

/**
 * Varias ventanas de Orbit.
 *
 * Cada una tiene su chrome y su TabManager. La pagina viva se puede mover de
 * una a otra sin recargar: se suelta el WebContentsView de un contentView y
 * se engancha en el otro.
 */
function createHost({ visuals, network, sessionStore, saveSettingsNow, restoreSession, onShell }) {
  const shells = [];

  function list() {
    return shells.filter((s) => s.window && !s.window.isDestroyed());
  }

  function fromSender(sender) {
    return list().find((s) => s.window.webContents.id === sender.id) ?? null;
  }

  function atPoint(x, y) {
    const hits = list().filter((s) => {
      const b = s.window.getBounds();
      return x >= b.x && y >= b.y && x <= b.x + b.width && y <= b.y + b.height;
    });
    if (!hits.length) return null;
    // Mientras se arrastra, la ventana de origen sigue con el foco. Si el
    // cursor ya esta sobre otra, esa es la destino.
    return hits.find((s) => !s.window.isFocused()) ?? hits[0];
  }

  function focused() {
    return (
      list().find((s) => s.window.isFocused()) ??
      list().sort((a, b) => (b.lastFocus || 0) - (a.lastFocus || 0))[0] ??
      list()[0] ??
      null
    );
  }

  function open({ placement, restore = false, detachedTab = null, session = null } = {}) {
    const settings = getSettings();
    const { window, mode } = createShellWindow({ settings, visuals, placement });
    const resize = createResizeController(window);
    const tabs = new TabManager({ window, getSettings });
    network.watch(tabs);

    const shell = { window, tabs, resize, windowMode: mode, lastFocus: Date.now() };
    shells.push(shell);

    if (detachedTab) tabs.attach(detachedTab, { waitForBounds: true });

    window.on('focus', () => {
      shell.lastFocus = Date.now();
    });

    window.webContents.once('did-finish-load', () => {
      if (session) restoreSessionInto(tabs, session, getSettings());
      else if (restore) restoreSession(tabs);
      else if (tabs.order.length === 0) {
        tabs.create(settings.browsing.startPage, { active: true });
      }
    });

    window.on('close', () => {
      persistBounds(window);
      const others = list().filter((s) => s !== shell);
      if (others.length === 0) persistSession();
      saveSettingsNow();
      resize.dispose();
      tabs.dispose();
    });

    window.on('closed', () => {
      const index = shells.indexOf(shell);
      if (index >= 0) shells.splice(index, 1);
      if (list().length) persistSession();
    });

    let boundsTimer = null;
    const scheduleBounds = () => {
      if (boundsTimer) clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => persistBounds(window), 400);
      if (typeof boundsTimer.unref === 'function') boundsTimer.unref();
    };
    window.on('resize', scheduleBounds);
    window.on('move', scheduleBounds);
    window.on('maximize', scheduleBounds);
    window.on('unmaximize', scheduleBounds);

    onShell?.(shell);
    return shell;
  }

  /**
   * Arrastrar una pestana fuera de su ventana.
   *
   * Si el cursor cae en otra ventana de Orbit, la pestana se une a ella.
   * Si cae en el escritorio, se abre una ventana nueva con esa pagina.
   */
  function tearOff(source, tabId, point) {
    if (!source || !source.tabs.tabs.has(tabId)) return;
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const target = atPoint(x, y);
    if (target === source && !point?.force) return;
    const dock = target && target !== source;

    const tab = source.tabs.detach(tabId);
    if (!tab) return;

    if (source.tabs.order.length === 0) {
      source.tabs.create(getSettings().browsing.startPage, { active: true });
    }

    if (dock) {
      target.tabs.attach(tab);
      target.window.focus();
      return;
    }

    const src = source.window.getBounds();
    const width = clamp(src.width, 620, 1100);
    const height = clamp(src.height, 420, 860);
    const wa = screen.getDisplayNearestPoint({ x, y }).workArea;
    open({
      placement: {
        width,
        height,
        x: clamp(x - 72, wa.x, wa.x + Math.max(0, wa.width - width)),
        y: clamp(y - 18, wa.y, wa.y + Math.max(0, wa.height - height)),
        maximized: false,
      },
      detachedTab: tab,
    });
  }

  function persistSession() {
    const alive = list();
    if (!sessionStore) return;
    sessionStore.data = {
      windows: alive.map((s) => {
        const bounds = s.window.isDestroyed() ? {} : s.window.getBounds();
        return {
          ...s.tabs.serializeSession(),
          bounds,
          maximized: !s.window.isDestroyed() && s.window.isMaximized(),
        };
      }),
    };
    sessionStore.saveNow();
  }

  function persistBounds(window) {
    if (!window || window.isDestroyed()) return;
    const settings = getSettings();
    settings.window.maximized = window.isMaximized();
    if (!window.isMaximized() && !window.isFullScreen()) {
      Object.assign(settings.window, window.getBounds());
    }
  }

  function restoreWindows() {
    const settings = getSettings();
    const saved = sessionStore?.data;

    if (settings.browsing.restoreSession && saved?.windows?.length) {
      saved.windows.forEach((entry) => {
        open({
          session: entry,
          placement: entry.bounds
            ? { ...entry.bounds, maximized: Boolean(entry.maximized) }
            : undefined,
        });
      });
      return;
    }

    open({ restore: true });
  }

  return { shells, list, fromSender, atPoint, focused, open, tearOff, persistSession, restoreWindows };
}

function restoreSessionInto(tabs, saved, settings) {
  if (!saved?.tabs?.length) {
    tabs.create(settings.browsing.startPage, { active: true });
    return;
  }
  const sleeping = settings.browsing.restoreAsleep;
  let activeId = null;
  saved.tabs.forEach((entry, index) => {
    const id = tabs.create(entry.url, {
      active: false,
      sleeping: sleeping ? index !== 0 : false,
      pinned: entry.pinned,
      title: entry.title,
    });
    if (index === 0) activeId = id;
  });
  if (activeId != null) tabs.activate(activeId);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}

module.exports = { createHost };
