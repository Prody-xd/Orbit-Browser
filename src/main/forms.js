'use strict';

const path = require('node:path');
const { app } = require('electron');
const { JsonStore } = require('./store');
const { getSettings } = require('./settings');

/**
 * Recuerda lo escrito en formularios de paginas visitadas a menudo.
 *
 * Los usuarios/correos se sugieren en cuanto los has escrito una vez.
 * El resto de campos espera mas de 3 visitas y el mismo valor dos veces.
 * Nunca guarda contrasenas ni pagos.
 */

const MIN_VISITS = 4;
const MIN_REPEATS = 2;
const MAX_PAGES = 400;
const MAX_VALUES = 6;
const MAX_VALUE_LEN = 200;

/** @type {FormMemory|null} */
let memory = null;

class FormMemory {
  constructor(store) {
    this.store = store;
    if (!this.store.data.pages || typeof this.store.data.pages !== 'object') {
      this.store.data.pages = {};
    }
  }

  enabled() {
    try {
      return getSettings().browsing?.rememberForms !== false;
    } catch {
      return true;
    }
  }

  noteVisit(url) {
    if (!this.enabled()) return;
    const key = pageKey(url);
    if (!key) return;
    const page = this._page(key);
    page.visits = (Number(page.visits) || 0) + 1;
    page.lastVisit = Date.now();
    this._trim();
    this.store.save();
  }

  record({ url, field, value, kind }) {
    if (!this.enabled()) return;
    const key = pageKey(url);
    const name = fieldKey(field);
    const text = normalizeValue(value);
    if (!key || !name || !text) return;
    if (isSecretField(name, kind)) return;
    const page = this._page(key);
    if (!page.fields || typeof page.fields !== 'object') page.fields = {};
    if (!page.fields[name] || typeof page.fields[name] !== 'object') page.fields[name] = {};
    const slot = page.fields[name];
    const prev = slot[text];
    slot[text] = {
      count: (Number(prev?.count) || 0) + 1,
      last: Date.now(),
    };
    pruneValues(slot);
    this.store.save();
  }

  suggest({ url, field, prefix, kind }) {
    if (!this.enabled()) return [];
    const key = pageKey(url);
    const name = fieldKey(field);
    if (!key || !name) return [];
    const page = this.store.data.pages[key];
    const username = isUsernameField(name, kind);
    const minVisits = username ? 1 : MIN_VISITS;
    const minRepeats = username ? 1 : MIN_REPEATS;
    if (!page || Number(page.visits) < minVisits) return [];
    const slot = page.fields?.[name];
    if (!slot) return [];
    const needle = String(prefix ?? '').trim().toLowerCase();
    return Object.entries(slot)
      .filter(([, meta]) => Number(meta?.count) >= minRepeats)
      .filter(([text]) => !needle || text.toLowerCase().startsWith(needle) || text.toLowerCase().includes(needle))
      .sort((a, b) => Number(b[1].count) - Number(a[1].count) || Number(b[1].last) - Number(a[1].last))
      .slice(0, 6)
      .map(([text, meta]) => ({ value: text, count: Number(meta.count) || 0 }));
  }

  visits(url) {
    const key = pageKey(url);
    return Number(this.store.data.pages[key]?.visits) || 0;
  }

  saveNow() {
    this.store.saveNow();
  }

  _page(key) {
    let page = this.store.data.pages[key];
    if (!page || typeof page !== 'object') {
      page = { visits: 0, lastVisit: 0, fields: {} };
      this.store.data.pages[key] = page;
    }
    return page;
  }

  _trim() {
    const pages = this.store.data.pages;
    const keys = Object.keys(pages);
    if (keys.length <= MAX_PAGES) return;
    keys
      .sort((a, b) => (Number(pages[a].lastVisit) || 0) - (Number(pages[b].lastVisit) || 0))
      .slice(0, keys.length - MAX_PAGES)
      .forEach((key) => delete pages[key]);
  }
}

function pageKey(url) {
  try {
    const parsed = new URL(String(url || ''));
    if (!/^https?:$/i.test(parsed.protocol)) return '';
    const pathName = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.origin}${pathName}`;
  } catch {
    return '';
  }
}

function isSecretField(field, kind) {
  if (kind === 'password' || kind === 'secret') return true;
  const n = String(field ?? '').toLowerCase();
  return /password|passwd|^pwd$|cc-number|cc-csc|cc-exp|one-time|otp/.test(n);
}

function isUsernameField(field, kind) {
  if (kind === 'username' || kind === 'email') return true;
  if (isSecretField(field, kind)) return false;
  const n = String(field ?? '').toLowerCase();
  return /^(user|username|email|e-mail|login|account|identifier|nickname|userid|user_name|user-name)$/.test(n)
    || /(^|[_:-])(user|username|email|login)([_:-]|$)/.test(n)
    || n.includes('username')
    || n.includes('e-mail');
}

function fieldKey(field) {
  const raw = String(field ?? '')
    .trim()
    .slice(0, 80)
    .toLowerCase();
  return raw.replace(/[^\w.:#@-]/g, '') || '';
}

function normalizeValue(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > MAX_VALUE_LEN) return '';
  return text;
}

function pruneValues(slot) {
  const entries = Object.entries(slot);
  if (entries.length <= MAX_VALUES) return;
  entries
    .sort((a, b) => Number(a[1].last) - Number(b[1].last))
    .slice(0, entries.length - MAX_VALUES)
    .forEach(([text]) => delete slot[text]);
}

function initForms() {
  memory = new FormMemory(
    new JsonStore(path.join(app.getPath('userData'), 'form-memory.json'), { pages: {} }, { debounceMs: 800 }),
  );
  return memory;
}

function getForms() {
  return memory;
}

module.exports = { FormMemory, initForms, getForms, pageKey, MIN_VISITS, MIN_REPEATS };
