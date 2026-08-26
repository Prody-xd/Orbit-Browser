'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebContentsView, shell } = require('electron');

const PARTITION = 'persist:orbit';
const PAGE_BACKGROUND = '#16161e';

/**
 * Gestor de pestanas.
 *
 * Cada pestana viva es un `WebContentsView`: una vista nativa compuesta por
 * Chromium, mucho mas barata que un `<webview>` y sin el coste de reenviar
 * eventos por IPC.
 *
 * El ahorro de recursos real viene de dormir pestanas: destruir el proceso del
 * renderer y conservar solo su metadata (url, titulo, favicon, scroll). Al
 * despertarla se recarga y se restaura el scroll. Eso libera de decenas a
 * cientos de MB por pestana, que es donde de verdad se gasta la RAM.
 */
class TabManager extends EventEmitter {
  /**
   * @param {{window: import('electron').BrowserWindow, getSettings: () => any}} deps
   */
  constructor({ window, getSettings }) {
    super();
    this.window = window;
    this.getSettings = getSettings;

    /** @type {Map<number, Tab>} */
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
    this.pageBounds = { x: 0, y: 0, width: 800, height: 600 };
    this.borderRadius = 0;

    this._sweepTimer = setInterval(() => this._sweepIdle(), 15_000);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  // ---------------------------------------------------------------- lifecycle

  /**
   * @param {string} url
   * @param {{active?: boolean, sleeping?: boolean, pinned?: boolean, title?: string}} [opts]
   */
  create(url, opts = {}) {
    const id = this.nextId++;
    /** @type {Tab} */
    const tab = {
      id,
      url: url || this.getSettings().browsing.startPage,
      title: opts.title || '',
      favicon: null,
      view: null,
      sleeping: false,
      pinned: Boolean(opts.pinned),
      loading: false,
      audible: false,
      crashed: false,
      error: null,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Date.now(),
      scroll: { x: 0, y: 0 },
      _restoreScroll: false,
    };

    this.tabs.set(id, tab);
    this.order.push(id);

    if (opts.sleeping) {
      // Pestana perezosa: existe en la barra pero no gasta nada hasta que la abres.
      tab.sleeping = true;
      if (opts.active !== false && this.activeId == null) this.activeId = id;
      this._emit();
      return id;
    }

    this._spawnView(tab);
    if (opts.active !== false) this.activate(id);
    else this._enforceLiveLimit();
    this._emit();
    return id;
  }

  close(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    this._destroyView(tab);
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[this.order.length - 1];
      if (next != null) this.activate(next);
    }
    this._emit();
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;

    if (this.activeId != null && this.activeId !== id) {
      const prev = this.tabs.get(this.activeId);
      if (prev?.view) this._setViewVisible(prev.view, false);
    }

    this.activeId = id;
    tab.lastActiveAt = Date.now();

    if (tab.sleeping || !tab.view) this.wake(id, { activating: true });
    else {
      this._setViewVisible(tab.view, true);
      this._applyBounds(tab);
    }

    this._enforceLiveLimit();
    this._emit();
  }

  // -------------------------------------------------------------- suspension

