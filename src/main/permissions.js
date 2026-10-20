'use strict';

const path = require('node:path');
const { app, BrowserWindow } = require('electron');
const { JsonStore } = require('./store');
const { getSettings } = require('./settings');
const { DialogOverlay, chromeVars, hostLabel } = require('./js-dialogs');

/**
 * Permisos por sitio.
 *
 * Chromium pide cámara, ubicación, notificaciones, etc. Orbit concedía
 * pantalla completa y DRM, y denegaba el resto en silencio. Ahora se pregunta
 * (el mismo diálogo que alert/confirm) y se guarda la excepción.
 */

const LABELS = {
  geolocation: 'ubicación',
  notifications: 'notificaciones',
  camera: 'cámara',
  microphone: 'micrófono',
  media: 'cámara y micrófono',
  midi: 'dispositivos MIDI',
  pointerLock: 'bloquear el puntero',
  'clipboard-read': 'leer el portapapeles',
  'display-capture': 'compartir la pantalla',
  'idle-detection': 'detectar inactividad',
  openExternal: 'abrir una aplicación externa',
  'speaker-selection': 'elegir altavoz',
  'storage-access': 'acceder al almacenamiento',
  'window-management': 'gestionar ventanas',
  keyboardLock: 'bloquear el teclado',
  fileSystem: 'archivos del equipo',
  serial: 'dispositivos serie',
  hid: 'dispositivos HID',
  usb: 'dispositivos USB',
  bluetooth: 'Bluetooth',
  unknown: 'un permiso extra',
};

const AUTO_ALLOW = new Set(['fullscreen', 'clipboard-sanitized-write']);

/** @type {PermissionGate|null} */
let gate = null;

class PermissionGate {
  constructor(store, getHost) {
    this.store = store;
    this.getHost = getHost;
    this.queue = [];
    this.current = null;
    /** @type {Map<import('electron').BrowserWindow, DialogOverlay>} */
    this.overlays = new Map();
    this.changed = null;
  }

  origins() {
    if (!this.store.data.origins || typeof this.store.data.origins !== 'object') {
      this.store.data.origins = {};
    }
    return this.store.data.origins;
  }

  list() {
    const out = [];
    for (const [origin, perms] of Object.entries(this.origins())) {
      if (!perms || typeof perms !== 'object') continue;
      for (const [permission, decision] of Object.entries(perms)) {
        if (decision !== 'allow' && decision !== 'deny') continue;
        out.push({
          origin,
          host: hostLabel(origin),
          permission,
          label: labelOf(permission),
          decision,
        });
      }
    }
    out.sort((a, b) => a.host.localeCompare(b.host, 'es') || a.label.localeCompare(b.label, 'es'));
    return out;
  }

  get(origin, permission) {
    const slot = this.origins()[origin];
    const value = slot?.[permission];
    return value === 'allow' || value === 'deny' ? value : null;
  }

  set(origin, keys, decision) {
    if (!origin || !keys?.length || (decision !== 'allow' && decision !== 'deny')) return;
    const origins = this.origins();
    if (!origins[origin] || typeof origins[origin] !== 'object') origins[origin] = {};
    for (const key of keys) origins[origin][key] = decision;
    this.store.saveNow();
    this.changed?.();
  }

  remove(origin, permission) {
    const slot = this.origins()[origin];
    if (!slot) return;
    delete slot[permission];
    if (!Object.keys(slot).length) delete this.origins()[origin];
    this.store.saveNow();
    this.changed?.();
  }

  storedDecision(origin, keys) {
    if (!origin || !keys.length) return null;
    const values = keys.map((key) => this.get(origin, key));
    if (values.every((value) => value === 'allow')) return 'allow';
    if (values.some((value) => value === 'deny')) return 'deny';
    if (values.every((value) => value == null)) return null;
    return null;
  }

  isGranted(origin, permission) {
    return this.storedDecision(origin, [permission]) === 'allow';
  }

  isPromptOpen() {
    return Boolean(this.current) || this.queue.length > 0;
  }

  overlayContents() {
    const overlay = this.current?.overlay;
    return overlay?.view?.webContents ?? null;
  }

  layoutAll() {
    for (const overlay of this.overlays.values()) overlay.layout();
  }

  decide(wc, permission, details, callback) {
    if (AUTO_ALLOW.has(permission)) return callback(true);
    if (permission === 'mediaKeySystem') {
      try {
        return callback(getSettings().browsing?.protectedContent !== false);
      } catch {
        return callback(true);
      }
    }

    const origin = originOf(wc, details);
    const keys = keysOf(permission, details);
    const stored = this.storedDecision(origin, keys);
    if (stored === 'allow') return callback(true);
    if (stored === 'deny') return callback(false);

    this.enqueue({ wc, origin, permission, keys, callback });
  }

  check(wc, permission, requestingOrigin, details) {
    if (AUTO_ALLOW.has(permission)) return true;
    if (permission === 'mediaKeySystem') {
      try {
        return getSettings().browsing?.protectedContent !== false;
      } catch {
        return true;
      }
    }
    const origin = originOf(wc, details, requestingOrigin);
    const keys = keysOf(permission, details);
    return this.storedDecision(origin, keys) === 'allow';
  }

