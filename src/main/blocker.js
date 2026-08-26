'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, session } = require('electron');

/**
 * Bloqueo de rastreadores por host exacto o sufijo de dominio.
 *
 * A proposito no interpretamos reglas tipo EasyList: el filtro corre en cada
 * peticion de red, asi que tiene que ser una busqueda en un Set, no un motor
 * de expresiones regulares. Un dominio bloqueado tambien bloquea sus
 * subdominios, que cubre la mayoria de los casos reales sin coste medible.
 */
const BUILTIN = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'googletagservices.com',
  'adservice.google.com',
  'scorecardresearch.com',
  'quantserve.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'adnxs.com',
  'rubiconproject.com',
  'pubmatic.com',
  'openx.net',
  'casalemedia.com',
  'bidswitch.net',
  'moatads.com',
  'adsrvr.org',
  'amazon-adsystem.com',
  'facebook.net',
  'hotjar.com',
  'mixpanel.com',
  'segment.io',
  'branch.io',
  'fullstory.com',
  'clarity.ms',
  'newrelic.com',
  'nr-data.net',
  'sentry-cdn.com',
  'bugsnag.com',
  'optimizely.com',
  'crazyegg.com',
  'mouseflow.com',
  'inspectlet.com',
  'yandex-metrica.com',
  'mc.yandex.ru',
];

class TrackerBlocker {
  /**
   * @param {{partition: string, getSettings: () => any}} deps
   */
  constructor({ partition, getSettings }) {
    this.partition = partition;
    this.getSettings = getSettings;
    this.blocked = new Set(BUILTIN);
    this.allowed = new Set();
    this.blockedCount = 0;
    this.installed = false;
    this._hostCache = new Map();
  }

  listsPath() {
    return path.join(app.getPath('userData'), 'blocklist.json');
  }

  /** Carga la lista del usuario, que se suma a la incluida. */
  loadUserLists() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.listsPath(), 'utf8'));
      for (const host of raw.block ?? []) this.blocked.add(normalize(host));
      for (const host of raw.allow ?? []) this.allowed.add(normalize(host));
    } catch (err) {
      if (err.code === 'ENOENT') {
        const seed = { block: [], allow: [] };
        try {
          fs.writeFileSync(this.listsPath(), JSON.stringify(seed, null, 2), 'utf8');
        } catch {
          /* no critico */
        }
      }
    }
    this._hostCache.clear();
  }

  install() {
    if (this.installed) return;
    this.installed = true;
    this.loadUserLists();

    const ses = session.fromPartition(this.partition);
    ses.webRequest.onBeforeRequest((details, callback) => {
      this.onRequest?.(details);
      if (!this.getSettings().browsing.blockTrackers) return callback({});
      // Nunca bloqueamos el documento principal: si te equivocas en una regla,
      // no quieres que una pagina entera deje de cargar.
      if (details.resourceType === 'mainFrame') return callback({});

      const host = hostFromUrl(details.url);
      if (!host) return callback({});

      if (this._isBlocked(host)) {
        this.blockedCount++;
        return callback({ cancel: true });
      }
      return callback({});
    });
  }

  _isBlocked(host) {
    const cached = this._hostCache.get(host);
    if (cached !== undefined) return cached;

    let result = false;
    if (!this._matches(this.allowed, host)) result = this._matches(this.blocked, host);

    // Cache acotada: evita que el Map crezca sin limite en sesiones largas.
    if (this._hostCache.size > 5000) this._hostCache.clear();
    this._hostCache.set(host, result);
    return result;
  }

  _matches(set, host) {
    if (set.size === 0) return false;
    if (set.has(host)) return true;
    let index = host.indexOf('.');
    while (index !== -1) {
      const suffix = host.slice(index + 1);
      if (set.has(suffix)) return true;
      index = host.indexOf('.', index + 1);
    }
    return false;
  }

  stats() {
    return {
      blockedCount: this.blockedCount,
      rules: this.blocked.size,
      allowRules: this.allowed.size,
      path: this.listsPath(),
    };
  }
}

function hostFromUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function normalize(host) {
  return String(host).trim().toLowerCase().replace(/^\*?\.?/, '');
}

module.exports = { TrackerBlocker, BUILTIN };
