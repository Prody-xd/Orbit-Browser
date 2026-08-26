'use strict';

const { EventEmitter } = require('node:events');

/**
 * Recuento de fetch/XHR por pestana.
 *
 * Corre en el mismo `onBeforeRequest` que el bloqueador: Electron solo admite
 * un listener de ese evento por sesion. Contar ahi es barato (un Map) y no
 * anade otro filtro de red.
 *
 * La clave es el id del WebContents, no el id de pestana: sobrevive al mover
 * la pagina de una ventana a otra.
 */
const FETCH_TYPES = new Set(['xhr', 'fetch', 'websocket']);
const MAX_ENDPOINTS = 80;
const MENU_LIMIT = 22;

class NetworkActivity extends EventEmitter {
  constructor() {
    super();
    /** @type {Set<import('./tabs').TabManager>} */
    this.sources = new Set();
    /** @type {Map<number, {count: number, endpoints: Map<string, {url: string, count: number}>}>} */
    this.byContents = new Map();
    this._timer = null;
  }

  watch(tabs) {
    if (!tabs || this.sources.has(tabs)) return;
    this.sources.add(tabs);
    tabs.on('main-navigate', (id) => {
      const wcId = tabs.contentsId(id);
      if (wcId != null) this.reset(wcId);
    });
    tabs.on('tab-closed', (_id, contentsId) => {
      if (contentsId != null) this.byContents.delete(contentsId);
    });
    tabs.on('activated', () => this._schedule());
  }

  observe(details) {
    if (!FETCH_TYPES.has(details.resourceType)) return;
    const url = String(details.url ?? '');
    if (!/^https?:/i.test(url)) return;

    const wcId = details.webContentsId;
    if (wcId == null) return;

    const key = endpointKey(url);
    if (!key) return;

    let log = this.byContents.get(wcId);
    if (!log) {
      log = { count: 0, endpoints: new Map() };
      this.byContents.set(wcId, log);
    }

    log.count++;
    const prev = log.endpoints.get(key);
    if (prev) {
      prev.count++;
      prev.url = url;
    } else if (log.endpoints.size < MAX_ENDPOINTS) {
      log.endpoints.set(key, { url, count: 1 });
    }

    this._schedule();
  }

  reset(contentsId) {
    this.byContents.delete(contentsId);
    this._schedule();
  }

  snapshot(contentsId) {
    const log = this.byContents.get(contentsId);
    if (!log) return { count: 0, endpoints: [] };
    const endpoints = [...log.endpoints.entries()]
      .map(([key, entry]) => ({ key, url: entry.url, count: entry.count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return { count: log.count, endpoints };
  }

  snapshotFor(tabs) {
    if (!tabs) return { count: 0, endpoints: [] };
    return this.snapshot(tabs.contentsId(tabs.activeId));
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('update');
    }, 160);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }
}

function endpointKey(raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') {
      return `ws ${parsed.host}${parsed.pathname}`;
    }
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return '';
  }
}

function formatCount(n) {
  const value = Number(n) || 0;
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return `${Math.round(value / 1000)}k`;
}

module.exports = { NetworkActivity, FETCH_TYPES, MENU_LIMIT, formatCount, endpointKey };