  enqueue(job) {
    this.queue.push(job);
    this.pump();
  }

  pump() {
    if (this.current || !this.queue.length) return;
    const job = this.queue.shift();
    if (!job?.wc || job.wc.isDestroyed?.()) {
      try {
        job?.callback(false);
      } catch {
        /* ya respondido */
      }
      this.pump();
      return;
    }
    this.current = job;
    this.show(job).catch(() => this.finish(job, false, false));
  }

  async show(job) {
    const overlay = this.overlayFor(job.wc);
    if (!overlay) return this.finish(job, false, false);

    const onGone = () => this.finish(job, false, false);
    try {
      job.wc.once('destroyed', onGone);
      job.wc.once('render-process-gone', onGone);
    } catch {
      /* ya cerrado */
    }
    job.cleanup = () => {
      try {
        job.wc.off('destroyed', onGone);
        job.wc.off('render-process-gone', onGone);
      } catch {
        /* */
      }
    };

    job.overlay = overlay;
    overlay.onReply = (result) => {
      this.finish(job, Boolean(result?.ok), true);
    };
    await overlay.show(payloadOf(job));
  }

  finish(job, allow, remember) {
    if (this.current !== job && !this.queue.includes(job)) return;
    job.cleanup?.();
    if (remember && job.origin) this.set(job.origin, job.keys, allow ? 'allow' : 'deny');
    try {
      job.callback(allow);
    } catch {
      /* ya respondido */
    }
    if (job.overlay) {
      job.overlay.onReply = null;
      job.overlay.hide();
    }
    if (this.current === job) this.current = null;
    this.queue = this.queue.filter((item) => item !== job);
    this.pump();
  }

  overlayFor(wc) {
    const host = this.getHost?.();
    const shell = shellOf(host, wc);
    const window = shell?.window || BrowserWindow.fromWebContents(wc) || host?.focused()?.window;
    if (!window || window.isDestroyed()) return null;

    let overlay = this.overlays.get(window);
    if (overlay && overlay.window === window) return overlay;

    overlay = new DialogOverlay(window, () => {
      if (shell?.tabs) return { ...shell.tabs.pageBounds, radius: shell.tabs.borderRadius };
      const [width, height] = window.getContentSize();
      return { x: 0, y: 0, width, height, radius: 0 };
    });
    this.overlays.set(window, overlay);
    window.once('closed', () => {
      overlay.dispose();
      this.overlays.delete(window);
    });
    return overlay;
  }
}

function originOf(wc, details, requestingOrigin) {
  const raw =
    details?.requestingUrl ||
    details?.securityOrigin ||
    requestingOrigin ||
    details?.requestingOrigin ||
    (typeof wc?.getURL === 'function' ? wc.getURL() : '') ||
    '';
  try {
    const url = new URL(String(raw));
    if (url.protocol === 'orbit:') return `${url.protocol}//${url.hostname}`;
    if (url.origin && url.origin !== 'null') return url.origin;
  } catch {
    /* */
  }
  return String(raw);
}

function keysOf(permission, details) {
  if (permission === 'media') {
    const types = Array.isArray(details?.mediaTypes) ? details.mediaTypes : [];
    const keys = [];
    if (types.includes('video') || details?.mediaType === 'video') keys.push('camera');
    if (types.includes('audio') || details?.mediaType === 'audio') keys.push('microphone');
    return keys.length ? keys : ['media'];
  }
  if (permission === 'midiSysex' || permission === 'midi') return ['midi'];
  return [permission];
}

function labelOf(permission) {
  return LABELS[permission] || permission;
}

function payloadOf(job) {
  const names = job.keys.map(labelOf);
  const what = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}`;
  return {
    type: 'permission',
    origin: job.origin,
    title: hostLabel(job.origin),
    message: `Quiere usar ${what}.`,
    hint: 'Se recordará para este sitio. Puedes cambiarlo en Ajustes → Navegación.',
    okLabel: 'Permitir',
    cancelLabel: 'Bloquear',
    showCancel: true,
    showPrompt: false,
    showSuppress: false,
    theme: chromeVars(),
  };
}

function shellOf(host, wc) {
  if (!host || !wc) return null;
  for (const shell of host.list()) {
    if (shell.tabs.idFromWebContentsId(wc.id) != null) return shell;
    if (shell.window?.webContents?.id === wc.id) return shell;
  }
  const bw = BrowserWindow.fromWebContents(wc);
  if (!bw) return host.focused();
  return host.list().find((shell) => shell.window === bw) || host.focused();
}

function initPermissions({ ses, getHost, onChange }) {
  gate = new PermissionGate(
    new JsonStore(path.join(app.getPath('userData'), 'permissions.json'), { origins: {} }, { debounceMs: 200 }),
    getHost,
  );
  gate.changed = onChange;

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    gate.decide(wc, permission, details, callback);
  });
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    return gate.check(wc, permission, requestingOrigin, details);
  });
  return gate;
}

function getPermissions() {
  return gate;
}

module.exports = {
  initPermissions,
  getPermissions,
  originOf,
  keysOf,
  labelOf,
};
