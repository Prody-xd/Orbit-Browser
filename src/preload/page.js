'use strict';

const { ipcRenderer } = require('electron');

/**
 * Memoria de formularios dentro de la pagina.
 *
 * Corre en el preload aislado: ve el DOM, pero el sitio no ve esta API.
 * El desplegable se pinta en un Shadow DOM cerrado para no pelear con el CSS
 * de la pagina.
 */

const SKIP_TYPES = new Set(['password', 'hidden', 'file', 'checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'range', 'color']);
const SKIP_AUTO = /password|new-password|current-password|cc-number|cc-csc|cc-exp|one-time-code|otp/i;

let host = null;
let shadow = null;
let listEl = null;
let activeEl = null;
let suggestions = [];
let selected = 0;
let debounce = null;

function fieldKind(el) {
  if (el instanceof HTMLInputElement && String(el.type || '').toLowerCase() === 'password') return 'password';
  const auto = `${el.autocomplete || ''} ${el.name || ''} ${el.id || ''}`.toLowerCase();
  if (SKIP_AUTO.test(auto)) return 'password';
  const type = el instanceof HTMLInputElement ? String(el.type || '').toLowerCase() : '';
  if (type === 'email') return 'username';
  if (/\b(username|email|nickname)\b/.test(el.autocomplete || '')) return 'username';
  if (/(^|[\s_:-])(user|username|email|e-mail|login|account|userid)([\s_:-]|$)/.test(auto)) return 'username';
  if (auto.includes('username')) return 'username';
  return 'text';
}

function eligible(el) {
  if (!el || el.disabled || el.readOnly) return false;
  if (fieldKind(el) === 'password') return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (!(el instanceof HTMLInputElement)) return false;
  const type = String(el.type || 'text').toLowerCase();
  if (SKIP_TYPES.has(type)) return false;
  return true;
}

function fieldId(el) {
  return el.name || el.id || el.getAttribute('autocomplete') || el.placeholder || el.type || 'field';
}

function ensureUi() {
  if (host?.isConnected) return;
  host = document.createElement('div');
  host.setAttribute('data-orbit-suggest', '');
  host.style.all = 'initial';
  host.style.position = 'absolute';
  host.style.zIndex = '2147483646';
  host.style.pointerEvents = 'none';
  shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .box {
      pointer-events: auto;
      min-width: 180px;
      max-width: min(420px, 90vw);
      max-height: 220px;
      overflow: auto;
      border-radius: 10px;
      border: 1px solid rgba(80, 90, 120, 0.35);
      background: Canvas;
      color: CanvasText;
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.28);
      font: 13px/1.35 "Segoe UI", system-ui, sans-serif;
    }
    .hint {
      padding: 7px 10px 4px;
      font-size: 11px;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      opacity: 0.62;
    }
    button {
      display: block;
      width: 100%;
      padding: 8px 10px;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    button[aria-selected="true"], button:hover {
      background: color-mix(in srgb, Highlight 22%, transparent);
    }
  `;
  listEl = document.createElement('div');
  listEl.className = 'box';
  listEl.hidden = true;
  shadow.append(style, listEl);
  (document.documentElement || document.body)?.append(host);
}

function hide() {
  suggestions = [];
  if (listEl) listEl.hidden = true;
  if (host) host.style.pointerEvents = 'none';
}

function fill(value) {
  if (!activeEl) return;
  activeEl.focus();
  activeEl.value = value;
  activeEl.dispatchEvent(new Event('input', { bubbles: true }));
  activeEl.dispatchEvent(new Event('change', { bubbles: true }));
  hide();
}

function render() {
  if (!listEl || !activeEl || !suggestions.length) {
    hide();
    return;
  }
  ensureUi();
  const rect = activeEl.getBoundingClientRect();
  host.style.left = `${Math.round(rect.left + window.scrollX)}px`;
  host.style.top = `${Math.round(rect.bottom + window.scrollY + 4)}px`;
  host.style.pointerEvents = 'auto';
  listEl.replaceChildren();
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.textContent = 'Sugerido por Orbit';
  listEl.append(hint);
  suggestions.forEach((entry, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = entry.value;
    btn.setAttribute('aria-selected', index === selected ? 'true' : 'false');
    btn.addEventListener('mousedown', (event) => {
      event.preventDefault();
      fill(entry.value);
    });
    listEl.append(btn);
  });
  listEl.hidden = false;
}

async function query(el) {
  if (!eligible(el)) return hide();
  activeEl = el;
  try {
    const found = await ipcRenderer.invoke('form:suggest', {
      url: location.href,
      field: fieldId(el),
      prefix: el.value,
      kind: fieldKind(el),
    });
    if (activeEl !== el) return;
    suggestions = Array.isArray(found) ? found : [];
    selected = 0;
    render();
  } catch {
    hide();
  }
}

function record(el) {
  if (!eligible(el)) return;
  const value = String(el.value || '').trim();
  if (value.length < 2) return;
  ipcRenderer.send('form:record', {
    url: location.href,
    field: fieldId(el),
    value,
    kind: fieldKind(el),
  });
}

document.addEventListener(
  'focusin',
  (event) => {
    const el = event.target;
    if (!eligible(el)) return hide();
    clearTimeout(debounce);
    debounce = setTimeout(() => query(el), 40);
  },
  true,
);

document.addEventListener(
  'input',
  (event) => {
    const el = event.target;
    if (el !== activeEl) return;
    clearTimeout(debounce);
    debounce = setTimeout(() => query(el), 80);
  },
  true,
);

document.addEventListener(
  'focusout',
  (event) => {
    const el = event.target;
    if (eligible(el)) record(el);
    setTimeout(() => {
      if (!shadow?.activeElement && document.activeElement !== activeEl) hide();
    }, 0);
  },
  true,
);

document.addEventListener(
  'keydown',
  (event) => {
    if (!suggestions.length || !listEl || listEl.hidden) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      selected = (selected + 1) % suggestions.length;
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      selected = (selected - 1 + suggestions.length) % suggestions.length;
      render();
    } else if (event.key === 'Enter' && suggestions[selected]) {
      event.preventDefault();
      fill(suggestions[selected].value);
    } else if (event.key === 'Escape') {
      hide();
    }
  },
  true,
);

document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    for (const el of form.elements) record(el);
  },
  true,
);
