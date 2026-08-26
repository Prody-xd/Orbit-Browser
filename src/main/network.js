'use strict';

const { EventEmitter } = require('node:events');

/**
 * Recuento de fetch/XHR por pestana.
 *
 * Corre en el mismo `onBeforeRequest` que el bloqueador: Electron solo admite
 * un listener de ese evento por sesion. Contar ahi es barato (un Map) y no
 * anade otro filtro de red.
 */
const FETCH_TYPES = new Set(['xhr', 'fetch', 'websocket']);
const MAX_ENDPOINTS = 80;
const MENU_LIMIT = 22;

class NetworkActivity extends EventEmitter {
  /**
   * @param {{tabs: import('./tabs').TabManager}} deps
   */
  constructor({ tabs }) {
    super();
    this.tabs = tabs;
    /** @type {Map<number, {count: number, endpoints: Map<string, {url: string, count: number}>}>} */
    this.byTab = new Map();
    this._timer = null;

    tabs.on('main-navigate', (id) => this.reset(id));
    tabs.on('tab-closed', (id) => this.byTab.delete(id));
    tabs.on('activated', () => this.emit('update', this.activeSnapshot()));
  }

  observe(details) {
    if (!FETCH_TYPES.has(details.resourceType)) return;
    const url = String(details.url ?? '');
    if (!/^https?:/i.test(url)) return;

    const tabId = this.tabs.idFromWebContentsId(details.webContentsId);
    if (tabId == null) return;

    const key = endpointKey(url);
    if (!key) return;

    let log = this.byTab.get(tabId);
    if (!log) {
      log = { count: 0, endpoints: new Map() };
      this.byTab.set(tabId, log);
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

  reset(tabId) {
    this.byTab.delete(tabId);
    this._schedule();
  }

  snapshot(tabId) {
    const log = this.byTab.get(tabId);
    if (!log) return { count: 0, endpoints: [] };
    const endpoints = [...log.endpoints.entries()]
      .map(([key, entry]) => ({ key, url: entry.url, count: entry.count }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    return { count: log.count, endpoints };
  }

  activeSnapshot() {
    return this.snapshot(this.tabs.activeId);
  }

  _schedule() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('update', this.activeSnapshot());
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
