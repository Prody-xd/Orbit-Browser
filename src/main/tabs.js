'use strict';

const path = require('node:path');
const { EventEmitter } = require('node:events');
const { WebContentsView, shell } = require('electron');
const { attachWindowOpen } = require('./popups');
const { createTabDialogs, attachPageDialogs } = require('./js-dialogs');
const { getForms, pageKey } = require('./forms');

const PARTITION = 'persist:orbit';

/**
 * Lienzo detras de la pagina.
 *
 * Las paginas web asumen el fondo blanco de Chromium. Si pintamos el
 * WebContentsView de oscuro, un sitio claro (o uno que no declara fondo)
 * se ve "en modo oscuro" aunque no lo tenga. El tema de Orbit solo colorea
 * las paginas internas `orbit://`; el resto queda blanco y, si el sitio
 * implementa modo oscuro (`prefers-color-scheme` o su propio interruptor),
 * lo aplica el.
 */
function pageCanvasColor(url, getSettings) {
  if (!String(url || '').startsWith('orbit:')) return '#ffffff';
  try {
    const { getTheme } = require('./themes');
    const theme = getTheme(getSettings?.()?.appearance?.theme);
    return theme?.colors?.page || theme?.colors?.base || '#16161e';
  } catch {
    return '#16161e';
  }
}

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
    this._ignorePageMouse = false;
    this._boundsReady = false;
    this.findBarOpen = false;
    this.jsDialogs = createTabDialogs(this);
    /** Timestamp de cuando esta ventana dejo de estar al frente. 0 = al frente. */
    this._backgroundSince = 0;

    this._sweepTimer = setInterval(() => this._sweepIdle(), 15_000);
    if (typeof this._sweepTimer.unref === 'function') this._sweepTimer.unref();
  }

  /** Relaciona el id de un WebContents de pagina con la pestana que lo posee. */
  idFromWebContentsId(webContentsId) {
    if (webContentsId == null) return null;
    for (const tab of this.tabs.values()) {
      if (tab.view && !tab.view.webContents.isDestroyed() && tab.view.webContents.id === webContentsId) {
        return tab.id;
      }
    }
    return null;
  }

  contentsId(id) {
    return wcIdOf(this.tabs.get(id));
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
      muted: false,
      crashed: false,
      error: null,
      canGoBack: false,
      canGoForward: false,
      lastActiveAt: Date.now(),
      scroll: { x: 0, y: 0 },
      _restoreScroll: false,
      owner: this,
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

    const contentsId = wcIdOf(tab);
    this._destroyView(tab);
    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[this.order.length - 1];
      if (next != null) this.activate(next);
    }
    this.emit('tab-closed', id, contentsId);
    this._emit();
  }

  /**
   * Suelta una pestana viva para moverla a otra ventana. No destruye el
   * proceso: el WebContentsView se reparenta en el destino.
   */
  detach(id) {
    const tab = this.tabs.get(id);
    if (!tab) return null;

    if (tab.view) {
      try {
        this.window.contentView.removeChildView(tab.view);
      } catch {
        /* la ventana ya puede estar cerrada */
      }
      this._setViewVisible(tab.view, false);
    }

    this.tabs.delete(id);
    this.order = this.order.filter((x) => x !== id);

    if (this.activeId === id) {
      this.activeId = null;
      const next = this.order[this.order.length - 1];
      if (next != null) this.activate(next);
    }

    this._emit();
    this.jsDialogs.sync();
    return tab;
  }

  /**
   * Engancha una pestana que venia de otra ventana. Reasigna el id para no
   * chocar con las de este TabManager.
   */
  attach(tab, { waitForBounds = false } = {}) {
    if (!tab) return null;
    tab.owner = this;
    tab.id = this.nextId++;
    this.tabs.set(tab.id, tab);
    this.order.push(tab.id);

    if (this.activeId != null && this.activeId !== tab.id) {
      const prev = this.tabs.get(this.activeId);
      if (prev?.view) this._setViewVisible(prev.view, false);
    }

    this.activeId = tab.id;
    tab.lastActiveAt = Date.now();

    if (tab.view) {
      this.window.contentView.addChildView(tab.view);
      if (this._ignorePageMouse && typeof tab.view.setIgnoreMouseEvents === 'function') {
        tab.view.setIgnoreMouseEvents(true);
      }
      const showNow = this._boundsReady && !waitForBounds;
      this._setViewVisible(tab.view, showNow);
      if (showNow) this._applyBounds(tab);
    } else {
      this.wake(tab.id, { activating: true });
      if (tab.view && (waitForBounds || !this._boundsReady)) {
        this._setViewVisible(tab.view, false);
      }
    }

    this._enforceLiveLimit();
    this.emit('activated', tab.id);
    this._emit();
    this.jsDialogs.raise();
    this.jsDialogs.sync();
    return tab.id;
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
    this.emit('activated', id);
    this._emit();
    this.jsDialogs.raise();
    this.jsDialogs.sync();
  }

  // -------------------------------------------------------------- suspension

  /** Duerme una pestana: libera su proceso de renderer. */
  sleep(id, { force = false } = {}) {
    const tab = this.tabs.get(id);
    if (!tab || tab.sleeping || !tab.view) return false;
    if (!force && id === this.activeId) return false;
    if (tab.jsDialog) return false;

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
    return this.sleepBackground({ includeActive: false });
  }

  /**
   * Duerme pestanas vivas de esta ventana.
   * `includeActive` sirve para ventanas que no estan al frente: ahi la
   * "activa" tampoco se esta mirando.
   */
  sleepBackground({ includeActive = false } = {}) {
    let count = 0;
    for (const tab of this.tabs.values()) {
      if (!this._isSleepCandidate(tab, { allowActive: includeActive })) continue;
      if (this.sleep(tab.id, { force: includeActive })) count++;
    }
    return count;
  }

  /** La ventana volvio al frente: despierta la pestana visible si estaba dormida. */
  onWindowForeground() {
    this._backgroundSince = 0;
    const tab = this.tabs.get(this.activeId);
    if (tab?.sleeping) this.wake(this.activeId, { activating: true });
  }

  onWindowBackground() {
    if (!this._backgroundSince) this._backgroundSince = Date.now();
  }

  /** Minimizar: no se ve nada, se puede liberar ya (salvo audio/fijadas). */
  onWindowMinimized() {
    if (!this.getSettings().resources.sleepEnabled) return;
    if (!this._backgroundSince) this._backgroundSince = Date.now();
    this.sleepBackground({ includeActive: true });
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

  setMuted(id, muted) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.muted = Boolean(muted);
    const wc = tab.view?.webContents;
    if (wc && !wc.isDestroyed()) wc.setAudioMuted(tab.muted);
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

  /**
   * Durante un arrastre del chrome (rail de pestañas), la pagina no debe
   * comerse el cursor: es una vista nativa encima del HTML.
   */
  setPageIgnoreMouse(ignore) {
    this._ignorePageMouse = Boolean(ignore);
    for (const tab of this.tabs.values()) {
      if (tab.view && typeof tab.view.setIgnoreMouseEvents === 'function') {
        tab.view.setIgnoreMouseEvents(this._ignorePageMouse);
      }
    }
  }

  /** El renderer manda el rectangulo del hueco de la pagina medido en CSS. */
  setPageBounds(bounds, radius = 0) {
    this.pageBounds = {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    this.borderRadius = Math.round(radius);
    this._boundsReady = true;
    const active = this.tabs.get(this.activeId);
    if (active?.view) {
      this._setViewVisible(active.view, true);
      this._applyBounds(active);
    }
    this.jsDialogs.layout();
  }

  /** Recolorea el lienzo de cada pestana (p. ej. al cambiar el tema). */
  refreshPageCanvases() {
    for (const tab of this.tabs.values()) {
      if (!tab.view) continue;
      tab.view.setBackgroundColor(pageCanvasColor(tab.url, () => this.getSettings()));
    }
  }

  /** Busca texto en la pestana con el resaltado nativo de Chromium. */
  findInPage(id, text, opts = {}) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (!tab.view) this.wake(id, { activating: id === this.activeId });
    const wc = tab.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    const query = String(text ?? '');
    if (!query) {
      this.stopFind(id);
      return;
    }
    // En Electron `findNext` se mapea a Blink `new_session`, no al
    // `find_next` de Chromium: true = busqueda nueva, false = siguiente.
    wc.findInPage(query, {
      forward: opts.forward !== false,
      findNext: !opts.findNext,
      matchCase: Boolean(opts.matchCase),
    });
  }

  stopFind(id) {
    const wc = this.tabs.get(id)?.view?.webContents;
    if (!wc || wc.isDestroyed()) return;
    try {
      wc.stopFindInPage('clearSelection');
    } catch {
      /* ya cerrada */
    }
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
          muted: Boolean(t.muted),
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
    this.jsDialogs.dispose();
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

    view.setBackgroundColor(pageCanvasColor(tab.url, () => this.getSettings()));
    tab.view = view;
    if (this._ignorePageMouse && typeof view.setIgnoreMouseEvents === 'function') {
      view.setIgnoreMouseEvents(true);
    }
    this.window.contentView.addChildView(view);
    this._setViewVisible(view, false);
    this._applyBounds(tab);
    this._wire(tab);
    this.jsDialogs.raise();
    if (tab.muted) view.webContents.setAudioMuted(true);

    view.webContents.loadURL(tab.url).catch(() => {});
  }

  _destroyView(tab) {
    this.jsDialogs.dismiss(tab);
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
    const owner = () => tab.owner;
    const touch = () => {
      const mgr = owner();
      if (!mgr) return;
      const nav = wc.navigationHistory;
      tab.canGoBack = nav ? nav.canGoBack() : false;
      tab.canGoForward = nav ? nav.canGoForward() : false;
      mgr._emit();
    };

    wc.on('page-title-updated', (_e, title) => {
      tab.title = title;
      owner()?._emit();
    });

    wc.on('page-favicon-updated', (_e, icons) => {
      tab.favicon = icons?.[0] ?? null;
      owner()?._emit();
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      owner()?._emit();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      touch();
    });

    wc.on('did-navigate', (_e, url) => {
      const mgr = owner();
      tab.url = url;
      tab.error = null;
      if (tab.view) tab.view.setBackgroundColor(pageCanvasColor(url, () => mgr?.getSettings()));
      noteFormVisit(tab, url);
      mgr?.emit('main-navigate', tab.id);
      touch();
    });

    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) {
        tab.url = url;
        noteFormVisit(tab, url);
        touch();
      }
    });

    wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED: pasa al cancelar una navegacion, no es un error real.
      if (!isMainFrame || code === -3) return;
      tab.error = { code, description, url };
      owner()?._emit();
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
      owner()?._emit();
    });

    wc.on('render-process-gone', (_e, details) => {
      // Si Chromium mata el renderer (OOM, crash), lo tratamos como una
      // pestana dormida: la metadata sobrevive y se puede recargar.
      const mgr = owner();
      tab.crashed = details?.reason !== 'clean-exit';
      mgr?._destroyView(tab);
      tab.sleeping = true;
      tab.loading = false;
      mgr?._emit();
    });

    wc.on('found-in-page', (_e, result) => {
      owner()?.emit('find-result', { tabId: tab.id, result });
    });

    attachPageDialogs(wc, tab);

    attachWindowOpen(wc, {
      getParentWindow: () => owner()?.window ?? null,
      openTab: (url, opts) => owner()?.create(url, opts),
    });

    wc.on('context-menu', (_e, params) => {
      owner()?.emit('page-context-menu', { tabId: tab.id, params });
    });

    wc.on('before-input-event', (event, input) => {
      // Los atajos del navegador tienen que funcionar tambien cuando el foco
      // esta dentro de la pagina, no solo en el chrome. Si no se interceptan
      // aqui, la pagina se los queda.
      const mgr = owner();
      if (!mgr || input.type !== 'keyDown') return;
      const combo = comboOf(input);
      if (combo === 'escape' && mgr.findBarOpen) {
        event.preventDefault();
        if (input.isAutoRepeat) return;
        mgr.emit('shortcut', combo);
        return;
      }
      if (!combo || !SHORTCUTS.has(combo)) return;
      event.preventDefault();
      // Ctrl+, y Escape basculan: el auto-repeat los dejaria abriendo y
      // cerrando a la vez.
      if (input.isAutoRepeat && (combo === 'ctrl+,' || combo === 'escape')) return;
      mgr.emit('shortcut', combo);
    });

    wc.on('will-navigate', (event, url) => {
      // Protocolos externos (mailto:, tel:, etc.) van al sistema, no a una pestana.
      if (!/^(https?|orbit|about|file|data|blob):/i.test(url)) {
        event.preventDefault();
        shell.openExternal(url).catch(() => {});
      }
    });
  }

  _isSleepCandidate(tab, { allowActive = false } = {}) {
    const r = this.getSettings().resources;
    if (!tab.view || tab.sleeping) return false;
    if (!allowActive && tab.id === this.activeId) return false;
    if (tab.jsDialog) return false;
    if (r.keepAudibleAwake !== false && tab.audible) return false;
    if (r.keepPinnedAwake && tab.pinned) return false;
    return true;
  }

  _windowIsForeground() {
    return Boolean(this.window && !this.window.isDestroyed() && this.window.isFocused() && !this.window.isMinimized());
  }

  /** Duerme pestanas que llevan demasiado tiempo sin uso. */
  _sweepIdle() {
    const r = this.getSettings().resources;
    if (!r.sleepEnabled) return;
    const limitMs = Math.max(1, Number(r.sleepAfterMinutes) || 10) * 60_000;
    const now = Date.now();
    const windowIdle = !this._windowIsForeground() && this._backgroundSince > 0 && now - this._backgroundSince > limitMs;

    for (const tab of this.tabs.values()) {
      if (tab.id === this.activeId && windowIdle && this._isSleepCandidate(tab, { allowActive: true })) {
        this.sleep(tab.id, { force: true });
        continue;
      }
      if (this._isSleepCandidate(tab) && now - tab.lastActiveAt > limitMs) this.sleep(tab.id);
    }
  }

  /** Mantiene el numero de pestanas vivas bajo el tope, durmiendo las mas viejas. */
  _enforceLiveLimit() {
    const max = Number(this.getSettings().resources.maxLiveTabs) || 0;
    if (max <= 0) return;

    const live = [...this.tabs.values()].filter((t) => t.view).sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    let excess = live.length - max;
    const allowActive = !this._windowIsForeground();
    for (const tab of live) {
      if (excess <= 0) break;
      if (this._isSleepCandidate(tab, { allowActive }) && this.sleep(tab.id, { force: allowActive })) excess--;
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
  'ctrl+f',
  'ctrl+g',
  'ctrl+shift+g',
  'f3',
  'shift+f3',
  'ctrl+s',
  'ctrl+p',
  'ctrl+u',
  'ctrl+shift+i',
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
  const named = { arrowleft: 'left', arrowright: 'right', comma: ',' }[key] ?? key;
  parts.push(named);
  // Orden fijo: ctrl+alt+shift+tecla, para poder comparar cadenas.
  const order = { ctrl: 0, alt: 1, shift: 2 };
  return parts.sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)).join('+');
}

function noteFormVisit(tab, url) {
  const key = pageKey(url);
  if (!key || tab._formPageKey === key) return;
  tab._formPageKey = key;
  try {
    getForms()?.noteVisit(url);
  } catch {
    /* settings aun no listos */
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function wcIdOf(tab) {
  const wc = tab?.view?.webContents;
  if (!wc || wc.isDestroyed()) return null;
  return wc.id;
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
 * @property {boolean} muted
 * @property {boolean} crashed
 * @property {{code:number,description:string,url:string}|null} error
 * @property {boolean} canGoBack
 * @property {boolean} canGoForward
 * @property {number} lastActiveAt
 * @property {{x:number,y:number}} scroll
 * @property {boolean} _restoreScroll
 * @property {TabManager|null} owner
 */