  /** Duerme una pestana: libera su proceso de renderer. */
  sleep(id, { force = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || tab.sleeping || !tab.view) return false;
    if (!force && id === this.activeId) return false;

    const wc = tab.view.webContents;
    // Guardamos el scroll antes de matar el proceso para que despertar no
    // se sienta como perder el sitio donde estabas leyendo.
    //
    // Con limite de tiempo a proposito: una pagina colgada nunca responde a
    // `executeJavaScript`, y dormir pestanas tiene que funcionar sobre todo
    // cuando una pagina se ha vuelto un problema. Perder la posicion de scroll
    // es aceptable; no poder liberar la memoria, no.
    const capture = wc.isDestroyed()
      ? Promise.resolve(null)
      : Promise.race([
          wc.executeJavaScript('({x: window.scrollX, y: window.scrollY})', true).catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 600)),
        ]);

    capture.then((pos) => {
      if (pos && typeof pos.y === 'number') tab.scroll = pos;
      this._destroyView(tab);
      tab.sleeping = true;
      tab.loading = false;
      tab.audible = false;
      tab._restoreScroll = true;
      this._emit();
    });

    return true;
  }

  /** Despierta una pestana dormida recargando su url. */
  wake(id, { activating = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || tab.view) return;

    this._spawnView(tab);
    tab.sleeping = false;
    tab.crashed = false;
    if (activating || id === this.activeId) {
      this._setViewVisible(tab.view, true);
      this._applyBounds(tab);
    } else {
      this._setViewVisible(tab.view, false);
    }
    this._emit();
  }

  /** Duerme todas menos la activa. Boton de panico para la RAM. */
  sleepAllButActive() {
    let count = 0;
    for (const tab of this.tabs.values()) {
      if (tab.id !== this.activeId && tab.view && this._isSleepCandidate(tab)) {
        if (this.sleep(tab.id)) count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------- navegacion

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const url = this._resolveInput(input);
    tab.url = url;
    tab.error = null;
    if (!tab.view) {
      this.wake(id, { activating: id === this.activeId });
      // wake() carga tab.url, ya actualizado arriba.
      return;
    }
    tab.view.webContents.loadURL(url).catch(() => {});
  }

  reload(id, { ignoreCache = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (!tab.view) return this.wake(id, { activating: id === this.activeId });
    if (ignoreCache) tab.view.webContents.reloadIgnoringCache();
    else tab.view.webContents.reload();
  }

  stop(id) {
    this.tabs.get(id)?.view?.webContents.stop();
  }

  goBack(id) {
    const wc = this.tabs.get(id)?.view?.webContents;
    if (!wc) return;
    const nav = wc.navigationHistory;
    if (nav?.canGoBack()) nav.goBack();
  }

  goForward(id) {
    const wc = this.tabs.get(id)?.view?.webContents;
    if (!wc) return;
    const nav = wc.navigationHistory;
    if (nav?.canGoForward()) nav.goForward();
  }

  setPinned(id, pinned) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.pinned = Boolean(pinned);
    this._emit();
  }

  move(id, toIndex) {
    const from = this.order.indexOf(id);
    if (from < 0) return;
    this.order.splice(from, 1);
    this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
    this._emit();
  }

  /** Reevalua los topes de recursos tras un cambio de ajustes. */
  enforceLimits() {
    this._enforceLiveLimit();
  }

  // ------------------------------------------------------------------ layout

  /** El renderer manda el rectangulo del hueco de la pagina medido en CSS. */
  setPageBounds(bounds, radius = 0) {
    this.pageBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    this.borderRadius = Math.round(radius);
    const active = this.tabs.get(this.activeId);
    if (active) this._applyBounds(active);
  }

  // ---------------------------------------------------------------- snapshot

  /** Estado serializable para la UI. Sin objetos nativos. */
  snapshot() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        return {
          id: t.id,
          url: t.url,
          title: t.title || hostOf(t.url) || 'Nueva pestaña',
          favicon: t.favicon,
          sleeping: t.sleeping,
          pinned: t.pinned,
          loading: t.loading,
          audible: t.audible,
          crashed: t.crashed,
          error: t.error,
          canGoBack: t.canGoBack,
          canGoForward: t.canGoForward,
          live: Boolean(t.view),
          pid: t.view && !t.view.webContents.isDestroyed() ? safePid(t.view.webContents) : null,
        };
      }),
    };
  }

  /** Sesion persistible: urls y titulos, nada mas. */
  serializeSession() {
    return {
      activeId: this.activeId,
      tabs: this.order.map((id) => {
        const t = this.tabs.get(id);
        return { url: t.url, title: t.title, pinned: t.pinned };
      }),
    };
  }

  dispose() {
    clearInterval(this._sweepTimer);
    for (const tab of this.tabs.values()) this._destroyView(tab);
    this.tabs.clear();
    this.order = [];
  }

  // ----------------------------------------------------------------- privado

  _spawnView(tab) {
    const { resources } = this.getSettings();

    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        preload: path.join(__dirname, '..', 'preload', 'page.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Aqui si queremos throttling: son paginas ajenas en segundo plano.
        backgroundThrottling: resources.backgroundThrottle !== false,
        imageAnimationPolicy: resources.imageAnimationPolicy || 'allowed',
        webviewTag: false,
        spellcheck: false,
      },
    });

    view.setBackgroundColor(PAGE_BACKGROUND);
    tab.view = view;
    this.window.contentView.addChildView(view);
    this._setViewVisible(view, false);
    this._applyBounds(tab);
    this._wire(tab);

    view.webContents.loadURL(tab.url).catch(() => {});
  }

  _destroyView(tab) {
    const view = tab.view;
    if (!view) return;
    tab.view = null;
    try {
      this.window.contentView.removeChildView(view);
    } catch {
      /* la ventana ya puede estar cerrada */
    }
    try {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    } catch {
      /* ya cerrado */
    }
  }

  _setViewVisible(view, visible) {
    if (typeof view.setVisible === 'function') view.setVisible(visible);
  }

  _applyBounds(tab) {
    if (!tab.view) return;
    tab.view.setBounds(this.pageBounds);
    if (typeof tab.view.setBorderRadius === 'function') {
      tab.view.setBorderRadius(this.borderRadius);
    }
  }

  _wire(tab) {
    const wc = tab.view.webContents;
    const touch = () => {
      const nav = wc.navigationHistory;
      tab.canGoBack = nav ? nav.canGoBack() : false;
      tab.canGoForward = nav ? nav.canGoForward() : false;
      this._emit();
    };

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      this._emit();
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons?.[0] ?? null;
      this._emit();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      this._emit();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      touch();
    });

    wc.on('did-navigate', (_e, url) => {
      tab.url = url;
      tab.error = null;
      touch();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url;
        touch();
      }
    });

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED: pasa al cancelar una navegacion, no es un error real.
      if (!isMainFrame || code === -3) return;
      tab.error = { code, description, url };
      this._emit();
    });

    wc.on('did-finish-load', () => {
      if (tab._restoreScroll && (tab.scroll.x || tab.scroll.y)) {
        tab._restoreScroll = false;
        const { x, y } = tab.scroll;
        wc.executeJavaScript(`window.scrollTo(${Number(x) || 0}, ${Number(y) || 0})`, true).catch(() => {});
      }
    });

    wc.on('audio-state-changed', (event) => {
      tab.audible = Boolean(event?.audible ?? wc.isCurrentlyAudible());
      this._emit();
    });

    wc.on('render-process-gone', (_e, details) => {
      // Si Chromium mata el renderer (OOM, crash), lo tratamos como una
      // pestana dormida: la metadata sobrevive y se puede recargar.
      tab.crashed = details?.reason !== 'clean-exit';
      this._destroyView(tab);
      tab.sleeping = true;
      tab.loading = false;
      this._emit();
    });

    wc.setWindowOpenHandler(({ url, disposition }) => {
      if (disposition === 'foreground-tab' || disposition === 'background-tab' || disposition === 'new-window') {
        this.create(url, { active: disposition === 'foreground-tab' });
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });

    wc.on('context-menu', (_e, params) => {
      this.emit('page-context-menu', { tabId: tab.id, params });
    });

    wc.on('before-input-event', (event, input) => {
      // Los atajos del navegador tienen que funcionar tambien cuando el foco
      // esta dentro de la pagina, no solo en el chrome. Si no se interceptan
      // aqui, la pagina se los queda.
      if (input.type !== 'keyDown') return;
      const combo = comboOf(input);
      if (combo && SHORTCUTS.has(combo)) {
        event.preventDefault();
        this.emit('shortcut', combo);
      }
    });

    wc.on('will-navigate', (event, url) => {
      // Protocolos externos (mailto:, tel:, etc.) van al sistema, no a una pestana.
      if (!/^(https?|orbit|about|file|data|blob):/i.test(url)) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
  }

  _isSleepCandidate(tab) {
    const r = this.getSettings().resources;
    if (!tab.view || tab.sleeping) return false;
    if (tab.id === this.activeId) return false;
    if (r.keepAudibleAwake !== false && tab.audible) return false;
    if (r.keepPinnedAwake && tab.pinned) return false;
    return true;
  }

  /** Duerme pestanas que llevan demasiado tiempo sin uso. */
  _sweepIdle() {
    const r = this.getSettings().resources;
    if (!r.sleepEnabled) return;
    const limitMs = Math.max(1, Number(r.sleepAfterMinutes) || 10) * 60_000;
    const now = Date.now();
    for (const tab of this.tabs.values()) {
      if (this._isSleepCandidate(tab) && now - tab.lastActiveAt > limitMs) this.sleep(tab.id);
    }
  }

  /** Mantiene el numero de pestanas vivas bajo el tope, durmiendo las mas viejas. */
  _enforceLiveLimit() {
    const max = Number(this.getSettings().resources.maxLiveTabs) || 0;
    if (max <= 0) return;

    const live = [...this.tabs.values()].filter((t) => t.view).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    let excess = live.length - max;
    for (const tab of live) {
      if (excess <= 0) break;
      if (this._isSleepCandidate(tab) && this.sleep(tab.id)) excess--;
    }
  }

  /** Decide si lo escrito en la barra es una url o una busqueda. */
  _resolveInput(input) {
    const raw = String(input ?? '').trim();
    if (!raw) return this.getSettings().browsing.startPage;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw;

    const looksLikeHost = /^[^\s/?#]+\.[^\s/?#]{2,}(?:[/?#]|$)/.test(raw) || raw.startsWith('localhost');
    if (looksLikeHost) return `https://${raw}`;

    const template = this.getSettings().browsing.searchTemplate || 'https://duckduckgo.com/?q=%s';
    return template.replace('%s', encodeURIComponent(raw));
  }

  _emit() {
    if (this._emitScheduled) return;
    // Colapsa rafagas de eventos de Chromium en un solo mensaje por frame:
    // navegar una pagina puede disparar 10+ eventos en pocos ms.
    this._emitScheduled = true;
    setTimeout(() => {
      this._emitScheduled = false;
      this.emit('update', this.snapshot());
    }, 16);
  }
}

/** Atajos que el navegador reclama por encima de la pagina. */
const SHORTCUTS = new Set([
  'ctrl+t',
  'ctrl+w',
  'ctrl+l',
  'ctrl+r',
  'ctrl+shift+r',
  'ctrl+tab',
  'ctrl+shift+tab',
  'ctrl+,',
  'alt+left',
  'alt+right',
  'f5',
  'f6',
  ...Array.from({ length: 9 }, (_, i) => `ctrl+${i + 1}`),
]);

function comboOf(input) {
  const key = String(input.key ?? '').toLowerCase();
  if (!key) return null;
  const parts = [];
  if (input.control) parts.push('ctrl');
  if (input.alt) parts.push('alt');
  if (input.shift) parts.push('shift');
  const named = { arrowleft: 'left', arrowright: 'right' }[key] ?? key;
  parts.push(named);
  // Orden fijo: ctrl+alt+shift+tecla, para poder comparar cadenas.
  const order = { ctrl: 0, alt: 1, shift: 2 };
  return parts.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)).join('+');
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function safePid(wc) {
  try {
    return wc.getOSProcessId();
  } catch {
    return null;
  }
}

module.exports = { TabManager, PARTITION };

/**
 * @typedef {object} Tab
 * @property {number} id
 * @property {string} url
 * @property {string} title
 * @property {string|null} favicon
 * @property {import('electron').WebContentsView|null} view
 * @property {boolean} sleeping
 * @property {boolean} pinned
 * @property {boolean} loading
 * @property {boolean} audible
 * @property {boolean} crashed
 * @property {{code:number,description:string,url:string}|null} error
 * @property {boolean} canGoBack
 * @property {boolean} canGoForward
 * @property {number} lastActiveAt
 * @property {{x:number,y:number}} scroll
 * @property {boolean} _restoreScroll
 */
